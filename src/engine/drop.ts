import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Paths } from "./paths";

let seq = 0;
const pending = new Set<Promise<void>>();

/** The folder trees wait in while they are deleted. */
const trashOf = (paths: Pick<Paths, "cache">) => join(paths.cache, "trash");

/**
 * Removes path without stopping the event loop, which a synchronous delete of a gigabyte build tree does for
 * seconds. The tree is renamed into the cache's trash at once, so path is gone when this returns, and is deleted on
 * the thread pool after. Across file systems the rename fails, and it is renamed beside itself instead; when even
 * that fails (a root-owned parent), it is deleted here and now. A missing path is fine.
 */
export function dropTree(path: string, paths: Pick<Paths, "cache">): void {
	try {
		lstatSync(path);
	} catch {
		return;
	}
	seq += 1;
	const name = `${basename(path)}.${process.pid}.${seq}`;
	let aside = join(trashOf(paths), name);
	try {
		mkdirSync(trashOf(paths), { recursive: true });
		renameSync(path, aside);
	} catch {
		aside = `${path}.upkeep-drop.${process.pid}.${seq}`;
		try {
			renameSync(path, aside);
		} catch {
			rmSync(path, { recursive: true, force: true });
			return;
		}
	}
	const done: Promise<void> = rm(aside, { recursive: true, force: true })
		.catch(() => {
			// left for sweepTrash on the next start
		})
		.finally(() => pending.delete(done));
	pending.add(done);
}

/** Resolves once every delete dropTree started has finished. */
export async function dropsSettled(): Promise<void> {
	await Promise.all(pending);
}

/** Deletes, in the background, what an earlier process left in the trash when it quit or died mid-delete. */
export function sweepTrash(paths: Pick<Paths, "cache">): void {
	const trash = trashOf(paths);
	if (!existsSync(trash)) return;
	for (const name of readdirSync(trash)) if (!name.includes(`.${process.pid}.`)) dropTree(join(trash, name), paths);
}
