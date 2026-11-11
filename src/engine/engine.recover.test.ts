import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createEngine, type EngineDeps } from "./engine";
import type { FetchLike } from "./github";
import { installBuilt } from "./kinds/built";
import { loadManifest } from "./manifest";
import type { RunOpts, RunResult } from "./run";
import { readInflight, writeInflight } from "./store";
import { ok, strictRun, tempHome } from "./testkit";

let t: ReturnType<typeof tempHome>;
let dir = "";
let proc = "";
beforeEach(() => {
	t = tempHome("recover");
	dir = join(t.paths.home, "srv");
	proc = join(t.dir, "proc");
	mkdirSync(proc);
	put(join(dir, "bin/srv"), "version f2918cabb");
	put(join(dir, "lib/core.so"), "core 1");
	writeFileSync(join(t.dir, "seed.toml"), SEED);
});
afterEach(() => t.cleanup());

function put(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}
const fail = (stderr = "no"): RunResult => ({ code: 1, stdout: "", stderr, timedOut: false });

function hashTree(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else out[p.slice(root.length)] = new Bun.CryptoHasher("sha256").update(readFileSync(p)).digest("hex");
		}
	};
	walk(root);
	return out;
}

const SEED = `[apps.srv]
name = "Server"
kind = "source"
repo = "o/srv"
dir = "~/srv"
move = "ff"
check = ["print-version"]
keep = ["bin", "lib"]
build = ["make all"]
pause = [{ name = "api", active = ["is-active", "api"], stop = ["stop", "api"], start = ["start", "api"] }]

[[apps.srv.serve]]
name = "srv"
active = ["is-active", "srv"]
stop = ["sudo", "stop", "srv"]
start = ["sudo", "start", "srv"]
since = ["since", "srv"]
health = "http://127.0.0.1:1/health"
wait_s = 0
`;

/** A fake box: two units (the served one and a paused one), a git that does nothing, a build that rewrites bin and lib. */
function fakeBox(kill?: string) {
	const units: Record<string, { running: boolean; starts: number }> = {
		srv: { running: true, starts: 1 },
		api: { running: true, starts: 1 },
	};
	const killed: number[] = [];
	const rec = strictRun((argv: string[], opts: RunOpts) => {
		const key = argv.join(" ");
		if (kill && key === kill) throw new Error("killed");
		const [cmd, ...rest] = argv;
		if (cmd === "sudo" && rest[1] === "-l") return ok();
		if (cmd === "gh") return fail("not logged in");
		const unit = units[argv.at(-1) ?? ""];
		if (cmd === "is-active" && unit) return unit.running ? ok() : fail();
		if ((cmd === "stop" || (cmd === "sudo" && rest[1] === "stop")) && unit) {
			unit.running = false;
			return ok();
		}
		if ((cmd === "start" || (cmd === "sudo" && rest[1] === "start")) && unit) {
			unit.running = true;
			unit.starts += 1;
			return ok();
		}
		if (cmd === "since" && unit) return ok(`${unit.starts}\n`);
		if (key === "print-version") return ok(`${readFileSync(join(dir, "bin/srv"), "utf8").replace("version ", "")}\n`);
		if (cmd === "cp") {
			cpSync(rest[1] ?? "", rest[2] ?? "", { recursive: true, verbatimSymlinks: true });
			return ok();
		}
		if (cmd === "install") {
			cpSync(rest[2] ?? "", rest[3] ?? "");
			return ok();
		}
		if (cmd === "mv") {
			renameSync(rest[1] ?? "", rest[2] ?? "");
			return ok();
		}
		if (cmd === "rm") return ok();
		if (cmd === "git" && rest[2] === "rev-parse") return ok("c0ffee\n");
		if (cmd === "git" && rest[2] === "status") return ok("");
		if (cmd === "git") {
			opts.onStart?.(4100);
			return ok();
		}
		if (key === "bash -c make all") {
			opts.onStart?.(4242);
			put(join(dir, "bin/srv"), "version a1b2c3d4e");
			put(join(dir, "lib/core.so"), "core 2");
			return ok();
		}
		return undefined;
	});
	const fetch: FetchLike = async (url) => {
		if (url.endsWith("/releases/latest")) return Response.json({ tag_name: "v0.9.0" });
		return units.srv?.running ? new Response("ok") : new Response("down", { status: 503 });
	};
	return { ...rec, units, fetch, killed };
}

function deps(box: ReturnType<typeof fakeBox>): EngineDeps {
	writeFileSync(join(t.dir, "seed.toml"), SEED);
	return {
		paths: t.paths,
		seedManifest: join(t.dir, "seed.toml"),
		fetch: box.fetch,
		run: box.run,
		now: () => new Date("2026-11-11T12:00:00Z"),
		oldScript: join(t.dir, "no-old-script"),
		oldLock: join(t.dir, "old.lock"),
		oldLog: join(t.dir, "old.log"),
		procRoot: proc,
		kill: (pid) => box.killed.push(pid),
		recoverWaitMs: 0,
	};
}

const spec = () => {
	const s = loadManifest(join(t.dir, "seed.toml")).apps[0];
	if (!s) throw new Error("no seed");
	return s;
};
const target = { from: "f2918cabb", version: "0.9.0", tag: "v0.9.0" };
const kindCtx = (box: ReturnType<typeof fakeBox>) => ({
	paths: t.paths,
	run: box.run,
	fetch: box.fetch,
	token: null,
	settings: { keepBackups: 1, notify: true, checkAtLogin: false } as never,
	log: () => {},
	stage: () => {},
	procRoot: proc,
});

test("check with a built update's marker in place runs only probes and leaves the marker", async () => {
	const box = fakeBox();
	const d = deps(box);
	const marker = {
		key: "srv",
		dest: dir,
		backupVersion: "f2918cabb",
		tree: { step: "placing" as const, build: null, active: ["srv"], paused: ["api"] },
	};
	writeInflight(t.paths, marker);
	const engine = createEngine(d);
	await engine.check();
	expect(box.calls.map((c) => c.argv.join(" ")).filter((a) => a !== "gh auth token")).toEqual(["print-version"]);
	expect(readInflight(t.paths)).toEqual(marker);
	expect(engine.snapshot().apps[0]).toMatchObject({
		status: "problem",
		detail: "An update was interrupted. Restore f2918cabb from this row.",
	});
});

test("recover after a stop in the pause step starts the paused units and clears the marker", async () => {
	const box = fakeBox();
	box.units.api = { running: false, starts: 1 };
	writeInflight(t.paths, {
		key: "srv",
		dest: dir,
		backupVersion: null,
		tree: { step: "pause", build: null, active: [], paused: ["api"] },
	});
	expect(await createEngine(deps(box)).recover()).toEqual([{ key: "srv", ok: true }]);
	expect(box.units.api?.running).toBe(true);
	expect(readInflight(t.paths)).toBeNull();
});

test("recover ends a live build step first, restores, and starts every unit that was active, even one down now", async () => {
	const box = fakeBox();
	const d = deps(box);
	await expect(installBuilt(spec(), target, kindCtx(fakeBox("sudo -n stop srv")) as never)).rejects.toThrow("killed");
	// The build step's pid is still alive with the same start time.
	const m = readInflight(t.paths);
	if (!m?.tree) throw new Error("no marker");
	mkdirSync(join(proc, "4242"));
	writeFileSync(join(proc, "4242/stat"), "4242 (bash) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 777 0 0");
	writeInflight(t.paths, { ...m, tree: { ...m.tree, build: { pid: 4242, started: 777 } } });
	box.units.srv = { running: false, starts: 5 };
	const engine = createEngine(d);
	expect(await engine.recover()).toEqual([{ key: "srv", ok: true }]);
	expect(box.killed).toEqual([4242]);
	const all = box.calls.map((c) => c.argv.join(" "));
	expect(all.indexOf("sudo -n start srv")).toBeGreaterThan(-1);
	expect(box.units.srv?.running).toBe(true);
	expect(readFileSync(join(dir, "bin/srv"), "utf8")).toBe("version f2918cabb");
	expect(readInflight(t.paths)).toBeNull();
});

test("a pid reused by another process is never signalled", async () => {
	const box = fakeBox();
	mkdirSync(join(proc, "4242"));
	writeFileSync(join(proc, "4242/stat"), "4242 (vim) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 999 0 0");
	writeInflight(t.paths, {
		key: "srv",
		dest: dir,
		backupVersion: null,
		tree: { step: "pause", build: { pid: 4242, started: 777 }, active: [], paused: [] },
	});
	await createEngine(deps(box)).recover();
	expect(box.killed).toEqual([]);
});

test("a built restore stops what runs, puts the point back and starts it again", async () => {
	const box = fakeBox();
	expect(await installBuilt(spec(), target, kindCtx(box) as never)).toMatchObject({
		result: "done",
		installed: "a1b2c3d4e",
	});
	const engine = createEngine(deps(box));
	box.calls.length = 0;
	expect(await engine.restore("srv", "f2918cabb")).toEqual({ ok: true });
	const all = box.calls.map((c) => c.argv.join(" "));
	expect(all.indexOf("sudo -n stop srv")).toBeLessThan(all.indexOf("sudo -n start srv"));
	expect(readFileSync(join(dir, "bin/srv"), "utf8")).toBe("version f2918cabb");
	expect(box.units.srv?.running).toBe(true);
	expect(engine.history(5)[0]).toMatchObject({ key: "srv", result: "restored", to: "f2918cabb" });
});

const KILLS = [
	`git -C DIR fetch --no-tags origin tag v0.9.0`,
	"bash -c make all",
	"sudo -n stop srv",
	"sudo -n start srv",
	"print-version",
];

test("end to end: a kill at each step, then recover(): the old tree is back, every unit runs, and a second recover does nothing", async () => {
	for (const k of KILLS) {
		t.cleanup();
		t = tempHome("recover");
		dir = join(t.paths.home, "srv");
		proc = join(t.dir, "proc");
		mkdirSync(proc);
		put(join(dir, "bin/srv"), "version f2918cabb");
		put(join(dir, "lib/core.so"), "core 1");
		const before = hashTree(dir);
		const kill = k.replace("DIR", dir);
		const killer = fakeBox(kill);
		writeFileSync(join(t.dir, "seed.toml"), SEED);
		// oxlint-disable-next-line no-await-in-loop -- one kill point at a time, each on its own home
		await expect(installBuilt(spec(), target, kindCtx(killer) as never)).rejects.toThrow("killed");
		expect(readInflight(t.paths)?.tree).toBeDefined();
		// The box after the kill is the same box: carry its unit state over to the recovering process.
		const box = fakeBox();
		box.units.srv = { ...(killer.units.srv ?? { running: false, starts: 1 }) };
		box.units.api = { ...(killer.units.api ?? { running: false, starts: 1 }) };
		const engine = createEngine(deps(box));
		// oxlint-disable-next-line no-await-in-loop -- one kill point at a time
		expect(await engine.recover()).toEqual([{ key: "srv", ok: true }]);
		expect(readInflight(t.paths)).toBeNull();
		expect(box.units.srv?.running).toBe(true);
		expect(box.units.api?.running).toBe(true);
		expect(hashTree(dir)).toEqual(before);
		// oxlint-disable-next-line no-await-in-loop -- one kill point at a time
		expect(await engine.recover()).toEqual([]);
	}
});
