import { expect, test } from "bun:test";
import type { AppState, RunState, Snapshot } from "../shared/types";
import {
	createSettleWatch,
	failedNotice,
	readyFingerprint,
	readyNotice,
	runNotices,
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
		settings: {
			keepBackups: 1,
			notify: true,
			checkAtLogin: false,
			checkEvery: "6h",
			frame: "own",
			buttons: "auto",
			corners: "rounded",
			language: "system",
			selfAuto: false,
			upkeepCommand: false,
			waitDays: 0,
			waitUnmetered: false,
		},
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
	// An app the person stopped is not a failure.
	const stopped: RunState = {
		...failed,
		results: [{ ...failed.results[0], key: "a", name: "A", from: "1", to: "2", result: "stopped", ms: 1 }],
	};
	expect(trayIcon(snap(0, stopped))).toBe("idle");
});

test("titles and notices read as sentences", () => {
	expect(trayTitle(snap(0))).toBe("Upkeep");
	expect(trayTitle(snap(1))).toBe("Upkeep, 1 update ready");
	expect(trayTitle(snap(7))).toBe("Upkeep, 7 updates ready");
	expect(readyNotice(["fd"])).toBe("1 update ready: fd");
	expect(readyNotice(["fd"], "en", "metered")).toBe(
		"1 update ready: fd\nAutomatic updates wait for an unmetered connection.",
	);
	expect(readyNotice(["fd"], "de", "battery")).toBe(
		"1 Aktualisierung bereit: fd\nAutomatische Aktualisierungen warten auf Netzstrom.",
	);
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
	// The same set held back for a reason is a new notice; nothing ready stays nothing, whatever the wait.
	expect(readyFingerprint(a, "metered")).toBe("app0@1.0,app1@1.1;wait=metered");
	expect(readyFingerprint(snap(0), "battery")).toBe("");
	b.apps[1]!.latest = "9.9";
	expect(readyFingerprint(a)).not.toBe(readyFingerprint(b));
	expect(readyFingerprint(snap(0))).toBe("");
});

test("the menu and the icon's title speak the language given", () => {
	const labels = trayMenu(snap(2), undefined, "es").flatMap((i) => (i.type === "normal" ? [i.label] : []));
	expect(labels).toEqual(["Abrir Upkeep", "Buscar ahora", "Instalar 2 listas", "Salir"]);
	expect(trayTitle(snap(2), "ru")).toBe("Upkeep, 2 обновления готовы");
	expect(trayTitle(snap(1), "en")).toBe("Upkeep, 1 update ready");
});

test("after a run, notices say what updated and each failure, and nothing for an app the person stopped", () => {
	expect(
		runNotices([
			{ name: "A", result: "updated" },
			{ name: "B", result: "failed" },
			{ name: "C", result: "stopped" },
		]),
	).toEqual([updatedNotice(["A"]), failedNotice("B")]);
	expect(runNotices([{ name: "C", result: "stopped" }])).toEqual([]);
});

test("the settle watch fires once when a waiting row turns Ready, and owes the notice to idle when it is quiet", () => {
	const watch = createSettleWatch();
	// SAFETY: the watch reads only key, status and settles.
	const row = (over: Partial<AppState>) => ({ key: "zen", status: "held", ...over }) as AppState;
	const waiting = row({ settles: "2026-11-27T00:00:00.000Z" });
	expect(watch.row(row({ status: "ready" }), false)).toBe(false);
	expect(watch.row(waiting, false)).toBe(false);
	expect(watch.row(row({ status: "ready" }), false)).toBe(true);
	expect(watch.row(row({ status: "ready" }), false)).toBe(false);
	expect(watch.idle()).toBe(false);
	// During a run or its summary: nothing now, one notice when Upkeep is idle again.
	watch.row(waiting, true);
	expect(watch.row(row({ status: "ready" }), true)).toBe(false);
	expect(watch.idle()).toBe(true);
	expect(watch.idle()).toBe(false);
	// A waiting row that went to a check, not Ready, is forgotten.
	watch.row(waiting, false);
	expect(watch.row(row({ status: "checking" }), false)).toBe(false);
	expect(watch.row(row({ status: "ready" }), false)).toBe(false);
});
