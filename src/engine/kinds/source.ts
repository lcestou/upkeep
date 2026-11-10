import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AppSpec } from "../../shared/types";
import { SUDO_PASSWORD, sudoNeedsPassword } from "../run";
import { clearInflight, writeInflight } from "../store";
import { type Checked, type KindCtx, type Outcome, stageClock, type Target } from "./context";
import { checkRelease, destOf, probeInstalled } from "./release";

export function checkSource(spec: AppSpec, ctx: KindCtx): Promise<Checked | null> {
	return checkRelease(spec, ctx, false);
}

/** A root step in the manifest must never wait on a password prompt. */
export function nonInteractive(step: string): string {
	return step.replace(/(^|[;&|]\s*)sudo (?!-n )/g, "$1sudo -n ");
}

/** Clones the release tag and runs the manifest's build steps. There is no restore point: make install writes many files. */
export async function installSource(spec: AppSpec, target: Target, ctx: KindCtx): Promise<Outcome> {
	const dir = join(ctx.paths.cache, "build", spec.key);
	const clock = stageClock(ctx);
	const failed = (detail: string): Outcome => {
		clearInflight(ctx.paths);
		return { result: "failed", installed: target.from, detail, restartToApply: false, stages: clock.stop() };
	};
	const log = (l: string) => ctx.log(l);

	clock.start("download");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(join(ctx.paths.cache, "build"), { recursive: true });
	const url = `https://github.com/${spec.repo}.git`;
	ctx.log(`git clone --branch ${target.tag} --depth 1 ${url}`);
	const clone = await ctx.run(["git", "clone", "--branch", target.tag, "--depth", "1", url, dir], {
		timeoutMs: 600_000,
		onLine: log,
	});
	if (clone.code !== 0) return failed(`Could not clone ${spec.repo} at ${target.tag}.`);

	writeInflight(ctx.paths, { key: spec.key, dest: destOf(spec, ctx), backupVersion: null });
	clock.start("install", 0);
	const steps = spec.build ?? [];
	for (const [i, step] of steps.entries()) {
		ctx.stage("install", Math.round((i / steps.length) * 100));
		ctx.log(`$ ${step}`);
		// oxlint-disable-next-line no-await-in-loop -- build steps run in order and stop at the first failure
		const r = await ctx.run(["bash", "-c", nonInteractive(step)], { cwd: dir, timeoutMs: 30 * 60_000, onLine: log });
		if (r.timedOut) return failed(`Build step timed out: ${step}`);
		if (sudoNeedsPassword(r)) return failed(SUDO_PASSWORD);
		if (r.code !== 0) return failed(`Build step failed: ${step}`);
	}

	clock.start("verify");
	const after = await probeInstalled(spec, ctx);
	clearInflight(ctx.paths);
	if ("version" in after) {
		const detail = after.version !== target.version ? `Reports ${after.version}.` : undefined;
		return { result: "done", installed: after.version, detail, restartToApply: false, stages: clock.stop() };
	}
	return failed("Would not start after the update. No restore point for this kind.");
}
