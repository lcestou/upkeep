import { existsSync, lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MESSAGES } from "../../shared/messages";
import type { AppSpec, Serve, Service, Test } from "../../shared/types";
import { listBackups, prune, readMeta } from "../backup";
import { isRecord } from "../manifest";
import { dropTree } from "../drop";
import { stripEscapes } from "../probe";
import { asRootArgv, installAside, type Run, type RunOpts } from "../run";
import { argsRunning } from "../running";
import { clearInflight, type Inflight, readInflight, startTime, writeInflight } from "../store";
import {
	type KindCtx,
	nonInteractive,
	type Outcome,
	REASON_UNRECOVERED,
	readInstalled,
	stageClock,
	type Target,
} from "./context";
import {
	expandGlob,
	fill,
	inScope,
	notePlaced,
	pointOf,
	resolvePath,
	restoreTree,
	revertFiles,
	safePath,
	scopeOf,
	takeTree,
	type Tree,
	type TreeCtx,
	type Vars,
} from "./tree";

export const SUDO_REFUSED = MESSAGES.sudoRefused();

const LONG = 30 * 60_000;
const SERVICE_MS = 120_000;
/** The first line of s after trimming, or an empty string; the short form of a failed command's output for an error message. */
const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

/**
 * What a failed check_built step tells the row: the last line it printed, stdout or stderr in the order they came
 * (a check's own reason, or the error of the command that failed), without terminal colour codes and without the dots
 * it ends on, since the sentence adds its own full stop. A step that printed nothing but dots or nothing at all, or
 * that ran out of time (its last line may be cut), is named by its text. Each line was already logged as it came.
 */
const checkReason = (last: string, step: string) => stripEscapes(last).trim().replace(/\.+$/, "").trim() || step;

type Step = Inflight["tree"] extends infer T ? (T extends { step: infer S } ? S : never) : never;

/**
 * The in-flight marker of one built update. Every pid a step reports lands in it at once. Its first write throws
 * REASON_UNRECOVERED when another app's kept marker is there, so one app never erases another's only record.
 */
export function markerOf(spec: AppSpec, ctx: KindCtx, dest: string) {
	const procRoot = ctx.procRoot ?? "/proc";
	const state: NonNullable<Inflight["tree"]> = { step: "pause", build: null, active: [], paused: [] };
	let backupVersion: string | null = null;
	let first = true;
	const write = () => {
		if (first) {
			// Another app's kept marker is the only record of its half-put-back tree: never write over it.
			const prior = readInflight(ctx.paths);
			if (prior?.tree && prior.key !== spec.key) throw new Error(REASON_UNRECOVERED);
			first = false;
		}
		writeInflight(ctx.paths, { key: spec.key, dest, backupVersion, tree: { ...state } });
	};
	return {
		state,
		step(step: Step) {
			state.step = step;
			write();
		},
		point(version: string) {
			backupVersion = version;
			write();
		},
		paused(name: string) {
			state.paused.push(name);
			write();
		},
		active(names: string[]) {
			state.active = names;
			write();
		},
		/**
		 * For RunOpts.onStart: the step's pid and its start time, so recovery ends this exact process. A child that
		 * already exited has no start time and is not recorded: a pid with a start time of 0 could match nothing real.
		 */
		onStart: (pid: number) => {
			const started = Number(startTime(pid, procRoot) ?? Number.NaN);
			if (!Number.isFinite(started)) return;
			state.build = { pid, started };
			write();
		},
		/** The step that reported a pid has ended. */
		done() {
			if (state.build === null) return;
			state.build = null;
			write();
		},
		clear: () => clearInflight(ctx.paths),
	};
}
export type Marker = ReturnType<typeof markerOf>;

/** Runs argv with the step's pid going to the marker, and clears it after. */
async function tracked(run: Run, marker: Marker, argv: string[], opts: RunOpts) {
	try {
		return await run(argv, { ...opts, onStart: marker.onStart });
	} finally {
		marker.done();
	}
}

/** Whether the unit runs now: its active argv exits 0. A unit stuck stopping reads as down, which is what a stop wants. */
export async function isActive(run: Run, svc: Service): Promise<boolean> {
	return (await run(asRootArgv(svc.active), { timeoutMs: 30_000 })).code === 0;
}

/** Stops a unit. A stop that fails or runs out counts when the unit is down after it. */
export async function stopService(run: Run, svc: Service): Promise<boolean> {
	const r = await run(asRootArgv(svc.stop), { timeoutMs: SERVICE_MS, killTree: true });
	return r.code === 0 || !(await isActive(run, svc));
}

/** Starts a unit. A start that fails or runs out counts when the unit is up after it. */
export async function startService(run: Run, svc: Service & { start: string[] }): Promise<boolean> {
	const r = await run(asRootArgv(svc.start), { timeoutMs: SERVICE_MS, killTree: true });
	return r.code === 0 || (await isActive(run, svc));
}

/**
 * Every argv of the table that starts with sudo, roughly in the order an update runs them, checked with sudo -n -l
 * before anything changes. Placeholders are not filled here, so a sudoers rule that names exact arguments will not
 * match an argv that carries one. sudo inside a step's shell text is not seen; nonInteractive gives it -n instead.
 */
export function rootArgvs(spec: AppSpec): string[][] {
	const services = [...(spec.pause ?? []), ...(spec.serve ?? [])];
	const tests = [...(spec.serve ?? []).flatMap((s) => s.test ?? []), ...(spec.test ?? [])];
	const argvs = [
		...(spec.busy ?? []).map((b) => b.run),
		...services.flatMap((s) => [s.active, s.stop, s.start, s.since]),
		...(spec.record ?? []).map((r) => r.run),
		spec.needs,
		...tests.map((t) => t.run),
		spec.check,
		spec.commit,
	];
	return argvs.filter((a): a is string[] => a?.[0] === "sudo");
}

/** Whether sudo -n -l allows every root argv of the table, checked in table order before anything changes. */
async function sudoAllowed(spec: AppSpec, ctx: KindCtx): Promise<boolean> {
	for (const argv of rootArgvs(spec)) {
		const rest = argv[1] === "-n" ? argv.slice(2) : argv.slice(1);
		// oxlint-disable-next-line no-await-in-loop -- one check per command
		if ((await ctx.run(["sudo", "-n", "-l", ...rest], { timeoutMs: 30_000 })).code !== 0) return false;
	}
	return true;
}

/** The first busy entry that holds right now, as its say text, or null. */
async function busyNow(spec: AppSpec, ctx: KindCtx, stopped: boolean): Promise<string | null> {
	for (const b of spec.busy ?? []) {
		if ((b.when === "stopped") !== stopped) continue;
		if (b.process && argsRunning(b.process, ctx.procRoot ?? "/proc")) return b.say;
		// oxlint-disable-next-line no-await-in-loop -- busy entries are checked in order
		if (b.run && (await ctx.run(b.run, { timeoutMs: 30_000 })).code === 0) return b.say;
	}
	return null;
}

/**
 * Writes each config value into the JSON files it names; the file's other keys are written back untouched. Symlinks
 * are skipped. A pattern that names no file but links throws before anything is written. A file that is not JSON, or
 * holds something other than an object, throws before that file is written; files of earlier entries are written by then.
 */
function applyConfig(spec: AppSpec, ctx: KindCtx, dir: string | null): void {
	const each = (spec.config ?? []).map((c) => ({
		c,
		files: expandGlob(c.file, ctx.paths, dir).filter((f) => !lstatSync(f).isSymbolicLink()),
	}));
	// A value written nowhere is a setting lost without a word, as when an upstream moves its config files.
	const none = each.find((e) => e.files.length === 0);
	if (none) throw new Error(`${none.c.file} matches no config file.`);
	for (const { c, files } of each) {
		for (const file of files) {
			const json: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (!isRecord(json)) throw new Error(`${file} does not hold a JSON object.`);
			if (c.key) json[c.key] = c.value;
			else if (c.array && c.flag) {
				const held = json[c.array];
				const arr: unknown[] = Array.isArray(held) ? held : [];
				const at = arr.indexOf(c.flag);
				if (at >= 0 && at + 1 < arr.length) arr[at + 1] = c.value;
				else arr.push(c.flag, c.value);
				json[c.array] = arr;
			}
			const tmp = `${file}.upkeep-tmp`;
			writeFileSync(tmp, `${JSON.stringify(json, null, 2)}\n`);
			renameSync(tmp, file);
		}
	}
}

/**
 * The stage, resolved and checked, after checking every place path: a stage may not be the home directory, dir or
 * a live place target (or above one), and a place may not take a directory above home or dir. Throws the refusal.
 */
function placePaths(spec: AppSpec, ctx: KindCtx, dir: string | null, vars: Vars): string | null {
	const at = (p: string, v: Vars) => resolvePath(fill(p, v), ctx.paths, dir);
	const tos = (spec.place ?? []).map((pl) => at(pl.to, vars));
	const stage = spec.stage ? safePath(at(spec.stage, vars), ctx.paths, { dir, not: tos }) : null;
	const v = { ...vars };
	if (stage) v.stage = stage;
	for (const pl of spec.place ?? []) placeFromTo(pl, ctx, dir, stage, v);
	return stage;
}

/**
 * One place entry's from (inside the stage or dir) and to, resolved and checked; throws the refusal. A to may not be
 * a folder directly in home, nor Upkeep's own config, data, state or cache directory or anything above one.
 */
function placeFromTo(
	pl: { from: string; to: string },
	ctx: KindCtx,
	dir: string | null,
	stage: string | null,
	vars: Vars,
) {
	const at = (p: string) => resolvePath(fill(p, vars), ctx.paths, dir);
	const roots = [stage, dir].filter((r): r is string => r !== null);
	const { config, data, state, cache, home } = ctx.paths;
	const to = safePath(at(pl.to), ctx.paths, { dir, not: [config, data, state, cache] });
	// A place target is moved whole into the restore point and pruned with it later: never a folder of home itself.
	if (dirname(to) === home) throw new Error(MESSAGES.placeTargetInHome(to));
	return { src: safePath(at(pl.from), ctx.paths, { dir, under: roots }), to };
}

/** What a build that passed every check hands to the install stage. */
export type Built = {
	dir: string | null;
	stage: string | null;
	point: string;
	tree: Tree;
	vars: Vars;
	/** serve entries that were running, with what since printed before the stop. */
	active: { svc: Serve; since: string }[];
	paused: Service[];
	marker: Marker;
	treeCtx: TreeCtx;
};

type Failed = { failed: string; cleanup?: "pause" | "revert" };

/**
 * Download, backup and build, in the plan's fixed order. Nothing in serve is stopped here, so any failure
 * leaves the running version untouched: the files are reverted and the paused units started again.
 */
export async function prepareBuilt(
	spec: AppSpec,
	target: Target,
	ctx: KindCtx,
	clock: { start(stage: "download" | "backup" | "build"): void },
): Promise<Built | { failed: string }> {
	const dir = spec.dir ? resolvePath(spec.dir, ctx.paths, null) : null;
	const shown = spec.dir ?? "";
	const vars: Vars = { tag: target.tag, version: target.version };
	// Every path the table removes or replaces is checked before the first command runs.
	let stage: string | null;
	try {
		stage = placePaths(spec, ctx, dir, vars);
	} catch (err) {
		return { failed: MESSAGES.refusedNothingChanged(err instanceof Error ? err.message : String(err)) };
	}
	if (stage) vars.stage = stage;
	const scope = scopeOf(dir, stage);
	const marker = markerOf(spec, ctx, dir ?? stage ?? "");
	const paused: Service[] = [];
	const treeCtx: TreeCtx = {
		paths: ctx.paths,
		run: ctx.run,
		log: ctx.log,
		onStart: marker.onStart,
		rename: ctx.rename,
	};
	let point: string | null = null;

	const startPaused = async () => {
		for (const p of paused.toReversed()) {
			if (!p.start) continue;
			// oxlint-disable-next-line no-await-in-loop -- in reverse order of the stops
			if (!(await startService(ctx.run, { ...p, start: p.start }))) ctx.log(`Could not start ${p.name} again.`);
		}
	};
	const fail = async (f: Failed): Promise<{ failed: string }> => {
		if (f.cleanup === "revert" && point) {
			try {
				await revertFiles(point, treeCtx);
			} catch (err) {
				ctx.log(`Putting the files back failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			if (stage) dropTree(stage, ctx.paths);
		}
		await startPaused();
		marker.clear();
		return { failed: f.failed };
	};

	clock.start("download");
	if (!(await sudoAllowed(spec, ctx))) return { failed: SUDO_REFUSED };
	const first = await busyNow(spec, ctx, false);
	if (first) return { failed: MESSAGES.busySayNothingChanged(first) };
	// The marker exists before the first pause stop, so a kill from here on is recovered.
	marker.step("pause");
	for (const p of spec.pause ?? []) {
		// oxlint-disable-next-line no-await-in-loop -- units are held off in table order
		if (!(await isActive(ctx.run, p))) continue;
		// Written before the stop: a kill during or right after it must still find the unit to start again.
		marker.paused(p.name);
		// oxlint-disable-next-line no-await-in-loop -- units are held off in table order
		if (!(await stopService(ctx.run, p))) return fail({ failed: MESSAGES.couldNotStopUnit(p.name) });
		paused.push(p);
	}
	const second = await busyNow(spec, ctx, false);
	if (second) return fail({ failed: MESSAGES.busySayNothingChanged(second) });
	if (dir) {
		const status = await ctx.run(["git", "-C", dir, "status", "--porcelain", "--untracked-files=no"], {
			timeoutMs: 60_000,
		});
		if (status.code !== 0 || status.stdout.trim()) return fail({ failed: MESSAGES.localChanges(shown) });
		const fetched = await tracked(
			ctx.run,
			marker,
			["git", "-C", dir, "fetch", "--no-tags", "origin", "tag", target.tag],
			{
				timeoutMs: 600_000,
				killTree: true,
			},
		);
		if (fetched.code !== 0) return fail({ failed: MESSAGES.couldNotFetchTag(target.tag, shown) });
		// A reset drops every commit the tag does not hold. HEAD inside the tag just fetched loses nothing; else it
		// must be on a remote branch. The branch test alone failed after a reset to a tag newer than the last
		// branch fetch, since the fetch above brings the tag only and origin/<branch> stays where it was.
		if (spec.move === "reset") {
			const inTag = await ctx.run(["git", "-C", dir, "merge-base", "--is-ancestor", "HEAD", target.tag], {
				timeoutMs: 60_000,
			});
			const on =
				inTag.code === 0
					? null
					: await ctx.run(["git", "-C", dir, "branch", "-r", "--contains", "HEAD"], { timeoutMs: 60_000 });
			if (on && (on.code !== 0 || !on.stdout.trim())) return fail({ failed: MESSAGES.commitsNotOnGithub(shown) });
		}
	}

	clock.start("backup");
	const active: { svc: Serve; since: string }[] = [];
	for (const s of spec.serve ?? []) {
		// oxlint-disable-next-line no-await-in-loop -- one unit at a time, in table order
		if (!(await isActive(ctx.run, s))) continue;
		// oxlint-disable-next-line no-await-in-loop -- one unit at a time, in table order
		const since = s.since ? (await ctx.run(asRootArgv(s.since), { timeoutMs: 30_000 })).stdout.trim() : "";
		active.push({ svc: s, since });
	}
	let tree: Tree;
	try {
		const at = (ctx.now?.() ?? new Date()).toISOString();
		const taken = await takeTree(spec, treeCtx, { version: target.from ?? "unknown", at, vars });
		point = taken.point;
		tree = taken.tree;
	} catch (err) {
		marker.done();
		return fail({
			failed: MESSAGES.couldNotTakePoint(err instanceof Error ? err.message : String(err)),
		});
	}
	vars.needs = tree.needs[0] ?? "";
	marker.point(target.from ?? "unknown");
	marker.active(active.map((a) => a.svc.name));
	marker.step("build");

	clock.start("build");
	for (const h of spec.hold ?? []) {
		let p = "";
		// The running process keeps its open files under the .upkeep-live name; the build writes a copy.
		try {
			p = inScope(resolvePath(h, ctx.paths, dir), ctx.paths, dir, scope);
			// Nothing runs from a path that is not there: a table may name the old and the new place of a tree.
			if (!existsSync(p)) {
				ctx.log(`hold ${h}: not there, so nothing runs from it.`);
				continue;
			}
			renameSync(p, `${p}.upkeep-live`);
		} catch (err) {
			ctx.log(`hold ${h}: ${err instanceof Error ? err.message : String(err)}`);
			return fail({ failed: MESSAGES.holdStepFailed(h), cleanup: "revert" });
		}
		// oxlint-disable-next-line no-await-in-loop -- one tree at a time
		const r = await tracked(ctx.run, marker, ["cp", "-a", `${p}.upkeep-live`, p], { timeoutMs: LONG, killTree: true });
		if (r.code !== 0) return fail({ failed: MESSAGES.holdStepFailed(h), cleanup: "revert" });
	}
	if (dir) {
		const move = spec.move ?? "ff";
		const argv =
			move === "reset"
				? ["git", "-C", dir, "reset", "-q", "--hard", target.tag]
				: move === "detach"
					? ["git", "-C", dir, "checkout", "-q", "--detach", target.tag]
					: ["git", "-C", dir, "merge", "-q", "--ff-only", target.tag];
		const moved = await tracked(ctx.run, marker, argv, { timeoutMs: 120_000, killTree: true });
		if (moved.code !== 0)
			return fail({
				failed: MESSAGES.cannotMoveWithoutMerge(shown, target.tag),
				cleanup: "revert",
			});
	}
	if (stage) dropTree(stage, ctx.paths);
	// Steps run in dir; a stage-only table runs them in the home directory, since the stage is theirs to create.
	const cwd = dir ?? ctx.paths.home;
	for (const step of spec.build ?? []) {
		// oxlint-disable-next-line no-await-in-loop -- build steps run in order
		const r = await tracked(ctx.run, marker, ["bash", "-c", nonInteractive(fill(step, vars))], {
			cwd,
			timeoutMs: LONG,
			killTree: true,
			onLine: (l) => ctx.log(l),
		});
		if (r.code !== 0) return fail({ failed: MESSAGES.buildStepFailed(step), cleanup: "revert" });
	}
	try {
		applyConfig(spec, ctx, dir);
	} catch (err) {
		ctx.log(`config: ${err instanceof Error ? err.message : String(err)}`);
		return fail({ failed: MESSAGES.checkFailedConfig(), cleanup: "revert" });
	}
	for (const step of spec.check_built ?? []) {
		let last = "";
		// oxlint-disable-next-line no-await-in-loop -- checks run in order
		const r = await tracked(ctx.run, marker, ["bash", "-c", nonInteractive(fill(step, vars))], {
			cwd,
			timeoutMs: LONG,
			killTree: true,
			onLine: (l) => {
				ctx.log(l);
				if (l.trim()) last = l;
			},
		});
		if (r.code !== 0)
			return fail({ failed: MESSAGES.checkFailedStep(checkReason(r.timedOut ? "" : last, step)), cleanup: "revert" });
	}
	return { dir, stage, point, tree, vars, active, paused, marker, treeCtx };
}

/** What installBuilt (chunk 7) returns when a prepared build fails before anything is stopped. */
export const failedBefore = (target: Target, detail: string): Omit<Outcome, "stages"> => ({
	result: "failed",
	installed: target.from,
	detail,
	restartToApply: false,
});

/** The probe's name when the version did not move. */
const VERSION_CHECK = MESSAGES.versionCheckLabel();

/**
 * Polls health every 2 s until it answers status (default 200) with expect matching, within wait_s (default 120).
 * It gives up early on a unit that is not coming up: since moved again (it restarted on its own, a crash loop), or
 * active failed on two polls in a row (it died, or waits out a restart delay). Both rest on start returning once the
 * unit is up, as systemctl start does for every unit type; a start that returns sooner (systemctl --no-block on a
 * Type=notify unit, or an active check that fails while the program loads) would be cut short and rolled back.
 */
async function healthy(svc: Serve, ctx: KindCtx): Promise<boolean> {
	if (!svc.health) return true;
	const until = Date.now() + (svc.wait_s ?? 120) * 1000;
	const want = svc.status ?? 200;
	const started = await sinceOf(ctx, svc);
	let down = 0;
	for (;;) {
		try {
			// oxlint-disable-next-line no-await-in-loop -- polling until it answers or the time is up
			const res = await ctx.fetch(svc.health, { signal: AbortSignal.timeout(10_000) });
			// oxlint-disable-next-line no-await-in-loop -- the body of this one answer
			const body = await res.text();
			if (res.status === want && (!svc.expect || new RegExp(svc.expect).test(body))) return true;
		} catch {
			// not up yet
		}
		// oxlint-disable-next-line no-await-in-loop -- read between two polls
		if (svc.since && (await sinceOf(ctx, svc)) !== started) {
			ctx.log(`${svc.name} restarted on its own before it answered: it is crashing.`);
			return false;
		}
		// oxlint-disable-next-line no-await-in-loop -- read between two polls
		down = (await isActive(ctx.run, svc)) ? 0 : down + 1;
		if (down >= 2) {
			ctx.log(`${svc.name} is not running, so it will not answer.`);
			return false;
		}
		if (Date.now() >= until) return false;
		// oxlint-disable-next-line no-await-in-loop -- polling every 2 s
		await Bun.sleep(Math.min(2000, Math.max(0, until - Date.now())));
	}
}

/** One test: a command (exit 0, expect matched, fail_on not) or a POST (2xx, expect matched, fail_on not). */
async function passes(test: Test, ctx: KindCtx, built: Built): Promise<boolean> {
	const timeoutMs = (test.timeout_s ?? 600) * 1000;
	let text = "";
	if (test.run) {
		const r = await tracked(
			ctx.run,
			built.marker,
			test.run.map((a) => fill(a, built.vars)),
			{
				cwd: built.dir ?? ctx.paths.home,
				timeoutMs,
				killTree: true,
				merge: true,
			},
		);
		if (r.code !== 0) return false;
		text = r.stdout;
	} else if (test.url) {
		try {
			const res = await ctx.fetch(test.url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: test.body,
				signal: AbortSignal.timeout(timeoutMs),
			});
			text = await res.text();
			if (!res.ok) return false;
		} catch {
			return false;
		}
	}
	if (test.expect && !new RegExp(test.expect).test(text)) return false;
	if (test.fail_on && new RegExp(test.fail_on).test(text)) return false;
	return true;
}

/**
 * Deletes each held old tree. It is renamed to .upkeep-gone first, so a cut delete never leaves a half tree under the
 * .upkeep-live name a put-back would rename in.
 */
function dropHeld(spec: AppSpec, ctx: KindCtx, dir: string | null): void {
	for (const h of spec.hold ?? []) {
		const p = resolvePath(h, ctx.paths, dir);
		if (existsSync(`${p}.upkeep-live`)) renameSync(`${p}.upkeep-live`, `${p}.upkeep-gone`);
		dropTree(`${p}.upkeep-gone`, ctx.paths);
	}
}

/** The name a test is reported under: its own name, else its url, else its command, else a generic label. */
const testName = (t: Test) => t.name ?? t.url ?? t.run?.[0] ?? MESSAGES.aTestLabel();

/**
 * After a verified update: build directories prune names, except what needs prints now (live) and what any kept
 * restore point names. Skipped, with a log line, when needs fails, prints nothing or names a missing directory:
 * deleting the live build would be far worse than leaving old ones.
 */
async function pruneBuilds(spec: AppSpec, ctx: KindCtx, built: Built): Promise<void> {
	if (!spec.prune?.length) return;
	if (!spec.needs) {
		ctx.log("Not pruning: the table has no needs to say what is live.");
		return;
	}
	const r = await ctx.run(spec.needs, { timeoutMs: 60_000 });
	const live =
		r.code === 0
			? r.stdout
					.split("\n")
					.map((l) => l.trim())
					.filter(Boolean)
			: [];
	if (live.length === 0 || live.some((d) => !existsSync(d))) {
		ctx.log("Not pruning: needs did not name a live build directory.");
		return;
	}
	const kept = new Set(live);
	for (const p of listBackups(ctx.paths, spec.key))
		for (const d of readMeta(pointOf(ctx.paths, spec.key, p.version))?.tree?.needs ?? []) kept.add(d);
	const scope = scopeOf(built.dir, built.stage);
	for (const pattern of spec.prune)
		for (const d of expandGlob(pattern, ctx.paths, built.dir)) {
			try {
				inScope(d, ctx.paths, built.dir, scope);
			} catch (err) {
				ctx.log(`Not pruning: ${err instanceof Error ? err.message : String(err)}`);
				continue;
			}
			if (kept.has(d) || !lstatSync(d).isDirectory()) continue;
			ctx.log(`Pruned ${d}`);
			dropTree(d, ctx.paths);
		}
}

/**
 * Installs a built app from a checkout or a stage: prepareBuilt, then stop, place, start, verify. A failure
 * after the first stop puts the restore point back and starts the old version; when that start fails too, every
 * unit that was running is started anyway and the row says the putting back failed.
 */
export async function installBuilt(spec: AppSpec, target: Target, ctx: KindCtx): Promise<Outcome> {
	const clock = stageClock(ctx);
	const finish = (o: Omit<Outcome, "stages">): Outcome => ({ ...o, stages: clock.stop() });
	const prepared = await prepareBuilt(spec, target, ctx, clock);
	if ("failed" in prepared) return finish(failedBefore(target, prepared.failed));
	const built = prepared;
	const { marker, point } = built;
	const from = target.from ?? MESSAGES.oldVersionLabel();
	const stopped: { svc: Serve; since: string }[] = [];

	const startPaused = async () => {
		for (const p of built.paused.toReversed())
			// oxlint-disable-next-line no-await-in-loop -- in reverse order of the stops
			if (p.start && !(await startService(ctx.run, { ...p, start: p.start })))
				ctx.log(`Could not start ${p.name} again.`);
	};
	/** Before anything was placed: start what was stopped, put the files back, start what was paused. */
	const undoStop = async (detail: string): Promise<Outcome> => {
		for (const s of stopped)
			// oxlint-disable-next-line no-await-in-loop -- in table order
			if (!(await startService(ctx.run, s.svc))) ctx.log(`Could not start ${s.svc.name} again.`);
		try {
			await revertFiles(point, built.treeCtx);
		} catch (err) {
			ctx.log(`Putting the files back failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		await startPaused();
		marker.clear();
		return finish(failedBefore(target, detail));
	};
	/** After the new files were in place: stop what runs, restore the point, start the old version and prove it. */
	const rollBack = async (detail: string): Promise<Outcome> => {
		marker.step("stopping");
		const before = new Map<string, string>();
		for (const s of stopped) {
			// A unit that will not stop is still serving the new files: putting the old ones under it would leave
			// neither version, so the marker stays for the next recovery and nothing is put back. The stop is sent
			// even to a unit that reads down: one crashing waits out its restart delay, and its own restart would
			// otherwise start it on a half put-back tree.
			// oxlint-disable-next-line no-await-in-loop -- in table order
			if (!(await stopService(ctx.run, s.svc))) {
				ctx.log(`Could not stop ${s.svc.name} to put ${from} back.`);
				for (const o of stopped)
					// oxlint-disable-next-line no-await-in-loop -- in table order
					if (!(await isActive(ctx.run, o.svc))) await startService(ctx.run, o.svc);
				// oxlint-disable-next-line no-await-in-loop -- the loop ends here
				await startPaused();
				return finish({
					result: "failed",
					installed: target.from,
					detail: MESSAGES.couldNotStopToPutBack(s.svc.name, from),
					restartToApply: false,
				});
			}
			const since = s.svc.since
				? // oxlint-disable-next-line no-await-in-loop -- in table order
					(await ctx.run(asRootArgv(s.svc.since), { timeoutMs: 30_000 })).stdout.trim()
				: "";
			before.set(s.svc.name, since);
		}
		marker.step("placing");
		let broken: string | null = null;
		try {
			await restoreTree(point, built.treeCtx);
		} catch (err) {
			ctx.log(`Restoring ${from} failed: ${err instanceof Error ? err.message : String(err)}`);
			broken = stopped[0]?.svc.name ?? spec.name;
		}
		marker.step("starting");
		for (const s of stopped) {
			// oxlint-disable-next-line no-await-in-loop -- in table order
			const up = (await startService(ctx.run, s.svc)) && (await healthy(s.svc, ctx));
			// oxlint-disable-next-line no-await-in-loop -- in table order
			const since = s.svc.since ? (await ctx.run(asRootArgv(s.svc.since), { timeoutMs: 30_000 })).stdout.trim() : "";
			if (!up || (s.svc.since && since === before.get(s.svc.name))) {
				ctx.log(`${s.svc.name} did not answer after putting ${from} back.`);
				broken ??= s.svc.name;
			}
		}
		await startPaused();
		marker.clear();
		if (broken)
			return finish({
				result: "failed",
				installed: target.from,
				detail: MESSAGES.putBackFailedNoAnswer(from, broken),
				restartToApply: false,
			});
		return finish({ result: "rolled_back", installed: target.from, detail, restartToApply: false });
	};

	clock.start("install");
	marker.step("stopping");
	for (const a of built.active) {
		// oxlint-disable-next-line no-await-in-loop -- services stop in table order
		if (!(await stopService(ctx.run, a.svc))) return undoStop(MESSAGES.couldNotStopUnit(a.svc.name));
		stopped.push(a);
	}
	const busyStopped = await busyNow(spec, ctx, true);
	if (busyStopped) return undoStop(MESSAGES.busySayNothingChanged(busyStopped));
	marker.step("placing");
	const rename = ctx.rename ?? renameSync;
	try {
		for (const [i, pl] of (spec.place ?? []).entries()) {
			const { src, to } = placeFromTo(pl, ctx, built.dir, built.stage, built.vars);
			if (lstatSync(src).isDirectory()) {
				// The replaced directory goes into the restore point, so a rollback renames it back.
				// Noted before the move: a kill between the two renames still leaves the old directory on record.
				if (existsSync(to)) {
					notePlaced(point, { to, name: `placed-${i}` });
					rename(to, join(point, `placed-${i}`));
				}
				rename(src, to);
			} else {
				const mode = existsSync(to) ? (statSync(to).mode & 0o7777).toString(8) : "755";
				// oxlint-disable-next-line no-await-in-loop -- one place at a time
				const r = await installAside(ctx.run, src, to, mode, false);
				if (r.code !== 0) throw new Error(firstLine(r.stderr || r.stdout));
			}
		}
	} catch (err) {
		ctx.log(`place: ${err instanceof Error ? err.message : String(err)}`);
		return rollBack(MESSAGES.couldNotPlaceFiles(from));
	}
	marker.step("starting");
	for (const s of stopped)
		// oxlint-disable-next-line no-await-in-loop -- services start in table order
		if (!(await startService(ctx.run, s.svc))) return rollBack(MESSAGES.wouldNotStartRestored(from));

	clock.start("verify");
	marker.step("verify");
	for (const s of stopped) {
		if (s.svc.since) {
			// A restart counts only when since moved: the old process still answering health proves nothing.
			// oxlint-disable-next-line no-await-in-loop -- one unit at a time
			const now = (await ctx.run(asRootArgv(s.svc.since), { timeoutMs: 30_000 })).stdout.trim();
			if (now === s.since) return rollBack(MESSAGES.wouldNotStartRestored(from));
		}
		// oxlint-disable-next-line no-await-in-loop -- one unit at a time
		if (!(await healthy(s.svc, ctx))) return rollBack(MESSAGES.wouldNotStartRestored(from));
		for (const test of s.svc.test ?? []) {
			// oxlint-disable-next-line no-await-in-loop -- tests run in order
			if (await passes(test, ctx, built)) continue;
			if (test.required === false) ctx.log(`Test did not pass (not required): ${testName(test)}`);
			else return rollBack(MESSAGES.failedTest(testName(test), from));
		}
	}
	for (const test of spec.test ?? []) {
		// URL tests need a running service; with nothing in serve running they are skipped.
		if (test.url && stopped.length === 0) continue;
		// oxlint-disable-next-line no-await-in-loop -- tests run in order
		if (await passes(test, ctx, built)) continue;
		if (test.required === false) ctx.log(`Test did not pass (not required): ${testName(test)}`);
		else return rollBack(MESSAGES.failedTest(testName(test), from));
	}
	// The version is read as checkBuilt reads it and compared as written: a commit hash is not a version to reshape.
	const after = await readInstalled(spec, ctx);
	const installed = after?.installed ?? null;
	if (installed === null || (installed === target.from && target.from !== target.version))
		return rollBack(MESSAGES.failedTest(VERSION_CHECK, from));
	prune(ctx.paths, spec.key, ctx.settings.keepBackups);
	await pruneBuilds(spec, ctx, built);
	// Only now: until verify passed, the held copy is what a rollback renames back.
	dropHeld(spec, ctx, built.dir);
	await startPaused();
	marker.clear();
	return finish({
		result: "done",
		installed,
		detail: stopped.length === 0 && (spec.serve?.length ?? 0) > 0 ? MESSAGES.updatedWithoutRestart() : undefined,
		restartToApply: false,
	});
}

/** What a unit's since argv prints now, trimmed; empty for a unit with no since. */
async function sinceOf(ctx: KindCtx, s: Serve): Promise<string> {
	return s.since ? (await ctx.run(asRootArgv(s.since), { timeoutMs: 30_000 })).stdout.trim() : "";
}

/** A pid recovery never signals, whatever a marker says: init, this process or its parent. */
const mine = (pid: number) => pid <= 1 || pid === process.pid || pid === process.ppid;

export type RecoverCtx = KindCtx & {
	/** Ends a process tree. The engine passes killTree; tests pass a recorder, never a real signal. */
	kill: (pid: number, procRoot: string) => void;
	/** The pause after a kill before files are touched. Default 2 s. */
	waitMs?: number;
};

/** The units of a spec named in a marker list, in table order. */
const named = <T extends Service>(list: T[] | undefined, names: string[]) =>
	(list ?? []).filter((s) => names.includes(s.name));

/**
 * Finishes or undoes one interrupted built update from its marker, by the step it names: a kill of the recorded
 * step first (only when the pid still has the same start time, so a reused pid is never signalled), then a stop of
 * every unit that was active, even one that reads down (a crashing unit between two restarts would otherwise come up
 * on a half put-back tree), then the put-back that step needs, then every unit that was active or paused is started. Returns false when anything
 * failed; the marker is kept then, so the next recovery tries again. Every step is safe to run twice.
 */
export async function recoverTree(m: Inflight, spec: AppSpec, ctx: RecoverCtx): Promise<boolean> {
	const tree = m.tree;
	if (!tree) return true;
	const procRoot = ctx.procRoot ?? "/proc";
	if (
		tree.build &&
		!mine(tree.build.pid) &&
		Number(startTime(tree.build.pid, procRoot) ?? Number.NaN) === tree.build.started
	) {
		ctx.kill(tree.build.pid, procRoot);
		await Bun.sleep(ctx.waitMs ?? 2000);
	}
	const point = m.backupVersion ? pointOf(ctx.paths, spec.key, m.backupVersion) : null;
	const treeCtx: TreeCtx = { paths: ctx.paths, run: ctx.run, log: ctx.log };
	let ok = true;
	const active = named(spec.serve, tree.active);
	if (tree.step === "pause") {
		// Nothing was changed yet; a point being written when it stopped is half a point.
		if (point) rmSync(`${point}.upkeep-tmp`, { recursive: true, force: true });
	} else {
		const before = new Map<string, string>();
		let stopFailed = false;
		for (const s of active) {
			// oxlint-disable-next-line no-await-in-loop -- in table order
			before.set(s.name, await sinceOf(ctx, s));
			// Stopped even when it reads down: a crashing unit waiting out its restart delay would come back up on a
			// half put-back tree. It is started again below either way.
			// oxlint-disable-next-line no-await-in-loop -- in table order
			if (!(await stopService(ctx.run, s))) {
				ctx.log(`Could not stop ${s.name}, so nothing was put back.`);
				stopFailed = true;
			}
		}
		// Files are never put back under a process still running from them.
		if (stopFailed) ok = false;
		else
			try {
				if (!point) throw new Error("the marker names no restore point");
				if (tree.step === "build") {
					await revertFiles(point, treeCtx);
					// The half-built stage, as the build's own failure path removes it.
					const stage = readMeta(point)?.tree?.stage;
					if (stage)
						rmSync(safePath(stage, ctx.paths, { dir: spec.dir ? resolvePath(spec.dir, ctx.paths, null) : null }), {
							recursive: true,
							force: true,
						});
				} else await restoreTree(point, treeCtx);
			} catch (err) {
				ctx.log(`Putting the files back failed: ${err instanceof Error ? err.message : String(err)}`);
				ok = false;
			}
		for (const s of active) {
			// oxlint-disable-next-line no-await-in-loop -- in table order
			const started = (await startService(ctx.run, s)) && (await healthy(s, ctx));
			// A start counts only when since moved: the new process still answering proves nothing.
			// oxlint-disable-next-line no-await-in-loop -- in table order
			const up = started && (!s.since || (await sinceOf(ctx, s)) !== before.get(s.name));
			if (!up) {
				ctx.log(`${s.name} did not answer after the recovery.`);
				ok = false;
			}
		}
	}
	for (const p of named(spec.pause, tree.paused).toReversed())
		// oxlint-disable-next-line no-await-in-loop -- in reverse order of the stops
		if (p.start && !(await startService(ctx.run, { ...p, start: p.start }))) {
			ctx.log(`Could not start ${p.name} again.`);
			ok = false;
		}
	if (ok) clearInflight(ctx.paths);
	return ok;
}

/**
 * Puts a built app's restore point back by hand: sudo preflight, busy, pause, stop what runs, restoreTree, start,
 * prove it, start the paused units. Each step is on the in-flight marker first, so a kill at any point is finished
 * by recover(); a failed restore keeps the marker for the same reason. Over a failed recovery's marker for this app,
 * a restore that goes through also starts the units that marker had down; an exit before anything moved writes that
 * marker back and leaves those units to the next recover(). It takes
 * no point of the version it replaces, so this restore cannot itself be undone; the next update takes a fresh point.
 */
export async function restoreBuilt(
	spec: AppSpec,
	version: string,
	ctx: KindCtx,
): Promise<{ ok: boolean; detail?: string }> {
	const point = pointOf(ctx.paths, spec.key, version);
	if (!readMeta(point)?.tree) return { ok: false, detail: MESSAGES.noRestorePoint(version) };
	if (!(await sudoAllowed(spec, ctx))) return { ok: false, detail: SUDO_REFUSED };
	const busy = await busyNow(spec, ctx, false);
	if (busy) return { ok: false, detail: MESSAGES.busySayNothingChanged(busy) };
	const dir = spec.dir ? resolvePath(spec.dir, ctx.paths, null) : null;
	// A failed recovery's marker for this app: its units are down now, so this restore starts them, and an early exit
	// writes it back instead of clearing it.
	const kept = readInflight(ctx.paths);
	const prior = kept?.tree && kept.key === spec.key ? kept : null;
	const giveBack = () => (prior ? writeInflight(ctx.paths, prior) : clearInflight(ctx.paths));
	const marker = markerOf(spec, ctx, dir ?? "");
	const paused: Service[] = (spec.pause ?? []).filter((p) => prior?.tree?.paused.includes(p.name));
	marker.state.paused.push(...paused.map((p) => p.name));
	marker.point(version);
	marker.step("pause");
	const startPaused = async () => {
		for (const p of paused.toReversed())
			// oxlint-disable-next-line no-await-in-loop -- in reverse order of the stops
			if (p.start && !(await startService(ctx.run, { ...p, start: p.start })))
				ctx.log(`Could not start ${p.name} again.`);
	};
	for (const p of spec.pause ?? []) {
		// oxlint-disable-next-line no-await-in-loop -- in table order
		if (paused.includes(p) || !(await isActive(ctx.run, p))) continue;
		marker.paused(p.name);
		// oxlint-disable-next-line no-await-in-loop -- in table order
		if (!(await stopService(ctx.run, p))) {
			// oxlint-disable-next-line no-await-in-loop -- the loop ends here
			await startPaused();
			giveBack();
			return { ok: false, detail: MESSAGES.couldNotStopUnit(p.name) };
		}
		paused.push(p);
	}
	const running: Serve[] = [];
	for (const s of spec.serve ?? [])
		// oxlint-disable-next-line no-await-in-loop -- in table order
		if (await isActive(ctx.run, s)) running.push(s);
	const toStart = (spec.serve ?? []).filter((s) => running.includes(s) || prior?.tree?.active.includes(s.name));
	marker.active(toStart.map((s) => s.name));
	marker.step("stopping");
	for (const s of running)
		// oxlint-disable-next-line no-await-in-loop -- in table order
		if (!(await stopService(ctx.run, s))) {
			// oxlint-disable-next-line no-await-in-loop -- the loop ends here
			for (const r of running) await startService(ctx.run, r);
			// oxlint-disable-next-line no-await-in-loop -- the loop ends here
			await startPaused();
			giveBack();
			return { ok: false, detail: MESSAGES.couldNotStopUnit(s.name) };
		}
	marker.step("placing");
	let detail: string | undefined;
	try {
		await restoreTree(point, { paths: ctx.paths, run: ctx.run, log: ctx.log, rename: ctx.rename });
	} catch (err) {
		detail = MESSAGES.couldNotRestoreFile(version, err instanceof Error ? err.message : String(err));
	}
	marker.step("starting");
	for (const s of toStart)
		// oxlint-disable-next-line no-await-in-loop -- in table order
		if (!((await startService(ctx.run, s)) && (await healthy(s, ctx))))
			detail ??= MESSAGES.noAnswerAfterRestore(s.name);
	await startPaused();
	if (detail) return { ok: false, detail };
	marker.clear();
	return { ok: true };
}
