import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Electrobun, { BrowserWindow, Tray, Updater, Utils } from "electrobun/main";
import pkg from "../../package.json";
import { createEngine } from "../engine/engine";
import { createExtras } from "../engine/extras/extras";
import { realDeps } from "../engine/real";
import { loadState, updateState } from "../engine/store";
import type { EngineEvent, RunPhase, WindowButton, WindowChrome } from "../shared/types";
import { syncAutostart, syncMenuExec } from "./autostart";
import { parseButtonLayout, type SystemLayout, windowChrome } from "./chrome";
import { createCoalescer } from "./coalesce";
import { dropStrayIcuData } from "./icu";
import { type LanguageCode, resolveLanguage, systemLanguages } from "../shared/languages";
import { isDevBuild, playDevScript } from "./dev-script";
import { startSchedule } from "./schedule";
import { claimInstance, releaseInstance } from "./instance";
import { countApps, selfPorts } from "./self-electrobun";
import { entryArgv, SELF_FILES } from "./self-shim";
import { createSelf, type Self, startTestAnswer } from "./self-update";
import { defineUpkeepRpc } from "./rpc";
import { loadWindowSize, saveWindowSize } from "./window-size";
import {
	failedNotice,
	readyFingerprint,
	readyNames,
	readyNotice,
	selfNotice,
	trayIcon,
	trayMenu,
	trayTitle,
	updatedNotice,
} from "./tray-model";

// Before any window opens: the launcher's ICU_DATA blanks the window where ICU keeps its data in a file (openSUSE).
dropStrayIcuData();

const VERSION = pkg.version;
// Started at login: no window, check, install what is marked automatic, stay in the tray.
// An environment variable, because the framework's launcher drops command-line arguments on Linux.
const background = process.env.UPKEEP_BACKGROUND === "1";
// A start test: the running version started this build from its staging folder, with copies of the person's files,
// to see that it comes up before anything is swapped. It answers in this file and leaves; it owns no socket and no
// tray, runs no check and touches nothing real.
const selftest = process.env.UPKEEP_SELFTEST ?? "";

const deps = {
	...realDeps(process.env, join(import.meta.dir, "../manifest/apps.toml"), join(import.meta.dir, "../catalogue")),
	version: VERSION,
};

let win: BrowserWindow | null = null;
let quitting = false;
// Set when the quit handler gave the instance socket away, so a quit that then did not happen takes it back.
let socketFreed = false;
let quitAfterRun = false;
// The tray's Quit during a System install: Upkeep quits once the install ends, never in the middle of it.
let quitAfterSystem = false;
let rebuilding = false;
let builtFrame = "";
const sizeFile = join(deps.paths.state, "window.json");
let sizeTimer: ReturnType<typeof setTimeout> | null = null;

/** `tab` opens the view on that tab: a window rebuilt from Settings comes back on Settings. */
function openWindow(tab = ""): void {
	if (win) {
		win.show();
		win.activate();
		return;
	}
	const now = chrome();
	builtFrame = frameKey(now);
	rpc = makeRpc();
	win = new BrowserWindow({
		title: "Upkeep",
		url: `views://mainview/index.html${tab ? `#${tab}` : ""}`,
		rpc,
		// "hiddenInset" drops the desktop's title bar and keeps the resize edges; the view then draws the bar itself.
		titleBarStyle: now.own ? "hiddenInset" : "default",
		// Rounded corners need a see-through window: the view paints everything but the four corner cut-offs.
		transparent: now.rounded,
		// No x or y: the framework then centres the window itself, with no jump from the corner.
		// SAFETY: the framework types a frame with x and y, but it centres the window when they are missing; the size file never holds a position.
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
		// With no tray a hidden window is unreachable: close quits instead, except during a run or a System install.
		if (!tray.visible && !installing()) return quit();
		// SAFETY: the framework passes a plain event object whose `response` field it reads back after the handlers run; the type does not declare it.
		(event as { response?: { allow: boolean } }).response = { allow: false };
		if (tray.visible) {
			win?.hide();
			// With the window out of the way, an update of Upkeep the person asked to be automatic may go ahead.
			void self?.auto();
		}
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

/** The frame state the view should draw now: the settings, the desktop layout and whether the window is maximised. */
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
		openWindow("settings");
	}
	tellChrome();
}

/** Runs a title-bar button the view drew. Does nothing before a window exists; close hides to the tray rather than ending the app. */
function windowOp(op: WindowButton): void {
	if (!win) return;
	if (op === "minimize") win.minimize();
	else if (op === "maximize") {
		if (win.isMaximized()) win.unmaximize();
		else win.maximize();
		tellChrome();
	} else if (!tray.visible && !installing()) quit();
	// Close hides, exactly as the desktop's own close button does.
	else if (tray.visible) win.hide();
}

/**
 * True while an app install or a System install runs. A System install's root apt run must not be cut off by a
 * quit, so the window's close and the tray's Quit wait for both.
 */
function installing(): boolean {
	return engine.snapshot().run.phase === "installing" || extras.installing();
}

/** Ends the app for real: marks the close as wanted and frees the socket first so a new launch can start. */
function quit(): void {
	quitting = true;
	releaseInstance(deps.paths.socket);
	Utils.quit();
}

if (!selftest && (await claimInstance(deps.paths.socket, openWindow)) === "secondary") {
	// Another Upkeep is running and has been asked to show its window. The framework's process.exit starts a
	// graceful quit and returns; the promise never settles, so no second engine, tray or window is built.
	await new Promise<never>(() => process.exit(0));
}

// SIGTERM at logout and the framework's own quit paths skip quit(): let the window close and free the socket. A
// System install still running is ended with its whole process group, so no root command outlives Upkeep unseen.
Electrobun.events.on("before-quit", (event) => {
	// Upkeep's own restart was asked for a moment before an install began (the kept copy takes a second to make, and
	// a press made meanwhile is served right after it). The install wins: the restart is refused, self-update hears
	// that as "staying up" and takes its attempt back. Nothing else is ever refused here, logout least of all.
	if (selfApi.snapshot().phase === "restarting" && installing()) {
		// SAFETY: the framework passes a plain event object whose `response` field it reads back after the handlers run; the type does not declare it.
		(event as { response?: { allow: boolean } }).response = { allow: false };
		return;
	}
	quitting = true;
	socketFreed = true;
	extras.stopSystem();
	releaseInstance(deps.paths.socket);
});

const engine = createEngine(deps);
// An update cut off by a crash or a power cut is finished or undone before the first check. Never in a start test:
// recovery acts on the installed apps themselves, and a test changes nothing real.
if (!selftest) void engine.recover();
// The system updates list: same paths and runner, its own state, never awaited by the engine's check.
// The background run below never installs system updates and never cleans: only the window's confirmed press does.
const extras = createExtras({
	paths: deps.paths,
	run: deps.run,
	now: deps.now,
	// Cleanup looks for Upkeep's own leftovers beside each installed app.
	leftoverDirs: () => [...new Set(engine.snapshot().apps.flatMap((a) => (a.dest ? [dirname(a.dest)] : [])))],
});
// The launcher and icon of this very install, so a login entry always points at the copy that wrote it.
const launcher = join(import.meta.dir, "../../../bin/launcher");
const appIcon = join(import.meta.dir, "../../appIcon.png");
/** Writes or removes the login entry to match the setting; skipped in dev and source runs. Throws if the autostart folder cannot be written. */
function applyLoginSetting(): void {
	// Only an installed build may own the login entry; a dev bundle or a source run would point it at a moving target.
	if (isDevBuild(import.meta.dir) || !existsSync(launcher)) return;
	// Both entries start Upkeep through the start script beside the app folder, which repairs an interrupted
	// self-update first; each falls back to the launcher when the script is not there.
	const command = entryArgv(dirname(dirname(dirname(launcher))));
	syncAutostart(deps.paths.config, engine.snapshot().settings.checkAtLogin, command, appIcon);
	syncMenuExec(join(dirname(deps.paths.data), "applications", "Upkeep.desktop"), command, launcher, SELF_FILES.shim);
}

/** Upkeep's own update. Absent in a start test, which must not look for updates or settle anything. */
const self: Self | null = selftest
	? null
	: createSelf(
			selfPorts({
				engine,
				extras,
				deps,
				env: process.env,
				windowOpen: () => win?.isVisible() ?? false,
				// The framework asked the quit handler before it gave up: undo what the handler did. The socket is
				// claimed again only when it was given away; asking for a socket Upkeep still owns would only make it
				// show its own window.
				stayUp: async () => {
					quitting = false;
					if (!socketFreed) return;
					socketFreed = false;
					await claimInstance(deps.paths.socket, openWindow);
				},
			}),
		);
/** What the view may ask of self-update; a start test answers that there is none. */
const selfApi: Pick<Self, "snapshot" | "prepare" | "restart" | "dismiss"> = self ?? {
	snapshot: () => ({ phase: "none" }),
	prepare: async () => {},
	restart: async () => {},
	dismiss: () => {},
};

// One channel per window: a channel stays tied to the webview it was first given to, so a rebuilt window with the old one never hears from this process and stays blank.
/** A fresh channel for a new window; see the note above on why one is never reused. `onSnapshot` hears each time the view asks for its snapshot. */
function makeRpc(onSnapshot?: () => void) {
	return defineUpkeepRpc(engine, deps, {
		self: selfApi,
		onSnapshot,
		onSettings: () => {
			applyLoginSetting();
			followFrameSetting();
		},
		chrome,
		windowOp,
		// The webview's own list comes from the C locale, which ignores LANGUAGE and falls back to English when the
		// desktop's locale is not generated; the environment is what the tray reads, so both use it.
		languages: () => systemLanguages(process.env),
		extras,
		env: process.env,
	});
}
let rpc = makeRpc();

if (selftest) {
	const info = await Updater.getLocalInfo();
	// The view asking for its snapshot proves the page loaded, its script ran and the channel works.
	rpc = makeRpc(() => {
		writeFileSync(selftest, startTestAnswer(info.hash, countApps(deps.paths.config)));
		process.exit(0);
	});
	win = new BrowserWindow({
		title: "Upkeep",
		url: "views://mainview/index.html",
		rpc,
		hidden: true,
		frame: { x: 0, y: 0, width: 980, height: 720 },
	});
	// The caller ends this process when it has its answer, or when the time is up.
	await new Promise<never>(() => {});
}

const tray = new Tray({ title: "Upkeep", image: "views://tray/idle.png", template: false, width: 22, height: 22 });
let shownIcon = "";
let shownTitle = "";
let shownMenu = "";

/** The tray's and the notifications' language: the setting, or for "system" the desktop's from the environment. */
function trayLanguage(): LanguageCode {
	return resolveLanguage(engine.snapshot().settings.language, systemLanguages(process.env));
}

/** Redraws the tray icon, title and menu from the engine, touching each only when it changed. */
function refreshTray(): void {
	const snapshot = engine.snapshot();
	const code = trayLanguage();
	const icon = trayIcon(snapshot);
	if (icon !== shownIcon) {
		shownIcon = icon;
		tray.setImage(`views://tray/${icon}.png`);
	}
	const title = trayTitle(snapshot, code);
	if (title !== shownTitle) {
		shownTitle = title;
		tray.setTitle(title);
	}
	const menu = trayMenu(snapshot, extras.snapshot().system, code, selfApi.snapshot());
	const key = JSON.stringify(menu);
	if (key !== shownMenu) {
		shownMenu = key;
		tray.setMenu(menu);
	}
}

tray.on("tray-clicked", (event) => {
	// SAFETY: the framework gives the clicked menu item's `action` string in `data`; the type does not declare it and a click with no data leaves it undefined.
	const action = (event as { data?: { action?: string } }).data?.action;
	if (action === "open") openWindow();
	else if (action === "check") void engine.check();
	// The window holds the owner's ticks; once it exists, its Install is the one that honours them.
	else if (action === "install") {
		if (win) openWindow();
		else void engine.install(engine.readyKeys(false));
	} else if (action === "quit") {
		if (extras.installing()) quitAfterSystem = true;
		if (engine.snapshot().run.phase === "installing") {
			quitAfterRun = true;
			engine.stopAfterCurrent();
		} else if (!quitAfterSystem) quit();
	}
});

/** Shows a desktop notice unless the owner turned notices off. */
function notify(body: string): void {
	if (engine.snapshot().settings.notify) Utils.showNotification({ title: "Upkeep", body });
}

let firstBackgroundCheck = background;
/** One notice per ready set: the same pending list is announced once, not after every check. */
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
	if (fingerprint && !win?.isVisible()) notify(readyNotice(readyNames(snapshot), trayLanguage()));
}

/** Says the outcome of an install with no window to read it: one notice for the updated apps, one per failure. */
function announceRun(): void {
	const results = engine.snapshot().run.results;
	const updated = results.filter((r) => r.result === "updated").map((r) => r.name);
	const code = trayLanguage();
	if (updated.length > 0) notify(updatedNotice(updated, code));
	for (const r of results) if (r.result !== "updated") notify(failedNotice(r.name, code));
}

// Before the window exists there is nobody to tell; the view asks for a snapshot when it mounts.
const toView = createCoalescer((event: EngineEvent) => {
	if (win) rpc.send.event(event);
});
let phase: RunPhase = "idle";
// Checks on the owner's schedule for as long as Upkeep runs; any check, pressed or scheduled, restarts the wait.
const schedule = startSchedule({
	every: () => engine.snapshot().settings.checkEvery,
	idle: () => phase === "idle",
	check: () => void engine.check(),
});

// Through the same coalescer as the engine's events: a non-row event flushes pending rows first, so order holds.
extras.subscribe((event) => {
	toView.push(event);
	refreshTray();
	if (quitAfterSystem && !extras.installing() && engine.snapshot().run.phase !== "installing") quit();
});

self?.subscribe((state) => {
	toView.push({ type: "self", self: state });
	refreshTray();
});

/** After a check of the apps: looks for a new Upkeep too, says so once, and installs it when that is switched on. */
async function selfLook(): Promise<void> {
	if (!self) return;
	try {
		const version = await self.check();
		if (version && !win?.isVisible()) notify(selfNotice(version, trayLanguage()));
		await self.auto();
	} catch (err) {
		// Upkeep's own update must never take the app list's check down with it.
		console.error("self-update:", err);
	}
}

engine.subscribe((event) => {
	toView.push(event);
	if (event.type !== "run") {
		// A meta event carries the settings, which may switch the language the tray speaks.
		if (event.type === "app" || event.type === "meta") refreshTray();
		return;
	}
	const before = phase;
	phase = event.run.phase;
	refreshTray();
	// A finished check or a dismissed run both just looked at every app: the schedule's wait starts again.
	if (phase === "idle" && (before === "checking" || before === "summary")) schedule.checked();
	if (before === "checking" && phase === "idle") {
		announceReady();
		void selfLook();
	}
	if (before === "installing" && phase === "summary") {
		// With no window to read the summary in, say it once and clear it.
		if (!win?.isVisible() || quitAfterRun) {
			announceRun();
			engine.dismissSummary();
		}
		if (quitAfterRun && !extras.installing()) quit();
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

// What the last self-update attempt came to. After one, the window comes back as it was, whatever started this process.
let wasOpen: boolean | null = null;
try {
	wasOpen = (await self?.settle()) ?? null;
} catch (err) {
	// Settling writes beside the app folder; a failure there must not stop Upkeep from starting.
	console.error("self-update:", err);
}
const startHidden = wasOpen === null ? background : !wasOpen;

if (startHidden && tray.visible) {
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
