import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSpec } from "../shared/types";
import type { FetchLike } from "./github";
import {
	crashPaths,
	crashSign,
	expired,
	healthAnswers,
	look,
	type Probation,
	readCrashes,
	readUnit,
	restartBaseline,
	serviceSign,
	unitsOf,
	watchOf,
} from "./probation";
import { strictRun, ok, tempHome } from "./testkit";

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("probation");
});
afterEach(() => t.cleanup());

const HOUR = 3_600_000;
const AT = Date.parse("2026-11-20T12:00:00Z");

/** A journal line as journalctl -o json prints one core dump, at ms. */
const dump = (exe: string, at: number, cmdline = exe) =>
	JSON.stringify({ COREDUMP_EXE: exe, COREDUMP_CMDLINE: cmdline, __REALTIME_TIMESTAMP: String(at * 1000) });

const spec = (o: Partial<AppSpec> = {}): AppSpec => ({ key: "tool", name: "Tool", kind: "file", ...o });

test("units come from restart and serve's active argv, through sudo, with --user kept apart", () => {
	expect(
		unitsOf(
			spec({
				restart: ["sudo", "-n", "systemctl", "restart", "tool"],
				serve: [
					{
						name: "a",
						active: ["systemctl", "--user", "is-active", "--quiet", "tool-web.service"],
						stop: [],
						start: [],
					},
					// The same unit twice is read once.
					{ name: "b", active: ["/usr/bin/systemctl", "is-active", "tool"], stop: [], start: [] },
					// A unit started some other way is not watched.
					{ name: "c", active: ["pgrep", "tool"], stop: [], start: [] },
				],
			}),
		),
	).toEqual([
		{ name: "tool", user: false },
		{ name: "tool-web.service", user: true },
	]);
	// A systemctl call that names no unit (only its verb) gives none.
	expect(unitsOf(spec({ restart: ["systemctl", "daemon-reload"] }))).toEqual([]);
	expect(unitsOf(spec())).toEqual([]);
});

test("a unit reads as its state and restart count, and anything unreadable as null", async () => {
	const { run, calls } = strictRun((argv) =>
		argv.includes("good")
			? ok("NRestarts=4\nActiveState=active\n")
			: argv.includes("unknown")
				? ok("NRestarts=\nActiveState=inactive\n")
				: argv.includes("throws")
					? undefined
					: { ...ok(), code: 1 },
	);
	expect(await readUnit(run, { name: "good", user: true })).toEqual({ active: "active", restarts: 4 });
	expect(calls[0]?.argv).toEqual(["systemctl", "--user", "show", "-p", "ActiveState", "-p", "NRestarts", "good"]);
	expect(await readUnit(run, { name: "unknown", user: false })).toBeNull();
	expect(await readUnit(run, { name: "denied", user: false })).toBeNull();
	// systemctl missing: the runner throws, which is nothing to report.
	expect(await readUnit(run, { name: "throws", user: false })).toBeNull();
	expect(await restartBaseline(run, spec({ restart: ["systemctl", "--user", "restart", "good"] }))).toEqual({
		restarts: { "user:good": 4 },
		failed: [],
	});
	expect(await restartBaseline(run, spec({ restart: ["systemctl", "restart", "denied"] }))).toEqual({
		restarts: {},
		failed: [],
	});
	// A unit already failed at the update is kept apart, so its failing later says nothing about the update.
	const down = strictRun(() => ok("NRestarts=1\nActiveState=failed\n")).run;
	expect(await restartBaseline(down, spec({ restart: ["systemctl", "restart", "down"] }))).toEqual({
		restarts: { "system:down": 1 },
		failed: ["system:down"],
	});
});

test("crashes come from the journal, leaving out Chromium and Electron helpers and lines that do not read", async () => {
	const lines = [
		dump("/opt/tool/tool", AT + HOUR),
		dump("/opt/tool/tool", AT + 2 * HOUR, "/opt/tool/tool --type=gpu-process --field-trial"),
		"not json",
		JSON.stringify([1, 2]),
		JSON.stringify({ COREDUMP_EXE: [1, 2], __REALTIME_TIMESTAMP: "1" }),
		JSON.stringify({ COREDUMP_EXE: "/x", __REALTIME_TIMESTAMP: "soon" }),
		// No command line logged: still a crash.
		JSON.stringify({ COREDUMP_EXE: "/opt/tool/tool", __REALTIME_TIMESTAMP: String((AT + 3 * HOUR) * 1000) }),
	];
	const { run, calls } = strictRun(() => ok(`${lines.join("\n")}\n`));
	expect(await readCrashes(run, AT)).toEqual([
		{ exe: "/opt/tool/tool", at: AT + HOUR },
		{ exe: "/opt/tool/tool", at: AT + 3 * HOUR },
	]);
	expect(calls[0]?.argv).toContain("MESSAGE_ID=fc2e22bc6ee647b6b90729ab34a250b1");
	expect(calls[0]?.argv.slice(-2)).toEqual(["--since", `@${AT / 1000}`]);
	// No access, or no journalctl at all: nothing to report.
	expect(await readCrashes(strictRun(() => ({ ...ok(), code: 1 })).run, AT)).toEqual([]);
	expect(await readCrashes(strictRun(() => undefined).run, AT)).toEqual([]);
});

test("a crash sign needs more crashes after the update than in the same span before it", () => {
	const own = ["/opt/tool/tool", "/opt/tool/lib"];
	const now = AT + 10 * HOUR;
	// 0 before, 1 after: a sign.
	expect(crashSign([{ exe: "/opt/tool/tool", at: AT + HOUR }], own, AT, now)).toEqual({ after: 1, sign: true });
	// 2 before, 2 after: not one.
	const even = [AT - HOUR, AT - 2 * HOUR, AT + HOUR, AT + 2 * HOUR].map((at) => ({ exe: "/opt/tool/tool", at }));
	expect(crashSign(even, own, AT, now)).toEqual({ after: 2, sign: false });
	// A crash before the matching span, another program's, and a file under a folder app's folder.
	const mixed = [
		{ exe: "/opt/tool/tool", at: AT - 11 * HOUR },
		{ exe: "/usr/bin/other", at: AT + HOUR },
		{ exe: "/opt/tool/lib/helper", at: AT + HOUR },
		{ exe: "/opt/tool/toolkit", at: AT + HOUR },
	];
	expect(crashSign(mixed, own, AT, now)).toEqual({ after: 1, sign: true });
	expect(crashSign([], own, AT, now)).toEqual({ after: 0, sign: false });
});

test("an app's crash paths are its installed files, each by its real path too", () => {
	const real = join(t.dir, "opt", "tool");
	mkdirSync(join(t.dir, "opt"), { recursive: true });
	writeFileSync(real, "");
	mkdirSync(join(t.paths.home, ".local/bin"), { recursive: true });
	symlinkSync(real, join(t.paths.home, ".local/bin/tool"));
	expect(crashPaths(spec({ dest: "~/.local/bin/tool" }), t.paths)).toEqual([
		join(t.paths.home, ".local/bin/tool"),
		real,
	]);
	expect(crashPaths(spec({ dest: "~/.local/bin/gone" }), t.paths)).toEqual([join(t.paths.home, ".local/bin/gone")]);
	expect(crashPaths(spec({ kind: "command" }), t.paths)).toEqual([]);
});

test("a service is a sign when failed or when it restarted 3 times since the update", () => {
	expect(serviceSign({ active: "failed", restarts: 0 }, 0)).toBe(true);
	expect(serviceSign({ active: "active", restarts: 5 }, 2)).toBe(true);
	expect(serviceSign({ active: "active", restarts: 4 }, 2)).toBe(false);
	// Failed already at the update: not a sign of it, though restarting on and on since still is.
	expect(serviceSign({ active: "failed", restarts: 0 }, 0, true)).toBe(false);
	expect(serviceSign({ active: "failed", restarts: 3 }, 0, true)).toBe(true);
	// No baseline (the unit could not be read at the update): only failed counts.
	expect(serviceSign({ active: "activating", restarts: 40 }, undefined)).toBe(false);
});

test("the health address answers only with a 2xx in time; any fault is a miss", async () => {
	const asked: RequestInit[] = [];
	const answer =
		(status: number): FetchLike =>
		async (_url, init) => {
			if (init) asked.push(init);
			return new Response("", { status });
		};
	expect(await healthAnswers(answer(200), "http://127.0.0.1:9/health")).toBe(true);
	expect(asked[0]?.method).toBe("GET");
	expect(asked[0]?.signal).toBeInstanceOf(AbortSignal);
	expect(await healthAnswers(answer(503), "http://127.0.0.1:9/health")).toBe(false);
	const refused: FetchLike = async () => {
		throw new TypeError("Unable to connect");
	};
	expect(await healthAnswers(refused, "http://127.0.0.1:9/health")).toBe(false);
	// A server that never answers runs out of time.
	const hangs: FetchLike = (_url, init) =>
		new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timed out"))));
	expect(await healthAnswers(hangs, "http://127.0.0.1:9/health", 10)).toBe(false);
});

test("two health misses in a row make a sign; an answer between them starts the count again", async () => {
	let up = false;
	const fetch: FetchLike = async () => new Response("", { status: up ? 200 : 503 });
	const { run } = strictRun(() => undefined);
	const s = spec({ health: "http://127.0.0.1:9/health" });
	const deps = { run, fetch, paths: t.paths, now: new Date(AT + HOUR) };
	const start: Probation = {
		at: new Date(AT).toISOString(),
		from: "1.0",
		to: "1.1",
		restarts: {},
		failed: [],
		misses: 0,
	};
	const one = await look(s, start, [], deps);
	expect(one).toMatchObject({ misses: 1 });
	expect(one.sign).toBeUndefined();
	up = true;
	const back = await look(s, one, [], deps);
	expect(back.misses).toBe(0);
	up = false;
	const two = await look(s, await look(s, back, [], deps), [], deps);
	expect(two).toMatchObject({ misses: 2, sign: "health" });
	// A sign once up stays, even when the address answers again.
	up = true;
	expect(await look(s, two, [], deps)).toMatchObject({ misses: 0, sign: "health" });
});

test("a look reads crashes first, then the service, and keeps the first sign it finds", async () => {
	const { run } = strictRun((argv) => (argv[0] === "systemctl" ? ok("ActiveState=failed\nNRestarts=0\n") : undefined));
	const fetch: FetchLike = async () => new Response("");
	const s = spec({ dest: "/opt/tool/tool", restart: ["systemctl", "restart", "tool"] });
	const deps = { run, fetch, paths: t.paths, now: new Date(AT + HOUR) };
	const start: Probation = {
		at: new Date(AT).toISOString(),
		from: "1.0",
		to: "1.1",
		restarts: { "system:tool": 0 },
		failed: [],
		misses: 0,
	};
	expect(await look(s, start, [], deps)).toMatchObject({ sign: "service" });
	const crashed = await look(s, start, [{ exe: "/opt/tool/tool", at: AT + 1 }], deps);
	expect(crashed).toMatchObject({ sign: "crash", crashes: 1 });
	// The record passed in is never changed.
	expect(start.sign).toBeUndefined();
});

test("a probation runs out after 3 days, and only a sign shows on the row", () => {
	const p: Probation = { at: new Date(AT).toISOString(), from: "1.0", to: "1.1", restarts: {}, failed: [], misses: 0 };
	expect(expired(p, new Date(AT + 71 * HOUR))).toBe(false);
	expect(expired(p, new Date(AT + 73 * HOUR))).toBe(true);
	expect(watchOf(undefined)).toBeUndefined();
	expect(watchOf(p)).toBeUndefined();
	expect(watchOf({ ...p, sign: "crash", crashes: 2 })).toEqual({
		sign: "crash",
		from: "1.0",
		to: "1.1",
		at: p.at,
		crashes: 2,
	});
	// A count left from before carries no meaning on another sign.
	expect(watchOf({ ...p, sign: "service", crashes: 1 })).toEqual({ sign: "service", from: "1.0", to: "1.1", at: p.at });
});
