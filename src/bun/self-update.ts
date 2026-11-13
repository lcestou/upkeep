import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MESSAGES } from "../shared/messages";
import type { SelfState } from "../shared/types";
import {
	clearKept,
	installShim,
	keepConfig,
	keepCopy,
	okMarker,
	readAttempt,
	SELF_FILES,
	writeAttempt,
} from "./self-shim";

/** What the new build writes when it came up as a test: this word, its own hash and how many apps it loaded. */
export const startTestAnswer = (hash: string, apps: number) => `ok ${hash} ${apps}`;

/** A version and the hash of its build. */
type Build = { version: string; hash: string };

/** Everything self-update asks of the framework, the file system and the rest of Upkeep. Fakes in tests. */
export type SelfPorts = {
	/** The running build and the channel root. Null when Upkeep does not run from a managed install (a dev build). */
	local: () => Promise<(Build & { root: string }) | null>;
	/** What the release address offers. available is the framework's word: the hash differs from the running one. */
	check: () => Promise<Build & { available: boolean; error: string }>;
	/** Downloads, verifies and stages. ready is false with the framework's own message in error. */
	download: () => Promise<{ ready: boolean; error: string }>;
	/** The hash of the staged build the framework would swap in, or null when none is staged. */
	stagedHash: () => string | null;
	/** Starts the staged build as a test and gives what it wrote, or null when it wrote nothing in time. */
	startTest: (root: string, hash: string) => Promise<string | null>;
	/** Asks the framework to swap and quit. Resolves false when the quit will not happen; never resolves when it will. */
	apply: () => Promise<false>;
	/** After a refused quit: takes the instance socket again and clears the quitting flag. */
	stayUp: () => Promise<void>;
	hasShell: () => boolean;
	freeBytes: (dir: string) => number;
	appBytes: (dir: string) => number;
	now: () => Date;
	/** A check or a run, a system install, a cleanup, a restore, an import, an add, or the run lock held by a live process. */
	busy: () => boolean;
	windowOpen: () => boolean;
	/** How many apps the running Upkeep has in its list. */
	appCount: () => number;
	/** The person's files a new version may rewrite: the app list, the state and the extras. */
	configFiles: () => string[];
	/** settings.selfAuto. */
	autoOn: () => boolean;
	/** The hash automatic update skips, "" for none. */
	failedHash: () => string;
	setFailedHash: (hash: string) => void;
	/** The hash of the last build the person was told about, "" for none, so each is announced once. */
	notifiedHash: () => string;
	setNotifiedHash: (hash: string) => void;
	/** One History row for a settled attempt. */
	history: (row: { from: string; to: string; result: "updated" | "rolled_back" }) => void;
	log: (line: string) => void;
};

/**
 * True when found is a later release than running. Upkeep's own versions are plain semver, so this is semver's order,
 * where a prerelease of the running version is older, not newer. A version that is not semver is never an update.
 */
export function newerSelf(running: string, found: string): boolean {
	// Bun's own reading is lenient ("0.1" passes), so the three numbers are required here.
	const plain = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
	if (!plain.test(running) || !plain.test(found)) return false;
	return Bun.semver.order(found, running) === 1;
}

/** How much room an update needs, in app folders: the staged copy, the kept copy, and one more for the download. */
const ROOM = 3;

/**
 * Turns the framework's update statuses into one answer: false when Upkeep is staying up. The framework's own promise
 * resolves either way, because the quit it starts is not awaited, so the statuses decide. "idle" is a refused quit,
 * "error" a helper that would not start (even after the restart was announced), "no-update" nothing to apply. When
 * the restart was announced and no error followed, the process is on its way out and this never resolves.
 */
export function applyAndWait(
	apply: () => Promise<void>,
	subscribe: (heard: (status: string) => void) => () => void,
): Promise<false> {
	return new Promise((resolve) => {
		let leaving = false;
		let done = false;
		const stay = () => {
			if (done) return;
			done = true;
			stop();
			resolve(false);
		};
		const stop = subscribe((status) => {
			if (status === "launching-new-version") leaving = true;
			else if (status === "idle" || status === "error" || status === "no-update") stay();
		});
		apply().then(
			() => {
				if (!leaving) stay();
			},
			() => stay(),
		);
	});
}

/** The variables a test start may inherit. Never the launcher's LD_PRELOAD or LD_LIBRARY_PATH, which name the old tree. */
const TEST_ENV = new Set([
	"HOME",
	"PATH",
	"DISPLAY",
	"WAYLAND_DISPLAY",
	"XAUTHORITY",
	"DBUS_SESSION_BUS_ADDRESS",
	"LANG",
	"LANGUAGE",
]);

/**
 * The environment for a test start: a short list from the running one, every LC_ variable, the XDG folders pointed
 * into dir so the new build reads copies and writes nowhere real, and the file it answers in.
 */
export function testEnv(env: Record<string, string | undefined>, dir: string, answer: string) {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(env))
		if (value !== undefined && (TEST_ENV.has(name) || name.startsWith("LC_"))) out[name] = value;
	return {
		...out,
		XDG_CONFIG_HOME: join(dir, "config"),
		XDG_STATE_HOME: join(dir, "state"),
		XDG_DATA_HOME: join(dir, "data"),
		XDG_CACHE_HOME: join(dir, "cache"),
		XDG_RUNTIME_DIR: join(dir, "run"),
		UPKEEP_SELFTEST: answer,
	};
}

/** Takes back an attempt that never reached the swap: the record, the kept copy and the kept files. */
function unwind(root: string): void {
	rmSync(join(root, SELF_FILES.attempt), { force: true });
	clearKept(root, true);
}

/** Self-update: one instance per running Upkeep. */
export type Self = {
	snapshot: () => SelfState;
	subscribe: (listener: (state: SelfState) => void) => () => void;
	/** Looks for a newer version. Resolves with its version the first time it is offered, else null. */
	check: () => Promise<string | null>;
	/** Downloads, verifies and test-starts the offered version. Changes nothing the running Upkeep uses. */
	prepare: () => Promise<void>;
	/** Swaps the tested version in and restarts. Returns only when the restart did not happen. */
	restart: () => Promise<void>;
	/** At start: reports what the last attempt came to. Resolves with whether the window was open before it, or null when there was none. */
	settle: () => Promise<boolean | null>;
	/** Prepares and restarts on its own when the person switched that on and nothing is in the way. */
	auto: () => Promise<void>;
	/** Takes a finished notice off the row. */
	dismiss: () => void;
};

/** Builds the self-update state machine over its ports. */
export function createSelf(p: SelfPorts): Self {
	let state: SelfState = { phase: "none" };
	/** The newer version the release address offers, and the running one it would replace. */
	let offered: (Build & { from: string }) | null = null;
	/** The hash that passed its start test. */
	let tested = "";
	const listeners = new Set<(state: SelfState) => void>();

	/** Publishes a new state. */
	function set(next: SelfState): void {
		state = next;
		for (const listener of listeners) listener(state);
	}
	/** A failed state for the offered version: nothing was changed. The reason goes to the log as well as the row. */
	function fail(why: string): void {
		p.log(`self-update: ${why}`);
		if (offered) set({ phase: "failed", from: offered.from, version: offered.version, why });
	}

	/** The check under way, if any: a restart waits for it, so none of its statuses is taken for the restart's own. */
	let looking: Promise<string | null> | null = null;

	/**
	 * Looks at the release address once. Only a version newer than the running one, with a hash of the framework's own
	 * shape, is an offer. A look that could not reach the address changes nothing: a build already downloaded and
	 * tested is not thrown away for a dropped connection. Resolves with the version the first time this build is
	 * offered on this machine, so it is announced once and not at every start.
	 */
	async function look(): Promise<string | null> {
		const local = await p.local();
		if (!local) return null;
		const found = await p.check();
		if (found.error) return null;
		// The framework would take any other hash, an older release included.
		if (!found.available || !newerSelf(local.version, found.version) || !/^[a-z0-9]{1,32}$/.test(found.hash)) {
			if (state.phase === "available" || state.phase === "ready" || state.phase === "failed") {
				offered = null;
				tested = "";
				set({ phase: "none" });
			}
			return null;
		}
		const fresh = found.hash !== p.notifiedHash();
		if (fresh) p.setNotifiedHash(found.hash);
		if (offered?.hash === found.hash && state.phase !== "none") return null;
		offered = { version: found.version, hash: found.hash, from: local.version };
		tested = "";
		// The notice that this very version was rolled back stays until the person has seen it; Try again works from it.
		if (state.phase === "rolled-back" && found.hash === p.failedHash()) return null;
		set({ phase: "available", from: local.version, version: found.version });
		return fresh ? found.version : null;
	}

	/** One look at a time, and none while a version is being prepared or swapped in. Never rejects. */
	async function check(): Promise<string | null> {
		if (state.phase === "preparing" || state.phase === "restarting") return null;
		if (looking) return looking;
		looking = (async () => {
			try {
				return await look();
			} catch (err) {
				p.log(`self-update: the check failed: ${String(err)}`);
				return null;
			}
		})();
		try {
			return await looking;
		} finally {
			looking = null;
		}
	}

	/**
	 * Pre-flight, download, start test. Whatever goes wrong, the running version is untouched and the row says so:
	 * an exception here (a full disk, a folder that cannot be read) ends as a failed state, never as a stuck one.
	 */
	async function prepare(): Promise<void> {
		if (state.phase === "preparing" || state.phase === "restarting" || state.phase === "ready") return;
		// After a rollback or a restart the offer is gone from memory: look again.
		if (!offered) await check();
		const local = await p.local();
		if (!offered || !local) return;
		const want = offered;
		try {
			if (p.busy()) return fail(MESSAGES.selfBusy());
			if (!p.hasShell()) return fail(MESSAGES.selfNoShell());
			if (p.freeBytes(local.root) < ROOM * p.appBytes(join(local.root, "app"))) return fail(MESSAGES.selfNoSpace());
			set({ phase: "preparing", from: want.from, version: want.version });
			const got = await p.download();
			if (!got.ready || p.stagedHash() !== want.hash) {
				p.log(`self-update: download failed: ${got.error || "the staged build is not the one offered"}`);
				return fail(MESSAGES.selfDownload());
			}
			const answer = await p.startTest(local.root, want.hash);
			if (answer !== startTestAnswer(want.hash, p.appCount())) {
				p.log(`self-update: start test of ${want.version} answered ${JSON.stringify(answer)}`);
				p.setFailedHash(want.hash);
				// A build that will not start is not kept staged: it is a whole copy of the app.
				rmSync(join(local.root, `app.prepared-${want.hash}`), { recursive: true, force: true });
				return fail(MESSAGES.selfTestFailed(want.version));
			}
			tested = want.hash;
			set({ phase: "ready", from: want.from, version: want.version });
		} catch (err) {
			p.log(`self-update: preparing ${want.version} threw: ${String(err)}`);
			fail(MESSAGES.selfDownload());
		}
	}

	/**
	 * Keeps the old version and the person's files, records the attempt, and asks the framework to swap. It returns
	 * only when the restart did not happen, and then nothing of the attempt is left for the start script to act on.
	 * The kept copy is made before the framework is asked, so a swap never happens without one.
	 */
	async function restart(): Promise<void> {
		if (state.phase !== "ready" || !offered || p.busy()) return;
		// A check under way would report through the framework's one status slot while the swap is asked for.
		if (looking) await looking;
		const local = await p.local();
		if (!local || state.phase !== "ready" || !offered || p.busy()) return;
		const want = offered;
		// Checked again here: a later check may have staged something else since the test passed.
		if (!newerSelf(local.version, want.version) || tested !== want.hash || p.stagedHash() !== want.hash) {
			tested = "";
			return fail(MESSAGES.selfNotApplied(want.version));
		}
		try {
			clearKept(local.root, true);
			keepCopy(join(local.root, "app"), join(local.root, SELF_FILES.keep));
			keepConfig(local.root, p.configFiles());
			writeAttempt(local.root, {
				fromVersion: local.version,
				fromHash: local.hash,
				toVersion: want.version,
				toHash: want.hash,
				window: p.windowOpen(),
				startedAt: p.now().toISOString(),
			});
		} catch (err) {
			p.log(`self-update: could not keep the running version: ${String(err)}`);
			unwind(local.root);
			return fail(MESSAGES.selfNotApplied(want.version));
		}
		set({ phase: "restarting", from: want.from, version: want.version });
		await p.apply();
		// Still here: the quit did not happen. Nothing was swapped, so the attempt is taken back.
		try {
			unwind(local.root);
			await p.stayUp();
		} catch (err) {
			p.log(`self-update: could not go back to normal after a refused restart: ${String(err)}`);
		}
		set({ phase: "ready", from: want.from, version: want.version });
	}

	/**
	 * What the last attempt came to, read from what is beside the app folder. Each step stands alone: one that fails
	 * (a full or read-only folder) is logged and the rest still run, because an attempt left on disk would make the
	 * start script put a healthy version back. The marker is written before anything optional.
	 */
	async function settle(): Promise<boolean | null> {
		const local = await p.local();
		if (!local) return null;
		/** Runs one step; a failure is logged and does not stop the next. */
		const step = (what: string, run: () => void) => {
			try {
				run();
			} catch (err) {
				p.log(`self-update: settling: ${what}: ${String(err)}`);
			}
		};
		const attempt = readAttempt(local.root);
		const rolledFile = join(local.root, SELF_FILES.rolledBack);
		let rolled = "";
		step("reading the rollback note", () => {
			rolled = existsSync(rolledFile) ? readFileSync(rolledFile, "utf8").trim() : "";
		});
		// This version is up: the start script reads the marker as "it has started".
		step("writing the marker", () => writeFileSync(join(local.root, okMarker(local.hash)), ""));
		step("removing the attempt", () => rmSync(join(local.root, SELF_FILES.attempt), { force: true }));
		step("removing the rollback note", () => rmSync(rolledFile, { force: true }));
		let window: boolean | null = null;
		if (rolled) {
			// Without the attempt the version that failed has no name; the build is still skipped from now on.
			const to = attempt?.toHash === rolled ? attempt.toVersion : "";
			step("recording the build that failed", () => p.setFailedHash(rolled));
			// The tree that would not start stays for a bug report, until the next attempt.
			step("clearing the kept copy", () => clearKept(local.root, false));
			if (to) {
				step("history", () => p.history({ from: local.version, to, result: "rolled_back" }));
				set({ phase: "rolled-back", from: local.version, version: to });
			}
			window = attempt?.window ?? null;
		} else if (attempt?.toHash === local.hash) {
			step("history", () => p.history({ from: attempt.fromVersion, to: local.version, result: "updated" }));
			step("clearing the kept copy", () => clearKept(local.root, true));
			set({ phase: "updated", from: attempt.fromVersion, version: local.version });
			window = attempt.window;
		} else if (attempt?.fromHash === local.hash) {
			// The framework's helper put this version back itself, or never swapped.
			step("clearing the kept copy", () => clearKept(local.root, true));
			set({
				phase: "failed",
				from: local.version,
				version: attempt.toVersion,
				why: MESSAGES.selfNotApplied(attempt.toVersion),
			});
			window = attempt.window;
		} else if (attempt) {
			// An attempt between two other versions, left behind by an install made by hand.
			step("clearing the kept copy", () => clearKept(local.root, true));
		}
		step("removing older markers", () => {
			for (const name of readdirSync(local.root))
				if (name.startsWith(okMarker("")) && name !== okMarker(local.hash))
					rmSync(join(local.root, name), { force: true });
		});
		step("writing the start script", () => installShim(local.root));
		return window;
	}

	/**
	 * The unattended path: prepares an offered version and restarts into a tested one, each only while the switch is
	 * on, the window is hidden and nothing is busy. A build that failed before is left for the person to try.
	 */
	async function auto(): Promise<void> {
		try {
			if (!p.autoOn() || p.busy() || p.windowOpen()) return;
			if (state.phase === "available" && offered && offered.hash !== p.failedHash()) await prepare();
			// Asked again: the test takes a while, and the window may have been opened meanwhile.
			if (state.phase === "ready" && !p.busy() && !p.windowOpen()) await restart();
		} catch (err) {
			// Called with nobody waiting on it (a window being hidden): it must never reject.
			p.log(`self-update: the automatic update threw: ${String(err)}`);
		}
	}

	return {
		snapshot: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		check,
		prepare,
		restart,
		settle,
		auto,
		dismiss() {
			if (state.phase === "updated" || state.phase === "rolled-back") set({ phase: "none" });
		},
	};
}
