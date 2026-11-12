import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AppSpec } from "../shared/types";

/** Reads the parent pid from /proc/<pid>/stat. Null for a gone process or pid 1's parent. */
function parentOf(pid: number, procRoot: string): number | null {
	try {
		const stat = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
		const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
		return ppid > 0 ? ppid : null;
	} catch {
		return null;
	}
}

/**
 * A process's state letter from /proc/<pid>/stat, or null when it is gone. "D" is uninterruptible sleep: a process
 * stuck on a dying FUSE mount, whose cmdline read can block the reader until the mount gives up.
 */
function stateOf(dir: string): string | null {
	try {
		const stat = readFileSync(join(dir, "stat"), "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) || null;
	} catch {
		return null;
	}
}

/** Where /proc/<pid>/exe points, read without following it: a stat into a busy FUSE mount can block. Null when gone. */
function exeOf(dir: string): string | null {
	try {
		return readlinkSync(join(dir, "exe"));
	} catch {
		return null;
	}
}

/** True when the process's command line, its arguments joined by spaces, contains text. Gone or unreadable is false. */
function hasText(dir: string, text: string): boolean {
	try {
		return readFileSync(join(dir, "cmdline"), "utf8").split("\0").join(" ").includes(text);
	} catch {
		return false;
	}
}

/** Null when the path no longer resolves, as a deleted exe link or a vanished process does. */
function real(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

// Our own AppImage probes run the image with one of these; they are never the app.
const PROBE_FLAGS = new Set(["--appimage-mount", "--appimage-extract", "--appimage-version"]);

/**
 * True when the app has a live process. dest must already be expanded.
 * The current process, its ancestors and its descendants never count: our own command line,
 * and the probes we start, can name dest.
 */
export function isRunning(
	spec: Pick<AppSpec, "kind" | "dest" | "process">,
	procRoot = "/proc",
	selfPid = process.pid,
): boolean {
	return matching(spec, procRoot, selfPid, true).length > 0;
}

/** Every pid isRunning would count. */
export function runningPids(
	spec: Pick<AppSpec, "kind" | "dest" | "process">,
	procRoot = "/proc",
	selfPid = process.pid,
): number[] {
	return matching(spec, procRoot, selfPid, false);
}

/**
 * The app's processes whose parent is not one of them: the ones to ask to quit. An Electron app (Cursor) names every
 * renderer as it names itself, and a renderer told to quit before its main process leaves a crash dialog behind.
 */
export function topPids(
	spec: Pick<AppSpec, "kind" | "dest" | "process">,
	procRoot = "/proc",
	selfPid = process.pid,
): number[] {
	const all = matching(spec, procRoot, selfPid, false);
	const set = new Set(all);
	return all.filter((p) => !set.has(parentOf(p, procRoot) ?? 0));
}

/** The pids isRunning counts; first stops at the first one. */
function matching(
	spec: Pick<AppSpec, "kind" | "dest" | "process">,
	procRoot: string,
	selfPid: number,
	first: boolean,
): number[] {
	const found: number[] = [];
	const skip = new Set<number>();
	for (let p: number | null = selfPid; p !== null && !skip.has(p); p = parentOf(p, procRoot)) skip.add(p);
	const destReal = spec.dest ? real(spec.dest) : null;
	let entries: string[];
	try {
		entries = readdirSync(procRoot);
	} catch {
		return found;
	}
	const descends = (pid: number): boolean => {
		const seen = new Set<number>();
		for (let p = parentOf(pid, procRoot); p !== null && !seen.has(p); p = parentOf(p, procRoot)) {
			if (p === selfPid) return true;
			seen.add(p);
		}
		return false;
	};
	for (const e of entries) {
		if (!/^\d+$/.test(e) || skip.has(Number(e)) || descends(Number(e))) continue;
		const dir = join(procRoot, e);
		let args: string[] = [];
		// A process in uninterruptible sleep is matched by name and exe only.
		if (stateOf(dir) !== "D")
			try {
				args = readFileSync(join(dir, "cmdline"), "utf8").split("\0");
			} catch {
				// gone, or not ours to read
			}
		if (args.some((a) => PROBE_FLAGS.has(a))) continue;
		let hit = false;
		if (spec.process) {
			try {
				hit = readFileSync(join(dir, "comm"), "utf8").trim() === spec.process;
			} catch {
				// gone, or not ours to read
			}
		}
		if (!hit && spec.dest) {
			hit =
				(destReal !== null && exeOf(dir) === destReal) ||
				args[0] === spec.dest ||
				// An AppImage re-execs from its mount; only its FUSE daemon still carries the image path.
				(spec.kind === "appimage" && args.some((a) => a === spec.dest));
		}
		if (!hit) continue;
		found.push(Number(e));
		if (first) break;
	}
	return found;
}

/** Clock ticks per second for /proc/<pid>/stat start times; 100 on Linux. */
const TICKS = 100;

/**
 * When the earliest process isRunning would count started, in ms since the epoch, or null when none runs.
 * Field 22 of /proc/<pid>/stat is ticks since boot; /proc/stat's btime is the boot time in seconds.
 */
export function earliestStart(
	spec: Pick<AppSpec, "kind" | "dest" | "process">,
	procRoot = "/proc",
	selfPid = process.pid,
): number | null {
	const pids = matching(spec, procRoot, selfPid, false);
	if (pids.length === 0) return null;
	let boot = 0;
	try {
		boot = Number(/^btime (\d+)$/m.exec(readFileSync(join(procRoot, "stat"), "utf8"))?.[1] ?? 0);
	} catch {
		// no boot time: every start reads as very old, which keeps a reminder rather than dropping it
	}
	let earliest: number | null = null;
	for (const pid of pids) {
		try {
			const stat = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
			const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
			if (!Number.isFinite(ticks)) continue;
			const at = (boot + ticks / TICKS) * 1000;
			if (earliest === null || at < earliest) earliest = at;
		} catch {
			// gone
		}
	}
	return earliest ?? boot * 1000;
}

/**
 * True when a process other than this one and its descendants has text in its command line. A busy entry's
 * process is matched this way: a script path is an argument of its interpreter, not the process name. Ancestors
 * count: an update started from inside the app it replaces must read as busy, or it would swap the tree its own
 * caller runs from.
 */
export function argsRunning(text: string, procRoot = "/proc", selfPid = process.pid): boolean {
	const skip = new Set<number>([selfPid]);
	const later: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(procRoot);
	} catch {
		return false;
	}
	for (const e of entries) {
		if (!/^\d+$/.test(e) || skip.has(Number(e))) continue;
		let ours = false;
		for (let p = parentOf(Number(e), procRoot), n = 0; p !== null && n < 64; p = parentOf(p, procRoot), n++)
			if (p === selfPid) {
				ours = true;
				break;
			}
		if (ours) continue;
		// A process in uninterruptible sleep is looked at again once the rest are read: it is usually out of it by then.
		if (stateOf(join(procRoot, e)) === "D") later.push(e);
		else if (hasText(join(procRoot, e), text)) return true;
	}
	return later.some((e) => stateOf(join(procRoot, e)) !== "D" && hasText(join(procRoot, e), text));
}
