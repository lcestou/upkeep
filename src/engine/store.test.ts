import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryRow } from "../shared/types";
import {
	appendHistory,
	claimLock,
	lockHeld,
	clearInflight,
	DEFAULT_SETTINGS,
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

test("a held run lock reads as held only while its holder lives", () => {
	expect(lockHeld(t.paths, proc)).toBe(false);
	fakeProc(10, "100");
	expect(claimLock(t.paths, 10, proc)).toBe(true);
	expect(lockHeld(t.paths, proc)).toBe(true);
	// The pid was reused by a process that started later: the lock is stale.
	fakeProc(10, "999");
	expect(lockHeld(t.paths, proc)).toBe(false);
	writeFileSync(join(t.paths.state, "run.lock"), "not a pid");
	expect(lockHeld(t.paths, proc)).toBe(false);
});

test("the upkeep command switch is off by default, survives other writes, and a wrong kind reads as off", () => {
	expect(loadState(t.paths).settings.upkeepCommand).toBe(false);
	updateState(t.paths, (s) => {
		s.settings.upkeepCommand = true;
	});
	updateState(t.paths, (s) => {
		s.skip.fd = "10.5.2";
	});
	expect(loadState(t.paths).settings.upkeepCommand).toBe(true);
	writeFileSync(join(t.paths.state, "state.json"), JSON.stringify({ settings: { upkeepCommand: 1 } }));
	expect(loadState(t.paths).settings.upkeepCommand).toBe(false);
});

test("the self-update switch and the skipped build survive a write that changes something else", () => {
	updateState(t.paths, (s) => {
		s.settings.selfAuto = true;
		s.selfFailed = "abc123";
		s.selfNotified = "def456";
	});
	updateState(t.paths, (s) => {
		s.skip.fd = "10.5.2";
	});
	const state = loadState(t.paths);
	expect(state.settings.selfAuto).toBe(true);
	expect(state.selfFailed).toBe("abc123");
	expect(state.selfNotified).toBe("def456");
	// A value of the wrong kind in a hand-edited file reads as the default.
	writeFileSync(join(t.paths.state, "state.json"), JSON.stringify({ selfFailed: 7, settings: { selfAuto: "yes" } }));
	expect(loadState(t.paths).selfFailed).toBe("");
	expect(loadState(t.paths).settings.selfAuto).toBe(false);
});

test("state defaults, and updateState merges one change into what is on disk", () => {
	expect(loadState(t.paths)).toEqual({
		skip: {},
		hold: {},
		auto: {},
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
		},
		notified: "",
		restart: {},
		selfFailed: "",
		selfNotified: "",
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
	// A language Upkeep has stays; anything else, such as a hand edit, reads as following the system.
	updateState(t.paths, (st) => {
		st.settings.language = "pl";
	});
	expect(loadState(t.paths).settings.language).toBe("pl");
	const edited = JSON.parse(readFileSync(file, "utf8"));
	edited.settings.language = "ar";
	writeFileSync(file, JSON.stringify(edited));
	expect(loadState(t.paths).settings.language).toBe("system");
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
	// The files an install writes beside are kept; anything in that list that is not a path is dropped.
	writeFileSync(
		join(t.paths.state, "inflight.json"),
		JSON.stringify({ key: "fd", dest: "/h/fd", files: ["/h/fd", 3, "/h/fdx"] }),
	);
	expect(readInflight(t.paths)).toEqual({ key: "fd", dest: "/h/fd", backupVersion: null, files: ["/h/fd", "/h/fdx"] });
	writeFileSync(join(t.paths.state, "inflight.json"), JSON.stringify({ key: "fd", dest: "/h/fd", files: [123] }));
	expect(readInflight(t.paths)).toEqual({ key: "fd", dest: "/h/fd", backupVersion: null });
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
	expect(stageWeights([], "x", "claude-plugins")).toEqual([{ id: "install", weight: 100 }]);
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

test("an unreadable state.json is kept beside it, and a second one never replaces the first", () => {
	const file = join(t.paths.state, "state.json");
	mkdirSync(t.paths.state, { recursive: true });
	writeFileSync(file, "{ first");
	expect(loadState(t.paths).settings).toEqual(DEFAULT_SETTINGS);
	// Read again and again, as every request does: still one copy.
	loadState(t.paths);
	loadState(t.paths);
	writeFileSync(file, "{ second");
	loadState(t.paths);
	const kept = readdirSync(t.paths.state).filter((n) => n.startsWith("state.json.unreadable"));
	expect(kept.length).toBe(2);
	expect(kept.map((n) => readFileSync(join(t.paths.state, n), "utf8")).toSorted()).toEqual(["{ first", "{ second"]);
});
