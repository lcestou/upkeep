import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Paths, paths } from "./paths";
import { createRunner, type Run, type RunOpts, type ProcessResult } from "./run";

/** A temp home with every Upkeep directory under it. Tests never touch the real one. */
export function tempHome(prefix: string): { dir: string; paths: Paths; cleanup(): void } {
	const dir = mkdtempSync(join(tmpdir(), `upkeep-${prefix}-`));
	const p = paths({
		HOME: join(dir, "home"),
		XDG_CONFIG_HOME: join(dir, "config"),
		XDG_STATE_HOME: join(dir, "state"),
		XDG_DATA_HOME: join(dir, "data"),
		XDG_CACHE_HOME: join(dir, "cache"),
		XDG_RUNTIME_DIR: join(dir, "run"),
	});
	mkdirSync(p.home, { recursive: true });
	return { dir, paths: p, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Writes an executable bash script. */
export function script(file: string, body: string): string {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `#!/bin/bash\n${body}\n`);
	chmodSync(file, 0o755);
	return file;
}

/** A real runner whose PATH holds only the system directories, under a temp home. */
export function realRun(p: Paths, basePath = "/usr/bin:/bin"): Run {
	return createRunner(p.home, join(p.cache, "tmp"), basePath);
}

export type Call = { argv: string[]; opts: RunOpts };

/**
 * A recording runner. Each argv is offered to handle first; returning undefined
 * passes it to the real runner, which tests only use for bash, tar, unzip, install and cp in temp dirs.
 */
export function recordingRun(
	p: Paths,
	handle: (argv: string[], opts: RunOpts) => ProcessResult | undefined | Promise<ProcessResult | undefined>,
): { run: Run; calls: Call[] } {
	const calls: Call[] = [];
	const real = realRun(p);
	const run: Run = Object.assign(
		async (argv: string[], opts: RunOpts = {}) => {
			calls.push({ argv, opts });
			const r = await handle(argv, opts);
			return r ?? real(argv, opts);
		},
		{ start: real.start },
	);
	return { run, calls };
}

export const ok = (stdout = ""): ProcessResult => ({ code: 0, stdout, stderr: "", timedOut: false });

/**
 * A runner that never reaches a real process: every argv must be answered by handle, and any other argv throws.
 * The extras tests use only this one.
 */
export function strictRun(
	handle: (argv: string[], opts: RunOpts) => ProcessResult | undefined | Promise<ProcessResult | undefined>,
): { run: Run; calls: Call[] } {
	const calls: Call[] = [];
	const run: Run = async (argv, opts = {}) => {
		calls.push({ argv, opts });
		const r = await handle(argv, opts);
		if (!r) throw new Error(`strictRun: no answer for ${argv.join(" ")}`);
		return r;
	};
	return { run, calls };
}
