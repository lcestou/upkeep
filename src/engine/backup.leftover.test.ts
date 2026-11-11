import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listBackups, takeBackup } from "./backup";
import { tempHome } from "./testkit";

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("backup-leftover");
});
afterEach(() => t.cleanup());

test("a restore point left half made by a crash is not listed as a second one", () => {
	const f = join(t.paths.home, "tool");
	writeFileSync(f, "v1");
	takeBackup(t.paths, { key: "tool" }, "1.0", [f], "2026-11-11T00:00:00.000Z");
	const root = join(t.paths.data, "backups", "tool");
	// What a crash between writing meta.json and the rename leaves behind.
	cpSync(join(root, "1.0"), join(root, "1.0.upkeep-tmp"), { recursive: true });
	expect(listBackups(t.paths, "tool").map((p) => p.version)).toEqual(["1.0"]);
});
