import { spawn } from "node:child_process";
import { MESSAGES } from "../shared/messages";
import type { AppSpec } from "../shared/types";
import { isRunning, topPids } from "./running";
import { type Run, sudoNeedsPassword } from "./run";

export type RestartCtx = {
	run: Run;
	procRoot?: string;
	/** Asks a process to quit. Default SIGTERM, which lets an app save its session; never SIGKILL. */
	signal: (pid: number) => void;
	/** Starts argv on its own, outside Upkeep's process tree, so quitting Upkeep leaves it running. Null once it started, else why not. */
	launch: (argv: string[]) => Promise<string | null>;
	pollMs: number;
	/** How long the closed app gets to exit. Default 15 s. */
	closeMs?: number;
};

/** SIGTERM, the polite ask: the app may still say no. A pid that has already gone is not an error. */
export function terminate(pid: number): void {
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// already gone
	}
}

/**
 * Starts argv detached in a new session with no stdio, and lets it outlive Upkeep. Answers once the process has
 * started (null) or could not be (the reason): a missing or unrunnable file is an error event, never a throw.
 */
export function launchDetached(argv: string[]): Promise<string | null> {
	const [cmd, ...args] = argv;
	if (!cmd) return Promise.resolve(MESSAGES.nothingToStart());
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
		child.once("error", (err) => resolve(err.message));
		child.once("spawn", () => {
			child.unref();
			resolve(null);
		});
	});
}

/**
 * Restarts an app the way its table says. restart: runs that argv (a service's systemctl restart asks for a password
 * through the desktop's own prompt). relaunch: asks each of its processes to quit, waits until none is left, then
 * starts dest (already expanded) again. The processes are found by process name only: an AppImage's own processes
 * run from its mount, the one process that names the image is the mount, and a script's process is its
 * interpreter. An app that will not quit in time is left running and never started a second time.
 */
export async function restartApp(
	spec: AppSpec,
	dest: string,
	ctx: RestartCtx,
): Promise<{ ok: boolean; detail?: string }> {
	if (spec.restart?.length) {
		const r = await ctx.run(spec.restart, { timeoutMs: 120_000 });
		if (sudoNeedsPassword(r)) return { ok: false, detail: MESSAGES.restartSudoPassword(spec.name) };
		return r.code === 0 ? { ok: true } : { ok: false, detail: MESSAGES.commandExited(spec.restart.join(" "), r.code) };
	}
	if (!spec.relaunch || !dest || !spec.process) return { ok: false, detail: MESSAGES.noRestartHow(spec.name) };
	const who = { kind: spec.kind, process: spec.process };
	// Only the top processes: each one's children quit with it.
	for (const pid of topPids(who, ctx.procRoot)) ctx.signal(pid);
	const until = Date.now() + (ctx.closeMs ?? 15_000);
	while (isRunning(who, ctx.procRoot)) {
		if (Date.now() > until) return { ok: false, detail: MESSAGES.didNotClose(spec.name) };
		// oxlint-disable-next-line no-await-in-loop -- polling until the app has quit is the point
		await Bun.sleep(ctx.pollMs);
	}
	const failed = await ctx.launch([dest]);
	return failed ? { ok: false, detail: MESSAGES.closedNotStarted(spec.name, failed) } : { ok: true };
}
