import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AppSpec } from "../shared/types";

function parentOf(pid: number, procRoot: string): number | null {
	try {
		const stat = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
		const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
		return ppid > 0 ? ppid : null;
	} catch {
		return null;
	}
}

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
				(destReal !== null && real(join(dir, "exe")) === destReal) ||
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
