import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	listBackups,
	packOlder,
	prune,
	putConfigBack,
	restoreBackup,
	takeBackup,
	takePoint,
	unpackPoint,
} from "./backup";
import { ok, realRun, recordingRun, tempHome } from "./testkit";

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

test("a package point restores through its own tool: rpm -U --oldpackage, and dpkg -i for a deb point", async () => {
	const rpm = join(t.dir, "tool-1.0.0.rpm");
	const deb = join(t.dir, "tool-1.0.0.deb");
	writeFileSync(rpm, "r");
	writeFileSync(deb, "d");
	takePoint(t.paths, { key: "r" }, "1.0.0", { package: "rpm", file: rpm });
	takePoint(t.paths, { key: "d" }, "1.0.0", { package: "deb", file: deb });
	const meta = (key: string) => JSON.parse(readFileSync(join(t.paths.data, `backups/${key}/1.0.0/meta.json`), "utf8"));
	expect(meta("r")).toMatchObject({ rpm: true });
	expect(meta("r").deb).toBeUndefined();
	expect(meta("d")).toMatchObject({ deb: true });
	const ok = recordingRun(t.paths, () => ({ code: 0, stdout: "", stderr: "", timedOut: false }));
	expect(await restoreBackup(t.paths, { key: "r" }, "1.0.0", ok.run)).toEqual({ ok: true });
	expect(await restoreBackup(t.paths, { key: "d" }, "1.0.0", ok.run)).toEqual({ ok: true });
	expect(ok.calls[0]?.argv).toEqual([
		"sudo",
		"-n",
		"rpm",
		"-U",
		"--oldpackage",
		join(t.paths.data, "backups/r/1.0.0/tool-1.0.0.rpm"),
	]);
	expect(ok.calls[1]?.argv).toEqual(["sudo", "-n", "dpkg", "-i", join(t.paths.data, "backups/d/1.0.0/tool-1.0.0.deb")]);
	const bad = recordingRun(t.paths, () => ({ code: 1, stdout: "", stderr: "", timedOut: false }));
	expect(await restoreBackup(t.paths, { key: "r" }, "1.0.0", bad.run)).toEqual({
		ok: false,
		detail: "rpm could not put 1.0.0 back. See the log.",
	});
});

/** A folder app's folder: text that packs small, a mode, and a link inside it. */
function folderApp(text: string): string {
	const folder = join(t.paths.home, ".local/share/tool");
	mkdirSync(join(folder, "lib"), { recursive: true });
	writeFileSync(join(folder, "lib/data"), text.repeat(20_000));
	writeFileSync(join(folder, "tool"), "#!/bin/sh\n");
	chmodSync(join(folder, "tool"), 0o750);
	symlinkSync("lib/data", join(folder, "data-link"));
	return folder;
}

const entriesOf = (key: string, version: string) => readdirSync(join(t.paths.data, "backups", key, version)).toSorted();

test("older points are packed, the newest stays plain, and a packed one restores whole", async () => {
	const folder = folderApp("one ");
	const lines: string[] = [];
	const log = (l: string) => lines.push(l);
	takeBackup(t.paths, { key: "tool" }, "1.0", [folder], "2026-11-01T10:00:00.000Z");
	await packOlder(t.paths, "tool", realRun(t.paths), log);
	expect(entriesOf("tool", "1.0")).toEqual(["folder-tool", "meta.json"]);
	writeFileSync(join(folder, "lib/data"), "two ".repeat(20_000));
	takeBackup(t.paths, { key: "tool" }, "2.0", [folder], "2026-11-02T10:00:00.000Z");
	await packOlder(t.paths, "tool", realRun(t.paths), log);
	expect(entriesOf("tool", "1.0")).toEqual([".upkeep-packed.tar.zst", "meta.json"]);
	expect(entriesOf("tool", "2.0")).toEqual(["folder-tool", "meta.json"]);
	expect(lines).toEqual(["Packed the 1.0 restore point of tool."]);
	// Still listed, newest first, as before.
	expect(listBackups(t.paths, "tool").map((p) => p.version)).toEqual(["2.0", "1.0"]);
	expect(await restoreBackup(t.paths, { key: "tool" }, "1.0", realRun(t.paths))).toEqual({ ok: true });
	expect(readFileSync(join(folder, "lib/data"), "utf8")).toBe("one ".repeat(20_000));
	expect(statSync(join(folder, "tool")).mode & 0o7777).toBe(0o750);
	expect(readlinkSync(join(folder, "data-link"))).toBe("lib/data");
	// The point it came from is plain again, so a second restore needs no unpack.
	expect(entriesOf("tool", "1.0")).toEqual(["folder-tool", "meta.json"]);
	// Packing again finds nothing new to do on a packed point.
	await packOlder(t.paths, "tool", realRun(t.paths), log);
	await packOlder(t.paths, "tool", realRun(t.paths), log);
	expect(lines).toEqual(["Packed the 1.0 restore point of tool.", "Packed the 1.0 restore point of tool."]);
});

test("AppImages, packages, commands and what does not shrink stay plain, and a failed pack leaves the point as it was", async () => {
	const image = join(t.dir, "app.AppImage");
	const b = Buffer.alloc(64 * 1024);
	b.write("\x7fELF", 0, "latin1");
	b.write("AI\x02", 8, "latin1");
	writeFileSync(image, b);
	takeBackup(t.paths, { key: "img" }, "1.0", [image], "2026-11-01T10:00:00.000Z");
	takeBackup(t.paths, { key: "img" }, "2.0", [image], "2026-11-02T10:00:00.000Z");
	const deb = join(t.dir, "tool_1.0_amd64.deb");
	writeFileSync(deb, "deb ".repeat(10_000));
	takePoint(t.paths, { key: "pkg" }, "1.0", { package: "deb", file: deb }, "2026-11-01T10:00:00.000Z");
	takePoint(t.paths, { key: "pkg" }, "2.0", { package: "deb", file: deb }, "2026-11-02T10:00:00.000Z");
	takePoint(t.paths, { key: "cmd" }, "1.0", { command: ["x", "1.0"] }, "2026-11-01T10:00:00.000Z");
	takePoint(t.paths, { key: "cmd" }, "2.0", { command: ["x", "2.0"] }, "2026-11-02T10:00:00.000Z");
	const noise = join(t.dir, "noise.bin");
	writeFileSync(noise, crypto.getRandomValues(new Uint8Array(64 * 1024)));
	takeBackup(t.paths, { key: "noise" }, "1.0", [noise], "2026-11-01T10:00:00.000Z");
	takeBackup(t.paths, { key: "noise" }, "2.0", [noise], "2026-11-02T10:00:00.000Z");
	const { run, calls } = recordingRun(t.paths, () => undefined);
	for (const key of ["img", "pkg", "cmd", "noise"])
		// oxlint-disable-next-line no-await-in-loop -- one app at a time, as after each update
		await packOlder(t.paths, key, run, () => {});
	expect(calls.map((c) => c.argv.slice(0, 2).join(" "))).toEqual(["tar --zstd"]);
	expect(entriesOf("noise", "1.0")).toEqual([".upkeep-plain", "meta.json", "noise.bin"]);
	// Marked: not tried again.
	await packOlder(t.paths, "noise", run, () => {});
	expect(calls).toHaveLength(1);
	// tar without zstd: the point stays plain, the half-written tarball goes, and the log says why.
	const folder = folderApp("x");
	takeBackup(t.paths, { key: "tool" }, "1.0", [folder], "2026-11-01T10:00:00.000Z");
	takeBackup(t.paths, { key: "tool" }, "2.0", [folder], "2026-11-02T10:00:00.000Z");
	const lines: string[] = [];
	const none = recordingRun(t.paths, (argv) =>
		argv[0] === "tar" ? { code: 2, stdout: "", stderr: "tar: zstd: Cannot exec", timedOut: false } : undefined,
	);
	await packOlder(t.paths, "tool", none.run, (l) => lines.push(l));
	expect(entriesOf("tool", "1.0")).toEqual(["folder-tool", "meta.json"]);
	expect(lines).toEqual(["Could not pack the 1.0 restore point of tool: tar: zstd: Cannot exec"]);
});

test("a pack or an unpack cut short is finished by the next run, and a tarball that will not open is kept", async () => {
	const folder = folderApp("cut ");
	takeBackup(t.paths, { key: "tool" }, "1.0", [folder], "2026-11-01T10:00:00.000Z");
	takeBackup(t.paths, { key: "tool" }, "2.0", [folder], "2026-11-02T10:00:00.000Z");
	await packOlder(t.paths, "tool", realRun(t.paths), () => {});
	const point = join(t.paths.data, "backups/tool/1.0");
	// A pack cut between its rename and its delete: a leftover plain entry beside the whole tarball.
	mkdirSync(join(point, "folder-tool"));
	writeFileSync(join(point, "folder-tool/stale"), "half");
	writeFileSync(join(point, ".upkeep-packed.tar.zst.upkeep-tmp"), "partial");
	await packOlder(t.paths, "tool", realRun(t.paths), () => {});
	expect(entriesOf("tool", "1.0")).toEqual([".upkeep-packed.tar.zst", "meta.json"]);
	// An unpack cut short: what it left aside, and a half-moved entry in the point, give way to the tarball's.
	mkdirSync(`${point}.upkeep-unpack/folder-tool`, { recursive: true });
	mkdirSync(join(point, "folder-tool"));
	writeFileSync(join(point, "folder-tool/stale"), "half");
	await unpackPoint(point, t.paths, realRun(t.paths));
	expect(entriesOf("tool", "1.0")).toEqual(["folder-tool", "meta.json"]);
	expect(existsSync(join(point, "folder-tool/stale"))).toBe(false);
	expect(readFileSync(join(point, "folder-tool/lib/data"), "utf8")).toBe("cut ".repeat(20_000));
	expect(existsSync(`${point}.upkeep-unpack`)).toBe(false);
	// A tarball tar cannot open: the restore says so and the point keeps it.
	await packOlder(t.paths, "tool", realRun(t.paths), () => {});
	writeFileSync(join(point, ".upkeep-packed.tar.zst"), "not a tarball");
	const r = await restoreBackup(t.paths, { key: "tool" }, "1.0", realRun(t.paths));
	expect(r.ok).toBe(false);
	expect(r.detail).toStartWith("Could not unpack the 1.0 restore point: ");
	expect(entriesOf("tool", "1.0")).toEqual([".upkeep-packed.tar.zst", "meta.json"]);
	// A leftover unpack folder is cleared by prune, like a half-built point.
	mkdirSync(`${point}.upkeep-unpack`);
	prune(t.paths, "tool", 5);
	expect(existsSync(`${point}.upkeep-unpack`)).toBe(false);
});

/** An app's settings under the temp home: a folder with a file and a link, a lone file, and a neighbour no table names. */
function settings(text: string): { folder: string; file: string; neighbour: string } {
	const folder = join(t.paths.home, ".config/tool");
	const file = join(t.paths.home, ".toolrc");
	const neighbour = join(t.paths.home, ".config/other/keep.conf");
	mkdirSync(folder, { recursive: true });
	mkdirSync(join(t.paths.home, ".config/other"), { recursive: true });
	writeFileSync(join(folder, "settings.json"), text);
	rmSync(join(folder, "current"), { force: true });
	symlinkSync("settings.json", join(folder, "current"));
	writeFileSync(file, `rc ${text}`);
	writeFileSync(neighbour, `other ${text}`);
	return { folder, file, neighbour };
}

const NAMED = ["~/.config/tool", "~/.toolrc", "~/.config/missing"];
const WITH_CONFIG = { key: "tool", keep_with_restore: NAMED };
const asides = (key: string) => readdirSync(join(t.paths.data, "config-aside", key)).toSorted();
const asideOf = (key: string, n: number) => join(t.paths.data, "config-aside", key, asides(key)[n] ?? "none");

test("keep_with_restore travels with a restore point: saved, listed, put back, and what it replaced kept aside", async () => {
	const s = settings("v1");
	const bin = join(t.dir, "tool");
	writeFileSync(bin, "bin 1");
	takeBackup(t.paths, WITH_CONFIG, "1.0", [bin], "2026-11-10T10:00:00.000Z");
	const meta = JSON.parse(readFileSync(join(t.paths.data, "backups/tool/1.0/meta.json"), "utf8"));
	// The missing path is left out; the others are saved in the point's own folder.
	expect(meta.config).toEqual([
		{ path: s.folder, name: "upkeep-config/0" },
		{ path: s.file, name: "upkeep-config/1" },
	]);
	expect(listBackups(t.paths, "tool")).toEqual([{ version: "1.0", at: "2026-11-10T10:00:00.000Z", config: true }]);
	// The new version migrates its settings; a neighbour changes too, and no table names it.
	settings("v2");
	writeFileSync(bin, "bin 2");
	expect(await restoreBackup(t.paths, { key: "tool" }, "1.0", realRun(t.paths), NAMED)).toEqual({ ok: true });
	expect(readFileSync(bin, "utf8")).toBe("bin 1");
	expect(readFileSync(join(s.folder, "settings.json"), "utf8")).toBe("v1");
	expect(readlinkSync(join(s.folder, "current"))).toBe("settings.json");
	expect(readFileSync(s.file, "utf8")).toBe("rc v1");
	expect(readFileSync(s.neighbour, "utf8")).toBe("other v2");
	expect(existsSync(join(t.paths.home, ".config/missing"))).toBe(false);
	expect(existsSync(`${s.folder}.upkeep-new`)).toBe(false);
	// The settings it replaced are kept aside, so the restore loses nothing.
	expect(asides("tool")).toHaveLength(1);
	expect(readFileSync(join(asideOf("tool", 0), "0/settings.json"), "utf8")).toBe("v2");
	expect(readFileSync(join(asideOf("tool", 0), "1"), "utf8")).toBe("rc v2");
	// A table with no keep_with_restore takes and lists points as before.
	takeBackup(t.paths, { key: "plain" }, "1.0", [bin], "2026-11-10T10:00:00.000Z");
	expect(listBackups(t.paths, "plain")).toEqual([{ version: "1.0", at: "2026-11-10T10:00:00.000Z" }]);
});

test("a rollback that passes no settings, or a table that dropped a path, leaves those settings as they are", async () => {
	settings("v1");
	const bin = join(t.dir, "tool");
	writeFileSync(bin, "bin 1");
	takeBackup(t.paths, WITH_CONFIG, "1.0", [bin], "x");
	settings("v2");
	// An install step failed: the new version never ran, so its settings stay.
	expect(await restoreBackup(t.paths, { key: "tool" }, "1.0", realRun(t.paths))).toEqual({ ok: true });
	expect(readFileSync(join(t.paths.home, ".config/tool/settings.json"), "utf8")).toBe("v2");
	expect(existsSync(join(t.paths.data, "config-aside"))).toBe(false);
	// The table no longer names ~/.toolrc: only the folder goes back.
	expect(await restoreBackup(t.paths, { key: "tool" }, "1.0", realRun(t.paths), ["~/.config/tool/"])).toEqual({
		ok: true,
	});
	expect(readFileSync(join(t.paths.home, ".config/tool/settings.json"), "utf8")).toBe("v1");
	expect(readFileSync(join(t.paths.home, ".toolrc"), "utf8")).toBe("rc v2");
});

test("a second put-back changes nothing and keeps the first one's aside; asides are pruned to three, oldest first", () => {
	settings("v1");
	takePoint(t.paths, WITH_CONFIG, "1.0", { command: ["true"] }, "x");
	const point = join(t.paths.data, "backups/tool/1.0");
	const saved = JSON.parse(readFileSync(join(point, "meta.json"), "utf8")).config;
	settings("v2");
	putConfigBack(point, saved, t.paths, "tool", NAMED, "2026-11-01T00:00:00.000Z");
	// A rerun after a cut (recovery, or a retry) finds the point's copy already live and moves nothing.
	putConfigBack(point, saved, t.paths, "tool", NAMED, "2026-11-02T00:00:00.000Z");
	expect(asides("tool")).toHaveLength(1);
	expect(readFileSync(join(asideOf("tool", 0), "0/settings.json"), "utf8")).toBe("v2");
	for (const [n, day] of ["03", "04", "05"].entries()) {
		settings(`w${n}`);
		putConfigBack(point, saved, t.paths, "tool", NAMED, `2026-11-${day}T00:00:00.000Z`);
	}
	expect(asides("tool")).toHaveLength(3);
	expect(readFileSync(join(asideOf("tool", 0), "0/settings.json"), "utf8")).toBe("w0");
	expect(readFileSync(join(asideOf("tool", 2), "0/settings.json"), "utf8")).toBe("w2");
});

test("when one path fails the others' asides stay, and a retry finishes without deleting them", () => {
	settings("v1");
	takePoint(t.paths, WITH_CONFIG, "1.0", { command: ["true"] }, "x");
	const point = join(t.paths.data, "backups/tool/1.0");
	const saved = JSON.parse(readFileSync(join(point, "meta.json"), "utf8")).config;
	settings("v2");
	// The second path cannot take the copy: a folder sits where its .upkeep-new goes and cannot be removed.
	const blocker = join(t.paths.home, ".toolrc.upkeep-new");
	mkdirSync(join(blocker, "inner"), { recursive: true });
	chmodSync(blocker, 0o500);
	try {
		expect(() => putConfigBack(point, saved, t.paths, "tool", NAMED, "2026-11-01T00:00:00.000Z")).toThrow(
			`Could not restore ${join(t.paths.home, ".toolrc")}: `,
		);
	} finally {
		chmodSync(blocker, 0o755);
	}
	expect(readFileSync(join(t.paths.home, ".toolrc"), "utf8")).toBe("rc v2");
	expect(readFileSync(join(asideOf("tool", 0), "0/settings.json"), "utf8")).toBe("v2");
	putConfigBack(point, saved, t.paths, "tool", NAMED, "2026-11-02T00:00:00.000Z");
	expect(readFileSync(join(t.paths.home, ".toolrc"), "utf8")).toBe("rc v1");
	expect(readFileSync(join(asideOf("tool", 0), "0/settings.json"), "utf8")).toBe("v2");
	expect(readFileSync(join(asideOf("tool", 1), "1"), "utf8")).toBe("rc v2");
});

test("a linked settings folder and Upkeep's own folders are left out of the point; a link at restore is refused", () => {
	const real = join(t.paths.home, "dotfiles/app");
	mkdirSync(real, { recursive: true });
	writeFileSync(join(real, "conf"), "c");
	mkdirSync(join(t.paths.home, ".config"), { recursive: true });
	symlinkSync(real, join(t.paths.home, ".config/app"));
	// Upkeep's config at its usual place under home, as on a real machine.
	const own = { ...t.paths, config: join(t.paths.home, ".config/upkeep") };
	mkdirSync(own.config, { recursive: true });
	const lines: string[] = [];
	const spec = { key: "app", keep_with_restore: ["~/.config/app", "~/.config/upkeep"] };
	takePoint(own, spec, "1.0", { command: ["true"] }, "x", (l) => lines.push(l));
	expect(lines).toEqual([
		"Left ~/.config/app out of the restore point of app: it is a link; name the folder it points to.",
		"Left ~/.config/upkeep out of the restore point of app: it holds Upkeep's own files.",
	]);
	expect(listBackups(t.paths, "app")).toEqual([{ version: "1.0", at: "x" }]);
	// A path that became a link after its point was taken is refused before anything moves.
	const point = join(t.dir, "point");
	mkdirSync(join(point, "upkeep-config/0"), { recursive: true });
	const live = join(t.paths.home, ".config/app");
	expect(() =>
		putConfigBack(point, [{ path: live, name: "upkeep-config/0" }], t.paths, "app", ["~/.config/app"]),
	).toThrow(`Could not restore ${live}: it is a link; name the folder it points to`);
	expect(readlinkSync(live)).toBe(real);
});

test("settings over 200 MB stay out of the point with a log line, and the update's point is still taken", () => {
	const big = join(t.paths.home, ".config/big");
	mkdirSync(big, { recursive: true });
	// Sparse: its size counts, its disk does not.
	writeFileSync(join(big, "profile"), "");
	truncateSync(join(big, "profile"), 201 * 1024 * 1024);
	const bin = join(t.dir, "tool");
	writeFileSync(bin, "bin");
	const lines: string[] = [];
	takeBackup(t.paths, { key: "tool", keep_with_restore: ["~/.config/big"] }, "1.0", [bin], "x", (l) => lines.push(l));
	expect(lines).toEqual(["Left ~/.config/big out of the restore point of tool: 201 MB is over 200 MB."]);
	expect(listBackups(t.paths, "tool")).toEqual([{ version: "1.0", at: "x" }]);
	expect(existsSync(join(t.paths.data, "backups/tool/1.0/upkeep-config"))).toBe(false);
});

test("a setting that cannot be read is left out with a log line, never failing the point", () => {
	const locked = join(t.paths.home, ".config/locked");
	mkdirSync(join(locked, "inner"), { recursive: true });
	writeFileSync(join(locked, "inner/secret"), "s");
	chmodSync(join(locked, "inner"), 0o000);
	const lines: string[] = [];
	try {
		takePoint(
			t.paths,
			{ key: "cmd", keep_with_restore: ["~/.config/locked"] },
			"1.0",
			{ command: ["true"] },
			"x",
			(l) => lines.push(l),
		);
	} finally {
		chmodSync(join(locked, "inner"), 0o755);
	}
	expect(lines).toHaveLength(1);
	expect(lines[0]).toStartWith("Left ~/.config/locked out of the restore point of cmd: ");
	expect(listBackups(t.paths, "cmd")).toEqual([{ version: "1.0", at: "x" }]);
	expect(existsSync(join(t.paths.data, "backups/cmd/1.0/upkeep-config/0"))).toBe(false);
});

test("command and package points put settings back only when their tool worked, and are packed when they hold some", async () => {
	settings("v1");
	takePoint(t.paths, WITH_CONFIG, "1.0", { command: ["put-back", "1.0"] }, "2026-11-01T10:00:00.000Z");
	settings("v2");
	const failing = recordingRun(t.paths, () => ({ code: 3, stdout: "", stderr: "", timedOut: false }));
	expect((await restoreBackup(t.paths, { key: "tool" }, "1.0", failing.run, NAMED)).ok).toBe(false);
	expect(readFileSync(join(t.paths.home, ".toolrc"), "utf8")).toBe("rc v2");
	const working = recordingRun(t.paths, () => ({ code: 0, stdout: "", stderr: "", timedOut: false }));
	expect(await restoreBackup(t.paths, { key: "tool" }, "1.0", working.run, NAMED)).toEqual({ ok: true });
	expect(readFileSync(join(t.paths.home, ".toolrc"), "utf8")).toBe("rc v1");

	// A .deb point holding settings: packed when older, unpacked and put back after dpkg.
	const deb = join(t.dir, "tool_1.0.deb");
	writeFileSync(deb, "deb ".repeat(5000));
	settings("d1".repeat(5000));
	takePoint(t.paths, { ...WITH_CONFIG, key: "pkg" }, "1.0", { package: "deb", file: deb }, "2026-11-01T10:00:00.000Z");
	takePoint(t.paths, { key: "pkg" }, "2.0", { package: "deb", file: deb }, "2026-11-02T10:00:00.000Z");
	await packOlder(t.paths, "pkg", realRun(t.paths), () => {});
	expect(entriesOf("pkg", "1.0")).toEqual([".upkeep-packed.tar.zst", "meta.json"]);
	expect(entriesOf("pkg", "2.0")).toEqual(["meta.json", "tool_1.0.deb"]);
	settings("d2");
	const real = realRun(t.paths);
	const dpkg: typeof real = (argv, opts) => (argv.includes("dpkg") ? Promise.resolve(ok("")) : real(argv, opts));
	expect(await restoreBackup(t.paths, { key: "pkg" }, "1.0", dpkg, NAMED)).toEqual({ ok: true });
	expect(readFileSync(join(t.paths.home, ".config/tool/settings.json"), "utf8")).toBe("d1".repeat(5000));

	// A folder point packed with zstd unpacks its settings with its files.
	const folder = folderApp("one ");
	settings("p1");
	takeBackup(t.paths, { ...WITH_CONFIG, key: "packed" }, "1.0", [folder], "2026-11-01T10:00:00.000Z");
	takeBackup(t.paths, { key: "packed" }, "2.0", [folder], "2026-11-02T10:00:00.000Z");
	await packOlder(t.paths, "packed", realRun(t.paths), () => {});
	expect(entriesOf("packed", "1.0")).toEqual([".upkeep-packed.tar.zst", "meta.json"]);
	settings("p2");
	expect(await restoreBackup(t.paths, { key: "packed" }, "1.0", realRun(t.paths), NAMED)).toEqual({ ok: true });
	expect(readFileSync(join(t.paths.home, ".config/tool/settings.json"), "utf8")).toBe("p1");
});

test("putConfigBack skips a path outside home that meta.json was edited to name, and says which path failed", () => {
	const point = join(t.dir, "point");
	mkdirSync(join(point, "upkeep-config"), { recursive: true });
	writeFileSync(join(point, "upkeep-config/0"), "x");
	const outside = join(t.dir, "outside");
	writeFileSync(outside, "kept");
	// Named by the table too, so only the home check stands between it and a swap.
	expect(() => putConfigBack(point, [{ path: outside, name: "upkeep-config/0" }], t.paths, "tool", [outside])).toThrow(
		`Could not restore ${outside}: it is not under home`,
	);
	expect(readFileSync(outside, "utf8")).toBe("kept");
	// A live path whose parent is a file cannot take the copy: the restore says so.
	writeFileSync(join(t.paths.home, "plainfile"), "f");
	const under = join(t.paths.home, "plainfile/x");
	expect(() =>
		putConfigBack(point, [{ path: under, name: "upkeep-config/0" }], t.paths, "tool", ["~/plainfile/x"]),
	).toThrow(`Could not restore ${under}: `);
});
