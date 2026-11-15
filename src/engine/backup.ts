import {
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
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
	spec: Pick<AppSpec, "key">,
	version: string,
	how: { package: PackageKind; file: string } | { command: string[]; tag?: string },
	at = new Date().toISOString(),
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
		writeFileSync(join(tmp, "meta.json"), JSON.stringify(meta, null, "\t"));
		dropTree(dir, paths);
		renameSync(tmp, dir);
	} catch (err) {
		rmSync(tmp, { recursive: true, force: true });
		throw err;
	}
	return { version, at };
}

/** Copies each installed file aside before an install. files are absolute paths that exist. */
export function takeBackup(
	paths: Paths,
	spec: Pick<AppSpec, "key" | "sudo">,
	version: string,
	files: string[],
	at = new Date().toISOString(),
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
		if (meta) points.push({ version: meta.version, at: meta.at });
	}
	return points.toSorted((a, b) => b.at.localeCompare(a.at));
}

/** Puts a restore point back (each file where it came from, with its old mode), then records its version at dest. */
export async function restoreBackup(
	paths: Paths,
	spec: Pick<AppSpec, "key" | "dest">,
	version: string,
	run: Run,
): Promise<{ ok: boolean; detail?: string }> {
	const r = await putBack(paths, spec, version, run);
	// The file back at dest is the point's version: recorded, for a program that cannot name its own.
	if (r.ok && spec.dest) stampInstalled(paths, spec.key, expandHome(spec.dest, paths.home), version);
	return r;
}

/** Puts one restore point back: its command, its package, or its files one at a time. */
async function putBack(
	paths: Paths,
	spec: Pick<AppSpec, "key">,
	version: string,
	run: Run,
): Promise<{ ok: boolean; detail?: string }> {
	const dir = join(backupDir(paths, spec.key), version);
	// A half-built point has a meta file and maybe not every file: it is never a version to go back to.
	const meta = version.endsWith(".upkeep-tmp") ? null : readMeta(dir);
	if (!meta) return { ok: false, detail: MESSAGES.noRestorePoint(version) };
	if (meta.command) {
		const r = await run(meta.command, { timeoutMs: 600_000, cwd: paths.home });
		if (sudoNeedsPassword(r)) return { ok: false, detail: SUDO_PASSWORD };
		return r.code === 0 ? { ok: true } : { ok: false, detail: MESSAGES.commandExited(meta.command.join(" "), r.code) };
	}
	const kind = meta.deb ? "deb" : meta.rpm ? "rpm" : null;
	if (kind && isPackage(kind)) {
		const file = join(dir, meta.files[0]?.name ?? "");
		const r = await run(asRoot(packageInstall(kind, file), true), { timeoutMs: 600_000 });
		if (sudoNeedsPassword(r)) return { ok: false, detail: SUDO_PASSWORD };
		return r.code === 0
			? { ok: true }
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
	return { ok: true };
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
			if (name.endsWith(".upkeep-tmp") || name.includes(".upkeep-drop.")) dropTree(join(root, name), paths);
	for (const p of listBackups(paths, key).slice(Math.max(1, keep))) dropTree(join(root, p.version), paths);
}
