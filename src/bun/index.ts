import { join } from "node:path";
import { BrowserWindow, Tray, Utils } from "electrobun/main";
import { createEngine } from "../engine/engine";
import { realDeps } from "../engine/real";
import { loadState, updateState } from "../engine/store";
import type { EngineEvent, RunPhase } from "../shared/types";
import { createCoalescer } from "./coalesce";
import { claimInstance } from "./instance";
import { defineUpkeepRpc } from "./rpc";
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

const VERSION = "0.1.0";
// Started at login: no window, check, install what is marked automatic, stay in the tray.
const background = process.argv.includes("--background") || process.env.UPKEEP_BACKGROUND === "1";

const deps = { ...realDeps(process.env, join(import.meta.dir, "../manifest/apps.toml")), version: VERSION };

let win: BrowserWindow | null = null;
let quitting = false;
let quitAfterRun = false;

function openWindow(): void {
	if (win) {
		win.show();
		win.activate();
		return;
	}
	win = new BrowserWindow({
		title: "Upkeep",
		url: "views://mainview/index.html",
		rpc,
		frame: { width: 980, height: 720, x: 0, y: 0 },
	});
	win.center();
	// The framework destroys the window unless a handler refuses. Hiding keeps the view's state and the tray alive.
	win.on("will-close", (event) => {
		if (quitting) return;
		(event as { response?: { allow: boolean } }).response = { allow: false };
		win?.hide();
	});
}

function quit(): void {
	quitting = true;
	Utils.quit();
}

if ((await claimInstance(deps.paths.socket, openWindow)) === "secondary") {
	// Another Upkeep is running and has been asked to show its window.
	process.exit(0);
}

const engine = createEngine(deps);
const rpc = defineUpkeepRpc(engine, deps, () => undefined);

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
	else if (action === "install") void engine.install(engine.readyKeys(false));
	else if (action === "quit") {
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
function announceReady(): void {
	const snapshot = engine.snapshot();
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
		if (!win?.isVisible()) {
			announceRun();
			engine.dismissSummary();
		}
		if (quitAfterRun) quit();
	}
});

refreshTray();

if (background) {
	await engine.check();
	const auto = engine.readyKeys(true);
	if (auto.length > 0) await engine.install(auto);
} else {
	openWindow();
	void engine.check();
}
