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
	const skip = new Set<number>();
	for (let p: number | null = selfPid; p !== null && !skip.has(p); p = parentOf(p, procRoot)) skip.add(p);
	const destReal = spec.dest ? real(spec.dest) : null;
	let entries: string[];
	try {
		entries = readdirSync(procRoot);
	} catch {
		return false;
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
		if (spec.process) {
			try {
				if (readFileSync(join(dir, "comm"), "utf8").trim() === spec.process) return true;
			} catch {
				// gone, or not ours to read
			}
		}
		if (!spec.dest) continue;
		if (destReal && real(join(dir, "exe")) === destReal) return true;
		if (args[0] === spec.dest) return true;
		// An AppImage re-execs from its mount; only its FUSE daemon still carries the image path.
		if (spec.kind === "appimage" && args.some((a) => a === spec.dest)) return true;
	}
	return false;
}
