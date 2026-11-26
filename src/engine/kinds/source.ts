import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { MESSAGES } from "../../shared/messages";
import type { AppSpec } from "../../shared/types";
import { cloneUrl, forgeRelease } from "../forge";
import { compareRefs, isFailure, latestFromSource, type Release } from "../github";
import { installBuilt, tagStillAt } from "./built";
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
	stopPressed,
	stoppedOutcome,
	type Target,
} from "./context";
import { checkRelease, destOf, listFailed, passBad, probeInstalled } from "./release";
import { resolvePath } from "./tree";

/**
 * A row with check reads its own version (checkBuilt); a clone row without it probes dest, as tmux and cava do. An
 * update on offer carries the commit its tag points at now, which the build checks again after it fetches.
 */
export async function checkSource(spec: AppSpec, ctx: KindCtx): Promise<Checked | null> {
	const c = spec.check ? await checkBuilt(spec, ctx) : await checkRelease(spec, ctx, false);
	if (c?.status === "ready" && c.target) {
		const commit = await remoteTagCommit(spec, c.target.tag, ctx);
		if (commit) c.target.commit = commit;
	}
	return c;
}

/**
 * The commit tag names on the remote the build will fetch it from: the checkout's origin for a dir row, the repo's
 * clone address for a clone row. Null for a stage row (it builds no checkout), a tag that is not a plain name, or a
 * remote that does not answer; the build then goes on unchecked, as it did before.
 */
async function remoteTagCommit(spec: AppSpec, tag: string, ctx: KindCtx): Promise<string | null> {
	if (!PLAIN_REF.test(tag)) return null;
	const refs = [`refs/tags/${tag}`, `refs/tags/${tag}^{}`];
	const argv = spec.dir
		? ["git", "-C", resolvePath(spec.dir, ctx.paths, null), "ls-remote", "origin", ...refs]
		: !spec.stage && spec.repo
			? ["git", "ls-remote", cloneUrl(spec.repo, spec.forge), ...refs]
			: null;
	if (!argv) return null;
	const r = await ctx.run(argv, { timeoutMs: 30_000 });
	return r.code === 0 ? tagCommitOf(r.stdout, tag) : null;
}

/**
 * The commit of tag in git ls-remote's answer: the peeled ^{} line of an annotated tag, else the tag's own line, which
 * for a lightweight tag is the commit. Null when neither line is there or its hash is not one.
 */
export function tagCommitOf(text: string, tag: string): string | null {
	const lines = text.split("\n").map((l) => l.trim().split(/\s+/));
	const sha = (ref: string) => lines.find(([h, r]) => r === ref && /^[0-9a-f]{40,64}$/.test(h ?? ""))?.[0] ?? null;
	return sha(`refs/tags/${tag}^{}`) ?? sha(`refs/tags/${tag}`);
}

/** Semver order when both sides are semver, so prereleases compare in full; `isNewer`'s number-by-number order otherwise. */
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
		if (isFailure(l))
			return { installed, latest: null, status: "problem", detail: l.detail, offline: l.failure === "network" };
		latest = l.version;
		release = l.release;
		tag = l.release?.tag ?? l.version;
	} else {
		const r = await forgeRelease(spec.repo ?? "", spec.forge, opts);
		if (isFailure(r))
			return { installed, latest: null, status: "problem", detail: r.detail, offline: r.failure === "network" };
		release = r;
		tag = r.tag;
		// A dotless tag is not a comparable version, but a commit compare needs none: the row shows the tag.
		latest = r.version ?? (spec.commit ? r.tag : null);
		if (!latest)
			return {
				installed,
				latest: null,
				status: "problem",
				detail: MESSAGES.latestTagNotTracked(r.tag),
				...fromRelease(r),
			};
	}
	// Only the list the version came from may stand in for it: with latest naming another source, repo's releases may not.
	const passed = await passBad(spec.latest ? { ...spec, repo: undefined } : spec, ctx, { tag, version: latest }, false);
	if (passed && isFailure(passed)) return listFailed(installed, passed);
	const avoided = passed === undefined ? {} : { detail: MESSAGES.badVersionPassed(latest, spec.bad_reason ?? "") };
	// Nothing else to offer: the row rests at the build it has, saying why.
	if (passed === null)
		return { installed, latest: installed, status: installed === null ? "problem" : "fresh", ...avoided };
	if (passed) {
		release = passed;
		tag = passed.tag;
		latest = passed.version ?? passed.tag;
	}
	const base = release ? fromRelease(release) : {};
	if (!("version" in probe))
		return { installed, latest, status: "problem", detail: probeProblem(spec.name, check[0] ?? "", probe), ...base };
	const target: Target = { from: installed, version: latest, tag };
	if (!spec.commit)
		return { installed, latest, status: newer(installed, latest) ? "ready" : "fresh", target, ...avoided, ...base };

	const built = await ctx.run(spec.commit, { timeoutMs: 10_000, merge: true });
	const sha = built.code === 0 ? (built.stdout.trim().split("\n")[0] ?? "") : "";
	if (!sha)
		return {
			installed,
			latest,
			status: "problem",
			detail: MESSAGES.couldNotReadCommit(),
			...base,
		};
	const cmp = await compareRefs(spec.repo ?? "", sha, tag, opts);
	if (isFailure(cmp)) return { installed, latest, status: "problem", detail: cmp.detail, ...base };
	const found = { installed, latest, target, commits: cmp.commits, ahead: cmp.ahead, ...avoided, ...base };
	if (cmp.status === "ahead") return { ...found, status: "ready" };
	if (cmp.status === "diverged") return { ...found, status: "ready", detail: MESSAGES.divergedCommit() };
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
				detail: MESSAGES.refusedTag(name),
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
	const url = cloneUrl(spec.repo ?? "", spec.forge);
	ctx.log(`git clone --branch ${target.tag} --depth 1 ${url}`);
	const clone = await ctx.run(["git", "clone", "--branch", target.tag, "--depth", "1", url, dir], {
		timeoutMs: 600_000,
		onLine: log,
		cuttable: true,
	});
	// Stop now before the build changes anything. Once it starts, every step is waited out: there is no restore point.
	if (stopPressed(ctx)) return { ...stoppedOutcome(target.from), stages: clock.stop() };
	if (clone.code !== 0) return failed(MESSAGES.couldNotClone(String(spec.repo), target.tag));
	const moved = await tagStillAt(target, dir, "HEAD", ctx);
	if (moved) return failed(moved);

	writeInflight(ctx.paths, { key: spec.key, dest: destOf(spec, ctx), backupVersion: null });
	clock.start("install", 0);
	const steps = spec.build ?? [];
	for (const [i, step] of steps.entries()) {
		ctx.stage("install", Math.round((i / steps.length) * 100));
		ctx.log(`$ ${step}`);
		// oxlint-disable-next-line no-await-in-loop -- build steps run in order and stop at the first failure
		const r = await ctx.run(["bash", "-c", nonInteractive(step)], { cwd: dir, timeoutMs: 30 * 60_000, onLine: log });
		if (r.timedOut) return failed(MESSAGES.buildStepTimedOut(step));
		if (sudoNeedsPassword(r)) return failed(SUDO_PASSWORD);
		if (r.code !== 0) return failed(MESSAGES.buildStepFailedClone(step));
	}

	clock.start("verify");
	const after = await probeInstalled(spec, ctx);
	clearInflight(ctx.paths);
	if ("version" in after) {
		const detail = after.version !== target.version ? MESSAGES.reportsVersion(after.version) : undefined;
		return { result: "done", installed: after.version, detail, restartToApply: false, stages: clock.stop() };
	}
	return failed(MESSAGES.wouldNotStartNoPointKind());
}
