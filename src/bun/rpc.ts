import { readdirSync } from "node:fs";
import { join } from "node:path";
import { BrowserView, Utils } from "electrobun/main";
import type { Engine, EngineDeps } from "../engine/engine";
import type { Extras } from "../engine/extras/extras";
import type { UpkeepRPC } from "../mainview/lib/bridge";
import type { WindowButton, WindowChrome } from "../shared/types";

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
	windowOp: (op: WindowButton) => void;
	/** The read-only system updates list, beside the engine. */
	extras: Extras;
};

export function defineUpkeepRpc(engine: Engine, deps: EngineDeps, hooks: WindowHooks) {
	const logDir = join(deps.paths.state, "logs");
	return BrowserView.defineRPC<UpkeepRPC>({
		// Limits requests from this process to the view, of which there are none. The view's own limit is in bridge.ts.
		maxRequestTime: 15000,
		handlers: {
			requests: {
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
				setSkip: ({ key, version }) => {
					engine.setSkip(key, version);
					return { ok: true };
				},
				setHold: ({ key, held }) => {
					engine.setHold(key, held);
					return { ok: true };
				},
				setAuto: ({ key, auto }) => {
					engine.setAuto(key, auto);
					return { ok: true };
				},
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
					if (what === "manifest") return { ok: Utils.openPath(join(deps.paths.config, "apps.toml")) };
					if (what === "log") {
						const id = engine.snapshot().run.id;
						const file = id ? join(logDir, `${id}.log`) : newestLog(logDir);
						return { ok: file ? Utils.openPath(file) : false };
					}
					const url = engine.snapshot().apps.find((a) => a.key === key)?.releaseUrl;
					// Only a release page the engine itself fetched is opened, never a string from the view.
					return { ok: url?.startsWith("https://") ? Utils.openExternal(url) : false };
				},
				copy: ({ text }) => {
					Utils.clipboardWriteText(text);
					return { ok: true };
				},
				chrome: () => hooks.chrome(),
				window: ({ op }) => {
					hooks.windowOp(op);
					return { ok: true };
				},
				suggest: ({ input, asset }) => engine.suggest(input, asset),
				scan: () => engine.scan(),
				addApps: ({ specs }) => engine.addApps(specs),
				removeApp: ({ key }) => engine.removeApp(key),
				pickFile: async () => {
					const picked = await Utils.openFileDialog({
						startingFolder: deps.paths.home,
						canChooseFiles: true,
						canChooseDirectory: false,
						allowsMultipleSelection: false,
					});
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
						Bun.spawn(["mintupdate"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
						return { ok: true };
					} catch {
						return { ok: false };
					}
				},
			},
			messages: {},
		},
	});
}
