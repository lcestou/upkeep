import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listBackups, prune, restoreBackup, takeBackup, takePoint } from "./backup";
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
		`${f}.upkeep-new`,
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

test("a restore whose install fails says so and stops", async () => {
	const f = join(t.dir, "uv");
	writeFileSync(f, "u");
	takeBackup(t.paths, { key: "uv" }, "0.9.1", [f]);
	const { run } = recordingRun(t.paths, (argv) =>
		argv[0] === "install"
			? { code: 1, stdout: "", stderr: "install: No space left on device\n", timedOut: false }
			: undefined,
	);
	expect(await restoreBackup(t.paths, { key: "uv" }, "0.9.1", run)).toEqual({
		ok: false,
		detail: "Could not restore uv: install: No space left on device",
	});
});

test("re-taking a restore point replaces its files rather than adding to them", () => {
	const a = join(t.dir, "uv");
	const b = join(t.dir, "uvx");
	writeFileSync(a, "u");
	writeFileSync(b, "x");
	takeBackup(t.paths, { key: "uv" }, "0.9.1", [a, b]);
	takeBackup(t.paths, { key: "uv" }, "0.9.1", [a]);
	expect(readdirSync(join(t.paths.data, "backups/uv/0.9.1")).toSorted()).toEqual(["meta.json", "uv"]);
	expect(readdirSync(join(t.paths.data, "backups/uv"))).toEqual(["0.9.1"]);
});

test("a command point runs its restore argv, and one that wants a sudo password says so plainly", async () => {
	takePoint(t.paths, { key: "tool" }, "1.0.0", { command: ["sudo", "tool-pin", "1.0.0"] }, "2026-11-10T10:00:00.000Z");
	const { run, calls } = recordingRun(t.paths, () => ({
		code: 1,
		stdout: "",
		stderr: "sudo: a password is required",
		timedOut: false,
	}));
	expect(await restoreBackup(t.paths, { key: "tool" }, "1.0.0", run)).toEqual({
		ok: false,
		detail: "sudo needs a password here. Run the update from a terminal.",
	});
	expect(calls[0]?.argv).toEqual(["sudo", "tool-pin", "1.0.0"]);
});
