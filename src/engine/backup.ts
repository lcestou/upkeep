import {
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	closeSync,
	openSync,
	readlinkSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { MESSAGES } from "../shared/messages";
import type { AppSpec, RestorePoint } from "../shared/types";
import { dropTree } from "./drop";
import { isPackage, PACKAGE_TOOL, type PackageKind, packageInstall } from "./kinds/package";
import { expandHome, type Paths } from "./paths";
import { stampInstalled } from "./store";
import { asRoot, installAside, type Run, SUDO_PASSWORD, sudoNeedsPassword } from "./run";

export type BackupMeta = {
	version: string;
	at: string;
	/** dir: a folder app's whole folder, copied with its links as links. link: a symlink, kept as its target only. */
	files: { name: string; dest: string; mode: string; dir?: boolean; link?: string }[];
	sudo: boolean;
	/** A .deb point: its one file is the old version's package, put back with dpkg -i. Older points on disk carry this. */
	deb?: boolean;
	/** An .rpm point: its one file is the old version's package, put back with rpm -U --oldpackage. */
	rpm?: boolean;
	/** A command app's point: no files, only the argv that puts this version back. */
	command?: string[];
	/** The tag that argv was filled with, so a later point of another version writes its tag the same way. */
	tag?: string;
	/** keep_with_restore paths saved in the point, each under upkeep-config/<i>, with where it goes back. */
	config?: SavedConfig[];
	tree?: {
		/** The app's table as it was at the run, so recovery and restore never depend on a later edit. */
		spec: AppSpec;
		dir: string | null;
		/** What keep and hold may touch: dir, or the stage's parent for a table with no dir. Older points have none. */
		scope?: string | null;
		/** The stage this run builds into, so a recovery at step build can remove a half-built one. */
		stage?: string | null;
		commit: string | null;
		kept: { rel: string; link: boolean }[];
		records: string[];
		needs: string[];
		/** place targets that were directories, saved under the point as placed-<i>. */
		placed: { to: string; name: string }[];
	};
};

/** Under data, not cache, so clearing the cache never costs a restore point. The key is not checked here. */
export function backupDir(paths: Paths, key: string): string {
	return join(paths.data, "backups", key);
}

/**
 * A version as a restore point's folder name. A version is whatever a check printed, so one with a slash, or one
 * that is empty, . or .., would name a folder outside the app's backups (and its delete would take them all).
 */
export function pointName(version: string): string {
	if (version === "" || version === "." || version === ".." || version.includes("/") || version.includes("\0"))
		throw new Error(MESSAGES.pointNameRefused(JSON.stringify(version)));
	return version;
}

/**
 * A point for an app whose files are not Upkeep's to copy: a .deb or .rpm (pass the kind and the old version's package) or a
 * command app (pass the argv that installs this version again as command). Built aside and renamed in, as takeBackup's.
 */
export function takePoint(
	paths: Paths,
	spec: Pick<AppSpec, "key" | "keep_with_restore">,
	version: string,
	how: { package: PackageKind; file: string } | { command: string[]; tag?: string },
	at = new Date().toISOString(),
	log: (line: string) => void = () => undefined,
): RestorePoint {
	const dir = join(backupDir(paths, spec.key), pointName(version));
	const tmp = `${dir}.upkeep-tmp`;
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp, { recursive: true });
	try {
		const meta: BackupMeta = { version, at, files: [], sudo: false };
		if ("package" in how) {
			const name = basename(how.file);
			copyFileSync(how.file, join(tmp, name));
			meta.files.push({ name, dest: "", mode: "644" });
			meta[how.package] = true;
		} else {
			meta.command = how.command;
			meta.tag = how.tag;
		}
		const config = saveConfig(tmp, spec, paths, log);
		if (config.length > 0) meta.config = config;
		writeFileSync(join(tmp, "meta.json"), JSON.stringify(meta, null, "\t"));
		dropTree(dir, paths);
		renameSync(tmp, dir);
	} catch (err) {
		rmSync(tmp, { recursive: true, force: true });
		throw err;
	}
	return { version, at };
}

/** Copies each installed file aside before an install, and the app's keep_with_restore paths. files are absolute paths that exist. */
export function takeBackup(
	paths: Paths,
	spec: Pick<AppSpec, "key" | "sudo" | "keep_with_restore">,
	version: string,
	files: string[],
	at = new Date().toISOString(),
	log: (line: string) => void = () => undefined,
): RestorePoint {
	const dir = join(backupDir(paths, spec.key), pointName(version));
	// Built aside and renamed in: a copy that fails (disk full, unreadable file) must not cost the old point.
	const tmp = `${dir}.upkeep-tmp`;
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp, { recursive: true });
	try {
		const meta: BackupMeta = { version, at, files: [], sudo: spec.sudo === true };
		for (const file of files) {
			const name = basename(file);
			const st = lstatSync(file);
			// The raw mode carries file-type bits that install -m rejects.
			const mode = (st.mode & 0o7777).toString(8);
			if (st.isSymbolicLink()) meta.files.push({ name, dest: file, mode, link: readlinkSync(file) });
			else if (st.isDirectory()) {
				// Its own name in the point: a folder app's folder and its program share a base name (kitty).
				cpSync(file, join(tmp, `folder-${name}`), { recursive: true, verbatimSymlinks: true });
				meta.files.push({ name: `folder-${name}`, dest: file, mode, dir: true });
			} else {
				copyFileSync(file, join(tmp, name));
				meta.files.push({ name, dest: file, mode });
			}
		}
		const config = saveConfig(tmp, spec, paths, log);
		if (config.length > 0) meta.config = config;
		writeFileSync(join(tmp, "meta.json"), JSON.stringify(meta, null, "\t"));
		dropTree(dir, paths);
		renameSync(tmp, dir);
	} catch (err) {
		rmSync(tmp, { recursive: true, force: true });
		throw err;
	}
	return { version, at };
}

/** Null for a missing or malformed meta.json, which listBackups then leaves out. File entries are not checked. */
export function readMeta(dir: string): BackupMeta | null {
	try {
		// SAFETY: takeBackup wrote this file as a BackupMeta; the next line checks version, at and files, and the rest is trusted as written.
		const m = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as BackupMeta;
		return typeof m.version === "string" && typeof m.at === "string" && Array.isArray(m.files) ? m : null;
	} catch {
		return null;
	}
}

/** Newest first. */
export function listBackups(paths: Paths, key: string): RestorePoint[] {
	const root = backupDir(paths, key);
	if (!existsSync(root)) return [];
	const points: RestorePoint[] = [];
	for (const name of readdirSync(root)) {
		// A point still being built when the process died. prune removes it.
		if (name.endsWith(".upkeep-tmp") || name.includes(".upkeep-drop.")) continue;
		const meta = readMeta(join(root, name));
		if (!meta) continue;
		const point: RestorePoint = { version: meta.version, at: meta.at };
		if (meta.config?.length) point.config = true;
		points.push(point);
	}
	return points.toSorted((a, b) => b.at.localeCompare(a.at));
}

/**
 * Puts a restore point back (each file where it came from, with its old mode), then records its version at dest.
 * config is the current table's keep_with_restore: only those of the point's saved settings go back, and none when it
 * is absent. A rollback after an install step failed passes none, since the new version never ran.
 */
export async function restoreBackup(
	paths: Paths,
	spec: Pick<AppSpec, "key" | "dest">,
	version: string,
	run: Run,
	config?: string[],
): Promise<{ ok: boolean; detail?: string }> {
	const r = await putBack(paths, spec, version, run, config ?? []);
	// The file back at dest is the point's version: recorded, for a program that cannot name its own.
	if (r.ok && spec.dest) stampInstalled(paths, spec.key, expandHome(spec.dest, paths.home), version);
	return r;
}

/** Puts one restore point back: its command, its package, or its files one at a time, then the settings config names. */
async function putBack(
	paths: Paths,
	spec: Pick<AppSpec, "key">,
	version: string,
	run: Run,
	config: string[],
): Promise<{ ok: boolean; detail?: string }> {
	const dir = join(backupDir(paths, spec.key), version);
	// A half-built point has a meta file and maybe not every file: it is never a version to go back to.
	const meta = version.endsWith(".upkeep-tmp") ? null : readMeta(dir);
	if (!meta) return { ok: false, detail: MESSAGES.noRestorePoint(version) };
	try {
		await unpackPoint(dir, paths, run);
	} catch (err) {
		return { ok: false, detail: err instanceof Error ? err.message : String(err) };
	}
	const settingsBack = () => configBack(dir, meta, paths, spec.key, config);
	if (meta.command) {
		const r = await run(meta.command, { timeoutMs: 600_000, cwd: paths.home });
		if (sudoNeedsPassword(r)) return { ok: false, detail: SUDO_PASSWORD };
		return r.code === 0
			? settingsBack()
			: { ok: false, detail: MESSAGES.commandExited(meta.command.join(" "), r.code) };
	}
	const kind = meta.deb ? "deb" : meta.rpm ? "rpm" : null;
	if (kind && isPackage(kind)) {
		const file = join(dir, meta.files[0]?.name ?? "");
		const r = await run(asRoot(packageInstall(kind, file), true), { timeoutMs: 600_000 });
		if (sudoNeedsPassword(r)) return { ok: false, detail: SUDO_PASSWORD };
		return r.code === 0
			? settingsBack()
			: { ok: false, detail: MESSAGES.packageCouldNotPutBack(PACKAGE_TOOL[kind], version) };
	}
	for (const f of meta.files) {
		if (f.link !== undefined || f.dir) {
			try {
				if (f.link !== undefined) relink(f.link, f.dest);
				else swapFolder(join(dir, f.name), f.dest, paths, true);
			} catch (err) {
				return {
					ok: false,
					detail: MESSAGES.couldNotRestoreFile(f.name, err instanceof Error ? err.message : String(err)),
				};
			}
			continue;
		}
		// oxlint-disable-next-line no-await-in-loop -- files go back one at a time so a failure stops the rest
		const r = await installAside(run, join(dir, f.name), f.dest, f.mode, meta.sudo);
		if (sudoNeedsPassword(r)) return { ok: false, detail: SUDO_PASSWORD };
		if (r.code !== 0) return { ok: false, detail: MESSAGES.couldNotRestoreFile(f.name, (r.stderr || r.stdout).trim()) };
	}
	return settingsBack();
}

/** putConfigBack as a restore result: ok, or the path that could not go back and why. */
function configBack(
	point: string,
	meta: BackupMeta,
	paths: Paths,
	key: string,
	config: string[],
): { ok: boolean; detail?: string } {
	try {
		putConfigBack(point, meta.config ?? [], paths, key, config);
		return { ok: true };
	} catch (err) {
		return { ok: false, detail: err instanceof Error ? err.message : String(err) };
	}
}

/** Settings bigger than this stay out of a restore point, with a log line: a browser profile can be gigabytes. */
const CONFIG_CAP = 200 * 1024 * 1024;

/** The folder in a point that holds its settings; a name no installed file or record takes. */
export const CONFIG_DIR = "upkeep-config";

/** How many restores' replaced settings are kept in config-aside/<key>, newest first. */
const ASIDE_KEEP = 3;

/** One keep_with_restore path in a point: name is its place in the point, path the absolute path it goes back to. */
export type SavedConfig = { path: string; name: string };

/** Whether anything is at p, a broken link included. */
function there(p: string): boolean {
	try {
		lstatSync(p);
		return true;
	} catch {
		return false;
	}
}

/** A keep_with_restore entry as the absolute path it names: ~ expanded, no trailing slash, so every comparison agrees. */
export function configPath(raw: string, home: string): string {
	return expandHome(raw, home).replace(/\/+$/, "");
}

/** Whether p is at or under root, compared as resolved absolute paths. */
const atOrUnder = (p: string, root: string) => p === root || p.startsWith(`${root}/`);

/**
 * Why Upkeep will not save or swap the live path p, or null. p must be strictly under home and outside Upkeep's own
 * folders (a restore would roll back the app list, or copy backups into themselves). A link is refused: a dotfiles
 * folder linked in would be saved as a 20-byte link and the swap would put no settings back. A mount point (or any
 * path on another file system than its parent) is refused: a swap renames, and a mount cannot be renamed. Checked at
 * the time, not at load: a path can become a link or a mount after the table was written.
 */
function configPathProblem(p: string, paths: Paths): string | null {
	if (!p.startsWith(`${paths.home}/`) || p.split("/").includes("..")) return "it is not under home";
	if ([paths.config, paths.state, paths.data, paths.cache].some((own) => atOrUnder(p, own) || atOrUnder(own, p)))
		return "it holds Upkeep's own files";
	if (!there(p)) return null;
	if (lstatSync(p).isSymbolicLink()) return "it is a link; name the folder it points to";
	if (statSync(p).dev !== statSync(dirname(p)).dev) return "it is a mount point";
	return null;
}

/** Whether the trees at a and b hold the same names, links and bytes. Links are compared, never followed. */
function sameTree(a: string, b: string): boolean {
	const sa = lstatSync(a, { throwIfNoEntry: false });
	const sb = lstatSync(b, { throwIfNoEntry: false });
	if (!sa || !sb) return false;
	if (sa.isSymbolicLink() || sb.isSymbolicLink())
		return sa.isSymbolicLink() && sb.isSymbolicLink() && readlinkSync(a) === readlinkSync(b);
	if (sa.isDirectory() !== sb.isDirectory()) return false;
	if (sa.isDirectory()) {
		const na = readdirSync(a).toSorted();
		const nb = readdirSync(b).toSorted();
		return na.length === nb.length && na.every((n, i) => n === nb[i] && sameTree(join(a, n), join(b, n)));
	}
	return sa.isFile() && sb.isFile() && sa.size === sb.size && readFileSync(a).equals(readFileSync(b));
}

/**
 * Copies each keep_with_restore path into <into>/upkeep-config/<i>, links inside kept as links, mode and times kept.
 * A path that is missing, over CONFIG_CAP, refused by configPathProblem or that fails to copy is left out with a log
 * line: settings never cost the update. The copy is taken while the app may run, so a file it is writing that moment
 * can be caught half-written.
 */
export function saveConfig(
	into: string,
	spec: Pick<AppSpec, "key" | "keep_with_restore">,
	paths: Paths,
	log: (line: string) => void,
): SavedConfig[] {
	const saved: SavedConfig[] = [];
	const leftOut = (raw: string, why: string) => log(`Left ${raw} out of the restore point of ${spec.key}: ${why}.`);
	for (const [i, raw] of (spec.keep_with_restore ?? []).entries()) {
		const path = configPath(raw, paths.home);
		if (!there(path)) continue;
		const problem = configPathProblem(path, paths);
		if (problem) {
			leftOut(raw, problem);
			continue;
		}
		const size = bytesOf(path);
		if (size > CONFIG_CAP) {
			leftOut(raw, `${Math.round(size / 1024 / 1024)} MB is over 200 MB`);
			continue;
		}
		const name = join(CONFIG_DIR, String(i));
		try {
			mkdirSync(join(into, CONFIG_DIR), { recursive: true });
			cpSync(path, join(into, name), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
			saved.push({ path, name });
		} catch (err) {
			rmSync(join(into, name), { recursive: true, force: true });
			leftOut(raw, err instanceof Error ? err.message : String(err));
		}
	}
	return saved;
}

/**
 * Puts a point's saved settings back, each copied in beside the live path and then renamed over it. Only paths the
 * current table still names go back (config, as written in the table), never one only the point recorded. What was
 * live is moved first to <data>/config-aside/<key>/<n>-<at>/<i>, a numbered folder of this restore's own, so a retry or
 * a second restore never deletes it; the lowest numbers are pruned to ASIDE_KEEP only after a whole put-back. A crash
 * between the two renames leaves the live path missing, with the replaced copy whole in the aside and the point's copy
 * at <path>.upkeep-new; pressing Restore again finishes it. A live path that is
 * already the point's copy is skipped, so a rerun after a cut changes nothing. When the copy cannot be renamed in, the
 * live path is moved back from the aside. A path missing from the point is left as it is. Throws on the first path
 * that cannot go back, or that is now a link or a mount point, before touching it.
 */
export function putConfigBack(
	point: string,
	saved: SavedConfig[],
	paths: Paths,
	key: string,
	config: string[],
	at = new Date().toISOString(),
	rename: (from: string, to: string) => void = renameSync,
): void {
	const named = new Set(config.map((c) => configPath(c, paths.home)));
	const todo = saved.filter((c) => named.has(c.path) && there(join(point, c.name)));
	if (todo.length === 0) return;
	const root = join(paths.data, "config-aside", key);
	// Numbered, not dated: a clock set back must never make the newest aside look oldest and be pruned.
	const aside = join(root, `${String((asideSeqs(root)[0] ?? 0) + 1).padStart(6, "0")}-${at.replace(/[:.]/g, "-")}`);
	let used = false;
	for (const [i, c] of todo.entries()) {
		const src = join(point, c.name);
		const fail = (why: string, cause?: unknown) => new Error(MESSAGES.couldNotRestoreFile(c.path, why), { cause });
		const problem = configPathProblem(c.path, paths);
		if (problem) throw fail(problem);
		const next = `${c.path}.upkeep-new`;
		const to = join(aside, String(i));
		let moved = false;
		try {
			if (sameTree(src, c.path)) continue;
			rmSync(next, { recursive: true, force: true });
			mkdirSync(dirname(c.path), { recursive: true });
			cpSync(src, next, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
			if (there(c.path)) {
				mkdirSync(aside, { recursive: true });
				used = true;
				try {
					rename(c.path, to);
					moved = true;
				} catch {
					// Data on another file system: a whole copy in the aside first, then the live path goes by a rename beside it.
					cpSync(c.path, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
					// From here the aside holds all of it, so a failure below puts the live path back from there.
					moved = true;
					rename(c.path, `${c.path}.upkeep-old`);
					dropTree(`${c.path}.upkeep-old`, paths);
				}
			}
			rename(next, c.path);
		} catch (err) {
			try {
				rmSync(next, { recursive: true, force: true });
			} catch {
				// Left for the next try, which clears it first.
			}
			// The live path is never left missing: what was moved aside goes back where it was.
			if (moved && !there(c.path))
				cpSync(to, c.path, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
			throw fail(err instanceof Error ? err.message : String(err), err);
		}
	}
	if (used) {
		const keep = new Set(asideSeqs(root).slice(0, ASIDE_KEEP));
		for (const name of readdirSync(root)) if (!keep.has(seqOf(name))) dropTree(join(root, name), paths);
	}
}

/** The number an aside's name starts with; 0 for a name without one, which is then the oldest. */
const seqOf = (name: string) => Number.parseInt(/^\d+/.exec(name)?.[0] ?? "0", 10);

/** The numbers of the asides under root, newest first, with 0 last so an empty root starts at 1. */
function asideSeqs(root: string): number[] {
	const seqs = there(root) ? readdirSync(root).map(seqOf) : [];
	return [...seqs, 0].toSorted((a, b) => b - a);
}

/** Points link at target, by a new link renamed over it, so the name is never missing. One already pointing there is left alone. */
export function relink(target: string, link: string): void {
	try {
		if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === target) return;
	} catch {
		// not there yet
	}
	const next = `${link}.upkeep-new`;
	rmSync(next, { force: true });
	symlinkSync(target, next);
	renameSync(next, link);
}

/**
 * Puts src in place as folder: beside it first, then two renames, so a running copy keeps the files it has open and
 * the folder is missing only between the renames. The old folder is dropped. copy keeps src (a restore point's copy);
 * without it src is moved, falling back to a copy across file systems.
 */
export function swapFolder(src: string, folder: string, paths: Pick<Paths, "cache">, copy = false): void {
	const next = `${folder}.upkeep-new`;
	rmSync(next, { recursive: true, force: true });
	mkdirSync(dirname(folder), { recursive: true });
	if (copy) cpSync(src, next, { recursive: true, verbatimSymlinks: true });
	else
		try {
			renameSync(src, next);
		} catch {
			cpSync(src, next, { recursive: true, verbatimSymlinks: true });
		}
	const old = `${folder}.upkeep-old`;
	dropTree(old, paths);
	if (existsSync(folder)) renameSync(folder, old);
	renameSync(next, folder);
	dropTree(old, paths);
}

/**
 * Deletes the oldest restore points beyond keep. At least one is always kept.
 * Also deletes every point left half-built by a process that died: takeBackup clears only its own version's.
 */
export function prune(paths: Paths, key: string, keep: number): void {
	const root = backupDir(paths, key);
	if (existsSync(root))
		for (const name of readdirSync(root))
			if (name.endsWith(".upkeep-tmp") || name.endsWith(".upkeep-unpack") || name.includes(".upkeep-drop."))
				dropTree(join(root, name), paths);
	for (const p of listBackups(paths, key).slice(Math.max(1, keep))) dropTree(join(root, p.version), paths);
}

/** A packed point's files, in its own folder beside meta.json, so the point is listed and read as before. */
const PACKED = ".upkeep-packed.tar.zst";
/** Marks a point that did not shrink by a tenth when packed, so it is not tried again. */
const PLAIN = ".upkeep-plain";

/** The bytes under p, links not followed; 0 for what cannot be read. */
function bytesOf(p: string): number {
	try {
		const st = lstatSync(p);
		if (!st.isDirectory()) return st.size;
		return readdirSync(p).reduce((n, name) => n + bytesOf(join(p, name)), 0);
	} catch {
		return 0;
	}
}

/** Whether the file starts as an AppImage does: ELF, with the type-2 magic at byte 8. False when it cannot be read. */
function isAppImageFile(file: string): boolean {
	let fd: number | null = null;
	try {
		fd = openSync(file, "r");
		const b = Buffer.alloc(11);
		return (
			readSync(fd, b, 0, 11, 0) === 11 &&
			b.toString("latin1", 0, 4) === "\x7fELF" &&
			b.toString("latin1", 8, 11) === "AI\x02"
		);
	} catch {
		return false;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

/**
 * Packs every restore point of key but the newest into one zstd tarball inside its folder: a source build's kept
 * trees and a folder app's folder halve or better. The newest stays plain, since a rollback right after a failed start
 * renames from it, with no unpack and no extra disk. Skipped: a package or command point (the package is compressed,
 * a command has no files), a point whose files are all AppImages (squashfs, nothing to gain), unless the point also
 * holds keep_with_restore settings, and one that did not
 * shrink by a tenth before. The tarball is written aside and renamed in before the plain files go, so a cut run
 * leaves a whole tarball or none, and the next run finishes the delete. Needs GNU tar with zstd; when tar fails the
 * points stay plain and it is tried again after the next update. Never throws.
 */
export async function packOlder(paths: Paths, key: string, run: Run, log: (line: string) => void): Promise<void> {
	const root = backupDir(paths, key);
	for (const p of listBackups(paths, key).slice(1)) {
		const point = join(root, p.version);
		const meta = readMeta(point);
		// Settings pack well, so a point holding them is packed whatever its kind.
		const settings = (meta?.config?.length ?? 0) > 0;
		if (!meta || ((meta.deb || meta.rpm || meta.command) && !settings) || existsSync(join(point, PLAIN))) continue;
		const packed = join(point, PACKED);
		const tmp = `${packed}.upkeep-tmp`;
		const failed = (why: string) => log(`Could not pack the ${p.version} restore point of ${key}: ${why}`);
		try {
			rmSync(tmp, { force: true });
			const entries = readdirSync(point).filter((n) => n !== "meta.json" && n !== PACKED && n !== PLAIN);
			// A pack cut after its rename: the tarball is whole, so what is left plain goes.
			if (existsSync(packed)) {
				for (const n of entries) dropTree(join(point, n), paths);
				continue;
			}
			const files = meta.files.filter((f) => f.link === undefined);
			const images =
				!meta.tree && files.length > 0 && files.every((f) => !f.dir && isAppImageFile(join(point, f.name)));
			if (entries.length === 0 || (images && !settings)) continue;
			// oxlint-disable-next-line no-await-in-loop -- one tarball at a time, so two never fill the disk together
			const r = await run(["tar", "--zstd", "-cf", tmp, "-C", point, "--", ...entries], { timeoutMs: 600_000 });
			if (r.code !== 0) {
				rmSync(tmp, { force: true });
				failed((r.stderr || r.stdout).trim());
				return;
			}
			const before = entries.reduce((n, e) => n + bytesOf(join(point, e)), 0);
			if (statSync(tmp).size > before * 0.9) {
				rmSync(tmp, { force: true });
				writeFileSync(join(point, PLAIN), "");
				continue;
			}
			renameSync(tmp, packed);
			for (const n of entries) dropTree(join(point, n), paths);
			log(`Packed the ${p.version} restore point of ${key}.`);
		} catch (err) {
			rmSync(tmp, { force: true });
			failed(err instanceof Error ? err.message : String(err));
		}
	}
}

/**
 * Makes a packed point plain again before it is put back: unpacked beside it into <point>.upkeep-unpack, each entry
 * renamed in over what a cut pack left, then the tarball removed. A plain point is left as it is. Throws when tar
 * fails, with the tarball kept, so nothing of the point is lost.
 */
export async function unpackPoint(point: string, paths: Pick<Paths, "cache">, run: Run): Promise<void> {
	const packed = join(point, PACKED);
	if (!existsSync(packed)) return;
	const aside = `${point}.upkeep-unpack`;
	dropTree(aside, paths);
	mkdirSync(aside, { recursive: true });
	const r = await run(["tar", "--zstd", "-xpf", packed, "-C", aside], { timeoutMs: 600_000 });
	if (r.code !== 0) {
		dropTree(aside, paths);
		throw new Error(MESSAGES.couldNotUnpackPoint(basename(point), (r.stderr || r.stdout).trim()));
	}
	for (const name of readdirSync(aside)) {
		dropTree(join(point, name), paths);
		renameSync(join(aside, name), join(point, name));
	}
	dropTree(aside, paths);
	rmSync(packed, { force: true });
}
