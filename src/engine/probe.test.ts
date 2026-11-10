import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeAppImageMeta, probeCommand, probeVersion, readProbe } from "./probe";
import { ok, realRun, recordingRun, script, tempHome } from "./testkit";

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("probe");
});
afterEach(() => t.cleanup());

test("a version is read from the probe output", async () => {
	const s = script(join(t.dir, "fd"), 'echo "fd 10.5.1"');
	expect(await probeVersion(s, ["--version"], { run: realRun(t.paths) })).toEqual({ version: "10.5.1" });
});

test("a missing shared library is broken, not version 6", async () => {
	const s = script(
		join(t.dir, "cava"),
		'echo "cava: error while loading shared libraries: libx.so.6: cannot open shared object file" >&2; exit 127',
	);
	expect(await probeVersion(s, ["-v"], { run: realRun(t.paths) })).toEqual({
		state: "broken",
		detail: "cava: error while loading shared libraries: libx.so.6: cannot open shared object file",
	});
});

test("terminal escapes are stripped before the version is read", () => {
	expect(readProbe(0, "\x1b[1;32mstarship\x1b[0m 1.24.1\n")).toEqual({ version: "1.24.1" });
	expect(readProbe(0, "\x1b]0;title\x07zoxide 0.9.9")).toEqual({ version: "0.9.9" });
});

test("empty output and output with no version are unknown; a missing file is absent", async () => {
	expect(readProbe(0, "")).toEqual({ state: "unknown", detail: "The version probe printed nothing." });
	expect(readProbe(0, "hello")).toEqual({ state: "unknown", detail: "hello" });
	expect(await probeVersion(join(t.dir, "none"), [], { run: realRun(t.paths) })).toEqual({ state: "absent" });
});

test("a probe that hangs is killed at the limit", async () => {
	const s = script(join(t.dir, "hang"), 'coproc { read -r _; }\nread -r -t 30 _ <&"${COPROC[0]}"');
	const r = await probeVersion(s, [], { run: realRun(t.paths), timeoutMs: 200 });
	expect(r).toEqual({ state: "unknown", detail: "The version probe printed nothing." });
});

test("probeCommand reads a command and is absent when it is not there", async () => {
	script(join(t.paths.home, ".local/bin/claude"), 'echo "2.1.322 (Claude Code)"');
	expect(await probeCommand(["claude", "--version"], { run: realRun(t.paths) })).toEqual({ version: "2.1.322" });
	expect(await probeCommand(["no-such-tool-here", "--version"], { run: realRun(t.paths) })).toEqual({
		state: "absent",
	});
});

test("the AppImage meta probe reads the mount point from stdout, reads metainfo and unmounts that path", async () => {
	const mnt = join(t.dir, "mount_abc");
	mkdirSync(join(mnt, "usr/share/metainfo"), { recursive: true });
	writeFileSync(
		join(mnt, "usr/share/metainfo/LRCGET.metainfo.xml"),
		'<component><releases><release version="1.0.1" date="2026-10-01"/><release version="0.9.0"/></releases></component>',
	);
	mkdirSync(join(t.dir, "mount_stale"), { recursive: true });
	const img = script(
		join(t.dir, "lrcget"),
		`if [ "$1" = "--appimage-mount" ]; then echo "${mnt}"; coproc { read -r _; }; read -r -t 30 _ <&"\${COPROC[0]}"; fi`,
	);
	const { run, calls } = recordingRun(t.paths, (argv) => (argv[0] === "fusermount" ? ok() : undefined));
	const tmpDir = join(t.paths.cache, "tmp");
	const r = await probeAppImageMeta(img, "usr/share/metainfo/LRCGET.metainfo.xml", { run, tmpDir, pollMs: 50 });
	expect(r).toEqual({ version: "1.0.1" });
	expect(calls.map((c) => c.argv)).toEqual([["fusermount", "-u", mnt]]);
	expect(readdirSync(tmpDir)).toEqual([]);
});

test("the meta probe reads X-AppImage-Version from a .desktop, and reports a missing mount", async () => {
	const mnt = join(t.dir, "m2");
	mkdirSync(mnt, { recursive: true });
	writeFileSync(join(mnt, "app.desktop"), "[Desktop Entry]\nName=T\nX-AppImage-Version=0.0.21\n");
	const img = script(join(t.dir, "t3"), `echo "${mnt}"; coproc { read -r _; }; read -r -t 30 _ <&"\${COPROC[0]}"`);
	const { run } = recordingRun(t.paths, () => ok());
	const tmpDir = join(t.paths.cache, "tmp");
	expect(await probeAppImageMeta(img, "app.desktop", { run, tmpDir, pollMs: 20 })).toEqual({ version: "0.0.21" });
	const silent = script(join(t.dir, "silent"), "exit 0");
	expect(await probeAppImageMeta(silent, "x.xml", { run, tmpDir, pollMs: 10, polls: 3 })).toEqual({
		state: "unknown",
		detail: `${silent} never reported a mount point.`,
	});
	expect(existsSync(join(t.dir, "nope"))).toBe(false);
});
