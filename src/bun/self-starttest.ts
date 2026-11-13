import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../engine/paths";
import { testEnv } from "./self-update";

/** The launcher of the build the framework staged for a hash, or null when it is not there. Its folder is named after the app. */
export function stagedLauncher(root: string, hash: string): string | null {
	const stage = join(root, `app.prepared-${hash}`);
	try {
		for (const name of readdirSync(stage)) {
			const launcher = join(stage, name, "bin", "launcher");
			if (existsSync(launcher)) return launcher;
		}
	} catch {
		// no such stage
	}
	return null;
}

export type StartTest = {
	/** The staged build's launcher. */
	launcher: string;
	/** The running Upkeep's environment; only a short list of it is passed on. */
	env: Record<string, string | undefined>;
	/** Where the running Upkeep keeps its files now. Each is copied to the same place under the test's own folders. */
	real: { config: string; state: string };
	/** A folder the temp folder is made in. */
	scratch: string;
	/** How long the build has to answer. */
	timeoutMs: number;
	/** How often the answer file is looked at. */
	pollMs?: number;
};

/**
 * Starts a staged build as a test and gives back what it wrote to its answer file, or null when it wrote nothing in
 * time. The build runs in its own process group with copies of the person's app list, state and extras, its own
 * runtime folder (so it never meets the running Upkeep's socket) and a short environment. Whatever happens, its
 * whole group is ended and the temp folder removed before this returns, so a build that hangs leaves nothing behind.
 * A file the person does not have yet is simply not copied.
 */
export async function runStartTest(t: StartTest): Promise<string | null> {
	mkdirSync(t.scratch, { recursive: true });
	const dir = mkdtempSync(join(t.scratch, "selftest-"));
	const answer = join(dir, "answer");
	const env = testEnv(t.env, dir, answer);
	const to = paths(env);
	for (const folder of [to.config, to.state, to.data, to.cache, join(dir, "run")])
		mkdirSync(folder, { recursive: true });
	for (const [from, dest, name] of [
		[t.real.config, to.config, "apps.toml"],
		[t.real.state, to.state, "state.json"],
		[t.real.state, to.state, "extras.json"],
	] as const)
		if (existsSync(join(from, name))) copyFileSync(join(from, name), join(dest, name));
	let child: ReturnType<typeof Bun.spawn> | null = null;
	try {
		child = Bun.spawn([t.launcher], { env, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		const until = Date.now() + t.timeoutMs;
		while (Date.now() < until) {
			if (existsSync(answer)) {
				const text = readFileSync(answer, "utf8").trim();
				// An empty file is one the build has opened and not yet written.
				if (text) return text;
			}
			// A build that left has said all it will: one last look, then there is nothing more to wait for.
			if (child.exitCode !== null) return existsSync(answer) ? readFileSync(answer, "utf8").trim() || null : null;
			await Bun.sleep(t.pollMs ?? 200);
		}
		return null;
	} catch {
		// The launcher could not be started at all.
		return null;
	} finally {
		if (child) {
			try {
				// The whole group: the launcher, the process it started, and anything that started.
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
		rmSync(dir, { recursive: true, force: true });
	}
}
