import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppSpec } from "../../shared/types";
import type { RunOpts, RunResult } from "../run";
import { type Inflight, readInflight } from "../store";
import { ok, strictRun, tempHome } from "../testkit";
import { type Built, prepareBuilt, SUDO_REFUSED } from "./built";
import type { KindCtx } from "./context";

let t: ReturnType<typeof tempHome>;
let srv = "";
let proc = "";
beforeEach(() => {
	t = tempHome("built");
	srv = join(t.paths.home, "srv");
	proc = join(t.dir, "proc");
	mkdirSync(proc);
	put(join(srv, "bin/srv"), "srv 1");
});
afterEach(() => t.cleanup());

function put(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

const fail = (stderr = "no"): RunResult => ({ code: 1, stdout: "", stderr, timedOut: false });

const SERVE = {
	name: "srv",
	active: ["is-active", "srv"],
	stop: ["sudo", "stop", "srv"],
	start: ["sudo", "start", "srv"],
	since: ["since", "srv"],
	health: "http://127.0.0.1:1/health",
};
const PAUSE = { name: "api", active: ["is-active", "api"], stop: ["stop", "api"], start: ["start", "api"] };

const spec = (extra: Partial<AppSpec> = {}): AppSpec => ({
	key: "srv",
	name: "Server",
	kind: "source",
	repo: "o/srv",
	dir: "~/srv",
	move: "ff",
	check: ["v"],
	keep: ["bin"],
	record: [{ file: "freeze.txt", run: ["freeze"] }],
	build: ["make all"],
	check_built: ["test -x out"],
	busy: [{ run: ["queue-busy"], say: "The queue has a job waiting." }],
	pause: [PAUSE],
	serve: [SERVE],
	...extra,
});
const target = { from: "1.0", version: "1.1", tag: "v1.1" };

type Answer = RunResult | undefined | ((argv: string[], opts: RunOpts) => RunResult | undefined);

/** A box where everything succeeds unless a test overrides a command by its joined argv. */
function box(over: Record<string, Answer> = {}) {
	const pids: Record<string, number> = { git: 101, freeze: 102, bash: 103 };
	const markers: { argv: string; marker: Inflight | null }[] = [];
	const rec = strictRun((argv, opts) => {
		const key = argv.join(" ");
		markers.push({ argv: key, marker: readInflight(t.paths) });
		const o = over[key];
		if (o !== undefined) return typeof o === "function" ? o(argv, opts) : o;
		const [cmd, ...rest] = argv;
		if (cmd === "sudo" && rest[1] === "-l") return ok();
		if (cmd === "queue-busy") return fail();
		if (cmd === "is-active") return ok();
		if (cmd === "stop" || cmd === "start" || (cmd === "sudo" && rest[1] !== "-l")) return ok();
		if (cmd === "since") return ok("100\n");
		if (cmd === "cp") {
			cpSync(rest[1] ?? "", rest[2] ?? "", { recursive: true, verbatimSymlinks: true });
			return ok();
		}
		if (cmd === "git" && rest[2] === "rev-parse") return ok("c0ffee\n");
		if (cmd === "git" && rest[2] === "status") return ok("");
		if (cmd === "git" || cmd === "freeze" || cmd === "bash") {
			opts.onStart?.(pids[cmd] ?? 1);
			markers.push({ argv: `${key} (started)`, marker: readInflight(t.paths) });
			return ok(cmd === "freeze" ? "pkg==1\n" : "");
		}
		return undefined;
	});
	return { ...rec, markers };
}

function ctx(run: KindCtx["run"]): KindCtx {
	return {
		paths: t.paths,
		run,
		fetch: async () => new Response("", { status: 404 }),
		token: null,
		settings: { keepBackups: 1, notify: true, checkAtLogin: false } as KindCtx["settings"],
		log: () => {},
		stage: () => {},
		procRoot: proc,
	};
}
const clock = { start: () => {} };
const argvs = (calls: { argv: string[] }[]) => calls.map((c) => c.argv.join(" "));

test("a build that fails its check stops nothing in serve, puts the files back and starts what it paused", async () => {
	const b = box({ "bash -c test -x out": fail("missing") });
	const r = await prepareBuilt(spec(), target, ctx(b.run), clock);
	expect(r).toEqual({ failed: "The build did not pass its check: test -x out. Nothing was changed." });
	const all = argvs(b.calls);
	expect(all.filter((a) => a.startsWith("sudo stop") || a.startsWith("sudo -n stop"))).toEqual([]);
	expect(all).toContain(`git -C ${srv} reset -q --keep c0ffee`);
	expect(all.at(-1)).toBe("start api");
	expect(readInflight(t.paths)).toBeNull();
});

test("busy is asked before the pause and again after it", async () => {
	let n = 0;
	const b = box({ "queue-busy": () => (++n === 2 ? ok() : fail()) });
	const r = await prepareBuilt(spec(), target, ctx(b.run), clock);
	expect(r).toEqual({ failed: "The queue has a job waiting. Nothing was changed." });
	const all = argvs(b.calls);
	expect(all.indexOf("queue-busy")).toBeLessThan(all.indexOf("stop api"));
	expect(all.lastIndexOf("queue-busy")).toBeGreaterThan(all.indexOf("stop api"));
	expect(all.at(-1)).toBe("start api");
	expect(all.some((a) => a.startsWith("git"))).toBe(false);
});

test("a refused sudo preflight changes nothing and runs no git", async () => {
	const b = box({ "sudo -n -l stop srv": fail("a password is required") });
	expect(await prepareBuilt(spec(), target, ctx(b.run), clock)).toEqual({ failed: SUDO_REFUSED });
	const all = argvs(b.calls);
	expect(all.some((a) => a.startsWith("git") || a.startsWith("stop"))).toBe(false);
	expect(readInflight(t.paths)).toBeNull();
});

test("the marker exists with step pause before the first pause stop", async () => {
	const b = box();
	const r = await prepareBuilt(spec(), target, ctx(b.run), clock);
	expect("failed" in r).toBe(false);
	const atStop = b.markers.find((m) => m.argv === "stop api");
	expect(atStop?.marker?.tree).toMatchObject({ step: "pause", paused: [] });
	expect(readInflight(t.paths)?.tree).toMatchObject({ step: "build", active: ["srv"], paused: ["api"] });
});

test("the fetch, a record step and a build step each put their pid in the marker while they run", async () => {
	const b = box();
	const r = (await prepareBuilt(spec(), target, ctx(b.run), clock)) as Built;
	const seen = (prefix: string) =>
		b.markers.find((m) => m.argv.startsWith(prefix) && m.argv.endsWith("(started)"))?.marker?.tree?.build?.pid;
	expect(seen("git -C")).toBe(101);
	expect(seen("freeze")).toBe(102);
	expect(seen("bash -c make all")).toBe(103);
	expect(r.active.map((a) => [a.svc.name, a.since])).toEqual([["srv", "100"]]);
	expect(readFileSync(join(r.point, "freeze.txt"), "utf8")).toBe("pkg==1\n");
	expect(argvs(b.calls)).toContain(`git -C ${srv} fetch --no-tags origin tag v1.1`);
	expect(argvs(b.calls)).toContain(`git -C ${srv} merge -q --ff-only v1.1`);
});

test("local changes, commits off the remote and a failed fetch each refuse with nothing changed", async () => {
	expect(
		await prepareBuilt(
			spec(),
			target,
			ctx(box({ [`git -C ${srv} status --porcelain --untracked-files=no`]: ok(" M x.c\n") }).run),
			clock,
		),
	).toEqual({
		failed: "~/srv has local changes. Nothing was changed.",
	});
	expect(
		await prepareBuilt(
			spec({ move: "reset" }),
			target,
			ctx(box({ [`git -C ${srv} branch -r --contains HEAD`]: ok("") }).run),
			clock,
		),
	).toEqual({ failed: "~/srv has commits that are not on GitHub. Nothing was changed." });
	const b = box({ [`git -C ${srv} fetch --no-tags origin tag v1.1`]: fail() });
	expect(await prepareBuilt(spec(), target, ctx(b.run), clock)).toEqual({
		failed: "Could not fetch v1.1 into ~/srv. Nothing was changed.",
	});
	expect(argvs(b.calls).at(-1)).toBe("start api");
	expect(existsSync(join(t.paths.data, "backups/srv/1.0"))).toBe(false);
});

test("a build step that fails is named, and a hold tree goes back to the running copy", async () => {
	put(join(srv, "engine/x"), "engine 1");
	const b = box({ "bash -c make all": () => (put(join(srv, "engine/x"), "half built"), fail("boom")) });
	const r = await prepareBuilt(spec({ hold: ["engine"], keep: ["bin", "engine"] }), target, ctx(b.run), clock);
	expect(r).toEqual({ failed: "Build step failed: make all. Nothing was changed." });
	expect(readFileSync(join(srv, "engine/x"), "utf8")).toBe("engine 1");
	expect(existsSync(join(srv, "engine.upkeep-live"))).toBe(false);
});
