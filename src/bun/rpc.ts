import { BrowserView, Utils } from "electrobun/main";
import type { Engine, EngineDeps } from "../engine/engine";
import type { UpkeepRPC } from "../mainview/lib/bridge";
import { type Desktop, upkeepRequests, type WindowHooks } from "./requests";

/** The framework's desktop calls, for the requests in requests.ts. */
const desktop: Desktop = {
	openPath: (path) => Utils.openPath(path),
	openExternal: (url) => Utils.openExternal(url),
	clipboardWriteText: (text) => Utils.clipboardWriteText(text),
	pickFile: (startingFolder) =>
		Utils.openFileDialog({
			startingFolder,
			canChooseFiles: true,
			canChooseDirectory: false,
			allowsMultipleSelection: false,
		}),
	pickFolder: (startingFolder) =>
		Utils.openFileDialog({
			startingFolder,
			canChooseFiles: false,
			canChooseDirectory: true,
			allowsMultipleSelection: false,
		}),
	spawnDetached: (argv) => {
		Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
	},
};

/** Builds the main-process end of the view channel. Its answers live in requests.ts, which is unit-tested; this file only binds them to the framework. */
export function defineUpkeepRpc(engine: Engine, deps: EngineDeps, hooks: WindowHooks) {
	return BrowserView.defineRPC<UpkeepRPC>({
		// Limits requests from this process to the view, of which there are none. The view's own limit is in bridge.ts.
		maxRequestTime: 15000,
		handlers: { requests: upkeepRequests(engine, deps, hooks, desktop), messages: {} },
	});
}
