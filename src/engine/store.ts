import {
	appendFileSync,
	closeSync,
	copyFileSync,
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
	checkEvery: "6h",
	frame: "own",
	buttons: "auto",
	corners: "rounded",
};

/** Any missing or out-of-range field takes its default; keepBackups is rounded into 1 to 5. */
function clampSettings(s: Partial<Settings>): Settings {
	const keep = Number(s.keepBackups ?? DEFAULT_SETTINGS.keepBackups);
	return {
		keepBackups: Math.min(5, Math.max(1, Number.isFinite(keep) ? Math.round(keep) : 1)),
		notify: typeof s.notify === "boolean" ? s.notify : DEFAULT_SETTINGS.notify,
		checkAtLogin: typeof s.checkAtLogin === "boolean" ? s.checkAtLogin : DEFAULT_SETTINGS.checkAtLogin,
		checkEvery:
			s.checkEvery === "daily" || s.checkEvery === "ask" || s.checkEvery === "6h"
				? s.checkEvery
				: DEFAULT_SETTINGS.checkEvery,
		frame: s.frame === "system" || s.frame === "own" ? s.frame : DEFAULT_SETTINGS.frame,
		buttons:
			s.buttons === "left" || s.buttons === "right" || s.buttons === "auto" ? s.buttons : DEFAULT_SETTINGS.buttons,
		corners: s.corners === "square" || s.corners === "rounded" ? s.corners : DEFAULT_SETTINGS.corners,
	};
}

/** An array, null or a scalar reads as an empty table. The values are not checked against T. */
function obj<T>(v: unknown): Record<string, T> {
	// SAFETY: v is a non-array object; T is the caller's claim about its values, true for the files writeAtomic wrote, unchecked for a hand edit.
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, T>) : {};
}

/** Skips, holds, auto flags and settings, in the state directory beside run.lock rather than with apps.toml. */
const stateFile = (paths: Paths) => join(paths.state, "state.json");

/** Never throws: a missing or unreadable file gives defaults, and an unreadable one is first copied to state.json.unreadable. */
export function loadState(paths: Paths): State {
	let raw: Record<string, unknown> = {};
	const file = stateFile(paths);
	try {
		raw = obj(JSON.parse(readFileSync(file, "utf8")));
	} catch (err) {
		// Absent: defaults. Unreadable: defaults too, but the next write would replace the file, so keep what was there beside it.
		// SAFETY: readFileSync throws an ErrnoException; JSON.parse's SyntaxError has no code, which reads as not ENOENT.
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			try {
				copyFileSync(file, `${file}.unreadable`);
			} catch {
				// nothing to keep, or nowhere to keep it
			}
		}
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

/** A reader sees the old file or the new one, never half. The directory must exist; a crash can leave a .tmp file behind. */
export function writeAtomic(file: string, text: string): void {
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

/** Holds "<pid> <start time>", so a lock left by a dead process can be told from a live one. */
const lockFile = (paths: Paths) => join(paths.state, "run.lock");

/** False when the file already exists. Any other error, a missing directory or a full disk, is thrown. */
function createExclusive(file: string, text: string): boolean {
	try {
		const fd = openSync(file, "wx", 0o644);
		writeFileSync(fd, text);
		closeSync(fd);
		return true;
	} catch (err) {
		// SAFETY: openSync and writeFileSync throw ErrnoException, which carries the code.
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

/** Leaves a lock another process holds. A missing lock is not an error. */
export function releaseLock(paths: Paths, pid = process.pid): void {
	const file = lockFile(paths);
	try {
		if (readFileSync(file, "utf8").split(" ")[0] === String(pid)) rmSync(file, { force: true });
	} catch {
		// not held
	}
}

export type Inflight = {
	key: string;
	dest: string;
	backupVersion: string | null;
	tree?: {
		step: "pause" | "build" | "stopping" | "placing" | "starting" | "verify";
		/** The build step running now, so recovery can end its tree first. */
		build: { pid: number; started: number } | null;
		/** serve entries that were active when the run began, and pause entries that were held. */
		active: string[];
		paused: string[];
	};
};

const TREE_STEPS = new Set(["pause", "build", "stopping", "placing", "starting", "verify"]);
/** An empty array counts. */
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** A marker's tree, only when every field has the right type. */
function treeOf(v: unknown): Inflight["tree"] | undefined {
	const t = obj<unknown>(v);
	if (typeof t.step !== "string" || !TREE_STEPS.has(t.step) || !strings(t.active) || !strings(t.paused))
		return undefined;
	let build: { pid: number; started: number } | null = null;
	if (t.build !== null) {
		const b = obj<unknown>(t.build);
		if (typeof b.pid !== "number" || typeof b.started !== "number") return undefined;
		build = { pid: b.pid, started: b.started };
	}
	// SAFETY: TREE_STEPS holds exactly the names of the step union, and t.step is in it.
	return { step: t.step as NonNullable<Inflight["tree"]>["step"], build, active: t.active, paused: t.paused };
}

/** The marker of an install in progress; recover reads it after a crash. */
const inflightFile = (paths: Paths) => join(paths.state, "inflight.json");

/** Replaces any earlier marker: one install runs at a time. */
export function writeInflight(paths: Paths, inflight: Inflight): void {
	mkdirSync(paths.state, { recursive: true });
	writeAtomic(inflightFile(paths), JSON.stringify(inflight));
}

/** Null when there is no marker or it lacks a string key and dest. A malformed tree is dropped, not the marker. */
export function readInflight(paths: Paths): Inflight | null {
	try {
		const v = obj<unknown>(JSON.parse(readFileSync(inflightFile(paths), "utf8")));
		if (typeof v.key !== "string" || typeof v.dest !== "string") return null;
		const marker: Inflight = {
			key: v.key,
			dest: v.dest,
			backupVersion: typeof v.backupVersion === "string" ? v.backupVersion : null,
		};
		// A tree that does not read cleanly is dropped; the rest of the marker still counts.
		const tree = v.tree === undefined ? undefined : treeOf(v.tree);
		if (tree) marker.tree = tree;
		return marker;
	} catch {
		return null;
	}
}

/** A missing marker is not an error. */
export function clearInflight(paths: Paths): void {
	rmSync(inflightFile(paths), { force: true });
}

/** One JSON row per line, under data, so it outlives a cleared cache. */
const historyFile = (paths: Paths) => join(paths.data, "history.jsonl");

/** True when the file's last byte is not a newline: a write that was cut short by a crash. */
function endsMidLine(file: string): boolean {
	try {
		const text = readFileSync(file);
		return text.length > 0 && text[text.length - 1] !== 0x0a;
	} catch {
		return false;
	}
}

/** Appends whole lines. After a line cut short by a crash it starts on a fresh one, or the next row would be joined to the torn line and lost with it. */
export function appendHistory(paths: Paths, rows: HistoryRow[]): void {
	if (rows.length === 0) return;
	mkdirSync(paths.data, { recursive: true });
	const file = historyFile(paths);
	const lead = endsMidLine(file) ? "\n" : "";
	appendFileSync(file, lead + rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
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
			// SAFETY: appendHistory is the only writer, one HistoryRow per line; a hand-edited row is not checked.
			rows.push(JSON.parse(line) as HistoryRow);
		} catch {
			// a torn last line from a crash
		}
	}
	return rows.toReversed().slice(0, Math.max(0, limit));
}

/** One file per run, named by the run id. */
const logsDir = (paths: Paths) => join(paths.state, "logs");

/** HH:MM:SS in local time. A string that is not a date is returned as given. */
function clock(at: string): string {
	const d = new Date(at);
	if (Number.isNaN(d.getTime())) return at;
	return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** Keeps newlines in the text; the run log writer flattens them, readRunLog relies on one line per entry. */
export function formatLogLine(line: LogLine): string {
	return line.key ? `[${clock(line.at)}] [${line.key}] ${line.text}` : `[${clock(line.at)}] ${line.text}`;
}

export type RunLog = { write(line: LogLine): void; close(): void; file: string };

/** Writes after close() are dropped, not thrown. The file is created by the first write, not here. */
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
export function stageWeights(
	history: HistoryRow[],
	key: string,
	kind: AppKind,
	given?: [Stage, number][],
): { id: Stage; weight: number }[] {
	const defaults = given ?? DEFAULT_WEIGHTS[kind];
	const fallback = defaults.map(([id, weight]) => ({ id, weight }));
	// history is newest first, as readHistory returns it.
	const last = history.find((r) => r.key === key && r.result === "updated");
	if (!last || defaults.length === 0) return fallback;
	const ms = defaults.map(([id]) => last.stages[id]);
	if (!ms.every((v): v is number => typeof v === "number" && v >= 0)) return fallback;
	const times = ms;
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

/** What the last check learned about one app, kept so the next start shows the list at once. */
export type KnownRow = {
	installed: string | null;
	latest: string | null;
	status: "fresh" | "ready" | "problem";
	detail?: string;
	size?: number;
	notes?: string;
	releaseUrl?: string;
	publishedAt?: string;
	/** A built row's newest commits (at most 30) and how far the release is ahead, so the pane has them at start. */
	commits?: { sha: string; title: string }[];
	ahead?: number;
	checkedAt: string;
};

/** The cached commit list, only entries with a sha and a title, at most 30; an empty list reads as none. */
function commitsOf(v: unknown): KnownRow["commits"] {
	if (!Array.isArray(v)) return undefined;
	const out = v
		.filter((c): c is { sha: string; title: string } => typeof c?.sha === "string" && typeof c?.title === "string")
		.slice(0, 30)
		.map((c) => ({ sha: c.sha, title: c.title }));
	return out.length > 0 ? out : undefined;
}

/** Anything that is not a string reads as undefined, so a wrong-typed field is treated as missing. */
const str = (x: unknown) => (typeof x === "string" ? x : undefined);

/** Under cache: losing it only means the next start shows no rows until a check. */
const rowsFile = (paths: Paths) => join(paths.cache, "rows.json");

/** Writes the rows file by rename, so a reader never sees half of it. */
export function saveRows(paths: Paths, rows: Record<string, KnownRow>): void {
	mkdirSync(paths.cache, { recursive: true });
	writeAtomic(rowsFile(paths), JSON.stringify(rows));
}

/** The rows of the last check. A missing or unreadable file is no rows. */
export function loadRows(paths: Paths): Record<string, KnownRow> {
	try {
		const raw = obj<unknown>(JSON.parse(readFileSync(rowsFile(paths), "utf8")));
		const out: Record<string, KnownRow> = {};
		for (const [key, v] of Object.entries(raw)) {
			const r = obj<unknown>(v);
			const status = r.status;
			if (status !== "fresh" && status !== "ready" && status !== "problem") continue;
			out[key] = {
				installed: str(r.installed) ?? null,
				latest: str(r.latest) ?? null,
				status,
				detail: str(r.detail),
				size: typeof r.size === "number" ? r.size : undefined,
				notes: str(r.notes),
				releaseUrl: str(r.releaseUrl),
				publishedAt: str(r.publishedAt),
				checkedAt: str(r.checkedAt) ?? "",
			};
			const commits = commitsOf(r.commits);
			if (commits) out[key].commits = commits;
			if (typeof r.ahead === "number") out[key].ahead = r.ahead;
		}
		return out;
	} catch {
		return {};
	}
}
