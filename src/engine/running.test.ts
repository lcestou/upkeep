import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { earliestStart, isRunning } from "./running";
import { tempHome } from "./testkit";

let t: ReturnType<typeof tempHome>;
let proc = "";
beforeEach(() => {
	t = tempHome("running");
	proc = join(t.dir, "proc");
	mkdirSync(proc);
});
afterEach(() => t.cleanup());

function fakeProc(pid: number, ppid: number, comm: string, cmdline: string[], exe?: string): void {
	const dir = join(proc, String(pid));
	mkdirSync(dir);
	writeFileSync(join(dir, "stat"), `${pid} (${comm}) S ${ppid} 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5555 0 0`);
	writeFileSync(join(dir, "comm"), `${comm}\n`);
	writeFileSync(join(dir, "cmdline"), `${cmdline.join("\0")}\0`);
	if (exe) symlinkSync(exe, join(dir, "exe"));
}

test("a process whose comm is the spec's process name is running", () => {
	fakeProc(100, 1, "zen", ["/tmp/.mount_x/zen"]);
	expect(isRunning({ kind: "appimage", dest: "/h/zen.AppImage", process: "zen" }, proc, 9)).toBe(true);
	expect(isRunning({ kind: "appimage", dest: "/h/zen.AppImage", process: "ghostty" }, proc, 9)).toBe(false);
});

test("an exe link that resolves to dest is running", () => {
	const dest = join(t.dir, "fd");
	writeFileSync(dest, "");
	fakeProc(200, 1, "fd", ["fd", "-H"], dest);
	expect(isRunning({ kind: "archive", dest }, proc, 9)).toBe(true);
});

test("a cmdline that starts with dest, or for an AppImage contains it, is running", () => {
	fakeProc(300, 1, "bash", ["/h/.local/bin/borg", "list"]);
	expect(isRunning({ kind: "file", dest: "/h/.local/bin/borg" }, proc, 9)).toBe(true);
	fakeProc(301, 1, "dwarfs", ["dwarfs", "-f", "/h/.local/bin/ghostty.appimage", "/tmp/.mount_g"]);
	expect(isRunning({ kind: "appimage", dest: "/h/.local/bin/ghostty.appimage" }, proc, 9)).toBe(true);
	expect(isRunning({ kind: "archive", dest: "/h/.local/bin/ghostty.appimage" }, proc, 9)).toBe(false);
});

test("an AppImage's path inside a longer argument does not count", () => {
	fakeProc(302, 1, "vim", ["vim", "/h/.local/bin/lrcget.bak"]);
	fakeProc(303, 1, "tail", ["tail", "/h/.local/bin/lrcget-notes"]);
	expect(isRunning({ kind: "appimage", dest: "/h/.local/bin/lrcget" }, proc, 9)).toBe(false);
});

test("the current process and its ancestors never count", () => {
	fakeProc(50, 1, "zsh", ["zsh", "-c", "upkeep /h/.local/bin/fd"]);
	fakeProc(60, 50, "bun", ["/h/.local/bin/fd"]);
	fakeProc(70, 60, "bun", ["/h/.local/bin/fd", "--check"]);
	expect(isRunning({ kind: "archive", dest: "/h/.local/bin/fd" }, proc, 70)).toBe(false);
	fakeProc(80, 1, "fd", ["/h/.local/bin/fd"]);
	expect(isRunning({ kind: "archive", dest: "/h/.local/bin/fd" }, proc, 70)).toBe(true);
});

test("our own probes never count: a descendant of this process, or any process with an AppImage probe flag", () => {
	const dest = "/h/.local/bin/lrcget";
	const spec = { kind: "appimage" as const, dest };
	fakeProc(9, 1, "bun", ["bun", "upkeep"]);
	fakeProc(400, 9, "lrcget", [dest, "--appimage-mount"]);
	fakeProc(401, 400, "lrcget", [dest]);
	fakeProc(402, 1, "lrcget", [dest, "--appimage-extract"]);
	fakeProc(403, 1, "lrcget", [dest, "--appimage-version"]);
	expect(isRunning(spec, proc, 9)).toBe(false);
	fakeProc(404, 1, "lrcget", [dest]);
	expect(isRunning(spec, proc, 9)).toBe(true);
});

test("the earliest start of the app's processes comes from boot time plus clock ticks", () => {
	writeFileSync(join(proc, "stat"), "cpu  1 2 3\nbtime 1800000000\n");
	fakeProc(600, 1, "zen", ["/h/zen"]);
	writeFileSync(join(proc, "600/stat"), "600 (zen) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 25050 0 0");
	fakeProc(601, 1, "zen", ["/h/zen"]);
	writeFileSync(join(proc, "601/stat"), "601 (zen) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 99900 0 0");
	// 25050 ticks at 100 per second is 250.5 s after boot.
	expect(earliestStart({ kind: "file", process: "zen" }, proc, 9)).toBe((1800000000 + 250.5) * 1000);
	expect(earliestStart({ kind: "file", process: "nope" }, proc, 9)).toBeNull();
});
