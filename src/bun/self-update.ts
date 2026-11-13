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
	/** A failed state for the offered version: nothing was changed. */
	function fail(why: string): void {
		if (offered) set({ phase: "failed", from: offered.from, version: offered.version, why });
	}

	async function check(): Promise<string | null> {
		if (state.phase === "preparing" || state.phase === "restarting") return null;
		const local = await p.local();
		if (!local) return null;
		const found = await p.check();
		// Only a newer version is an update. The framework would take any other hash, an older release included.
		if (found.error || !found.available || !newerSelf(local.version, found.version)) {
			if (state.phase === "available" || state.phase === "ready" || state.phase === "failed") {
				offered = null;
				tested = "";
				set({ phase: "none" });
			}
			return null;
		}
		if (offered?.hash === found.hash && state.phase !== "none") return null;
		offered = { version: found.version, hash: found.hash, from: local.version };
		tested = "";
		// The notice that this very version was rolled back stays until the person has seen it; Try again works from it.
		if (state.phase === "rolled-back" && found.hash === p.failedHash()) return null;
		set({ phase: "available", from: local.version, version: found.version });
		return found.version;
	}

	async function prepare(): Promise<void> {
		if (state.phase === "preparing" || state.phase === "restarting" || state.phase === "ready") return;
		// After a rollback or a restart the offer is gone from memory: look again.
		if (!offered) await check();
		const local = await p.local();
		if (!offered || !local) return;
		if (p.busy()) return fail(MESSAGES.selfBusy());
		if (!p.hasShell()) return fail(MESSAGES.selfNoShell());
		if (p.freeBytes(local.root) < ROOM * p.appBytes(join(local.root, "app"))) return fail(MESSAGES.selfNoSpace());
		const want = offered;
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
			return fail(MESSAGES.selfTestFailed(want.version));
		}
		tested = want.hash;
		set({ phase: "ready", from: want.from, version: want.version });
	}

	async function restart(): Promise<void> {
		if (state.phase !== "ready" || !offered || p.busy()) return;
		const local = await p.local();
		if (!local) return;
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
		unwind(local.root);
		await p.stayUp();
		set({ phase: "ready", from: want.from, version: want.version });
	}

	async function settle(): Promise<boolean | null> {
		const local = await p.local();
		if (!local) return null;
		installShim(local.root);
		const attempt = readAttempt(local.root);
		const rolledFile = join(local.root, SELF_FILES.rolledBack);
		const rolled = existsSync(rolledFile) ? readFileSync(rolledFile, "utf8").trim() : "";
		let window: boolean | null = null;
		if (rolled) {
			const to = attempt?.toHash === rolled ? attempt.toVersion : "";
			p.setFailedHash(rolled);
			p.history({ from: local.version, to, result: "rolled_back" });
			// The tree that would not start stays for a bug report, until the next attempt.
			clearKept(local.root, false);
			set({ phase: "rolled-back", from: local.version, version: to });
			window = attempt?.window ?? null;
		} else if (attempt?.toHash === local.hash) {
			p.history({ from: attempt.fromVersion, to: local.version, result: "updated" });
			clearKept(local.root, true);
			set({ phase: "updated", from: attempt.fromVersion, version: local.version });
			window = attempt.window;
		} else if (attempt?.fromHash === local.hash) {
			// The framework's helper put this version back itself, or never swapped.
			clearKept(local.root, true);
			set({
				phase: "failed",
				from: local.version,
				version: attempt.toVersion,
				why: MESSAGES.selfNotApplied(attempt.toVersion),
			});
			window = attempt.window;
		} else if (attempt) {
			// An attempt between two other versions, left behind by an install made by hand.
			clearKept(local.root, true);
		}
		rmSync(rolledFile, { force: true });
		rmSync(join(local.root, SELF_FILES.attempt), { force: true });
		// This version is up: the start script reads the marker as "it has started".
		writeFileSync(join(local.root, okMarker(local.hash)), "");
		for (const name of readdirSync(local.root))
			if (name.startsWith(okMarker("")) && name !== okMarker(local.hash))
				rmSync(join(local.root, name), { force: true });
		return window;
	}

	async function auto(): Promise<void> {
		if (!p.autoOn() || p.busy() || p.windowOpen()) return;
		if (state.phase === "available" && offered && offered.hash !== p.failedHash()) await prepare();
		// Asked again: the test takes a while, and the window may have been opened meanwhile.
		if (state.phase === "ready" && !p.busy() && !p.windowOpen()) await restart();
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
