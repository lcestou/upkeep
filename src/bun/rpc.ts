import { readdirSync } from "node:fs";
import { join } from "node:path";
import { BrowserView, Utils } from "electrobun/main";
import type { Engine, EngineDeps } from "../engine/engine";
import type { UpkeepRPC } from "../mainview/lib/bridge";

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
export function defineUpkeepRpc(engine: Engine, deps: EngineDeps, onSettings: () => void) {
	const logDir = join(deps.paths.state, "logs");
	return BrowserView.defineRPC<UpkeepRPC>({
		// A restore copies files and runs a version probe, which can take a few seconds.
		maxRequestTime: 15000,
		handlers: {
			requests: {
				snapshot: () => engine.snapshot(),
				check: ({ keys }) => {
					void engine.check(keys);
					return { started: true };
				},
				install: ({ keys }) => engine.install(keys),
				stopAfterCurrent: () => {
					engine.stopAfterCurrent();
					return { stopping: true };
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
					onSettings();
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
			},
			messages: {},
		},
	});
}
