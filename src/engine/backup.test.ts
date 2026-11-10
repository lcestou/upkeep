import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listBackups, prune, restoreBackup, takeBackup } from "./backup";
import { realRun, recordingRun, tempHome } from "./testkit";

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("backup");
});
afterEach(() => t.cleanup());

test("a backup copies the files with their modes and restores them", async () => {
	const zen = join(t.dir, "zen.AppImage");
	writeFileSync(zen, "old zen");
	chmodSync(zen, 0o775);
	const point = takeBackup(t.paths, { key: "zen" }, "1.17.1b", [zen], "2026-11-10T10:00:00.000Z");
	expect(point).toEqual({ version: "1.17.1b", at: "2026-11-10T10:00:00.000Z" });
	const meta = JSON.parse(readFileSync(join(t.paths.data, "backups/zen/1.17.1b/meta.json"), "utf8"));
	expect(meta).toEqual({
		version: "1.17.1b",
		at: "2026-11-10T10:00:00.000Z",
		files: [{ name: "zen.AppImage", dest: zen, mode: "775" }],
		sudo: false,
	});
	writeFileSync(zen, "new zen");
	chmodSync(zen, 0o644);
	expect(await restoreBackup(t.paths, { key: "zen" }, "1.17.1b", realRun(t.paths))).toEqual({ ok: true });
	expect(readFileSync(zen, "utf8")).toBe("old zen");
	expect(statSync(zen).mode & 0o7777).toBe(0o775);
});

test("a sudo backup restores through sudo -n install, and a password prompt fails plainly", async () => {
	const f = join(t.dir, "starship");
	writeFileSync(f, "s");
	chmodSync(f, 0o755);
	takeBackup(t.paths, { key: "starship", sudo: true }, "1.24.0", [f]);
	const { run, calls } = recordingRun(t.paths, () => ({
		code: 1,
		stdout: "",
		stderr: "sudo: a password is required\n",
		timedOut: false,
	}));
	expect(await restoreBackup(t.paths, { key: "starship" }, "1.24.0", run)).toEqual({
		ok: false,
		detail: "sudo needs a password here. Run the update from a terminal.",
	});
	expect(calls[0]?.argv).toEqual([
		"sudo",
		"-n",
		"install",
		"-m",
		"755",
		join(t.paths.data, "backups/starship/1.24.0/starship"),
		f,
	]);
});

test("listBackups is newest first and prune keeps at least one", () => {
	const f = join(t.dir, "bat");
	writeFileSync(f, "b");
	takeBackup(t.paths, { key: "bat" }, "0.24.0", [f], "2026-01-01T00:00:00.000Z");
	takeBackup(t.paths, { key: "bat" }, "0.26.1", [f], "2026-03-01T00:00:00.000Z");
	takeBackup(t.paths, { key: "bat" }, "0.25.0", [f], "2026-02-01T00:00:00.000Z");
	expect(listBackups(t.paths, "bat").map((p) => p.version)).toEqual(["0.26.1", "0.25.0", "0.24.0"]);
	prune(t.paths, "bat", 2);
	expect(listBackups(t.paths, "bat").map((p) => p.version)).toEqual(["0.26.1", "0.25.0"]);
	prune(t.paths, "bat", 0);
	expect(listBackups(t.paths, "bat").map((p) => p.version)).toEqual(["0.26.1"]);
	expect(listBackups(t.paths, "none")).toEqual([]);
});

test("restoring a version with no restore point says so", async () => {
	expect(await restoreBackup(t.paths, { key: "x" }, "1.0", realRun(t.paths))).toEqual({
		ok: false,
		detail: "No restore point 1.0.",
	});
});
