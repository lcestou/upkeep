import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AppSpec } from "../../shared/types";
import { compareRefs, fetchRelease, isFailure, latestFromSource, type Release } from "../github";
import { installBuilt } from "./built";
import { dropTree } from "../drop";
import { SUDO_PASSWORD, sudoNeedsPassword } from "../run";
import { clearInflight, writeInflight } from "../store";
import { isNewer } from "../version";
import {
	type Checked,
	fromRelease,
	type KindCtx,
	nonInteractive,
	type Outcome,
	probeProblem,
	readInstalled,
	stageClock,
	type Target,
} from "./context";
import { checkRelease, destOf, probeInstalled } from "./release";

/** A row with check reads its own version (checkBuilt); a clone row without it probes dest, as tmux and cava do. */
export function checkSource(spec: AppSpec, ctx: KindCtx): Promise<Checked | null> {
	return spec.check ? checkBuilt(spec, ctx) : checkRelease(spec, ctx, false);
}

/** Semver order when both sides are semver, so prereleases compare in full; the old script's order otherwise. */
function newer(installed: string | null, latest: string): boolean {
	if (installed === null) return false;
	try {
		return Bun.semver.order(latest, installed) > 0;
	} catch {
		return isNewer(installed, latest);
	}
}

/**
 * A row with check reads its installed version from that argv, on any machine. With commit, it is ready when
 * the release tag is ahead of the installed build's commit on GitHub, and it carries the newest commits.
 */
async function checkBuilt(spec: AppSpec, ctx: KindCtx): Promise<Checked | null> {
	const check = spec.check ?? [];
	const read = await readInstalled(spec, ctx);
	if (!read) {
		ctx.log(`${spec.name} is not installed (${check[0] ?? ""}), skipped.`);
		return null;
	}
	const { probe, installed } = read;
	const opts = {
		cacheDir: join(ctx.paths.cache, "github"),
		token: ctx.token,
		fetch: ctx.fetch,
		onRate: ctx.onRate,
		api: ctx.api,
		installed: installed ?? undefined,
	};
	let latest: string | null;
	let tag: string;
	let release: Release | undefined;
	if (spec.latest) {
		const l = await latestFromSource(spec.latest, opts);
		if (isFailure(l)) return { installed, latest: null, status: "problem", detail: l.detail };
		latest = l.version;
		release = l.release;
		tag = l.release?.tag ?? l.version;
	} else {
		const r = await fetchRelease(spec.repo ?? "", opts);
		if (isFailure(r)) return { installed, latest: null, status: "problem", detail: r.detail };
		release = r;
		tag = r.tag;
		// A dotless tag is not a comparable version, but a commit compare needs none: the row shows the tag.
		latest = r.version ?? (spec.commit ? r.tag : null);
		if (!latest)
			return {
				installed,
				latest: null,
				status: "problem",
				detail: `The latest tag ${r.tag} is not a tracked version.`,
				...fromRelease(r),
			};
	}
	const base = release ? fromRelease(release) : {};
	if (!("version" in probe))
		return { installed, latest, status: "problem", detail: probeProblem(spec.name, check[0] ?? "", probe), ...base };
	const target: Target = { from: installed, version: latest, tag };
	if (!spec.commit) return { installed, latest, status: newer(installed, latest) ? "ready" : "fresh", target, ...base };

	const built = await ctx.run(spec.commit, { timeoutMs: 10_000, merge: true });
	const sha = built.code === 0 ? (built.stdout.trim().split("\n")[0] ?? "") : "";
	if (!sha)
		return {
			installed,
			latest,
			status: "problem",
			detail: "Could not read the commit the installed copy was built from.",
			...base,
		};
	const cmp = await compareRefs(spec.repo ?? "", sha, tag, opts);
	if (isFailure(cmp)) return { installed, latest, status: "problem", detail: cmp.detail, ...base };
	const found = { installed, latest, target, commits: cmp.commits, ahead: cmp.ahead, ...base };
	if (cmp.status === "ahead") return { ...found, status: "ready" };
	if (cmp.status === "diverged")
		return { ...found, status: "ready", detail: "Built from a commit that is not on the release's history." };
	return { ...found, status: "fresh" };
}

/** A release tag or version Upkeep will put into a step: a letter or digit first, then only these characters. */
const PLAIN_REF = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * Clones the release tag and runs the manifest's build steps. There is no restore point: make install writes many files.
 * A checkout or stage row goes to installBuilt, which keeps one. A tag or version that is not a plain version name is
 * refused before any command runs, on both paths.
 */
export async function installSource(spec: AppSpec, target: Target, ctx: KindCtx): Promise<Outcome> {
	// A tag goes into shell steps and git argv as written: refuse shell syntax, and a leading - git would read as an option.
	for (const name of [target.tag, target.version])
		if (!PLAIN_REF.test(name))
			return {
				result: "failed",
				installed: target.from,
				detail: `Refused ${name}: not a plain version name. Nothing was changed.`,
				restartToApply: false,
				stages: {},
			};
	if (spec.dir || spec.stage) return installBuilt(spec, target, ctx);
	const dir = join(ctx.paths.cache, "build", spec.key);
	const clock = stageClock(ctx);
	const failed = (detail: string): Outcome => {
		clearInflight(ctx.paths);
		return { result: "failed", installed: target.from, detail, restartToApply: false, stages: clock.stop() };
	};
	const log = (l: string) => ctx.log(l);

	clock.start("download");
	dropTree(dir, ctx.paths);
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
