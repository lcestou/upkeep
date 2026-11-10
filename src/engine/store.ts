import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AppKind, HistoryRow, LogLine, Settings, Stage } from "../shared/types";
import type { Paths } from "./paths";

export type State = {
	skip: Record<string, string>;
	hold: Record<string, true>;
	auto: Record<string, boolean>;
	settings: Settings;
	notified: string;
	/** Apps replaced while they ran: key to the ISO time the install ended. Cleared once no older process remains. */
	restart: Record<string, string>;
};

export const DEFAULT_SETTINGS: Settings = {
	keepBackups: 1,
	notify: true,
	checkAtLogin: false,
	frame: "own",
	buttons: "auto",
	corners: "rounded",
};

function clampSettings(s: Partial<Settings>): Settings {
	const keep = Number(s.keepBackups ?? DEFAULT_SETTINGS.keepBackups);
	return {
		keepBackups: Math.min(5, Math.max(1, Number.isFinite(keep) ? Math.round(keep) : 1)),
		notify: typeof s.notify === "boolean" ? s.notify : DEFAULT_SETTINGS.notify,
		checkAtLogin: typeof s.checkAtLogin === "boolean" ? s.checkAtLogin : DEFAULT_SETTINGS.checkAtLogin,
		frame: s.frame === "system" || s.frame === "own" ? s.frame : DEFAULT_SETTINGS.frame,
		buttons:
			s.buttons === "left" || s.buttons === "right" || s.buttons === "auto" ? s.buttons : DEFAULT_SETTINGS.buttons,
		corners: s.corners === "square" || s.corners === "rounded" ? s.corners : DEFAULT_SETTINGS.corners,
	};
}

function obj<T>(v: unknown): Record<string, T> {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, T>) : {};
}

const stateFile = (paths: Paths) => join(paths.state, "state.json");

export function loadState(paths: Paths): State {
	let raw: Record<string, unknown> = {};
	try {
		raw = obj(JSON.parse(readFileSync(stateFile(paths), "utf8")));
	} catch {
		// absent or unreadable: defaults
	}
	return {
		skip: obj<string>(raw.skip),
		hold: obj<true>(raw.hold),
		auto: obj<boolean>(raw.auto),
		settings: clampSettings(obj(raw.settings)),
		notified: typeof raw.notified === "string" ? raw.notified : "",
		restart: obj<string>(raw.restart),
	};
}

function writeAtomic(file: string, text: string): void {
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
}

/** Re-reads the file, applies one change, writes it back by rename. The window and the command line may both be running. */
export function updateState(paths: Paths, change: (s: State) => void): State {
	mkdirSync(paths.state, { recursive: true });
	const s = loadState(paths);
	change(s);
	s.settings = clampSettings(s.settings);
	writeAtomic(stateFile(paths), JSON.stringify(s, null, "\t"));
	return s;
}

/** Field 22 of /proc/<pid>/stat, the start time in clock ticks, or null when the pid is gone. */
export function startTime(pid: number, procRoot = "/proc"): string | null {
	try {
		const stat = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
		// Fields after the comm's closing paren start at field 3.
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
	} catch {
		return null;
	}
}

const lockFile = (paths: Paths) => join(paths.state, "run.lock");

function createExclusive(file: string, text: string): boolean {
	try {
		const fd = openSync(file, "wx", 0o644);
		writeFileSync(fd, text);
		closeSync(fd);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw err;
	}
}

/** Claims the run lock. A lock whose pid is gone or started at another time is stale and taken over. */
export function claimLock(paths: Paths, pid = process.pid, procRoot = "/proc"): boolean {
	mkdirSync(paths.state, { recursive: true });
	const file = lockFile(paths);
	const mine = `${pid} ${startTime(pid, procRoot) ?? "0"}`;
	if (createExclusive(file, mine)) return true;
	let held = "";
	try {
		held = readFileSync(file, "utf8").trim();
	} catch {
		// released between our create and read
	}
	const [holder, started] = held.split(" ");
	const live = holder !== undefined && /^\d+$/.test(holder) && startTime(Number(holder), procRoot) === started;
	if (live) return false;
	// Rename aside first, so two claimers that both judged it stale cannot both win the create.
	const aside = `${file}.stale-${pid}`;
	try {
		renameSync(file, aside);
	} catch {
		// another claimer moved it first
	}
	rmSync(aside, { force: true });
	return createExclusive(file, mine);
}

export function releaseLock(paths: Paths, pid = process.pid): void {
	const file = lockFile(paths);
	try {
		if (readFileSync(file, "utf8").split(" ")[0] === String(pid)) rmSync(file, { force: true });
	} catch {
		// not held
	}
}

export type Inflight = { key: string; dest: string; backupVersion: string | null };

const inflightFile = (paths: Paths) => join(paths.state, "inflight.json");

export function writeInflight(paths: Paths, inflight: Inflight): void {
	mkdirSync(paths.state, { recursive: true });
	writeAtomic(inflightFile(paths), JSON.stringify(inflight));
}

export function readInflight(paths: Paths): Inflight | null {
	try {
		const v = obj<unknown>(JSON.parse(readFileSync(inflightFile(paths), "utf8")));
		if (typeof v.key !== "string" || typeof v.dest !== "string") return null;
		return { key: v.key, dest: v.dest, backupVersion: typeof v.backupVersion === "string" ? v.backupVersion : null };
	} catch {
		return null;
	}
}

export function clearInflight(paths: Paths): void {
	rmSync(inflightFile(paths), { force: true });
}

const historyFile = (paths: Paths) => join(paths.data, "history.jsonl");

export function appendHistory(paths: Paths, rows: HistoryRow[]): void {
	if (rows.length === 0) return;
	mkdirSync(paths.data, { recursive: true });
	appendFileSync(historyFile(paths), rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

/** The last limit rows, newest first. */
export function readHistory(paths: Paths, limit: number): HistoryRow[] {
	let text = "";
	try {
		text = readFileSync(historyFile(paths), "utf8");
	} catch {
		return [];
	}
	const rows: HistoryRow[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line) as HistoryRow);
		} catch {
			// a torn last line from a crash
		}
	}
	return rows.toReversed().slice(0, Math.max(0, limit));
}

const logsDir = (paths: Paths) => join(paths.state, "logs");

function clock(at: string): string {
	const d = new Date(at);
	if (Number.isNaN(d.getTime())) return at;
	return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

export function formatLogLine(line: LogLine): string {
	return line.key ? `[${clock(line.at)}] [${line.key}] ${line.text}` : `[${clock(line.at)}] ${line.text}`;
}

export type RunLog = { write(line: LogLine): void; close(): void; file: string };

export function openRunLog(paths: Paths, runId: string): RunLog {
	mkdirSync(logsDir(paths), { recursive: true });
	const file = join(logsDir(paths), `${runId}.log`);
	let open = true;
	return {
		file,
		write(line) {
			// One append per line: a crash loses at most the line being written.
			if (open) appendFileSync(file, `${formatLogLine(line).replace(/\n/g, " ")}\n`);
		},
		close() {
			open = false;
		},
	};
}

/** The run's log as lines. at is the HH:MM:SS the file holds. */
export function readRunLog(paths: Paths, runId: string): LogLine[] {
	if (!/^[\w.-]+$/.test(runId)) return [];
	let text = "";
	try {
		text = readFileSync(join(logsDir(paths), `${runId}.log`), "utf8");
	} catch {
		return [];
	}
	const lines: LogLine[] = [];
	for (const raw of text.split("\n")) {
		const m = /^\[([^\]]+)\] (?:\[([^\]]+)\] )?(.*)$/.exec(raw);
		if (m) lines.push({ at: m[1] ?? "", key: m[2] ?? null, text: m[3] ?? "" });
	}
	return lines;
}

/** Deletes the oldest run logs beyond keep. */
export function pruneLogs(paths: Paths, keep = 50): void {
	const dir = logsDir(paths);
	if (!existsSync(dir)) return;
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".log"))
		.map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
		.toSorted((a, b) => b.t - a.t || b.f.localeCompare(a.f));
	for (const { f } of files.slice(keep)) rmSync(join(dir, f), { force: true });
}

const DEFAULT_WEIGHTS: Record<AppKind, [Stage, number][]> = {
	appimage: [
		["download", 60],
		["backup", 10],
		["install", 20],
		["verify", 10],
	],
	archive: [
		["download", 60],
		["backup", 10],
		["install", 20],
		["verify", 10],
	],
	file: [
		["download", 60],
		["backup", 10],
		["install", 20],
		["verify", 10],
	],
	deb: [
		["download", 50],
		["install", 40],
		["verify", 10],
	],
	source: [
		["download", 10],
		["install", 80],
		["verify", 10],
	],
	command: [
		["install", 85],
		["verify", 15],
	],
	legacy: [
		["install", 85],
		["verify", 15],
	],
	manual: [],
};

/** Stage widths from the last update's timings, each at least 8, summing to 100; the kind's default when there is none. */
export function stageWeights(history: HistoryRow[], key: string, kind: AppKind): { id: Stage; weight: number }[] {
	const defaults = DEFAULT_WEIGHTS[kind];
	const fallback = defaults.map(([id, weight]) => ({ id, weight }));
	// history is newest first, as readHistory returns it.
	const last = history.find((r) => r.key === key && r.result === "updated");
	if (!last || defaults.length === 0) return fallback;
	const ms = defaults.map(([id]) => last.stages[id]);
	if (ms.some((v) => typeof v !== "number" || v < 0)) return fallback;
	const times = ms as number[];
	const total = times.reduce((a, b) => a + b, 0);
	if (total <= 0) return fallback;
	const floored = times.map((t) => Math.max(8, (t / total) * 100));
	const sum = floored.reduce((a, b) => a + b, 0);
	const weights = floored.map((w) => Math.round((w / sum) * 100));
	// Rounding can leave the sum at 99 or 101; the widest stage absorbs it.
	const widest = weights.indexOf(Math.max(...weights));
	weights[widest] = (weights[widest] ?? 0) + 100 - weights.reduce((a, b) => a + b, 0);
	return defaults.map(([id], i) => ({ id, weight: weights[i] ?? 0 }));
}
