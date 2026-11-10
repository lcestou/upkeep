import { existsSync } from "node:fs";
import { join } from "node:path";
import Electrobun, { BrowserWindow, Tray, Utils } from "electrobun/main";
import pkg from "../../package.json";
import { createEngine } from "../engine/engine";
import { realDeps } from "../engine/real";
import { loadState, updateState } from "../engine/store";
import type { EngineEvent, RunPhase, WindowButton, WindowChrome } from "../shared/types";
import { syncAutostart } from "./autostart";
import { parseButtonLayout, type SystemLayout, windowChrome } from "./chrome";
import { createCoalescer } from "./coalesce";
import { isDevBuild, playDevScript } from "./dev-script";
import { claimInstance, releaseInstance } from "./instance";
import { defineUpkeepRpc } from "./rpc";
import { loadWindowSize, saveWindowSize } from "./window-size";
import {
	failedNotice,
	readyFingerprint,
	readyNames,
	readyNotice,
	trayIcon,
	trayMenu,
	trayTitle,
	updatedNotice,
} from "./tray-model";

const VERSION = pkg.version;
// Started at login: no window, check, install what is marked automatic, stay in the tray.
// An environment variable, because the framework's launcher drops command-line arguments on Linux.
const background = process.env.UPKEEP_BACKGROUND === "1";

const deps = { ...realDeps(process.env, join(import.meta.dir, "../manifest/apps.toml")), version: VERSION };

let win: BrowserWindow | null = null;
let quitting = false;
let quitAfterRun = false;
let rebuilding = false;
let builtFrame = "";
const sizeFile = join(deps.paths.state, "window.json");
let sizeTimer: ReturnType<typeof setTimeout> | null = null;

function openWindow(): void {
	if (win) {
		win.show();
		win.activate();
		return;
	}
	const now = chrome();
	builtFrame = frameKey(now);
	win = new BrowserWindow({
		title: "Upkeep",
		url: "views://mainview/index.html",
		rpc,
		// "hiddenInset" drops the desktop's title bar and keeps the resize edges; the view then draws the bar itself.
		titleBarStyle: now.own ? "hiddenInset" : "default",
		// Rounded corners need a see-through window: the view paints everything but the four corner cut-offs.
		transparent: now.rounded,
		// No x or y: the framework then centres the window itself, with no jump from the corner.
		frame: loadWindowSize(sizeFile) as { x: number; y: number; width: number; height: number },
	});
	// A drag fires many resize events; the size is written once it has been still for half a second.
	win.on("resize", () => {
		tellChrome();
		if (sizeTimer) clearTimeout(sizeTimer);
		sizeTimer = setTimeout(() => {
			// An exception in a timer ends the process, mid-run included; a size is not worth that.
			try {
				if (win && !win.isMaximized()) saveWindowSize(sizeFile, win.getSize());
			} catch {
				// disk full or read-only: keep the old size
			}
		}, 500);
	});
	// The framework destroys the window unless a handler refuses. Hiding keeps the view's state and the tray alive.
	win.on("will-close", (event) => {
		if (quitting || rebuilding) return;
		// With no tray a hidden window is unreachable: close quits instead, except during a run.
		if (!tray.visible && engine.snapshot().run.phase !== "installing") return quit();
		(event as { response?: { allow: boolean } }).response = { allow: false };
		if (tray.visible) win?.hide();
	});
}

/** The desktop's own button layout, read once: the built-in frame puts its buttons where the owner expects them. */
function readSystemLayout(): SystemLayout {
	for (const schema of ["org.cinnamon.desktop.wm.preferences", "org.gnome.desktop.wm.preferences"]) {
		try {
			const out = Bun.spawnSync(["gsettings", "get", schema, "button-layout"], { stdin: "ignore", stderr: "ignore" });
			if (out.exitCode === 0 && out.stdout.toString().includes(":")) return parseButtonLayout(out.stdout.toString());
		} catch {
			// No gsettings on this desktop: fall through to the default.
		}
	}
	return parseButtonLayout("");
}
const systemLayout = readSystemLayout();

function chrome(): WindowChrome {
	return windowChrome(engine.snapshot().settings, systemLayout, win?.isMaximized() ?? false);
}

let toldChrome = "";
/** Tells the view when the frame, the button side or the maximised state changed. */
function tellChrome(): void {
	const now = chrome();
	const key = JSON.stringify(now);
	if (key === toldChrome) return;
	toldChrome = key;
	if (win) rpc.send.event({ type: "chrome", chrome: now });
}

/** What a window is built with and cannot change afterwards. */
function frameKey(c: WindowChrome): string {
	return `${c.own}/${c.rounded}`;
}

/** The frame and the corners are fixed when a window is created, so a change of either closes the window and opens a new one. */
function followFrameSetting(): void {
	if (win && frameKey(chrome()) !== builtFrame) {
		const old = win;
		win = null;
		rebuilding = true;
		try {
			old.close();
		} finally {
			rebuilding = false;
		}
		openWindow();
	}
	tellChrome();
}

function windowOp(op: WindowButton): void {
	if (!win) return;
	if (op === "minimize") win.minimize();
	else if (op === "maximize") {
		if (win.isMaximized()) win.unmaximize();
		else win.maximize();
		tellChrome();
	} else if (!tray.visible && engine.snapshot().run.phase !== "installing") quit();
	// Close hides, exactly as the desktop's own close button does.
	else if (tray.visible) win.hide();
}

function quit(): void {
	quitting = true;
	releaseInstance(deps.paths.socket);
	Utils.quit();
}

if ((await claimInstance(deps.paths.socket, openWindow)) === "secondary") {
	// Another Upkeep is running and has been asked to show its window.
	process.exit(0);
	// The framework's process.exit starts a graceful quit and returns; stop here so no second engine, tray or window is built.
	await new Promise<never>(() => {});
}

// SIGTERM at logout and the framework's own quit paths skip quit(): let the window close and free the socket.
Electrobun.events.on("before-quit", () => {
	quitting = true;
	releaseInstance(deps.paths.socket);
});

const engine = createEngine(deps);
// The launcher and icon of this very install, so a login entry always points at the copy that wrote it.
const launcher = join(import.meta.dir, "../../../bin/launcher");
const appIcon = join(import.meta.dir, "../../appIcon.png");
function applyLoginSetting(): void {
	// Only an installed build may own the login entry; a dev bundle or a source run would point it at a moving target.
	if (isDevBuild(import.meta.dir) || !existsSync(launcher)) return;
	syncAutostart(deps.paths.config, engine.snapshot().settings.checkAtLogin, launcher, appIcon);
}

const rpc = defineUpkeepRpc(engine, deps, {
	onSettings: () => {
		applyLoginSetting();
		followFrameSetting();
	},
	chrome,
	windowOp,
});

const tray = new Tray({ title: "Upkeep", image: "views://tray/idle.png", template: false, width: 22, height: 22 });
let shownIcon = "";
let shownMenu = "";

function refreshTray(): void {
	const snapshot = engine.snapshot();
	const icon = trayIcon(snapshot);
	if (icon !== shownIcon) {
		shownIcon = icon;
		tray.setImage(`views://tray/${icon}.png`);
		tray.setTitle(trayTitle(snapshot));
	}
	const menu = trayMenu(snapshot);
	const key = JSON.stringify(menu);
	if (key !== shownMenu) {
		shownMenu = key;
		tray.setMenu(menu);
	}
}

tray.on("tray-clicked", (event) => {
	const action = (event as { data?: { action?: string } }).data?.action;
	if (action === "open") openWindow();
	else if (action === "check") void engine.check();
	// The window holds the owner's ticks; once it exists, its Install is the one that honours them.
	else if (action === "install") {
		if (win) openWindow();
		else void engine.install(engine.readyKeys(false));
	} else if (action === "quit") {
		if (engine.snapshot().run.phase === "installing") {
			quitAfterRun = true;
			engine.stopAfterCurrent();
		} else quit();
	}
});

function notify(body: string): void {
	if (engine.snapshot().settings.notify) Utils.showNotification({ title: "Upkeep", body });
}

/** One notice per ready set: the same pending list is announced once, not after every check. */
let firstBackgroundCheck = background;
function announceReady(): void {
	const all = engine.snapshot();
	// At a login start the automatic apps are about to install and get their own "Updated" notice.
	const auto = firstBackgroundCheck ? new Set(engine.readyKeys(true)) : new Set<string>();
	firstBackgroundCheck = false;
	const snapshot = { ...all, apps: all.apps.filter((a) => !auto.has(a.key)) };
	const fingerprint = readyFingerprint(snapshot);
	if (fingerprint === loadState(deps.paths).notified) return;
	updateState(deps.paths, (s) => {
		s.notified = fingerprint;
	});
	// A visible window already shows the list.
	if (fingerprint && !win?.isVisible()) notify(readyNotice(readyNames(snapshot)));
}

function announceRun(): void {
	const results = engine.snapshot().run.results;
	const updated = results.filter((r) => r.result === "updated").map((r) => r.name);
	if (updated.length > 0) notify(updatedNotice(updated));
	for (const r of results) if (r.result !== "updated") notify(failedNotice(r.name));
}

// Before the window exists there is nobody to tell; the view asks for a snapshot when it mounts.
const toView = createCoalescer((event: EngineEvent) => {
	if (win) rpc.send.event(event);
});
let phase: RunPhase = "idle";

engine.subscribe((event) => {
	toView.push(event);
	if (event.type !== "run") {
		if (event.type === "app") refreshTray();
		return;
	}
	const before = phase;
	phase = event.run.phase;
	refreshTray();
	if (before === "checking" && phase === "idle") announceReady();
	if (before === "installing" && phase === "summary") {
		// With no window to read the summary in, say it once and clear it.
		if (!win?.isVisible() || quitAfterRun) {
			announceRun();
			engine.dismissSummary();
		}
		if (quitAfterRun) quit();
	}
});

refreshTray();
// Only an entry the owner asked for is kept: off removes a stale file, on repairs a moved install.
try {
	applyLoginSetting();
} catch (err) {
	// An autostart folder that cannot be written must not leave the app half started.
	console.error("login entry:", err);
}

if (background && tray.visible) {
	await engine.check();
	const auto = engine.readyKeys(true);
	if (auto.length > 0) await engine.install(auto);
} else {
	openWindow();
	const checked = engine.check();
	const script = process.env.UPKEEP_DEV_SCRIPT;
	if (script && isDevBuild(import.meta.dir)) {
		await checked;
		await playDevScript(
			script,
			(js) => win?.webview.executeJavascript(js),
			(index) => console.log(`[dev-script] step ${index} settled`),
		);
	}
}
