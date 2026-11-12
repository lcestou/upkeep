import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dropsSettled, dropTree, sweepTrash } from "./drop";
import { tempHome } from "./testkit";

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("drop");
});
afterEach(() => {
	chmodSync(t.dir, 0o755);
	t.cleanup();
});

/** A small tree with a nested file, so a delete has something to walk. */
function tree(at: string): string {
	mkdirSync(join(at, "a/b"), { recursive: true });
	writeFileSync(join(at, "a/b/f"), "x");
	return at;
}

test("a dropped tree is gone at once and deleted from the trash after", async () => {
	const p = tree(join(t.dir, "build-old"));
	dropTree(p, t.paths);
	expect(existsSync(p)).toBe(false);
	await dropsSettled();
	expect(readdirSync(join(t.paths.cache, "trash"))).toEqual([]);
	dropTree(join(t.dir, "missing"), t.paths);
	await dropsSettled();
});

test("when the trash cannot take it, the tree is renamed beside itself; when nothing can be renamed it is deleted now", async () => {
	writeFileSync(join(t.dir, "cache-file"), "");
	const paths = { cache: join(t.dir, "cache-file", "x") };
	const p = tree(join(t.dir, "stage"));
	dropTree(p, paths);
	expect(existsSync(p)).toBe(false);
	await dropsSettled();
	expect(readdirSync(t.dir).filter((n) => n.includes(".upkeep-drop."))).toEqual([]);
	const locked = join(t.dir, "locked");
	const q = tree(join(locked, "tree"));
	chmodSync(locked, 0o555);
	// Neither rename nor delete can work in a read-only parent: it fails as a plain delete would.
	expect(() => dropTree(q, paths)).toThrow();
	chmodSync(locked, 0o755);
	expect(existsSync(q)).toBe(true);
});

test("the sweep deletes what an earlier process left in the trash", async () => {
	tree(join(t.paths.cache, "trash", "build-old.1.1"));
	sweepTrash(t.paths);
	await dropsSettled();
	expect(readdirSync(join(t.paths.cache, "trash"))).toEqual([]);
	sweepTrash({ cache: join(t.dir, "nothing") });
});

test("a background delete that fails leaves the tree in the trash for the next sweep", async () => {
	const p = tree(join(t.dir, "stuck"));
	chmodSync(join(p, "a/b"), 0o555);
	dropTree(p, t.paths);
	await dropsSettled();
	const trash = join(t.paths.cache, "trash");
	const [left] = readdirSync(trash);
	expect(left).toStartWith("stuck.");
	chmodSync(join(trash, left ?? "", "a/b"), 0o755);
	// The sweep skips this process's own names, as a running delete may still own them; a later process takes it.
	sweepTrash(t.paths);
	await dropsSettled();
	expect(readdirSync(trash)).toEqual([left ?? ""]);
});
