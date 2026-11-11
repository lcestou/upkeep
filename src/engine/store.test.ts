import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryRow } from "../shared/types";
import {
	appendHistory,
	claimLock,
	clearInflight,
	loadState,
	openRunLog,
	pruneLogs,
	readHistory,
	readInflight,
	readRunLog,
	releaseLock,
	stageWeights,
	startTime,
	updateState,
	writeInflight,
} from "./store";
import { tempHome } from "./testkit";

let t: ReturnType<typeof tempHome>;
let proc = "";
beforeEach(() => {
	t = tempHome("store");
	proc = join(t.dir, "proc");
	mkdirSync(proc);
});
afterEach(() => t.cleanup());

function fakeProc(pid: number, start: string): void {
	mkdirSync(join(proc, String(pid)), { recursive: true });
	const after = [
		"S",
		"1",
		"1",
		"1",
		"0",
		"-1",
		"0",
		"0",
		"0",
		"0",
		"0",
		"0",
		"0",
		"0",
		"0",
		"20",
		"0",
		"1",
		"0",
		start,
		"0",
	];
	writeFileSync(join(proc, String(pid), "stat"), `${pid} (we (ird) ${after.join(" ")}`);
}

test("state defaults, and updateState merges one change into what is on disk", () => {
	expect(loadState(t.paths)).toEqual({
		skip: {},
		hold: {},
		auto: {},
		settings: { keepBackups: 1, notify: true, checkAtLogin: false, frame: "own", buttons: "auto", corners: "rounded" },
		notified: "",
		restart: {},
	});
	updateState(t.paths, (s) => {
		s.skip.fd = "10.5.2";
	});
	// Another process writes between our reads.
	const file = join(t.paths.state, "state.json");
	const other = JSON.parse(readFileSync(file, "utf8"));
	other.hold.zen = true;
	writeFileSync(file, JSON.stringify(other));
	const s = updateState(t.paths, (st) => {
		st.settings.keepBackups = 9;
	});
	expect(s.skip).toEqual({ fd: "10.5.2" });
	expect(s.hold).toEqual({ zen: true });
	expect(s.settings.keepBackups).toBe(5);
	expect(loadState(t.paths).settings.keepBackups).toBe(5);
	updateState(t.paths, (st) => {
		st.settings.keepBackups = 0;
	});
	expect(loadState(t.paths).settings.keepBackups).toBe(1);
	expect(readdirSync(t.paths.state)).toEqual(["state.json"]);
});

test("startTime reads field 22 even when comm holds spaces and parens", () => {
	fakeProc(42, "777");
	expect(startTime(42, proc)).toBe("777");
	expect(startTime(43, proc)).toBeNull();
});

test("the run lock is exclusive, and a dead or reused pid is taken over", () => {
	fakeProc(10, "100");
	fakeProc(11, "200");
	expect(claimLock(t.paths, 10, proc)).toBe(true);
	expect(readFileSync(join(t.paths.state, "run.lock"), "utf8")).toBe("10 100");
	expect(claimLock(t.paths, 11, proc)).toBe(false);
	// pid 10 now belongs to another process that started later.
	fakeProc(10, "999");
	expect(claimLock(t.paths, 11, proc)).toBe(true);
	expect(readFileSync(join(t.paths.state, "run.lock"), "utf8")).toBe("11 200");
	releaseLock(t.paths, 10);
	expect(readdirSync(t.paths.state)).toEqual(["run.lock"]);
	releaseLock(t.paths, 11);
	expect(readdirSync(t.paths.state)).toEqual([]);
	writeFileSync(join(t.paths.state, "run.lock"), "12 300");
	expect(claimLock(t.paths, 11, proc)).toBe(true);
});

test("inflight marker round trip", () => {
	expect(readInflight(t.paths)).toBeNull();
	writeInflight(t.paths, { key: "zen", dest: "/h/zen", backupVersion: "1.0" });
	expect(readInflight(t.paths)).toEqual({ key: "zen", dest: "/h/zen", backupVersion: "1.0" });
	clearInflight(t.paths);
	expect(readInflight(t.paths)).toBeNull();
});

const row = (key: string, at: string, result: HistoryRow["result"], stages: HistoryRow["stages"] = {}): HistoryRow => ({
	key,
	name: key,
	from: "1.0",
	to: "1.1",
	result,
	ms: 10,
	runId: "r",
	at,
	stages,
});

test("history appends and reads back newest first", () => {
	appendHistory(t.paths, [row("a", "1", "updated"), row("b", "2", "failed")]);
	appendHistory(t.paths, [row("c", "3", "rolled_back")]);
	expect(readHistory(t.paths, 2).map((r) => r.key)).toEqual(["c", "b"]);
	expect(readHistory(t.paths, 10).length).toBe(3);
});

test("the run log writes one line per event and reads back", () => {
	const log = openRunLog(t.paths, "20261110-101500-ab");
	log.write({ at: new Date(2026, 10, 10, 10, 15, 3).toISOString(), key: "fd", text: "Downloading" });
	log.write({ at: new Date(2026, 10, 10, 10, 15, 4).toISOString(), key: null, text: "Run done\nfine" });
	log.close();
	log.write({ at: new Date().toISOString(), key: "x", text: "after close" });
	expect(readFileSync(log.file, "utf8")).toBe("[10:15:03] [fd] Downloading\n[10:15:04] Run done fine\n");
	expect(readRunLog(t.paths, "20261110-101500-ab")).toEqual([
		{ at: "10:15:03", key: "fd", text: "Downloading" },
		{ at: "10:15:04", key: null, text: "Run done fine" },
	]);
	expect(readRunLog(t.paths, "../state")).toEqual([]);
});

test("pruneLogs keeps the newest", () => {
	const dir = join(t.paths.state, "logs");
	mkdirSync(dir, { recursive: true });
	for (let i = 0; i < 5; i++) {
		const f = join(dir, `r${i}.log`);
		writeFileSync(f, "");
		utimesSync(f, 1000 + i, 1000 + i);
	}
	pruneLogs(t.paths, 2);
	expect(readdirSync(dir).toSorted()).toEqual(["r3.log", "r4.log"]);
});

test("stage weights come from the last update with an 8 point floor, or the kind default", () => {
	expect(stageWeights([], "fd", "archive")).toEqual([
		{ id: "download", weight: 60 },
		{ id: "backup", weight: 10 },
		{ id: "install", weight: 20 },
		{ id: "verify", weight: 10 },
	]);
	expect(stageWeights([], "x", "deb").map((s) => s.weight)).toEqual([50, 40, 10]);
	expect(stageWeights([], "x", "source").map((s) => s.weight)).toEqual([10, 80, 10]);
	expect(stageWeights([], "x", "command").map((s) => s.weight)).toEqual([85, 15]);
	expect(stageWeights([], "x", "legacy")).toEqual([
		{ id: "install", weight: 85 },
		{ id: "verify", weight: 15 },
	]);
	expect(stageWeights([], "x", "manual")).toEqual([]);
	const history = [
		row("fd", "3", "failed", { download: 1, backup: 1, install: 1, verify: 1 }),
		row("fd", "2", "updated", { download: 9000, backup: 10, install: 900, verify: 90 }),
		row("fd", "1", "updated", { download: 1, backup: 1, install: 1, verify: 1 }),
	];
	const w = stageWeights(history, "fd", "archive");
	expect(w.map((s) => s.id)).toEqual(["download", "backup", "install", "verify"]);
	expect(w.reduce((a, s) => a + s.weight, 0)).toBe(100);
	expect(w.map((s) => s.weight)).toEqual([78, 7, 8, 7]);
});
