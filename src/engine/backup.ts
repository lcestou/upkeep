import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { AppSpec, RestorePoint } from "../shared/types";
import type { Paths } from "./paths";
import { installAside, type Run, SUDO_PASSWORD, sudoNeedsPassword } from "./run";

export type BackupMeta = {
	version: string;
	at: string;
	files: { name: string; dest: string; mode: string }[];
	sudo: boolean;
	tree?: {
		/** The app's table as it was at the run, so recovery and restore never depend on a later edit. */
		spec: AppSpec;
		dir: string | null;
		commit: string | null;
		kept: { rel: string; link: boolean }[];
		records: string[];
		needs: string[];
		/** place targets that were directories, saved under the point as placed-<i>. */
		placed: { to: string; name: string }[];
	};
};

function backupDir(paths: Paths, key: string): string {
	return join(paths.data, "backups", key);
}

/** Copies each installed file aside before an install. files are absolute paths that exist. */
export function takeBackup(
	paths: Paths,
	spec: Pick<AppSpec, "key" | "sudo">,
	version: string,
	files: string[],
	at = new Date().toISOString(),
): RestorePoint {
	const dir = join(backupDir(paths, spec.key), version);
	// Built aside and renamed in: a copy that fails (disk full, unreadable file) must not cost the old point.
	const tmp = `${dir}.upkeep-tmp`;
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp, { recursive: true });
	try {
		const meta: BackupMeta = { version, at, files: [], sudo: spec.sudo === true };
		for (const file of files) {
			const name = basename(file);
			copyFileSync(file, join(tmp, name));
			// The raw mode carries file-type bits that install -m rejects.
			meta.files.push({ name, dest: file, mode: (statSync(file).mode & 0o7777).toString(8) });
		}
		writeFileSync(join(tmp, "meta.json"), JSON.stringify(meta, null, "\t"));
		rmSync(dir, { recursive: true, force: true });
		renameSync(tmp, dir);
	} catch (err) {
		rmSync(tmp, { recursive: true, force: true });
		throw err;
	}
	return { version, at };
}

function readMeta(dir: string): BackupMeta | null {
	try {
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
		const meta = readMeta(join(root, name));
		if (meta) points.push({ version: meta.version, at: meta.at });
	}
	return points.toSorted((a, b) => b.at.localeCompare(a.at));
}

/** Installs each backed-up file back where it came from, with its old mode. */
export async function restoreBackup(
	paths: Paths,
	spec: Pick<AppSpec, "key">,
	version: string,
	run: Run,
): Promise<{ ok: boolean; detail?: string }> {
	const dir = join(backupDir(paths, spec.key), version);
	const meta = readMeta(dir);
	if (!meta) return { ok: false, detail: `No restore point ${version}.` };
	for (const f of meta.files) {
		// oxlint-disable-next-line no-await-in-loop -- files go back one at a time so a failure stops the rest
		const r = await installAside(run, join(dir, f.name), f.dest, f.mode, meta.sudo);
		if (sudoNeedsPassword(r)) return { ok: false, detail: SUDO_PASSWORD };
		if (r.code !== 0) return { ok: false, detail: `Could not restore ${f.name}: ${(r.stderr || r.stdout).trim()}` };
	}
	return { ok: true };
}

/** Deletes the oldest restore points beyond keep. At least one is always kept. */
export function prune(paths: Paths, key: string, keep: number): void {
	const points = listBackups(paths, key);
	for (const p of points.slice(Math.max(1, keep)))
		rmSync(join(backupDir(paths, key), p.version), { recursive: true, force: true });
}
