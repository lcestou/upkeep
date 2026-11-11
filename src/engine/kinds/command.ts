import { join } from "node:path";
import type { AppSpec } from "../../shared/types";
import { isFailure, latestFromSource } from "../github";
import { probeCommand } from "../probe";
import { isNewer } from "../version";
import { fill } from "./tree";
import {
	type Checked,
	fromRelease,
	type KindCtx,
	type Outcome,
	probeProblem,
	stageClock,
	type Target,
} from "./context";

/** A tool that updates itself: its own version flag, and the latest from npm, PyPI or GitHub. */
export async function checkCommand(spec: AppSpec, ctx: KindCtx): Promise<Checked | null> {
	const check = spec.check ?? [];
	const probe = await probeCommand(check, { run: ctx.run });
	if ("state" in probe && probe.state === "absent") {
		ctx.log(`${spec.name} is not installed at ${check[0] ?? ""}, skipped.`);
		return null;
	}
	const installed = "version" in probe ? probe.version : null;
	const latest = await latestFromSource(spec.latest ?? "", {
		cacheDir: join(ctx.paths.cache, "github"),
		token: ctx.token,
		fetch: ctx.fetch,
		onRate: ctx.onRate,
		api: ctx.api,
	});
	if (isFailure(latest)) return { installed, latest: null, status: "problem", detail: latest.detail };
	const base = latest.release ? fromRelease(latest.release) : {};
	if (!("version" in probe))
		return {
			installed,
			latest: latest.version,
			status: "problem",
			detail: probeProblem(spec.name, check[0] ?? "", probe),
			...base,
		};
	return {
		installed,
		latest: latest.version,
		status: isNewer(installed, latest.version) ? "ready" : "fresh",
		target: { from: installed, version: latest.version, tag: latest.release?.tag ?? latest.version },
		...base,
	};
}

/**
 * Runs the tool's own update command, then checks the version moved. {tag} and {version} in its argv are filled in;
 * it runs without a shell, so a tag can only ever be one argument.
 */
export async function installCommand(spec: AppSpec, target: Target, ctx: KindCtx): Promise<Outcome> {
	const clock = stageClock(ctx);
	clock.start("install");
	const update = (spec.update ?? []).map((a) => fill(a, { tag: target.tag, version: target.version }));
	ctx.log(`$ ${update.join(" ")}`);
	const r = await ctx.run(update, { timeoutMs: 600_000, onLine: (l) => ctx.log(l) });
	ctx.log(r.timedOut ? "The update command ran past 600 s and was stopped." : `The update command exited ${r.code}.`);
	clock.start("verify");
	const after = await probeCommand(spec.check ?? [], { run: ctx.run });
	const stages = clock.stop();
	if (!("version" in after))
		return {
			result: "failed",
			installed: target.from,
			detail: "Would not start after the update. No restore point for this kind.",
			restartToApply: false,
			stages,
		};
	if (after.version === target.from)
		return {
			result: "failed",
			installed: after.version,
			detail: `Still at ${after.version} after the update command.`,
			restartToApply: false,
			stages,
		};
	const detail = after.version !== target.version ? `Reports ${after.version}.` : undefined;
	return { result: "done", installed: after.version, detail, restartToApply: spec.note !== undefined, stages };
}
