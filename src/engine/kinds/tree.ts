import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";
import { MESSAGES } from "../../shared/messages";
import type { AppSpec } from "../../shared/types";
import { type BackupMeta, backupDir, CONFIG_DIR, pointName, putConfigBack, readMeta, saveConfig } from "../backup";
import { expandHome, type Paths } from "../paths";
import { installAside, type Run } from "../run";
import { nonInteractive } from "./context";

export type Tree = NonNullable<BackupMeta["tree"]>;

export type TreeCtx = {
	paths: Paths;
	run: Run;
	log: (line: string) => void;
	/** Every step that writes the tree reports its pid here, so recovery can end it first. */
	onStart?: (pid: number) => void;
	/** The rename every put-back uses. Tests pass one that fails once, to stop a put-back midway. */
	rename?: (from: string, to: string) => void;
};

/** The placeholders a table may use; anything else was refused when apps.toml was read. */
export type Vars = Partial<Record<"stage" | "tag" | "version" | "needs" | "point", string>>;

/** Fills {stage}, {tag}, {version}, {needs} and {point}. ${var} belongs to the shell and is left alone. */
export function fill(text: string, vars: Vars): string {
	return text.replace(/(?<!\$)\{(stage|tag|version|needs|point)\}/g, (m, k: keyof Vars) => vars[k] ?? m);
}

/** A table path: ~ expanded under the engine's home, a relative path taken inside dir. */
export function resolvePath(p: string, paths: Paths, dir: string | null): string {
	const e = expandHome(p, paths.home);
	return isAbsolute(e) || !dir ? e : join(dir, e);
}

/**
 * Refuses a table path before anything removes, renames or copies over it. Refused: a path that is not absolute or
 * has a .. segment; the root, the home directory or any directory above it; dir or any directory above it; anything
 * in not or above it; and, when under is given, a path outside every root in under (a root itself counts as inside,
 * so pass it in not too when it must not be touched whole). With under, the path's parent is also resolved through
 * its links and must still land inside a root, so dir/link/x with link pointing elsewhere is refused; the last segment
 * is not followed, so a link in keep is kept as a link. apps.toml was checked when it was read; this holds when a
 * placeholder, a glob or an edited table names something else. Returns the path normalized.
 */
export function safePath(p: string, paths: Paths, o: { dir: string | null; under?: string[]; not?: string[] }): string {
	if (!isAbsolute(p) || p.split("/").includes("..")) throw new Error(MESSAGES.refusedNotPlain(p));
	const n = normalize(p).replace(/(.)\/+$/, "$1");
	const covers = (q: string) => q === n || q.startsWith(n === "/" ? "/" : `${n}/`);
	for (const q of [paths.home, o.dir, ...(o.not ?? [])])
		if (q && covers(normalize(q))) throw new Error(MESSAGES.refusedHoldsMore(p));
	if (o.under && !o.under.some((u) => n === u || n.startsWith(`${u}/`))) throw new Error(MESSAGES.refusedOutside(p));
	if (o.under) {
		const real = join(realOf(dirname(n)), basename(n));
		if (!o.under.map(realOf).some((u) => real === u || real.startsWith(`${u}/`)))
			throw new Error(MESSAGES.refusedLinkOutside(p));
	}
	return n;
}

/** p with its links resolved; the part that does not exist yet is joined as written onto its nearest real parent. */
function realOf(p: string): string {
	const rest: string[] = [];
	let at = p;
	while (!exists(at) && at !== dirname(at)) {
		rest.unshift(basename(at));
		at = dirname(at);
	}
	try {
		return join(realpathSync(at), ...rest);
	} catch {
		// A dangling link or a loop: nothing safe can be said about where it leads.
		throw new Error(MESSAGES.refusedLinkNowhere(p));
	}
}

/** What keep, hold and prune may touch: dir, or the stage's parent for a table that builds only into a stage. */
export const scopeOf = (dir: string | null, stage: string | null | undefined): string | null =>
	dir ?? (stage ? dirname(stage) : null);

/** safePath for keep, hold and prune: strictly inside the scope. With no scope, nothing passes. */
export const inScope = (p: string, paths: Paths, dir: string | null, scope: string | null): string =>
	safePath(p, paths, { dir, under: scope ? [scope] : [], not: scope ? [scope] : [] });

/** True when anything is at p, a dangling link included; false on any stat error. */
const exists = (p: string) => {
	try {
		lstatSync(p);
		return true;
	} catch {
		return false;
	}
};

/** The paths a pattern names, links not followed. A pattern with no glob character names itself when it exists. */
export function expandGlob(pattern: string, paths: Paths, dir: string | null): string[] {
	const full = resolvePath(pattern, paths, dir);
	const parts = full.split("/");
	const at = parts.findIndex((s) => /[*?[]/.test(s));
	if (at < 0) return exists(full) ? [full] : [];
	const base = parts.slice(0, at).join("/") || "/";
	const glob = new Bun.Glob(parts.slice(at).join("/"));
	try {
		return [...glob.scanSync({ cwd: base, onlyFiles: false, dot: true, followSymlinks: false })]
			.map((m) => join(base, m))
			.toSorted();
	} catch {
		return [];
	}
}

const LONG = 30 * 60_000;
/** The first line of s after trimming, or an empty string; the short form of a failed command's output for an error message. */
const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

/** The point a version's restore files live in. */
export const pointOf = (paths: Paths, key: string, version: string) => join(backupDir(paths, key), pointName(version));

/**
 * Takes the restore point of a built app before its build: the kept paths (cp -a, so links and modes
 * survive), each record's output, what needs prints, the files place will replace, and HEAD. Built aside and
 * renamed in, as every restore point is.
 */
export async function takeTree(
	spec: AppSpec,
	ctx: TreeCtx,
	o: { version: string; at: string; vars: Vars },
): Promise<{ point: string; tree: Tree }> {
	const dir = spec.dir ? resolvePath(spec.dir, ctx.paths, null) : null;
	const scope = scopeOf(dir, o.vars.stage);
	const point = pointOf(ctx.paths, spec.key, o.version);
	const tmp = `${point}.upkeep-tmp`;
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp, { recursive: true });
	try {
		const tree: Tree = {
			spec,
			dir,
			scope,
			stage: o.vars.stage ?? null,
			commit: null,
			kept: [],
			records: [],
			needs: [],
			placed: [],
		};
		for (const pattern of spec.keep ?? []) {
			for (const p of expandGlob(pattern, ctx.paths, dir).map((x) => inScope(x, ctx.paths, dir, scope))) {
				const rel = relative(dir ?? "/", p);
				const into = join(tmp, "keep", rel);
				mkdirSync(dirname(into), { recursive: true });
				// oxlint-disable-next-line no-await-in-loop -- one copy at a time, each a big tree
				const r = await ctx.run(["cp", "-a", p, into], { timeoutMs: LONG });
				if (r.code !== 0) throw new Error(`cp ${rel}: ${firstLine(r.stderr || r.stdout)}`);
				tree.kept.push({ rel, link: lstatSync(p).isSymbolicLink() });
			}
		}
		for (const rec of spec.record ?? []) {
			// A record is a file in the point itself: never a path, and never a name the point already uses.
			if (/[/\0]/.test(rec.file) || [".", "..", "", "meta.json", "keep", CONFIG_DIR].includes(rec.file))
				throw new Error(MESSAGES.recordNotPlainName(rec.file));
			const argv = rec.run.map((a) => fill(a, { ...o.vars, point: tmp }));
			// oxlint-disable-next-line no-await-in-loop -- a record may read the one before it
			const r = await ctx.run(argv, { cwd: dir ?? undefined, timeoutMs: LONG, killTree: true, onStart: ctx.onStart });
			if (r.code !== 0) throw new Error(`${rec.file}: ${firstLine(r.stderr || r.stdout)}`);
			writeFileSync(join(tmp, rec.file), r.stdout);
			tree.records.push(rec.file);
		}
		if (spec.needs) {
			const r = await ctx.run(spec.needs, { timeoutMs: 60_000 });
			tree.needs =
				r.code === 0
					? r.stdout
							.split("\n")
							.map((l) => l.trim())
							.filter(Boolean)
					: [];
			if (tree.needs.length === 0) throw new Error(MESSAGES.needsPrintedNothing(firstLine(r.stderr || r.stdout)));
		}
		for (const [i, pl] of (spec.place ?? []).entries()) {
			const to = resolvePath(fill(pl.to, o.vars), ctx.paths, dir);
			// A directory target is moved into the point when place runs; a file is copied now.
			if (!exists(to) || !lstatSync(to).isFile()) continue;
			const name = `placed-${i}`;
			// oxlint-disable-next-line no-await-in-loop -- one copy at a time
			const r = await ctx.run(["cp", "-a", to, join(tmp, name)], { timeoutMs: LONG });
			if (r.code !== 0) throw new Error(`cp ${to}: ${firstLine(r.stderr || r.stdout)}`);
			tree.placed.push({ to, name });
		}
		if (dir) {
			const r = await ctx.run(["git", "-C", dir, "rev-parse", "HEAD"], { timeoutMs: 60_000 });
			if (r.code !== 0) throw new Error(`git rev-parse: ${firstLine(r.stderr || r.stdout)}`);
			tree.commit = firstLine(r.stdout);
		}
		const meta: BackupMeta = { version: o.version, at: o.at, files: [], sudo: false, tree };
		const config = saveConfig(tmp, spec, ctx.paths, ctx.log);
		if (config.length > 0) meta.config = config;
		writeFileSync(join(tmp, "meta.json"), JSON.stringify(meta, null, "\t"));
		rmSync(point, { recursive: true, force: true });
		renameSync(tmp, point);
		return { point, tree };
	} catch (err) {
		rmSync(tmp, { recursive: true, force: true });
		throw err;
	}
}

/** Adds a directory place moved into the point, so a rollback can rename it back. */
export function notePlaced(point: string, entry: { to: string; name: string }): void {
	const meta = readMeta(point);
	if (!meta?.tree) throw new Error(`No restore point at ${point}.`);
	meta.tree.placed.push(entry);
	writeFileSync(join(point, "meta.json"), JSON.stringify(meta, null, "\t"));
}

/**
 * Puts one directory back by rename: delete a stale <p>.upkeep-failed, move <p> aside, rename the old copy in,
 * delete what was moved aside. Safe to run again from the top after a stop at any point.
 */
function swapIn(src: string, p: string, rename: (a: string, b: string) => void): void {
	const failed = `${p}.upkeep-failed`;
	rmSync(failed, { recursive: true, force: true });
	if (exists(p)) rename(p, failed);
	rename(src, p);
	rmSync(failed, { recursive: true, force: true });
}

/** The permission bits of p in octal, setuid and sticky included; throws when p is missing. */
const modeOf = (p: string) => (statSync(p).mode & 0o7777).toString(8);

/**
 * Puts a built tree back from its point, in a fixed order: hold, keep, placed (after a stop only), git, undo.
 * Every step reads the filesystem first, so a run cut off anywhere finishes on the next one. It throws on the
 * first step that fails; the caller decides what that means for the services.
 */
async function putBack(point: string, ctx: TreeCtx, withPlaced: boolean): Promise<void> {
	const meta = readMeta(point);
	if (!meta?.tree) throw new Error(MESSAGES.noRestorePointAt(point));
	const tree = meta.tree;
	const rename = ctx.rename ?? renameSync;
	const dir = tree.dir;
	const scope = tree.scope ?? dir;

	// hold: the running process's own old tree goes back by rename, never by a copy.
	const holds = (tree.spec.hold ?? []).map((h) => inScope(resolvePath(h, ctx.paths, dir), ctx.paths, dir, scope));
	for (const [i, p] of holds.entries()) {
		// A held copy being deleted after a verified update is renamed first; a cut delete leaves only this.
		rmSync(`${p}.upkeep-gone`, { recursive: true, force: true });
		const live = `${p}.upkeep-live`;
		if (exists(live)) {
			swapIn(live, p, rename);
			// Before the stop the held copy is whole, so keep need not copy it again. After the stop the kept copy is
			// the truth, so restoreTree never marks a hold done.
			if (!withPlaced) writeFileSync(join(point, `hold-done-${i}`), "");
		} else rmSync(`${p}.upkeep-failed`, { recursive: true, force: true });
	}
	const heldBack = new Set(withPlaced ? [] : holds.filter((_, i) => existsSync(join(point, `hold-done-${i}`))));

	for (const k of tree.kept) {
		const p = inScope(join(dir ?? "/", k.rel), ctx.paths, dir, scope);
		const src = join(point, "keep", k.rel);
		if (heldBack.has(p)) continue;
		if (k.link) {
			// oxlint-disable-next-line no-await-in-loop -- one path at a time
			const r = await ctx.run(["ln", "-sfn", readlinkSync(src), p]);
			if (r.code !== 0) throw new Error(`ln ${k.rel}: ${firstLine(r.stderr || r.stdout)}`);
		} else if (lstatSync(src).isDirectory()) {
			const next = `${p}.upkeep-new`;
			rmSync(next, { recursive: true, force: true });
			// The copy lands beside the live path; only renames touch the live name.
			// oxlint-disable-next-line no-await-in-loop -- one path at a time
			const r = await ctx.run(["cp", "-a", src, next], { timeoutMs: LONG, killTree: true, onStart: ctx.onStart });
			if (r.code !== 0) throw new Error(`cp ${k.rel}: ${firstLine(r.stderr || r.stdout)}`);
			swapIn(next, p, rename);
		} else {
			// oxlint-disable-next-line no-await-in-loop -- one path at a time
			const r = await installAside(ctx.run, src, p, modeOf(src), false);
			if (r.code !== 0) throw new Error(`install ${k.rel}: ${firstLine(r.stderr || r.stdout)}`);
		}
	}

	if (withPlaced)
		for (const pl of tree.placed) {
			safePath(pl.to, ctx.paths, { dir });
			const src = join(point, pl.name);
			// Gone from the point: already put back (only a leftover move-aside may remain), or place never ran.
			if (!exists(src)) {
				rmSync(`${pl.to}.upkeep-failed`, { recursive: true, force: true });
				continue;
			}
			if (lstatSync(src).isDirectory()) swapIn(src, pl.to, rename);
			else {
				// oxlint-disable-next-line no-await-in-loop -- one path at a time
				const r = await installAside(ctx.run, src, pl.to, modeOf(src), false);
				if (r.code !== 0) throw new Error(`install ${pl.to}: ${firstLine(r.stderr || r.stdout)}`);
			}
		}

	if (dir && tree.commit) {
		const move = tree.spec.move ?? "ff";
		const argv =
			move === "reset"
				? ["git", "-C", dir, "reset", "-q", "--hard", tree.commit]
				: move === "detach"
					? ["git", "-C", dir, "checkout", "-q", "--detach", tree.commit]
					: ["git", "-C", dir, "reset", "-q", "--keep", tree.commit];
		const r = await ctx.run(argv, { timeoutMs: 120_000 });
		if (r.code !== 0) throw new Error(`git: ${firstLine(r.stderr || r.stdout)}`);
	}

	for (const step of tree.spec.undo ?? []) {
		// oxlint-disable-next-line no-await-in-loop -- undo steps run in order
		const r = await ctx.run(["bash", "-c", nonInteractive(fill(step, { point }))], {
			cwd: dir ?? undefined,
			timeoutMs: LONG,
			killTree: true,
			onStart: ctx.onStart,
		});
		if (r.code !== 0) throw new Error(MESSAGES.undoStepFailed(step));
	}
	// Settings only after the stop: before it the new version never ran, so they are as the point saved them.
	if (withPlaced) putConfigBack(point, meta.config ?? [], ctx.paths, tree.spec.key);
	// A finished put-back leaves no marks, so a later restore from this point copies every kept path again.
	for (const f of readdirSync(point)) if (f.startsWith("hold-done-")) rmSync(join(point, f), { force: true });
}

/** Before anything was stopped: hold, keep, git and undo go back. place never ran. */
export function revertFiles(point: string, ctx: TreeCtx): Promise<void> {
	return putBack(point, ctx, false);
}

/** After the stop: everything revertFiles does, plus the files and directories place replaced. */
export function restoreTree(point: string, ctx: TreeCtx): Promise<void> {
	return putBack(point, ctx, true);
}
