import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { backupDir, packOlder } from "./backup";
import { createEngine, type EngineDeps } from "./engine";
import { REASON_UNRECOVERED } from "./kinds/context";
import type { FetchLike } from "./github";
import { installBuilt, restoreBuilt, SUDO_REFUSED } from "./kinds/built";
import { loadManifest } from "./manifest";
import type { RunOpts, ProcessResult } from "./run";
import { DEFAULT_SETTINGS, readInflight, writeInflight } from "./store";
import { ok, realRun, strictRun, tempHome } from "./testkit";

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
const fail = (stderr = "no"): ProcessResult => ({ code: 1, stdout: "", stderr, timedOut: false });

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
function fakeBox(kill?: string, o: { stopFails?: boolean; sinceStuck?: boolean } = {}) {
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
			if (o.stopFails && unit === units.srv) return fail("refused");
			unit.running = false;
			return ok();
		}
		if ((cmd === "start" || (cmd === "sudo" && rest[1] === "start")) && unit) {
			unit.running = true;
			if (!o.sinceStuck) unit.starts += 1;
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
	settings: DEFAULT_SETTINGS,
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
	// Besides the probe, only reads: the token, and the Flatpak and Snap lists the rows' notes come from.
	const reads = new Set(["gh auth token", "flatpak list --app --columns=application,name", "snap list"]);
	expect(box.calls.map((c) => c.argv.join(" ")).filter((a) => !reads.has(a))).toEqual(["print-version"]);
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
	expect(await createEngine(deps(box)).recover()).toMatchObject([{ key: "srv", ok: true }]);
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
	expect(await engine.recover()).toMatchObject([{ key: "srv", ok: true }]);
	expect(box.killed).toEqual([4242]);
	const all = box.calls.map((c) => c.argv.join(" "));
	expect(all.indexOf("sudo -n start srv")).toBeGreaterThan(-1);
	// Down now may be a crash loop between two restarts: the stop goes out anyway, before the files go back.
	expect(all.indexOf("sudo -n stop srv")).toBeGreaterThan(-1);
	expect(all.indexOf("sudo -n stop srv")).toBeLessThan(all.indexOf("sudo -n start srv"));
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

test("a run stops at an app whose marker was kept, so the next app cannot erase it", async () => {
	const box = fakeBox("sudo -n start srv");
	box.units.two = { running: true, starts: 1 };
	const d = deps(box);
	writeFileSync(join(t.dir, "seed.toml"), `${SEED}\n${SEED.replaceAll("srv", "two")}`);
	// The fake's version probe reads srv's binary for both apps.
	put(join(dir, "bin/srv"), "version 0.8.0");
	put(join(t.paths.home, "two/bin/two"), "version 0.8.0");
	const engine = createEngine(d);
	await engine.check();
	expect(engine.readyKeys(false)).toEqual(["srv", "two"]);
	expect(await engine.install(["srv", "two"])).toEqual({ started: true });
	await engine.idle();
	expect(engine.snapshot().run.results.map((r) => r.key)).toEqual(["srv"]);
	expect(readInflight(t.paths)).toMatchObject({ key: "srv", tree: { step: "starting" } });
	expect(engine.snapshot().apps.find((a) => a.key === "two")?.status).toBe("ready");
});

test("an update never writes over another app's kept marker", async () => {
	const other = {
		key: "two",
		dest: "",
		backupVersion: null,
		tree: { step: "stopping" as const, build: null, active: [], paused: [] },
	};
	writeInflight(t.paths, other);
	const file = join(t.paths.state, "inflight.json");
	const before = readFileSync(file);
	await expect(installBuilt(spec(), target, kindCtx(fakeBox()) as never)).rejects.toThrow(REASON_UNRECOVERED);
	expect(readFileSync(file)).toEqual(before);
});

test("a restore over a failed recovery's marker keeps it when a stop fails, and starts its paused units when it works", async () => {
	const box = fakeBox(undefined, { stopFails: true });
	expect(await installBuilt(spec(), target, kindCtx(fakeBox()) as never)).toMatchObject({ result: "done" });
	box.units.api = { running: false, starts: 1 };
	const kept = {
		key: "srv",
		dest: dir,
		backupVersion: "gone",
		tree: { step: "placing" as const, build: null, active: [], paused: ["api"] },
	};
	writeInflight(t.paths, kept);
	const file = join(t.paths.state, "inflight.json");
	const before = readFileSync(file);
	expect(await restoreBuilt(spec(), "f2918cabb", kindCtx(box) as never)).toEqual({
		ok: false,
		detail: "Could not stop srv. Nothing was changed.",
	});
	expect(readFileSync(file)).toEqual(before);
	const works = fakeBox();
	works.units.api = { running: false, starts: 1 };
	expect(await restoreBuilt(spec(), "f2918cabb", kindCtx(works) as never)).toEqual({ ok: true });
	expect(works.units.api?.running).toBe(true);
	expect(readInflight(t.paths)).toBeNull();
});

test("the app a kept marker names cannot be removed: recovery needs its table", async () => {
	writeInflight(t.paths, {
		key: "srv",
		dest: dir,
		backupVersion: "gone",
		tree: { step: "placing", build: null, active: [], paused: [] },
	});
	const engine = createEngine(deps(fakeBox()));
	expect(await engine.removeApp("srv")).toEqual({ ok: false, detail: REASON_UNRECOVERED });
	expect(loadManifest(join(t.paths.config, "apps.toml")).apps.map((a) => a.key)).toEqual(["srv"]);
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
		expect(await engine.recover()).toMatchObject([{ key: "srv", ok: true }]);
		expect(readInflight(t.paths)).toBeNull();
		expect(box.units.srv?.running).toBe(true);
		expect(box.units.api?.running).toBe(true);
		expect(hashTree(dir)).toEqual(before);
		// oxlint-disable-next-line no-await-in-loop -- one kill point at a time
		expect(await engine.recover()).toEqual([]);
	}
});

test("a recovery that fails stops Install and every other app's restore, and leaves its marker byte for byte", async () => {
	const box = fakeBox();
	expect(await installBuilt(spec(), target, kindCtx(box) as never)).toMatchObject({ result: "done" });
	const d = deps(box);
	writeFileSync(join(t.dir, "seed.toml"), `${SEED}\n${SEED.replaceAll("srv", "two")}`);
	// The marker names a restore point that is not there, so the put-back fails and the marker is kept.
	writeInflight(t.paths, {
		key: "srv",
		dest: dir,
		backupVersion: "gone",
		tree: { step: "placing", build: null, active: [], paused: [] },
	});
	const file = join(t.paths.state, "inflight.json");
	const before = readFileSync(file);
	const engine = createEngine(d);
	expect(await engine.install(["srv"])).toEqual({ started: false, reason: REASON_UNRECOVERED });
	expect(readFileSync(file)).toEqual(before);
	expect(await engine.restore("two", "f2918cabb")).toEqual({ ok: false, detail: REASON_UNRECOVERED });
	expect(readFileSync(file)).toEqual(before);
	expect(await engine.restore("srv", "f2918cabb")).toEqual({ ok: true });
	expect(readFileSync(join(dir, "bin/srv"), "utf8")).toBe("version f2918cabb");
	expect(readInflight(t.paths)).toBeNull();
});

test("a kill during a pause stop leaves the unit on the marker, and recover starts it again", async () => {
	const killer = fakeBox("stop api");
	await expect(installBuilt(spec(), target, kindCtx(killer) as never)).rejects.toThrow("killed");
	expect(readInflight(t.paths)?.tree).toMatchObject({ step: "pause", paused: ["api"] });
	// The stop went through before the process died.
	const box = fakeBox();
	box.units.api = { running: false, starts: 1 };
	expect(await createEngine(deps(box)).recover()).toMatchObject([{ key: "srv", ok: true }]);
	expect(box.units.api?.running).toBe(true);
	expect(readInflight(t.paths)).toBeNull();
});

test("recovery never puts files back under a unit it could not stop, and keeps the marker", async () => {
	const killer = fakeBox("print-version");
	await expect(installBuilt(spec(), target, kindCtx(killer) as never)).rejects.toThrow("killed");
	const marker = readFileSync(join(t.paths.state, "inflight.json"), "utf8");
	const box = fakeBox(undefined, { stopFails: true });
	expect(await createEngine(deps(box)).recover()).toMatchObject([{ key: "srv", ok: false }]);
	expect(readFileSync(join(dir, "bin/srv"), "utf8")).toBe("version a1b2c3d4e");
	expect(readFileSync(join(t.paths.state, "inflight.json"), "utf8")).toBe(marker);
});

test("recovery counts a start only when since moved", async () => {
	const killer = fakeBox("print-version");
	await expect(installBuilt(spec(), target, kindCtx(killer) as never)).rejects.toThrow("killed");
	const box = fakeBox(undefined, { sinceStuck: true });
	expect(await createEngine(deps(box)).recover()).toMatchObject([{ key: "srv", ok: false }]);
	expect(readInflight(t.paths)?.tree).toBeDefined();
});

test("a kill during a built restore leaves a marker, and recover finishes the restore", async () => {
	expect(await installBuilt(spec(), target, kindCtx(fakeBox()) as never)).toMatchObject({ result: "done" });
	const killer = fakeBox("sudo -n start srv");
	await expect(restoreBuilt(spec(), "f2918cabb", kindCtx(killer) as never)).rejects.toThrow("killed");
	expect(readInflight(t.paths)).toMatchObject({
		backupVersion: "f2918cabb",
		tree: { step: "starting", active: ["srv"], paused: ["api"] },
	});
	const box = fakeBox();
	box.units.srv = { ...(killer.units.srv ?? { running: false, starts: 1 }) };
	box.units.api = { ...(killer.units.api ?? { running: false, starts: 1 }) };
	expect(await createEngine(deps(box)).recover()).toMatchObject([{ key: "srv", ok: true }]);
	expect(readFileSync(join(dir, "bin/srv"), "utf8")).toBe("version f2918cabb");
	expect(box.units.srv?.running).toBe(true);
	expect(box.units.api?.running).toBe(true);
	expect(readInflight(t.paths)).toBeNull();
});

test("a built restore from a packed point unpacks it before anything stops, then puts the old tree back", async () => {
	put(join(dir, "lib/data"), "kept data ".repeat(50_000));
	expect(await installBuilt(spec(), target, kindCtx(fakeBox()) as never)).toMatchObject({ result: "done" });
	// A newer point makes f2918cabb an older one, which is packed.
	const later = join(backupDir(t.paths, "srv"), "later");
	put(
		join(later, "meta.json"),
		JSON.stringify({ version: "later", at: "2099-01-01T00:00:00Z", files: [], sudo: false }),
	);
	await packOlder(t.paths, "srv", realRun(t.paths), () => {});
	const point = join(backupDir(t.paths, "srv"), "f2918cabb");
	expect(readdirSync(point).toSorted()).toEqual([".upkeep-packed.tar.zst", "meta.json"]);
	// tar failing leaves the point packed and stops nothing.
	const refused = fakeBox();
	const broken = async (argv: string[], opts?: RunOpts) =>
		argv[0] === "tar" ? fail("zstd: not found") : refused.run(argv, opts);
	expect(await restoreBuilt(spec(), "f2918cabb", { ...kindCtx(refused), run: broken } as never)).toEqual({
		ok: false,
		detail: "Could not unpack the f2918cabb restore point: zstd: not found",
	});
	expect([refused.units.srv?.running, refused.units.api?.running]).toEqual([true, true]);
	expect(existsSync(join(point, ".upkeep-packed.tar.zst"))).toBe(true);
	const box = fakeBox();
	const run = async (argv: string[], opts?: RunOpts) =>
		argv[0] === "tar" ? realRun(t.paths)(argv, opts) : box.run(argv, opts);
	expect(await restoreBuilt(spec(), "f2918cabb", { ...kindCtx(box), run } as never)).toEqual({ ok: true });
	expect(readFileSync(join(dir, "bin/srv"), "utf8")).toBe("version f2918cabb");
	expect(readFileSync(join(dir, "lib/core.so"), "utf8")).toBe("core 1");
	expect(readFileSync(join(dir, "lib/data"), "utf8")).toBe("kept data ".repeat(50_000));
});

test("a built restore checks sudo -n -l before it stops anything", async () => {
	expect(await installBuilt(spec(), target, kindCtx(fakeBox()) as never)).toMatchObject({ result: "done" });
	const box = fakeBox();
	const run = async (argv: string[], opts?: RunOpts) =>
		argv[0] === "sudo" && argv[2] === "-l" ? fail("a password is required") : box.run(argv, opts);
	expect(await restoreBuilt(spec(), "f2918cabb", { ...kindCtx(box), run } as never)).toEqual({
		ok: false,
		detail: SUDO_REFUSED,
	});
	expect(box.calls.map((c) => c.argv.join(" ")).filter((a) => a.includes("stop"))).toEqual([]);
	expect(readInflight(t.paths)).toBeNull();
});

test("recovery never signals init, this process or its parent, even when the start time matches", async () => {
	for (const pid of [1, process.pid, process.ppid]) {
		mkdirSync(join(proc, String(pid)), { recursive: true });
		writeFileSync(join(proc, String(pid), "stat"), `${pid} (x) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 777 0 0`);
		writeInflight(t.paths, {
			key: "srv",
			dest: dir,
			backupVersion: null,
			tree: { step: "pause", build: { pid, started: 777 }, active: [], paused: [] },
		});
		const box = fakeBox();
		// oxlint-disable-next-line no-await-in-loop -- one pid at a time
		await createEngine(deps(box)).recover();
		expect(box.killed).toEqual([]);
	}
});

test("recovery at step build removes the half-built stage", async () => {
	const s = { ...spec(), stage: "~/stage-{tag}" };
	await expect(installBuilt(s, target, kindCtx(fakeBox("bash -c make all")) as never)).rejects.toThrow("killed");
	const stage = join(t.paths.home, "stage-v0.9.0");
	put(join(stage, "half.o"), "x");
	expect(readInflight(t.paths)?.tree?.step).toBe("build");
	expect(await createEngine(deps(fakeBox())).recover()).toMatchObject([{ key: "srv", ok: true }]);
	expect(existsSync(stage)).toBe(false);
	expect(existsSync(dir)).toBe(true);
});
