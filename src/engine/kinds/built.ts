import { existsSync, lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSpec, Serve, Service, Test } from "../../shared/types";
import { listBackups, prune, readMeta } from "../backup";
import { asRootArgv, installAside, type Run, type RunOpts } from "../run";
import { argsRunning } from "../running";
import { clearInflight, type Inflight, startTime, writeInflight } from "../store";
import { type KindCtx, type Outcome, stageClock, type Target } from "./context";
import { nonInteractive, readInstalled } from "./source";
import {
	expandGlob,
	fill,
	notePlaced,
	pointOf,
	resolvePath,
	restoreTree,
	revertFiles,
	takeTree,
	type Tree,
	type TreeCtx,
	type Vars,
} from "./tree";

export const SUDO_REFUSED = "sudo needs a password here, so nothing was stopped or changed.";

const LONG = 30 * 60_000;
const SERVICE_MS = 120_000;
const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

/** A step's failure becomes this, with its sentence; everything before it is put back by the caller. */
export class BuiltFailure extends Error {}

type Step = Inflight["tree"] extends infer T ? (T extends { step: infer S } ? S : never) : never;

/** The in-flight marker of one built update. Every pid a step reports lands in it at once. */
export function markerOf(spec: AppSpec, ctx: KindCtx, dest: string) {
	const procRoot = ctx.procRoot ?? "/proc";
	const state: NonNullable<Inflight["tree"]> = { step: "pause", build: null, active: [], paused: [] };
	let backupVersion: string | null = null;
	const write = () => writeInflight(ctx.paths, { key: spec.key, dest, backupVersion, tree: { ...state } });
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
		/** For RunOpts.onStart: the step's pid and its start time, so recovery ends this exact process. */
		onStart: (pid: number) => {
			state.build = { pid, started: Number(startTime(pid, procRoot) ?? 0) };
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

/** Every serve and pause argv the table runs as root, checked with sudo -n -l before anything changes. */
export function rootArgvs(spec: AppSpec): string[][] {
	const all: string[][] = [];
	for (const s of [...(spec.pause ?? []), ...(spec.serve ?? [])])
		for (const argv of [s.active, s.stop, s.start, s.since]) if (argv?.[0] === "sudo") all.push(argv);
	return all;
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

/** Writes each config value into the JSON files it names. Symlinks are skipped. */
function applyConfig(spec: AppSpec, ctx: KindCtx, dir: string | null): void {
	for (const c of spec.config ?? []) {
		for (const file of expandGlob(c.file, ctx.paths, dir)) {
			if (lstatSync(file).isSymbolicLink()) continue;
			const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
			if (c.key) json[c.key] = c.value;
			else if (c.array && c.flag) {
				const arr = Array.isArray(json[c.array]) ? (json[c.array] as unknown[]) : [];
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
	const stage = spec.stage ? resolvePath(fill(spec.stage, vars), ctx.paths, dir) : null;
	if (stage) vars.stage = stage;
	const marker = markerOf(spec, ctx, dir ?? stage ?? "");
	const paused: Service[] = [];
	const treeCtx: TreeCtx = { paths: ctx.paths, run: ctx.run, log: ctx.log, onStart: marker.onStart };
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
			if (stage) rmSync(stage, { recursive: true, force: true });
		}
		await startPaused();
		marker.clear();
		return { failed: f.failed };
	};

	clock.start("download");
	for (const argv of rootArgvs(spec)) {
		const rest = argv[1] === "-n" ? argv.slice(2) : argv.slice(1);
		// oxlint-disable-next-line no-await-in-loop -- one check per command
		if ((await ctx.run(["sudo", "-n", "-l", ...rest], { timeoutMs: 30_000 })).code !== 0)
			return { failed: SUDO_REFUSED };
	}
	const first = await busyNow(spec, ctx, false);
	if (first) return { failed: `${first} Nothing was changed.` };
	// The marker exists before the first pause stop, so a kill from here on is recovered.
	marker.step("pause");
	for (const p of spec.pause ?? []) {
		// oxlint-disable-next-line no-await-in-loop -- units are held off in table order
		if (!(await isActive(ctx.run, p))) continue;
		// oxlint-disable-next-line no-await-in-loop -- units are held off in table order
		if (!(await stopService(ctx.run, p))) return fail({ failed: `Could not stop ${p.name}. Nothing was changed.` });
		paused.push(p);
		marker.paused(p.name);
	}
	const second = await busyNow(spec, ctx, false);
	if (second) return fail({ failed: `${second} Nothing was changed.` });
	if (dir) {
		const status = await ctx.run(["git", "-C", dir, "status", "--porcelain", "--untracked-files=no"], {
			timeoutMs: 60_000,
		});
		if (status.code !== 0 || status.stdout.trim())
			return fail({ failed: `${shown} has local changes. Nothing was changed.` });
		if (spec.move === "reset") {
			const on = await ctx.run(["git", "-C", dir, "branch", "-r", "--contains", "HEAD"], { timeoutMs: 60_000 });
			if (on.code !== 0 || !on.stdout.trim())
				return fail({ failed: `${shown} has commits that are not on GitHub. Nothing was changed.` });
		}
		const fetched = await tracked(
			ctx.run,
			marker,
			["git", "-C", dir, "fetch", "--no-tags", "origin", "tag", target.tag],
			{
				timeoutMs: 600_000,
				killTree: true,
			},
		);
		if (fetched.code !== 0)
			return fail({ failed: `Could not fetch ${target.tag} into ${shown}. Nothing was changed.` });
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
			failed: `Could not take a restore point: ${err instanceof Error ? err.message : String(err)}. Nothing was changed.`,
		});
	}
	vars.needs = tree.needs[0] ?? "";
	marker.point(target.from ?? "unknown");
	marker.active(active.map((a) => a.svc.name));
	marker.step("build");

	clock.start("build");
	for (const h of spec.hold ?? []) {
		const p = resolvePath(h, ctx.paths, dir);
		// The running process keeps its open files under the .upkeep-live name; the build writes a copy.
		try {
			renameSync(p, `${p}.upkeep-live`);
		} catch (err) {
			ctx.log(`hold ${h}: ${err instanceof Error ? err.message : String(err)}`);
			return fail({ failed: `Build step failed: hold ${h}. Nothing was changed.`, cleanup: "revert" });
		}
		// oxlint-disable-next-line no-await-in-loop -- one tree at a time
		const r = await ctx.run(["cp", "-a", `${p}.upkeep-live`, p], { timeoutMs: LONG });
		if (r.code !== 0) return fail({ failed: `Build step failed: hold ${h}. Nothing was changed.`, cleanup: "revert" });
	}
	if (dir) {
		const move = spec.move ?? "ff";
		const argv =
			move === "reset"
				? ["git", "-C", dir, "reset", "-q", "--hard", target.tag]
				: move === "detach"
					? ["git", "-C", dir, "checkout", "-q", "--detach", target.tag]
					: ["git", "-C", dir, "merge", "-q", "--ff-only", target.tag];
		const moved = await ctx.run(argv, { timeoutMs: 120_000 });
		if (moved.code !== 0)
			return fail({
				failed: `${shown} cannot move to ${target.tag} without a merge. Nothing was changed.`,
				cleanup: "revert",
			});
	}
	if (stage) rmSync(stage, { recursive: true, force: true });
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
		if (r.code !== 0) return fail({ failed: `Build step failed: ${step}. Nothing was changed.`, cleanup: "revert" });
	}
	try {
		applyConfig(spec, ctx, dir);
	} catch (err) {
		ctx.log(`config: ${err instanceof Error ? err.message : String(err)}`);
		return fail({ failed: "The build did not pass its check: config. Nothing was changed.", cleanup: "revert" });
	}
	for (const step of spec.check_built ?? []) {
		// oxlint-disable-next-line no-await-in-loop -- checks run in order
		const r = await tracked(ctx.run, marker, ["bash", "-c", nonInteractive(fill(step, vars))], {
			cwd,
			timeoutMs: LONG,
			killTree: true,
			onLine: (l) => ctx.log(l),
		});
		if (r.code !== 0) {
			ctx.log(firstLine(r.stderr || r.stdout));
			return fail({ failed: `The build did not pass its check: ${step}. Nothing was changed.`, cleanup: "revert" });
		}
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
const VERSION_CHECK = "the version check";

/** Polls health every 2 s until it answers status (default 200) with expect matching, within wait_s (default 120). */
async function healthy(svc: Serve, ctx: KindCtx): Promise<boolean> {
	if (!svc.health) return true;
	const until = Date.now() + (svc.wait_s ?? 120) * 1000;
	const want = svc.status ?? 200;
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
		rmSync(`${p}.upkeep-gone`, { recursive: true, force: true });
	}
}

const testName = (t: Test) => t.name ?? t.url ?? t.run?.[0] ?? "a test";

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
	for (const pattern of spec.prune)
		for (const d of expandGlob(pattern, ctx.paths, built.dir)) {
			if (kept.has(d) || !lstatSync(d).isDirectory()) continue;
			ctx.log(`Pruned ${d}`);
			rmSync(d, { recursive: true, force: true });
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
	const from = target.from ?? "the old version";
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
			// oxlint-disable-next-line no-await-in-loop -- in table order
			if (await isActive(ctx.run, s.svc)) await stopService(ctx.run, s.svc);
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
				detail: `Would not start after the update, and putting ${from} back failed: ${broken} did not answer. See the log.`,
				restartToApply: false,
			});
		return finish({ result: "rolled_back", installed: target.from, detail, restartToApply: false });
	};

	clock.start("install");
	marker.step("stopping");
	for (const a of built.active) {
		// oxlint-disable-next-line no-await-in-loop -- services stop in table order
		if (!(await stopService(ctx.run, a.svc))) return undoStop(`Could not stop ${a.svc.name}. Nothing was changed.`);
		stopped.push(a);
	}
	const busyStopped = await busyNow(spec, ctx, true);
	if (busyStopped) return undoStop(`${busyStopped} Nothing was changed.`);
	marker.step("placing");
	try {
		for (const [i, pl] of (spec.place ?? []).entries()) {
			const src = resolvePath(fill(pl.from, built.vars), ctx.paths, built.dir);
			const to = resolvePath(fill(pl.to, built.vars), ctx.paths, built.dir);
			if (lstatSync(src).isDirectory()) {
				// The replaced directory goes into the restore point, so a rollback renames it back.
				if (existsSync(to)) {
					renameSync(to, join(point, `placed-${i}`));
					notePlaced(point, { to, name: `placed-${i}` });
				}
				renameSync(src, to);
			} else {
				const mode = existsSync(to) ? (statSync(to).mode & 0o7777).toString(8) : "755";
				// oxlint-disable-next-line no-await-in-loop -- one place at a time
				const r = await installAside(ctx.run, src, to, mode, false);
				if (r.code !== 0) throw new Error(firstLine(r.stderr || r.stdout));
			}
		}
	} catch (err) {
		ctx.log(`place: ${err instanceof Error ? err.message : String(err)}`);
		return rollBack(`Could not put the new files in place. Restored ${from}.`);
	}
	marker.step("starting");
	for (const s of stopped)
		// oxlint-disable-next-line no-await-in-loop -- services start in table order
		if (!(await startService(ctx.run, s.svc))) return rollBack(`Would not start after the update. Restored ${from}.`);
	dropHeld(spec, ctx, built.dir);

	clock.start("verify");
	marker.step("verify");
	for (const s of stopped) {
		if (s.svc.since) {
			// A restart counts only when since moved: the old process still answering health proves nothing.
			// oxlint-disable-next-line no-await-in-loop -- one unit at a time
			const now = (await ctx.run(asRootArgv(s.svc.since), { timeoutMs: 30_000 })).stdout.trim();
			if (now === s.since) return rollBack(`Would not start after the update. Restored ${from}.`);
		}
		// oxlint-disable-next-line no-await-in-loop -- one unit at a time
		if (!(await healthy(s.svc, ctx))) return rollBack(`Would not start after the update. Restored ${from}.`);
		for (const test of s.svc.test ?? []) {
			// oxlint-disable-next-line no-await-in-loop -- tests run in order
			if (await passes(test, ctx, built)) continue;
			if (test.required === false) ctx.log(`Test did not pass (not required): ${testName(test)}`);
			else return rollBack(`Failed its test after the update: ${testName(test)}. Restored ${from}.`);
		}
	}
	for (const test of spec.test ?? []) {
		// URL tests need a running service; with nothing in serve running they are skipped.
		if (test.url && stopped.length === 0) continue;
		// oxlint-disable-next-line no-await-in-loop -- tests run in order
		if (await passes(test, ctx, built)) continue;
		if (test.required === false) ctx.log(`Test did not pass (not required): ${testName(test)}`);
		else return rollBack(`Failed its test after the update: ${testName(test)}. Restored ${from}.`);
	}
	// The version is read as checkBuilt reads it and compared as written: a commit hash is not a version to reshape.
	const after = await readInstalled(spec, ctx);
	const installed = after?.installed ?? null;
	if (installed === null || (installed === target.from && target.from !== target.version))
		return rollBack(`Failed its test after the update: ${VERSION_CHECK}. Restored ${from}.`);
	prune(ctx.paths, spec.key, ctx.settings.keepBackups);
	await pruneBuilds(spec, ctx, built);
	await startPaused();
	marker.clear();
	return finish({
		result: "done",
		installed,
		detail:
			stopped.length === 0 && (spec.serve?.length ?? 0) > 0
				? "Updated without a restart: none of its services was running."
				: undefined,
		restartToApply: false,
	});
}

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
 * step first (only when the pid still has the same start time, so a reused pid is never signalled), then the
 * put-back that step needs, then every unit that was active or paused is started. Returns false when anything
 * failed; the marker is kept then, so the next recovery tries again. Every step is safe to run twice.
 */
export async function recoverTree(m: Inflight, spec: AppSpec, ctx: RecoverCtx): Promise<boolean> {
	const tree = m.tree;
	if (!tree) return true;
	const procRoot = ctx.procRoot ?? "/proc";
	if (tree.build && Number(startTime(tree.build.pid, procRoot) ?? Number.NaN) === tree.build.started) {
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
		for (const s of active)
			// oxlint-disable-next-line no-await-in-loop -- in table order
			if (await isActive(ctx.run, s)) await stopService(ctx.run, s);
		try {
			if (!point) throw new Error("the marker names no restore point");
			if (tree.step === "build") await revertFiles(point, treeCtx);
			else await restoreTree(point, treeCtx);
		} catch (err) {
			ctx.log(`Putting the files back failed: ${err instanceof Error ? err.message : String(err)}`);
			ok = false;
		}
		for (const s of active) {
			// oxlint-disable-next-line no-await-in-loop -- in table order
			const up = (await startService(ctx.run, s)) && (await healthy(s, ctx));
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
 * Puts a built app's restore point back by hand: busy, pause, stop what runs, restoreTree, start, prove it,
 * start the paused units. It takes no point of the version it replaces, so this restore cannot itself be undone;
 * the next update takes a fresh point.
 */
export async function restoreBuilt(
	spec: AppSpec,
	version: string,
	ctx: KindCtx,
): Promise<{ ok: boolean; detail?: string }> {
	const point = pointOf(ctx.paths, spec.key, version);
	if (!readMeta(point)?.tree) return { ok: false, detail: `No restore point ${version}.` };
	const busy = await busyNow(spec, ctx, false);
	if (busy) return { ok: false, detail: `${busy} Nothing was changed.` };
	const paused: Service[] = [];
	const startPaused = async () => {
		for (const p of paused.toReversed())
			// oxlint-disable-next-line no-await-in-loop -- in reverse order of the stops
			if (p.start && !(await startService(ctx.run, { ...p, start: p.start })))
				ctx.log(`Could not start ${p.name} again.`);
	};
	for (const p of spec.pause ?? []) {
		// oxlint-disable-next-line no-await-in-loop -- in table order
		if (!(await isActive(ctx.run, p))) continue;
		// oxlint-disable-next-line no-await-in-loop -- in table order
		if (!(await stopService(ctx.run, p))) {
			// oxlint-disable-next-line no-await-in-loop -- the loop ends here
			await startPaused();
			return { ok: false, detail: `Could not stop ${p.name}. Nothing was changed.` };
		}
		paused.push(p);
	}
	const running: Serve[] = [];
	for (const s of spec.serve ?? [])
		// oxlint-disable-next-line no-await-in-loop -- in table order
		if (await isActive(ctx.run, s)) running.push(s);
	for (const s of running)
		// oxlint-disable-next-line no-await-in-loop -- in table order
		if (!(await stopService(ctx.run, s))) {
			// oxlint-disable-next-line no-await-in-loop -- the loop ends here
			for (const r of running) await startService(ctx.run, r);
			// oxlint-disable-next-line no-await-in-loop -- the loop ends here
			await startPaused();
			return { ok: false, detail: `Could not stop ${s.name}. Nothing was changed.` };
		}
	let detail: string | undefined;
	try {
		await restoreTree(point, { paths: ctx.paths, run: ctx.run, log: ctx.log });
	} catch (err) {
		detail = `Could not restore ${version}: ${err instanceof Error ? err.message : String(err)}`;
	}
	for (const s of running)
		// oxlint-disable-next-line no-await-in-loop -- in table order
		if (!((await startService(ctx.run, s)) && (await healthy(s, ctx))))
			detail ??= `${s.name} did not answer after the restore. See the log.`;
	await startPaused();
	return detail ? { ok: false, detail } : { ok: true };
}
