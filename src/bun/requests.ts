import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Engine, EngineDeps } from "../engine/engine";
import type { Extras } from "../engine/extras/extras";
import { claimLock, readWebhook, releaseLock, writeWebhook } from "../engine/store";
import { addressProblem, maskAddress } from "../engine/webhook";
import { exportSetup, importSetup } from "../engine/transfer";
import { MESSAGES } from "../shared/messages";
import { aboutUrl, releasePage } from "./about";
import type { Self } from "./self-update";
import type { RequestHandlers, WindowButton, WindowChrome } from "../shared/types";

/** The newest run log, for "Open log file" when no run is in progress. */
function newestLog(logDir: string): string | null {
	try {
		const names = readdirSync(logDir).filter((n) => n.endsWith(".log"));
		const newest = names.toSorted().at(-1);
		return newest ? join(logDir, newest) : null;
	} catch {
		return null;
	}
}

/** Every request the view can make, answered by the engine. */
export type WindowHooks = {
	/** Runs after any setting changed, so the login entry and the window frame can follow. */
	onSettings: () => void;
	/**
	 * Makes the files outside Upkeep that settings decide (the login entry, the menu entry, the upkeep command) match
	 * them. Import runs this and not onSettings: onSettings may rebuild the window for a new frame, which would drop
	 * the import's answer on the old window's channel. An imported frame therefore shows at the next start.
	 */
	applyEntries: () => void;
	chrome: () => WindowChrome;
	/** The desktop's languages from the environment, so the window and the tray follow the same list. */
	languages: () => string[];
	windowOp: (op: WindowButton) => void;
	/** The system updates list and its install, beside the engine. */
	extras: Extras;
	/** The environment, for the desktop and session a bug report names. */
	env: Record<string, string | undefined>;
	/** Upkeep's own update. */
	self: Pick<Self, "snapshot" | "prepare" | "restart" | "dismiss">;
	/** Called each time a view asks for its snapshot: a start test waits for the first. */
	onSnapshot?: () => void;
	/** Uninstalls Upkeep (uninstall.ts) and quits it, or answers why not. */
	uninstall: (purge: boolean) => { ok: boolean; problem?: string };
};

/** What the requests ask of the desktop: the framework's Utils in the app, a recorder in tests. */
export type Desktop = {
	openPath: (path: string) => boolean;
	openExternal: (url: string) => boolean;
	clipboardWriteText: (text: string) => void;
	/** The paths chosen; empty or [""] when cancelled. */
	pickFile: (startingFolder: string) => Promise<string[]>;
	/** A folder dialog; a cancelled one gives no path, or an empty one. */
	pickFolder: (startingFolder: string) => Promise<string[]>;
	/** Starts argv detached and never waits; throws when it cannot start. */
	spawnDetached: (argv: string[]) => void;
	/** The text of /etc/os-release for a bug report, or "" where it cannot be read. */
	osRelease: () => string;
};

/** The main-process answer to every request the view can make. Plain code, so it is unit-tested without the framework. */
export function upkeepRequests(
	engine: Engine,
	deps: EngineDeps,
	hooks: WindowHooks,
	desktop: Desktop,
): RequestHandlers {
	const logDir = join(deps.paths.state, "logs");
	/** The text of the file an import last asked about; Import on the ask writes this, and any other press clears it. */
	let asked: string | null = null;
	/** The kept notice address as Settings shows it, or null; the address itself never goes to the window. */
	const maskedWebhook = () => {
		const a = readWebhook(deps.paths);
		return a === null ? null : maskAddress(a);
	};
	return {
		snapshot: () => {
			hooks.onSnapshot?.();
			return engine.snapshot();
		},
		self: () => hooks.self.snapshot(),
		// Both take a while and report through self events; the answer only says the press was taken.
		selfUpdate: () => {
			void hooks.self.prepare();
			return { ok: true };
		},
		selfRestart: () => {
			void hooks.self.restart();
			return { ok: true };
		},
		selfDismiss: () => {
			hooks.self.dismiss();
			return { ok: true };
		},
		check: ({ keys }) => {
			// The engine ignores a check while it is checking or installing. Say so, so the view can.
			const phase = engine.snapshot().run.phase;
			void engine.check(keys);
			return { started: phase !== "installing" && phase !== "checking" };
		},
		install: ({ keys, now }) => engine.install(keys, now === true),
		stopNow: () => {
			engine.stopNow();
			return { stopping: engine.snapshot().run.stopping };
		},
		stopAfterCurrent: () => {
			engine.stopAfterCurrent();
			// Only a run in progress can be stopped; outside one the engine does nothing.
			return { stopping: engine.snapshot().run.stopping };
		},
		dismissSummary: () => {
			engine.dismissSummary();
			return { ok: true };
		},
		restore: ({ key, version }) => engine.restore(key, version),
		setSkip: ({ key, version }) => ({ ok: engine.setSkip(key, version) }),
		setHold: ({ key, held }) => ({ ok: engine.setHold(key, held) }),
		setPause: ({ key, days }) => ({ ok: engine.setPause(key, days) }),
		setAuto: ({ key, auto }) => ({ ok: engine.setAuto(key, auto) }),
		setPrerelease: ({ key, prerelease }) => ({ ok: engine.setPrerelease(key, prerelease) }),
		versions: ({ key }) => engine.versions(key),
		releaseNotes: ({ key }) => engine.releaseNotes(key),
		installVersion: ({ key, tag }) => engine.installVersion(key, tag),
		setMenu: ({ key, menu }) => engine.setMenu(key, menu),
		setSettings: (patch) => {
			const settings = engine.setSettings(patch);
			try {
				hooks.onSettings();
			} catch (err) {
				// The setting is saved; a login entry that cannot be written is reported, not fatal.
				console.error("login entry:", err);
			}
			return settings;
		},
		token: () => engine.tokenState(),
		setToken: async ({ token }) => {
			const r = await engine.setToken(token);
			return r === "ok" ? { ok: true, ...engine.tokenState() } : { ok: false, problem: r, ...engine.tokenState() };
		},
		webhook: () => ({ masked: maskedWebhook() }),
		setWebhook: ({ address }) => {
			const a = address?.trim() || null;
			const problem = a === null ? null : addressProblem(a);
			if (problem) return { ok: false, problem, masked: maskedWebhook() };
			writeWebhook(deps.paths, a);
			return { ok: true, masked: maskedWebhook() };
		},
		history: ({ limit }) => engine.history(limit),
		runLog: ({ runId }) => engine.runLog(runId),
		open: ({ what, key, id: advisory }) => {
			if (what === "manifest") return { ok: desktop.openPath(join(deps.paths.config, "apps.toml")) };
			if (what === "log") {
				const id = engine.snapshot().run.id;
				const file = id ? join(logDir, `${id}.log`) : newestLog(logDir);
				return { ok: file ? desktop.openPath(file) : false };
			}
			if (what === "self-notes") {
				const self = hooks.self.snapshot();
				// No offer, or one with no version to name: there is no page to open.
				if (self.phase === "none" || !self.version) return { ok: false };
				return { ok: desktop.openExternal(releasePage(self.version)) };
			}
			// Upkeep's own pages are built here from fixed addresses; the view only names which one.
			if (what === "changelog" || what === "bug" || what === "repo") {
				const info = {
					version: deps.version ?? "",
					arch: deps.arch ?? "",
					osRelease: desktop.osRelease(),
					env: hooks.env,
				};
				return { ok: desktop.openExternal(aboutUrl(what, info)) };
			}
			const app = engine.snapshot().apps.find((a) => a.key === key);
			// An advisory's page is the one the engine built for that ID, never an address from the view.
			if (what === "advisory") {
				const page = app?.security?.ids.find((a) => a.id === advisory)?.url;
				return { ok: page?.startsWith("https://") ? desktop.openExternal(page) : false };
			}
			const url = app?.releaseUrl;
			// Only a release page the engine itself fetched is opened, never a string from the view.
			return { ok: url?.startsWith("https://") ? desktop.openExternal(url) : false };
		},
		copy: ({ text }) => {
			desktop.clipboardWriteText(text);
			return { ok: true };
		},
		chrome: () => hooks.chrome(),
		languages: () => hooks.languages(),
		window: ({ op }) => {
			hooks.windowOp(op);
			return { ok: true };
		},
		suggest: ({ input, asset }) => engine.suggest(input, asset),
		scan: () => engine.scan(),
		addApps: ({ specs }) => engine.addApps(specs),
		removeApp: ({ key }) => engine.removeApp(key),
		restartApp: ({ key }) => engine.restartApp(key),
		pickFile: async () => {
			const picked = await desktop.pickFile(deps.paths.home);
			// A cancelled dialog gives no path, or an empty one.
			return { path: picked.find((p) => p !== "") ?? null };
		},
		exportSetup: async () => {
			const dir = (await desktop.pickFolder(deps.paths.home)).find((p) => p !== "");
			if (!dir) return { ok: false };
			const day = deps.now().toISOString().slice(0, 10);
			const file = join(dir, `upkeep-settings-${day}.json`);
			try {
				writeFileSync(file, `${JSON.stringify(exportSetup(deps.paths, deps.seedManifest, deps.now()), null, "\t")}\n`);
				return { ok: true, file };
			} catch (err) {
				return { ok: false, problem: err instanceof Error ? err.message : String(err) };
			}
		},
		importSetup: async ({ sure }) => {
			let text: string;
			if (sure) {
				// The text the ask was built from, not the file read again: what the person read is what lands.
				if (asked === null) return { ok: false, problems: [MESSAGES.importNothingAsked()] };
				text = asked;
			} else {
				const file = (await desktop.pickFile(deps.paths.home)).find((p) => p !== "");
				if (!file) return { ok: false };
				try {
					text = readFileSync(file, "utf8");
				} catch (err) {
					return { ok: false, problems: [err instanceof Error ? err.message : String(err)] };
				}
			}
			// The same lock an install holds, so an import never lands during a run. A refused Import keeps the ask's
			// text, so pressing it again after the run needs no new pick.
			if (!claimLock(deps.paths)) return { ok: false, problems: [MESSAGES.importDuringRun()] };
			asked = null;
			let r: ReturnType<typeof importSetup>;
			try {
				r = importSetup(deps.paths, deps.seedManifest, text, deps.now(), sure === true);
			} finally {
				releaseLock(deps.paths);
			}
			if ("ask" in r) {
				asked = text;
				return { ok: false, ask: r.ask };
			}
			// A failed import writes nothing (it puts every file back), so the ask stays answerable, as the window keeps it open.
			if (!r.ok) {
				if (sure) asked = text;
				return { ok: false, problems: r.problems };
			}
			// The new settings, extras and list reach the window: settings and extras by their events, the list by a check.
			engine.setSettings({});
			hooks.extras.setSettings({});
			// The login entry and the upkeep command follow the imported settings now, not at the next start.
			try {
				hooks.applyEntries();
			} catch (err) {
				console.error("login entry:", err);
			}
			void engine.check();
			return { ok: true, apps: r.apps, autoOff: r.autoOff.length };
		},
		extras: () => hooks.extras.snapshot(),
		setExtras: (patch) => hooks.extras.setSettings(patch),
		systemCheck: () => hooks.extras.checkSystem(),
		systemPlan: ({ ids }) => hooks.extras.planSystem(ids),
		// The person's press, after they read the commands: nothing else in Upkeep starts a System install.
		systemInstall: ({ ids, commands }) => hooks.extras.installSystem(ids, commands),
		systemSnapshotAnswer: ({ go }) => hooks.extras.answerSnapshot(go),
		cleanupMeasure: () => hooks.extras.measureCleanup(),
		cleanupReview: ({ picks }) => hooks.extras.reviewCleanup(picks),
		cleanupRun: ({ picks, commands, typed }) => hooks.extras.runCleanup(picks, commands, typed),
		uninstall: ({ purge }) => hooks.uninstall(purge === true),
		openTool: ({ what }) => {
			if (what !== "update-manager") return { ok: false };
			try {
				// Update Manager installs the system's updates; Upkeep only opens it, detached, and never waits.
				desktop.spawnDetached(["mintupdate"]);
				return { ok: true };
			} catch {
				return { ok: false };
			}
		},
	};
}
