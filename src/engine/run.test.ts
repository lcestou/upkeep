import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { asRoot, sudoNeedsPassword } from "./run";
import { realRun, script, tempHome } from "./testkit";

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("run");
});
afterEach(() => t.cleanup());

test("output is captured through a temp file that is removed after", async () => {
	const s = script(join(t.dir, "a.sh"), "echo out; echo err >&2; exit 3");
	const r = await realRun(t.paths)([s]);
	expect(r).toEqual({ code: 3, stdout: "out\n", stderr: "err\n", timedOut: false });
	expect(readdirSync(join(t.paths.cache, "tmp"))).toEqual([]);
});

test("merge keeps stdout and stderr in the order written", async () => {
	const s = script(join(t.dir, "m.sh"), "echo one; echo two >&2; echo three");
	const r = await realRun(t.paths)([s], { merge: true });
	expect(r.stdout).toBe("one\ntwo\nthree\n");
});

test("stdin is ignored, so nothing can wait on a terminal", async () => {
	const s = script(join(t.dir, "in.sh"), 'read -r x; echo "got:$x"');
	expect((await realRun(t.paths)([s], { timeoutMs: 5000 })).stdout).toBe("got:\n");
});

test("~/ is expanded and the owner's bin directories lead PATH", async () => {
	script(join(t.paths.home, ".local/bin/mytool"), "echo mytool-ran");
	const s = script(join(t.paths.home, "p.sh"), 'echo "$PATH"; mytool');
	const r = await realRun(t.paths)(["~/p.sh"]);
	const [path, ran] = r.stdout.trim().split("\n");
	expect(path?.split(":").slice(0, 2)).toEqual([join(t.paths.home, ".local/bin"), join(t.paths.home, ".bun/bin")]);
	expect(ran).toBe("mytool-ran");
	expect(s.startsWith(t.paths.home)).toBe(true);
});

test("onLine streams lines as they arrive", async () => {
	const s = script(join(t.dir, "l.sh"), "echo a; echo b >&2; printf c");
	const lines: string[] = [];
	const r = await realRun(t.paths)([s], { onLine: (l) => lines.push(l) });
	expect(lines.toSorted()).toEqual(["a", "b", "c"]);
	expect(r.stdout).toBe("a\nc");
});

test("a timeout kills the child and says so", async () => {
	const s = script(join(t.dir, "slow.sh"), 'coproc { read -r _; }\nread -r -t 30 _ <&"${COPROC[0]}"');
	const started = Date.now();
	const r = await realRun(t.paths)([s], { timeoutMs: 200 });
	expect(r.timedOut).toBe(true);
	expect(r.code).toBe(137);
	expect(Date.now() - started).toBeLessThan(5000);
});

test("a command that does not exist is 127", async () => {
	const r = await realRun(t.paths)([join(t.dir, "nope")]);
	expect(r.code).toBe(127);
	expect(existsSync(join(t.dir, "nope"))).toBe(false);
});

test("root steps go through sudo -n and a password prompt is recognised", () => {
	expect(asRoot(["install", "a", "b"], true)).toEqual(["sudo", "-n", "install", "a", "b"]);
	expect(asRoot(["install", "a", "b"], false)).toEqual(["install", "a", "b"]);
	expect(sudoNeedsPassword({ code: 1, stdout: "", stderr: "sudo: a password is required\n", timedOut: false })).toBe(
		true,
	);
	expect(sudoNeedsPassword({ code: 1, stdout: "", stderr: "install: cannot stat", timedOut: false })).toBe(false);
});

test("start reads a process's output while it runs, and stop kills one that ignores SIGTERM", async () => {
	const s = script(join(t.dir, "stubborn.sh"), "trap '' TERM; echo /mnt/here; while :; do sleep 0.05; done");
	const run = realRun(t.paths);
	const p = run.start?.([s], { stopMs: 200 });
	if (!p) throw new Error("no start");
	// oxlint-disable-next-line no-await-in-loop -- polling for the first line
	for (let i = 0; i < 40 && !p.output(); i++) await Bun.sleep(25);
	expect(p.output()).toBe("/mnt/here\n");
	const t0 = Date.now();
	await p.stop();
	expect(Date.now() - t0).toBeLessThan(1500);
	expect(readdirSync(join(t.paths.cache, "tmp"))).toEqual([]);
});
