import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Engine, EngineDeps } from "../engine/engine";
import type { Extras } from "../engine/extras/extras";
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
	chrome: () => WindowChrome;
	/** The desktop's languages from the environment, so the window and the tray follow the same list. */
	languages: () => string[];
	windowOp: (op: WindowButton) => void;
	/** The read-only system updates list, beside the engine. */
	extras: Extras;
};

/** What the requests ask of the desktop: the framework's Utils in the app, a recorder in tests. */
export type Desktop = {
	openPath: (path: string) => boolean;
	openExternal: (url: string) => boolean;
	clipboardWriteText: (text: string) => void;
	/** The paths chosen; empty or [""] when cancelled. */
	pickFile: (startingFolder: string) => Promise<string[]>;
	/** Starts argv detached and never waits; throws when it cannot start. */
	spawnDetached: (argv: string[]) => void;
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
		snapshot: () => engine.snapshot(),
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
		extras: () => hooks.extras.snapshot(),
		setExtras: (patch) => hooks.extras.setSettings(patch),
		systemCheck: () => hooks.extras.checkSystem(),
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
