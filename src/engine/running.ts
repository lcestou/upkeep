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

/**
 * True when the app has a live process. dest must already be expanded.
 * The current process and its ancestors never count: our own command line can name dest.
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
	for (const e of entries) {
		if (!/^\d+$/.test(e) || skip.has(Number(e))) continue;
		const dir = join(procRoot, e);
		if (spec.process) {
			try {
				if (readFileSync(join(dir, "comm"), "utf8").trim() === spec.process) return true;
			} catch {
				// gone, or not ours to read
			}
		}
		if (!spec.dest) continue;
		if (destReal && real(join(dir, "exe")) === destReal) return true;
		let args: string[] = [];
		try {
			args = readFileSync(join(dir, "cmdline"), "utf8").split("\0");
		} catch {
			continue;
		}
		if (args[0] === spec.dest) return true;
		// An AppImage re-execs from its mount; only its FUSE daemon still carries the image path.
		if (spec.kind === "appimage" && args.some((a) => a.includes(spec.dest ?? ""))) return true;
	}
	return false;
}
