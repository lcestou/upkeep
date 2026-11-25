import { join } from "node:path";
import { MESSAGES } from "../../shared/messages";
import type { AppSpec } from "../../shared/types";
import { isFailure, latestFromSource } from "../github";
import { probeCommand } from "../probe";
import { isNewer } from "../version";
import { fill } from "./tree";
import { prune, restoreBackup, takePoint } from "../backup";
import {
	type Checked,
	cuttableRun,
	fromRelease,
	type KindCtx,
	type Outcome,
	probeProblem,
	stageClock,
	stopPressed,
	stoppedOutcome,
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
 * The tag of version, written the way target's tag is: "v2.1.400" for 2.1.400 gives "v2.1.322" for 2.1.322.
 * A tag that does not hold its version gives the bare version, which is wrong for a tool whose tags carry a prefix.
 */
export function tagOf(target: Pick<Target, "tag" | "version"> | undefined, version: string): string {
	return target?.tag.includes(target.version) ? target.tag.replace(target.version, version) : version;
}

/**
 * Runs the tool's own update command, then checks the version moved. {tag} and {version} in its argv are filled in;
 * it runs without a shell, so a tag can only ever be one argument. With a restore argv in its table, the installed
 * version is a restore point first, and a tool that will not start after the update gets it back. Done asks for a
 * restart only when the table has a restart command or relaunch.
 */
export async function installCommand(spec: AppSpec, target: Target, ctx: KindCtx): Promise<Outcome> {
	const clock = stageClock(ctx);
	let point: string | null = null;
	if (spec.restore?.length && target.from) {
		clock.start("backup");
		const tag = tagOf(target, target.from);
		const command = spec.restore.map((a) => fill(a, { version: target.from ?? "", tag }));
		takePoint(ctx.paths, spec, target.from, { command, tag }, (ctx.now?.() ?? new Date()).toISOString());
		point = target.from;
		ctx.log(`Restore point ${target.from} taken`);
	}
	if (stopPressed(ctx)) return { ...stoppedOutcome(target.from), stages: clock.stop() };
	clock.start("install");
	const update = (spec.update ?? []).map((a) => fill(a, { tag: target.tag, version: target.version }));
	ctx.log(`$ ${update.join(" ")}`);
	// In home, never in whatever folder Upkeep was started from: a tool may write beside where it runs (old line 1725).
	// Cuttable even without a restore command: the person pressed Stop now, and stoppedAfterCut says what is left.
	const r = await ctx.run(update, {
		timeoutMs: 600_000,
		onLine: (l) => ctx.log(l),
		cwd: ctx.paths.home,
		cuttable: true,
	});
	ctx.log(
		r.stopped
			? "The update command was stopped."
			: r.timedOut
				? "The update command ran past 600 s and was stopped."
				: `The update command exited ${r.code}.`,
	);
	if (stopPressed(ctx)) return stoppedAfterCut(spec, target, ctx, point, clock.stop());
	clock.start("verify");
	const after = await probeCommand(spec.check ?? [], { run: cuttableRun(ctx) });
	if (stopPressed(ctx)) return stoppedAfterCut(spec, target, ctx, point, clock.stop());
	const stages = clock.stop();
	if (!("version" in after)) {
		const back = point ? await restoreBackup(ctx.paths, spec, point, ctx.run) : null;
		if (back?.ok)
			return {
				result: "rolled_back",
				installed: point,
				detail: MESSAGES.wouldNotStartRestored(String(point)),
				restartToApply: false,
				stages,
			};
		if (back) ctx.log(`Restore failed: ${back.detail ?? ""}`);
		return {
			result: "failed",
			installed: target.from,
			detail: point
				? MESSAGES.wouldNotStartPutBackFailed(point)
				: spec.restore?.length
					? MESSAGES.wouldNotStartNoVersionKnown()
					: MESSAGES.wouldNotStartNoRestoreCommand(),
			restartToApply: false,
			stages,
		};
	}
	if (after.version === target.from)
		return {
			result: "failed",
			installed: after.version,
			detail: MESSAGES.stillAtAfterCommand(after.version),
			restartToApply: false,
			stages,
		};
	if (point) prune(ctx.paths, spec.key, ctx.settings.keepBackups);
	const detail = after.version !== target.version ? MESSAGES.reportsVersion(after.version) : undefined;
	// Only a table that can restart the tool asks for it; open sessions of one that cannot run on, as its note says.
	const restartToApply = (spec.restart?.length ?? 0) > 0 || spec.relaunch === true;
	return { result: "done", installed: after.version, detail, restartToApply, stages };
}

/**
 * After Stop now cut the update: a restore point goes back; without one the tool's own updater was interrupted, so
 * Upkeep cannot promise the old state and says what a version probe finds instead. Never cut itself: it is the undo.
 */
async function stoppedAfterCut(
	spec: AppSpec,
	target: Target,
	ctx: KindCtx,
	point: string | null,
	stages: Outcome["stages"],
): Promise<Outcome> {
	if (point) {
		const back = await restoreBackup(ctx.paths, spec, point, ctx.run);
		if (back.ok) return { ...stoppedOutcome(point), stages };
		// The restore's own sentence says what went wrong; the update itself was cut, so "would not start" would be wrong.
		return { result: "failed", installed: target.from, detail: back.detail, restartToApply: false, stages };
	}
	const now = await probeCommand(spec.check ?? [], { run: ctx.run });
	if ("version" in now)
		return {
			result: "stopped",
			installed: now.version,
			detail: MESSAGES.stoppedStillAt(spec.name, now.version),
			restartToApply: false,
			stages,
		};
	return {
		result: "stopped",
		installed: target.from,
		detail: MESSAGES.stoppedWontStart(spec.name, probeProblem(spec.name, spec.check?.[0] ?? spec.key, now)),
		restartToApply: false,
		stages,
	};
}
