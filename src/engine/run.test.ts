import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { asRoot, asRootArgv, runsAsRoot, sudoNeedsPassword } from "./run";
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

test("a timeout with killTree also kills the grandchild", async () => {
	const pidFile = join(t.dir, "gc.pid");
	const r = await realRun(t.paths)(["bash", "-c", `sleep 30 & echo $! > "${pidFile}"; wait`], {
		timeoutMs: 300,
		killTree: true,
	});
	expect(r.timedOut).toBe(true);
	await Bun.sleep(100);
	const pid = Number(await Bun.file(pidFile).text());
	expect(existsSync(`/proc/${pid}`)).toBe(false);
});

test("a timeout with group ends the whole process group, the grandchild included", async () => {
	const pidFile = join(t.dir, "group.pid");
	const r = await realRun(t.paths)(["bash", "-c", `sleep 30 & echo $! > "${pidFile}"; wait`], {
		timeoutMs: 300,
		group: true,
		onLine: () => {},
	});
	expect(r.timedOut).toBe(true);
	await Bun.sleep(300);
	const pid = Number(await Bun.file(pidFile).text());
	expect(existsSync(`/proc/${pid}`)).toBe(false);
});

test("a grandchild that keeps the pipe open does not hold the run, and its late lines are dropped", async () => {
	const started = Date.now();
	const got: string[] = [];
	const r = await realRun(t.paths)(["bash", "-c", "(sleep 2.5; echo late) & echo done"], {
		onLine: (l) => got.push(l),
		timeoutMs: 20_000,
	});
	expect(r.code).toBe(0);
	expect(Date.now() - started).toBeLessThan(5000);
	await Bun.sleep(1000);
	expect(got).toEqual(["done"]);
}, 15_000);

test("a table's sudo argv always gets -n, once, and onStart sees the child's pid", async () => {
	expect(asRootArgv(["sudo", "systemctl", "stop", "x"])).toEqual(["sudo", "-n", "systemctl", "stop", "x"]);
	expect(asRootArgv(["sudo", "-n", "systemctl", "stop", "x"])).toEqual(["sudo", "-n", "systemctl", "stop", "x"]);
	expect(asRootArgv(["systemctl", "--user", "stop", "x"])).toEqual(["systemctl", "--user", "stop", "x"]);
	const pids: number[] = [];
	const s = script(join(t.dir, "pid.sh"), "echo $$");
	const r = await realRun(t.paths)([s], { onStart: (pid) => pids.push(pid) });
	expect(pids).toEqual([Number(r.stdout.trim())]);
});

test("the runner gives every argv that starts with sudo -n, in run and in start", async () => {
	// A stand-in sudo in the temp home, and no system directory on PATH, so the real one can never run.
	script(join(t.paths.home, ".local/bin/sudo"), 'echo "stand-in $*"');
	const run = realRun(t.paths, "");
	expect((await run(["sudo", "systemctl", "stop", "x"])).stdout).toBe("stand-in -n systemctl stop x\n");
	expect((await run(["sudo", "-n", "true"])).stdout).toBe("stand-in -n true\n");
	const started = run.start?.(["sudo", "sleep-ish"]);
	await Bun.sleep(300);
	expect(started?.output()).toBe("stand-in -n sleep-ish\n");
	await started?.stop();
});

/** True while any process is left in the group pgid leads. */
function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
}

test("every child leads a process group of its own, so the terminal's Ctrl-C never reaches it", async () => {
	const r = await realRun(t.paths)(["bash", "-c", "echo $$; ps -o pgid= -p $$"]);
	const [pid, pgid] = r.stdout
		.trim()
		.split("\n")
		.map((s) => Number(s.trim()));
	expect(pgid).toBe(pid);
	expect(pgid).not.toBe(process.pid);
});

test("Stop now cuts a cuttable step: its whole group ends within 5 s and the result says stopped", async () => {
	const stop = new AbortController();
	let leader = 0;
	const running = realRun(t.paths)(["bash", "-c", "sleep 30 & sleep 30; wait"], {
		cuttable: true,
		cancel: stop.signal,
		onLine: () => {},
		onStart: (pid) => {
			leader = pid;
		},
	});
	await Bun.sleep(200);
	const at = Date.now();
	stop.abort();
	const r = await running;
	expect(Date.now() - at).toBeLessThan(5000);
	expect(r).toMatchObject({ code: 143, stopped: true, timedOut: false });
	await Bun.sleep(200);
	expect(groupAlive(leader)).toBe(false);
});

test("Stop now lets a step that is not cuttable run to its end", async () => {
	const stop = new AbortController();
	const running = realRun(t.paths)(["bash", "-c", "sleep 0.5; echo finished"], { cancel: stop.signal });
	stop.abort();
	const r = await running;
	expect(r.code).toBe(0);
	expect(r.stopped).toBeUndefined();
	expect(r.stdout).toBe("finished\n");
});

test("a cuttable step asked to start after Stop now does not start", async () => {
	const stop = new AbortController();
	stop.abort();
	const marker = join(t.dir, "ran");
	const r = await realRun(t.paths)(["touch", marker], { cuttable: true, cancel: stop.signal });
	expect(r.stopped).toBe(true);
	expect(existsSync(marker)).toBe(false);
});

test("a cut step that ignores TERM is killed 5 s later", async () => {
	const stop = new AbortController();
	let leader = 0;
	const s = script(join(t.dir, "deaf.sh"), "trap '' TERM\nwhile true; do sleep 0.1; done");
	const running = realRun(t.paths)([s], {
		cuttable: true,
		cancel: stop.signal,
		onStart: (pid) => {
			leader = pid;
		},
	});
	await Bun.sleep(200);
	const at = Date.now();
	stop.abort();
	const r = await running;
	expect(Date.now() - at).toBeGreaterThanOrEqual(4500);
	expect(Date.now() - at).toBeLessThan(7000);
	expect(r.stopped).toBe(true);
	await Bun.sleep(200);
	expect(groupAlive(leader)).toBe(false);
}, 15_000);

test("a cut returns only once every member of the step's group is gone, even when the leader exits first", async () => {
	const stop = new AbortController();
	const pidFile = join(t.dir, "member.pid");
	// The member ignores TERM (and so do its sleeps); the leader dies of TERM at once.
	const member = script(
		join(t.dir, "member.sh"),
		`trap '' TERM\necho $$ > "${pidFile}"\nwhile true; do sleep 0.1; done`,
	);
	const running = realRun(t.paths)(["bash", "-c", `"${member}" & wait`], { cuttable: true, cancel: stop.signal });
	await until(() => existsSync(pidFile));
	const at = Date.now();
	stop.abort();
	const r = await running;
	expect(r.stopped).toBe(true);
	expect(Date.now() - at).toBeGreaterThanOrEqual(4500);
	expect(existsSync(`/proc/${Number(readFileSync(pidFile, "utf8"))}`)).toBe(false);
}, 15_000);

test("a step that runs as root is never cut, whatever its caller asked", async () => {
	expect(runsAsRoot(["sudo", "-n", "dpkg", "-i", "x.deb"])).toBe(true);
	expect(runsAsRoot(["bash", "-c", "make && sudo -n make install"])).toBe(true);
	expect(runsAsRoot(["/bin/sh", "-c", "sudo true"])).toBe(true);
	expect(runsAsRoot(["bash", "-c", "make all"])).toBe(false);
	expect(runsAsRoot(["git", "fetch"])).toBe(false);
	// A stand-in sudo in the temp home: the step still runs to its end after the press.
	script(join(t.paths.home, ".local/bin/sudo"), 'shift; sleep 0.3; echo "ran $*"');
	const stop = new AbortController();
	stop.abort();
	const r = await realRun(t.paths, "/usr/bin:/bin")(["sudo", "true"], { cuttable: true, cancel: stop.signal });
	expect(r.stopped).toBeUndefined();
	expect(r.stdout).toBe("ran true\n");
});

test("start's process leads a process group of its own too", async () => {
	const started = realRun(t.paths).start?.(["bash", "-c", "echo $$ $(ps -o pgid= -p $$); sleep 5"]);
	await until(() => (started?.output() ?? "").includes("\n"));
	const [pid, pgid] = (started?.output() ?? "").trim().split(/\s+/).map(Number);
	expect(pgid).toBe(pid);
	await started?.stop();
});

/** Waits until cond holds, every 20 ms for up to 3 s. */
async function until(cond: () => boolean, left = 150): Promise<void> {
	if (cond() || left === 0) return;
	await Bun.sleep(20);
	return until(cond, left - 1);
}
