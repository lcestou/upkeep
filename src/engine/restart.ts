import { spawn } from "node:child_process";
import type { AppSpec } from "../shared/types";
import { isRunning, runningPids } from "./running";
import { type Run, sudoNeedsPassword } from "./run";

export type RestartCtx = {
	run: Run;
	procRoot?: string;
	/** Asks a process to quit. Default SIGTERM, which lets an app save its session; never SIGKILL. */
	signal: (pid: number) => void;
	/** Starts argv on its own, outside Upkeep's process tree, so quitting Upkeep leaves it running. */
	launch: (argv: string[]) => void;
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

/** Starts argv detached in a new session with no stdio, and lets it outlive Upkeep. */
export function launchDetached(argv: string[]): void {
	const [cmd, ...args] = argv;
	if (!cmd) return;
	spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

/**
 * Restarts an app the way its table says. restart: runs that argv (a service's systemctl restart asks for a password
 * through the desktop's own prompt). relaunch: asks each of its processes to quit, waits until none is left, then
 * starts dest (already expanded) again. The processes are found by process name when the table gives one: an
 * AppImage's own processes run from its mount, and the one process that names the image is the mount, which must
 * not go first. An app that will not quit in time is left running and never started a second time.
 */
export async function restartApp(
	spec: AppSpec,
	dest: string,
	ctx: RestartCtx,
): Promise<{ ok: boolean; detail?: string }> {
	if (spec.restart?.length) {
		const r = await ctx.run(spec.restart, { timeoutMs: 120_000 });
		if (sudoNeedsPassword(r))
			return { ok: false, detail: `sudo needs a password here. Restart ${spec.name} yourself.` };
		return r.code === 0 ? { ok: true } : { ok: false, detail: `${spec.restart.join(" ")} exited ${r.code}.` };
	}
	if (!spec.relaunch || !dest) return { ok: false, detail: `${spec.name}'s table does not say how to restart it.` };
	const who = spec.process ? { kind: spec.kind, process: spec.process } : { kind: spec.kind, dest };
	for (const pid of runningPids(who, ctx.procRoot)) ctx.signal(pid);
	const until = Date.now() + (ctx.closeMs ?? 15_000);
	while (isRunning(who, ctx.procRoot)) {
		if (Date.now() > until) return { ok: false, detail: `${spec.name} did not close. Close it, then open it again.` };
		// oxlint-disable-next-line no-await-in-loop -- polling until the app has quit is the point
		await Bun.sleep(ctx.pollMs);
	}
	ctx.launch([dest]);
	return { ok: true };
}
