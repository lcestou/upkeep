import {
	appendFileSync,
	chmodSync,
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
import { isLanguage } from "../shared/languages";
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
	/** The hash of a version of Upkeep that failed its start test or was rolled back; automatic self-update skips it. "" for none. */
	selfFailed: string;
	/** The hash of the last version of Upkeep the person was told about, so each is announced once. "" for none. */
	selfNotified: string;
	/** What Upkeep last wrote at each app's dest, by key: read back when the program itself names no version. */
	installed: Record<string, Stamp>;
};

/**
 * A version Upkeep installed, with the size, change time and inode its dest had right after: while all three still
 * match, the file is the one Upkeep wrote. An updater that rewrites the file in place with the same size and an old
 * change time would fool it; one that writes a new file never does.
 */
export type Stamp = { version: string; size: number; mtimeMs: number; ino: number };

/** The entries that hold a string version and three numbers; anything else a hand edit left is dropped. */
function stampsOf(v: unknown): Record<string, Stamp> {
	const out: Record<string, Stamp> = {};
	for (const [key, s] of Object.entries(obj<unknown>(v))) {
		const r = obj<unknown>(s);
		if (
			typeof r.version === "string" &&
			typeof r.size === "number" &&
			typeof r.mtimeMs === "number" &&
			typeof r.ino === "number"
		)
			out[key] = { version: r.version, size: r.size, mtimeMs: r.mtimeMs, ino: r.ino };
	}
	return out;
}

export const DEFAULT_SETTINGS: Settings = {
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
};

/** The waits Settings offers, in days. */
const WAITS = [0, 1, 3, 7] as const;

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
		language: s.language === "system" || isLanguage(s.language) ? s.language : DEFAULT_SETTINGS.language,
		selfAuto: typeof s.selfAuto === "boolean" ? s.selfAuto : DEFAULT_SETTINGS.selfAuto,
		upkeepCommand: typeof s.upkeepCommand === "boolean" ? s.upkeepCommand : DEFAULT_SETTINGS.upkeepCommand,
		waitDays: WAITS.find((w) => w === s.waitDays) ?? DEFAULT_SETTINGS.waitDays,
	};
}

/** An array, null or a scalar reads as an empty table. The values are not checked against T. */
function obj<T>(v: unknown): Record<string, T> {
	// SAFETY: v is a non-array object; T is the caller's claim about its values, true for the files writeAtomic wrote, unchecked for a hand edit.
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, T>) : {};
}

/** Skips, holds, auto flags and settings, in the state directory beside run.lock rather than with apps.toml. */
const stateFile = (paths: Paths) => join(paths.state, "state.json");

/**
 * Never throws: a missing or unreadable file gives defaults, and an unreadable one is first copied beside it as
 * state.json.unreadable-<hash of its bytes>. It is read on almost every request, so the same bad file is kept once,
 * and a different bad file never replaces it.
 */
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
				// One read, so the copy holds the very bytes its name was made from, even if the file changes meanwhile.
				const bytes = readFileSync(file);
				const keep = `${file}.unreadable-${new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 12)}`;
				if (!existsSync(keep)) writeFileSync(keep, bytes);
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
		selfFailed: typeof raw.selfFailed === "string" ? raw.selfFailed : "",
		selfNotified: typeof raw.selfNotified === "string" ? raw.selfNotified : "",
		installed: stampsOf(raw.installed),
	};
}

/** A reader sees the old file or the new one, never half. The directory must exist; a crash can leave a .tmp file behind. */
export function writeAtomic(file: string, text: string): void {
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
}

/** How long a writer waits for another's lock, and how old a lock is before it counts as left behind whatever its pid. */
const STATE_LOCK_WAIT_MS = 2000;
const STATE_LOCK_STALE_MS = 10_000;

/** The pid a lock file holds, or null when it is gone or holds none. */
function lockPid(lock: string): number | null {
	try {
		const pid = readFileSync(lock, "utf8").trim();
		return /^\d+$/.test(pid) ? Number(pid) : null;
	} catch {
		return null;
	}
}

/**
 * True when the lock was left behind: its holder's pid has no /proc entry, or the lock is older than
 * STATE_LOCK_STALE_MS whatever its pid. The change it guards takes milliseconds, so a holder that old is gone, and a
 * pid reused since a crash cannot keep a dead lock alive. A lock that vanished is not abandoned: the next try makes one.
 */
function lockAbandoned(lock: string): boolean {
	let age: number;
	try {
		age = Date.now() - statSync(lock).mtimeMs;
	} catch {
		return false;
	}
	const pid = lockPid(lock);
	return age > STATE_LOCK_STALE_MS || (pid !== null && !existsSync(join("/proc", String(pid))));
}

/**
 * Runs fn holding state.json.lock, created exclusively with this process's pid, so the window and the command line
 * never read, change and write the file at the same time and lose each other's change. A lock whose holder died is
 * taken over. When the lock cannot be made at all (a full disk, a read-only folder) or the wait runs out, fn runs
 * anyway: a lost race costs one setting, and a refused write would cost it too. Two processes taking over the same
 * dead holder's lock in the same instant can both run; that needs a crash and a race together.
 */
export function withStateLock<T>(paths: Paths, fn: () => T): T {
	const lock = `${stateFile(paths)}.lock`;
	const until = Date.now() + STATE_LOCK_WAIT_MS;
	let held = false;
	for (;;) {
		try {
			writeFileSync(lock, String(process.pid), { flag: "wx" });
			held = true;
			break;
		} catch (err) {
			// SAFETY: writeFileSync throws an ErrnoException, which carries the code.
			if ((err as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() > until) break;
			if (lockAbandoned(lock))
				try {
					rmSync(lock, { force: true });
				} catch {
					// Not ours to remove (a directory, a permission): go on without the lock.
					break;
				}
			else Bun.sleepSync(10);
		}
	}
	try {
		return fn();
	} finally {
		// Only our own: a lock another process holds now is never removed here.
		if (held && lockPid(lock) === process.pid) rmSync(lock, { force: true });
	}
}

/** Re-reads the file, applies one change, writes it back by rename, under the state lock: the window and the command line may both be running. */
export function updateState(paths: Paths, change: (s: State) => void): State {
	mkdirSync(paths.state, { recursive: true });
	return withStateLock(paths, () => {
		const s = loadState(paths);
		change(s);
		s.settings = clampSettings(s.settings);
		writeAtomic(stateFile(paths), JSON.stringify(s, null, "\t"));
		return s;
	});
}

/** The pasted GitHub token, kept apart from state.json so that an export, a log or an event never carries it. */
const tokenFile = (paths: Paths) => join(paths.state, "github-token");

/** What a GitHub token is made of: letters, digits and underscores (ghp_…, github_pat_…, or 40 hex digits). */
const GITHUB_TOKEN = /^\w{20,255}$/;

/** Whether text is made only of a GitHub token's characters, at a token's length. */
export const isTokenText = (t: string) => GITHUB_TOKEN.test(t);

/** The token pasted in Settings, or null when none is kept or the file no longer holds one. A file others can read is made 0600 first. Never throws. */
export function readToken(paths: Paths): string | null {
	try {
		const file = tokenFile(paths);
		const t = readFileSync(file, "utf8").trim();
		if (!GITHUB_TOKEN.test(t)) return null;
		// A file copied in readable by others is closed to its owner before it is used.
		if (statSync(file).mode & 0o077) chmodSync(file, 0o600);
		return t;
	} catch {
		return null;
	}
}

/**
 * Keeps a token in a file only its owner can read (0600), or deletes the file for null. False, and nothing written, for
 * text that is not a token's shape, so a stray paste never reaches a request header.
 */
export function writeToken(paths: Paths, token: string | null): boolean {
	const file = tokenFile(paths);
	if (token === null) {
		rmSync(file, { force: true });
		return true;
	}
	const t = token.trim();
	if (!GITHUB_TOKEN.test(t)) return false;
	mkdirSync(paths.state, { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	// A fresh file made 0600 as it is written (a crash's leftover goes first); rename keeps the mode.
	rmSync(tmp, { force: true });
	writeFileSync(tmp, t, { mode: 0o600, flag: "wx" });
	renameSync(tmp, file);
	return true;
}

/** Records that file holds version, as Upkeep just wrote it. A file that is not there drops the record instead. */
export function stampInstalled(paths: Paths, key: string, file: string, version: string): void {
	let st: { size: number; mtimeMs: number; ino: number } | null = null;
	try {
		st = statSync(file);
	} catch {
		// nothing there to vouch for
	}
	updateState(paths, (s) => {
		if (st) s.installed[key] = { version, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
		else delete s.installed[key];
	});
}

/** The version recorded for key while file is still the one Upkeep wrote there, else null. A symlink is followed. */
export function stampedVersion(paths: Paths, key: string, file: string): string | null {
	const s = loadState(paths).installed[key];
	if (!s) return null;
	try {
		const st = statSync(file);
		return st.size === s.size && st.mtimeMs === s.mtimeMs && st.ino === s.ino ? s.version : null;
	} catch {
		return null;
	}
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

/**
 * Claims the run lock. A lock whose pid is gone or started at another time is stale and taken over. owner names the
 * holder inside one process: the engine and the System install share a pid, so a pid alone cannot tell whose lock it is.
 */
export function claimLock(paths: Paths, pid = process.pid, procRoot = "/proc", owner = ""): boolean {
	mkdirSync(paths.state, { recursive: true });
	const file = lockFile(paths);
	const mine = `${pid} ${startTime(pid, procRoot) ?? "0"}${owner ? ` ${owner}` : ""}`;
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

/**
 * True while a live process holds the run lock, this one included: an install, a restore, an import or an add is
 * under way somewhere. Reads only; a stale lock (its pid gone or started at another time) reads as not held.
 */
export function lockHeld(paths: Paths, procRoot = "/proc"): boolean {
	let held = "";
	try {
		held = readFileSync(lockFile(paths), "utf8").trim();
	} catch {
		return false;
	}
	const [holder, started] = held.split(" ");
	return holder !== undefined && /^\d+$/.test(holder) && startTime(Number(holder), procRoot) === started;
}

/**
 * Leaves a lock another process holds, and one the same process holds under another owner: a refused System install
 * never frees the engine's lock, nor the engine a System install's. A missing lock is not an error.
 */
export function releaseLock(paths: Paths, pid = process.pid, owner = ""): void {
	const file = lockFile(paths);
	try {
		const [holder, , held = ""] = readFileSync(file, "utf8").trim().split(" ");
		if (holder === String(pid) && held === owner) rmSync(file, { force: true });
	} catch {
		// not held
	}
}

export type Inflight = {
	key: string;
	dest: string;
	backupVersion: string | null;
	/** Every file the install writes beside (an archive's bins), so recovery finds each temp copy even after the app left the list. */
	files?: string[];
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
		// A list with no path left in it says nothing, so recovery falls back to the table.
		const files = Array.isArray(v.files) ? v.files.filter((f): f is string => typeof f === "string") : [];
		if (files.length > 0) marker.files = files;
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
	rpm: [
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
	"claude-plugins": [["install", 100]],
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
				// A row cached before a 0 meant "not listed" would show "0 B" until the next check.
				size: typeof r.size === "number" && r.size > 0 ? r.size : undefined,
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
