import { expect, test } from "bun:test";
import type { RunState, Snapshot, SystemRow, SystemState } from "../shared/types";
import { selfNotice, trayIcon, trayMenu, trayTitle } from "./tray-model";

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
const snap = { apps: [], run: idle, settings: {}, rate: null, checkedAt: null, version: "0" } as unknown as Snapshot;
const row = (id: string): SystemRow => ({
	id,
	source: "apt",
	name: id,
	type: "security",
	installed: "1",
	latest: "2",
	running: false,
});
const system = (mode: SystemState["mode"], n: number): SystemState => ({
	mode,
	phase: "idle",
	rows: Array.from({ length: n }, (_, i) => row(`apt:p${i}`)),
	checkedAt: null,
	problem: null,
	glMissing: null,
	packages: "mint",
});

test("shown system updates add one menu line before the divider, opening the window", () => {
	const menu = trayMenu(snap, system("show", 7));
	const at = menu.findIndex((i) => i.type === "divider");
	expect(menu[at - 1]).toEqual({ type: "normal", label: "System updates: 7", action: "open" });
});

test("no line when the area is off, when nothing is pending, or with no system state", () => {
	const plain = trayMenu(snap);
	expect(trayMenu(snap, system("off", 7))).toEqual(plain);
	expect(trayMenu(snap, system("show", 0))).toEqual(plain);
});

test("system updates never reach the tray icon or its count", () => {
	expect(trayIcon(snap)).toBe("idle");
	expect(trayTitle(snap)).toBe("Upkeep");
});

test("a new version of Upkeep adds one line that opens the window, in the tray's language, and no other phase does", () => {
	const plain = trayMenu(snap);
	for (const phase of ["available", "ready"] as const) {
		const menu = trayMenu(snap, undefined, "en", { phase, from: "0.1.0", version: "0.1.1" });
		const at = menu.findIndex((i) => i.type === "divider");
		expect(menu[at - 1]).toEqual({ type: "normal", label: "Upkeep 0.1.1 is ready", action: "open" });
		expect(menu).toHaveLength(plain.length + 1);
	}
	expect(selfNotice("0.1.1", "de")).toBe("Upkeep 0.1.1 ist bereit");
	for (const phase of ["preparing", "restarting", "updated", "rolled-back"] as const)
		expect(trayMenu(snap, undefined, "en", { phase, from: "0.1.0", version: "0.1.1" })).toEqual(plain);
	expect(trayMenu(snap, undefined, "en", { phase: "none" })).toEqual(plain);
	expect(trayMenu(snap, undefined, "en", { phase: "failed", from: "0.1.0", version: "0.1.1", why: "x" })).toEqual(
		plain,
	);
});
