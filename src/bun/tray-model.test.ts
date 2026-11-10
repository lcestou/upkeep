import { expect, test } from "bun:test";
import type { AppState, RunState, Snapshot } from "../shared/types";
import {
	failedNotice,
	readyFingerprint,
	readyNotice,
	trayIcon,
	trayMenu,
	trayTitle,
	updatedNotice,
} from "./tray-model";

const idle: RunState = {
	id: null,
	phase: "idle",
	index: 0,
	total: 0,
	currentKey: null,
	stopping: false,
	results: [],
	retry: false,
};

function snap(ready: number, run: RunState = idle): Snapshot {
	const apps = Array.from({ length: ready + 2 }, (_, i) => ({
		key: `app${i}`,
		name: `App ${i}`,
		latest: `1.${i}`,
		status: i < ready ? "ready" : "fresh",
	})) as AppState[];
	return {
		apps,
		run,
		settings: { keepBackups: 1, notify: true, checkAtLogin: false, frame: "own", buttons: "auto", corners: "rounded" },
		rate: null,
		checkedAt: null,
		version: "0.1.0",
	};
}

test("menu without updates has no install item", () => {
	expect(trayMenu(snap(0)).map((i) => (i.type === "normal" ? i.label : "-"))).toEqual([
		"Open Upkeep",
		"Check now",
		"-",
		"Quit",
	]);
});

test("menu with updates offers them by count", () => {
	expect(trayMenu(snap(3)).map((i) => (i.type === "normal" ? i.label : "-"))).toEqual([
		"Open Upkeep",
		"Check now",
		"Install 3 ready",
		"-",
		"Quit",
	]);
});

test("during a run the menu cannot start another and quitting waits", () => {
	const labels = trayMenu(snap(3, { ...idle, phase: "installing" })).map((i) => (i.type === "normal" ? i.label : "-"));
	expect(labels).toEqual(["Open Upkeep", "Check now", "-", "Quit after this run"]);
});

test("during a check the menu offers no install, because the engine would refuse it", () => {
	const labels = trayMenu(snap(3, { ...idle, phase: "checking" })).map((i) => (i.type === "normal" ? i.label : "-"));
	expect(labels).toEqual(["Open Upkeep", "Check now", "-", "Quit"]);
});

test("icon names", () => {
	expect(trayIcon(snap(0))).toBe("idle");
	expect(trayIcon(snap(1))).toBe("count-1");
	expect(trayIcon(snap(9))).toBe("count-9");
	expect(trayIcon(snap(10))).toBe("count-9plus");
	expect(trayIcon(snap(4, { ...idle, phase: "installing" }))).toBe("working");
	const failed: RunState = {
		...idle,
		phase: "summary",
		results: [{ key: "a", name: "A", from: "1", to: "2", result: "failed", ms: 1 }],
	};
	expect(trayIcon(snap(0, failed))).toBe("failed");
});

test("titles and notices read as sentences", () => {
	expect(trayTitle(snap(0))).toBe("Upkeep");
	expect(trayTitle(snap(1))).toBe("Upkeep, 1 update ready");
	expect(trayTitle(snap(7))).toBe("Upkeep, 7 updates ready");
	expect(readyNotice(["fd"])).toBe("1 update ready: fd");
	expect(readyNotice(["fd", "Zen Browser", "Cursor", "wrangler"])).toBe(
		"4 updates ready: fd, Zen Browser, Cursor, wrangler",
	);
	expect(readyNotice(["a", "b", "c", "d", "e", "f", "g"])).toBe("7 updates ready: a, b, c, d and 3 more");
	expect(updatedNotice(["omp", "headroom"])).toBe("Updated omp, headroom");
	expect(failedNotice("wrangler")).toBe("wrangler failed to update. Open Upkeep for the log.");
});

test("the fingerprint changes when the ready set or a version changes, and only then", () => {
	const a = snap(2);
	const b = snap(2);
	expect(readyFingerprint(a)).toBe(readyFingerprint(b));
	expect(readyFingerprint(a)).toBe("app0@1.0,app1@1.1");
	b.apps[1]!.latest = "9.9";
	expect(readyFingerprint(a)).not.toBe(readyFingerprint(b));
	expect(readyFingerprint(snap(0))).toBe("");
});
