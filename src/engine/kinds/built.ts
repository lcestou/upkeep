import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { AppSpec, Serve, Service } from "../../shared/types";
import { asRootArgv, type Run, type RunOpts } from "../run";
import { argsRunning } from "../running";
import { clearInflight, type Inflight, startTime, writeInflight } from "../store";
import type { KindCtx, Outcome, Target } from "./context";
import { expandGlob, fill, resolvePath, takeTree, type Tree, type TreeCtx, revertFiles, type Vars } from "./tree";

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
	return (await run(svc.active, { timeoutMs: 30_000 })).code === 0;
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
		const since = s.since ? (await ctx.run(s.since, { timeoutMs: 30_000 })).stdout.trim() : "";
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
		const r = await tracked(ctx.run, marker, ["bash", "-c", fill(step, vars)], {
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
		const r = await tracked(ctx.run, marker, ["bash", "-c", fill(step, vars)], {
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
