import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { AppSpec } from "../shared/types";
import { launchDetached, restartApp, terminate } from "./restart";
import { runningPids } from "./running";
import { recordingRun, script, tempHome } from "./testkit";

let t: ReturnType<typeof tempHome>;
let name = "";
beforeEach(() => {
	t = tempHome("restart");
	// A name of its own, under the 15 characters a process name keeps, so only this test's process matches.
	name = `upkf${Math.random().toString(36).slice(2, 8)}`;
});
afterEach(() => {
	for (const pid of runningPids({ kind: "file", process: name })) terminate(pid);
	t.cleanup();
});

const OK = { code: 0, stdout: "", stderr: "", timedOut: false };

/** Starts a long sleeper outside this test's process tree, as a desktop app would be, and gives its path. */
async function startApp(): Promise<string> {
	// Short sleeps, so nothing outlives the test by more than a tenth of a second.
	const dest = script(join(t.dir, name), "while :; do sleep 0.1; done");
	await Bun.spawn(["bash", "-c", `"${dest}" >/dev/null 2>&1 &`]).exited;
	// oxlint-disable-next-line no-await-in-loop -- polling until the process shows up is the point
	for (let i = 0; i < 50 && runningPids({ kind: "file", process: name }).length === 0; i++) await Bun.sleep(20);
	return dest;
}

const app = (extra: Partial<AppSpec>): AppSpec => ({ key: "app", name: "App", kind: "file", ...extra });

test("a restart argv is run, and its failure or a sudo password prompt is said plainly", async () => {
	let answer = OK;
	const { run, calls } = recordingRun(t.paths, () => answer);
	const ctx = { run, signal: terminate, launch: async () => null, pollMs: 10 };
	const spec = app({ restart: ["systemctl", "restart", "app"] });
	expect(await restartApp(spec, "", ctx)).toEqual({ ok: true });
	expect(calls[0]?.argv).toEqual(["systemctl", "restart", "app"]);
	answer = { code: 1, stdout: "", stderr: "Failed", timedOut: false };
	expect(await restartApp(spec, "", ctx)).toEqual({ ok: false, detail: "systemctl restart app exited 1." });
	answer = { code: 1, stdout: "", stderr: "sudo: a password is required", timedOut: false };
	expect(await restartApp(spec, "", ctx)).toEqual({
		ok: false,
		detail: "sudo needs a password here. Restart App yourself.",
	});
	expect(await restartApp(app({}), "", ctx)).toEqual({
		ok: false,
		detail: "App's table does not say how to restart it.",
	});
});

test("relaunch asks the app to quit, waits until it has, then starts dest again", async () => {
	const dest = await startApp();
	const launched: string[][] = [];
	const { run } = recordingRun(t.paths, () => OK);
	const spec = app({ relaunch: true, dest, process: name });
	const r = await restartApp(spec, dest, {
		run,
		signal: terminate,
		launch: async (a) => (launched.push(a), null),
		pollMs: 10,
	});
	expect(r).toEqual({ ok: true });
	expect(launched).toEqual([[dest]]);
	expect(runningPids({ kind: "file", process: name })).toEqual([]);
});

test("an app that will not quit is left running and never started twice", async () => {
	const dest = await startApp();
	const launched: string[][] = [];
	const { run } = recordingRun(t.paths, () => OK);
	const spec = app({ relaunch: true, dest, process: name });
	const ctx = {
		run,
		signal: () => {},
		launch: async (a: string[]) => (launched.push(a), null),
		pollMs: 10,
		closeMs: 50,
	};
	expect(await restartApp(spec, dest, ctx)).toEqual({
		ok: false,
		detail: "App did not close. Close it, then open it again.",
	});
	expect(launched).toEqual([]);
	expect(runningPids({ kind: "file", process: name }).length).toBe(1);
});

test("terminate ignores a pid that has gone, and launch starts argv on its own", async () => {
	expect(() => terminate(2 ** 22 + 7)).not.toThrow();
	expect(await launchDetached([])).toBe("nothing to start");
	expect(await launchDetached([join(t.dir, "missing")])).toContain("ENOENT");
	const mark = join(t.dir, "launched");
	expect(await launchDetached(["bash", "-c", `echo yes > "${mark}"`])).toBeNull();
	// oxlint-disable-next-line no-await-in-loop -- polling until the file shows up is the point
	for (let i = 0; i < 50 && !(await Bun.file(mark).exists()); i++) await Bun.sleep(20);
	expect(await Bun.file(mark).text()).toBe("yes\n");
});

test("an app that closed but cannot be started again says so", async () => {
	const dest = await startApp();
	const { run } = recordingRun(t.paths, () => OK);
	const spec = app({ relaunch: true, dest, process: name });
	const ctx = { run, signal: terminate, launch: async () => "spawn x ENOENT", pollMs: 10 };
	expect(await restartApp(spec, dest, ctx)).toEqual({
		ok: false,
		detail: "App closed, but could not be started again: spawn x ENOENT",
	});
	expect(await restartApp(app({ relaunch: true, dest }), dest, ctx)).toEqual({
		ok: false,
		detail: "App's table does not say how to restart it.",
	});
});
