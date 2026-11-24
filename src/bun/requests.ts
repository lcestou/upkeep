import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Engine, EngineDeps } from "../engine/engine";
import type { Extras } from "../engine/extras/extras";
import { claimLock, releaseLock } from "../engine/store";
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
		install: ({ keys }) => engine.install(keys),
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
		setAuto: ({ key, auto }) => ({ ok: engine.setAuto(key, auto) }),
		setPrerelease: ({ key, prerelease }) => ({ ok: engine.setPrerelease(key, prerelease) }),
		versions: ({ key }) => engine.versions(key),
		installVersion: ({ key, tag }) => engine.installVersion(key, tag),
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
		history: ({ limit }) => engine.history(limit),
		runLog: ({ runId }) => engine.runLog(runId),
		open: ({ what, key }) => {
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
			const url = engine.snapshot().apps.find((a) => a.key === key)?.releaseUrl;
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
		importSetup: async () => {
			const file = (await desktop.pickFile(deps.paths.home)).find((p) => p !== "");
			if (!file) return { ok: false };
			let text: string;
			try {
				text = readFileSync(file, "utf8");
			} catch (err) {
				return { ok: false, problems: [err instanceof Error ? err.message : String(err)] };
			}
			// The same lock an install holds, so an import never lands during a run.
			if (!claimLock(deps.paths)) return { ok: false, problems: [MESSAGES.importDuringRun()] };
			let r: ReturnType<typeof importSetup>;
			try {
				r = importSetup(deps.paths, deps.seedManifest, text, deps.now());
			} finally {
				releaseLock(deps.paths);
			}
			if (!r.ok) return { ok: false, problems: r.problems };
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
			return { ok: true, apps: r.apps };
		},
		extras: () => hooks.extras.snapshot(),
		setExtras: (patch) => hooks.extras.setSettings(patch),
		systemCheck: () => hooks.extras.checkSystem(),
		systemPlan: ({ ids }) => hooks.extras.planSystem(ids),
		// The person's press, after they read the commands: nothing else in Upkeep starts a System install.
		systemInstall: ({ ids, commands }) => hooks.extras.installSystem(ids, commands),
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
