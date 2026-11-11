import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listBackups, prune, restoreBackup, takeBackup } from "./backup";
import { tempHome } from "./testkit";

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("backup-leftover");
});
afterEach(() => t.cleanup());

/** A runner that must not be reached. */
function never(): never {
	throw new Error("a half-made point must not reach the runner");
}

test("a restore point left half made by a crash is not listed as a second one", () => {
	const f = join(t.paths.home, "tool");
	writeFileSync(f, "v1");
	takeBackup(t.paths, { key: "tool" }, "1.0", [f], "2026-11-11T00:00:00.000Z");
	const root = join(t.paths.data, "backups", "tool");
	// What a crash between writing meta.json and the rename leaves behind.
	cpSync(join(root, "1.0"), join(root, "1.0.upkeep-tmp"), { recursive: true });
	expect(listBackups(t.paths, "tool").map((p) => p.version)).toEqual(["1.0"]);
});

test("pruning removes a half-made point of a version that is never taken again, and it cannot be restored", async () => {
	const f = join(t.paths.home, "tool");
	writeFileSync(f, "v2");
	takeBackup(t.paths, { key: "tool" }, "2.0", [f], "2026-11-11T00:00:00.000Z");
	const root = join(t.paths.data, "backups", "tool");
	cpSync(join(root, "2.0"), join(root, "1.0.upkeep-tmp"), { recursive: true });
	expect(await restoreBackup(t.paths, { key: "tool" }, "1.0.upkeep-tmp", never)).toEqual({
		ok: false,
		detail: "No restore point 1.0.upkeep-tmp.",
	});
	prune(t.paths, "tool", 3);
	expect(existsSync(join(root, "1.0.upkeep-tmp"))).toBe(false);
	expect(listBackups(t.paths, "tool").map((p) => p.version)).toEqual(["2.0"]);
});
