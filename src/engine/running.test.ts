import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRunning } from "./running";
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

test("the current process and its ancestors never count", () => {
	fakeProc(50, 1, "zsh", ["zsh", "-c", "upkeep /h/.local/bin/fd"]);
	fakeProc(60, 50, "bun", ["/h/.local/bin/fd"]);
	fakeProc(70, 60, "bun", ["/h/.local/bin/fd", "--check"]);
	expect(isRunning({ kind: "archive", dest: "/h/.local/bin/fd" }, proc, 70)).toBe(false);
	fakeProc(80, 1, "fd", ["/h/.local/bin/fd"]);
	expect(isRunning({ kind: "archive", dest: "/h/.local/bin/fd" }, proc, 70)).toBe(true);
});
