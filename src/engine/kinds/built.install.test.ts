import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	renameSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AppSpec, Serve } from "../../shared/types";
import type { FetchLike } from "../github";
import type { ProcessResult, Run, RunOpts } from "../run";
import { DEFAULT_SETTINGS, readInflight } from "../store";
import { ok, strictRun, tempHome, withCancel } from "../testkit";
import { installBuilt, startService, stopService } from "./built";
import type { KindCtx } from "./context";

let t: ReturnType<typeof tempHome>;
let dir = "";
let proc = "";
beforeEach(() => {
	t = tempHome("built-install");
	dir = join(t.paths.home, "srv");
	proc = join(t.dir, "proc");
	mkdirSync(proc);
	put(join(dir, "bin/srv"), "version f2918cabb");
	put(join(dir, "lib/core.so"), "core 1");
});
afterEach(() => t.cleanup());

function put(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}
const fail = (stderr = "no"): ProcessResult => ({
	code: 1,
	stdout: "",
	stderr,
	timedOut: false,
});

/** Every file under root with its content, so a tree can be compared byte for byte. */
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

/**
 * A fake box with one service. The service's state is a record; stop and start flip it, since reports a
 * start counter, health answers while it runs. The built program is a file whose content is its version.
 */
function fakeBox(
	o: {
		startFails?: number;
		buildFails?: boolean;
		newVersion?: string;
		healthFails?: boolean;
		sinceStuck?: boolean;
		stopFailsAfter?: number;
		/** The new version dies at once: active reads false, and with restart the unit comes back up (since moves) on every look. */
		crashes?: "restart" | "dead";
		/** Runs as the build, before the new program is written: what the app's own setup does to the tree. */
		onBuild?: () => void;
	} = {},
) {
	const svc = { running: true, starts: 1, servedVersion: "f2918cabb" };
	let startCalls = 0;
	let stopCalls = 0;
	const newVersion = o.newVersion ?? "a1b2c3d4e";
	const rec = strictRun((argv: string[], opts: RunOpts) => {
		const key = argv.join(" ");
		const [cmd, ...rest] = argv;
		if (cmd === "sudo" && rest[0] === "-n" && rest[1] === "-l") return ok();
		const crashing = o.crashes !== undefined && svc.running && svc.servedVersion === newVersion;
		if (key === "is-active srv") return svc.running && !crashing ? ok() : fail();
		if (key === "sudo -n stop srv") {
			stopCalls += 1;
			if (o.stopFailsAfter !== undefined && stopCalls > o.stopFailsAfter) return fail("refused");
			svc.running = false;
			return ok();
		}
		if (key === "sudo -n start srv") {
			startCalls += 1;
			if (o.startFails && startCalls <= o.startFails) return fail("unit failed");
			svc.running = true;
			if (!o.sinceStuck) svc.starts += 1;
			svc.servedVersion = readFileSync(join(dir, "bin/srv"), "utf8").replace("version ", "");
			return ok();
		}
		if (key === "since srv") {
			if (crashing && o.crashes === "restart") svc.starts += 1;
			return ok(`${svc.starts}\n`);
		}
		if (key === "print-version") return ok(`${readFileSync(join(dir, "bin/srv"), "utf8").replace("version ", "")}\n`);
		if (cmd === "cp") {
			cpSync(rest[1] ?? "", rest[2] ?? "", {
				recursive: true,
				verbatimSymlinks: true,
			});
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
		if (cmd === "ln" && rest[0] === "-sfn") {
			rmSync(rest[2] ?? "", { force: true });
			symlinkSync(rest[1] ?? "", rest[2] ?? "");
			return ok();
		}
		if (cmd === "git" && rest[2] === "rev-parse") return ok("c0ffee\n");
		if (cmd === "git" && rest[2] === "status") return ok("");
		if (cmd === "git" && rest[2] === "branch") return ok("origin/main\n");
		if (cmd === "git") return ok();
		if (cmd === "needs") return ok("");
		if (key === "bash -c make all") {
			opts.onStart?.(4242);
			if (o.buildFails) return fail("compile error");
			o.onBuild?.();
			put(join(dir, "bin/srv"), `version ${newVersion}`);
			put(join(dir, "lib/core.so"), "core 2");
			return ok();
		}
		return undefined;
	});
	const fetch: FetchLike = async () =>
		svc.running && !o.healthFails && !(o.crashes && svc.servedVersion === newVersion)
			? new Response('{"status":"ok"}')
			: new Response("down", { status: 503 });
	return { ...rec, svc, fetch };
}

const SERVE: Serve = {
	name: "srv",
	active: ["is-active", "srv"],
	stop: ["sudo", "stop", "srv"],
	start: ["sudo", "start", "srv"],
	since: ["since", "srv"],
	health: "http://127.0.0.1:1/health",
	wait_s: 0,
};
const spec = (extra: Partial<AppSpec> = {}): AppSpec => ({
	key: "srv",
	name: "Server",
	kind: "source",
	repo: "o/srv",
	dir: "~/srv",
	move: "ff",
	check: ["print-version"],
	commit: ["print-version"],
	keep: ["bin", "lib"],
	build: ["make all"],
	serve: [SERVE],
	...extra,
});
const target = { from: "f2918cabb", version: "0.9.0", tag: "v0.9.0" };

function ctx(box: ReturnType<typeof fakeBox>): KindCtx {
	return {
		paths: t.paths,
		run: box.run,
		fetch: box.fetch,
		token: null,
		settings: DEFAULT_SETTINGS,
		log: () => {},
		stage: () => {},
		procRoot: proc,
	};
}
const argvs = (calls: { argv: string[] }[]) => calls.map((c) => c.argv.join(" "));

test("end to end: a good update stops, swaps, starts, proves the restart, and reads the new commit as written", async () => {
	const box = fakeBox();
	const o = await installBuilt(spec(), target, ctx(box));
	expect(o).toMatchObject({
		result: "done",
		installed: "a1b2c3d4e",
		restartToApply: false,
	});
	expect(Object.keys(o.stages)).toEqual(["download", "backup", "build", "install", "verify"]);
	expect(box.svc).toMatchObject({
		running: true,
		starts: 2,
		servedVersion: "a1b2c3d4e",
	});
	expect(readInflight(t.paths)).toBeNull();
	expect(existsSync(join(t.paths.data, "backups/srv/f2918cabb/meta.json"))).toBe(true);
});

test("end to end: a build that fails never issues a stop, and the tree is as it was", async () => {
	const before = hashTree(dir);
	const box = fakeBox({ buildFails: true });
	const o = await installBuilt(spec(), target, ctx(box));
	expect(o).toMatchObject({
		result: "failed",
		detail: "Build step failed: make all. Nothing was changed.",
	});
	expect(argvs(box.calls).filter((a) => a.startsWith("sudo -n stop"))).toEqual([]);
	expect(argvs(box.calls)).toContain("sudo -n -l stop srv");
	expect(hashTree(dir)).toEqual(before);
	expect(box.svc).toMatchObject({ running: true, starts: 1 });
});

test("end to end: a start that fails puts the old tree back byte for byte and starts the old version", async () => {
	const before = hashTree(dir);
	const box = fakeBox({ startFails: 1 });
	const o = await installBuilt(spec(), target, ctx(box));
	expect(o).toMatchObject({
		result: "rolled_back",
		installed: "f2918cabb",
		detail: "Would not start after the update. Restored f2918cabb.",
	});
	expect(hashTree(dir)).toEqual(before);
	expect(box.svc).toMatchObject({ running: true, servedVersion: "f2918cabb" });
	expect(readInflight(t.paths)).toBeNull();
});

test("a since value that did not change rolls back: the old process answering proves nothing", async () => {
	const box = fakeBox({ sinceStuck: true });
	const o = await installBuilt(spec(), target, ctx(box));
	expect(o.result).toBe("failed");
	expect(o.detail).toBe(
		"Would not start after the update, and putting f2918cabb back failed: srv did not answer. See the log.",
	);
	expect(readFileSync(join(dir, "bin/srv"), "utf8")).toBe("version f2918cabb");
});

test("a failed health check rolls back and starts the old unit", async () => {
	const box = fakeBox({ healthFails: true });
	const o = await installBuilt(spec(), target, ctx(box));
	expect(o.detail).toContain("putting f2918cabb back failed: srv did not answer");
	expect(readFileSync(join(dir, "bin/srv"), "utf8")).toBe("version f2918cabb");
	expect(box.svc.running).toBe(true);
	expect(argvs(box.calls).filter((a) => a === "sudo -n start srv")).toHaveLength(2);
});

test("a unit that restarts on its own while starting rolls back at once, not after wait_s", async () => {
	const box = fakeBox({ crashes: "restart" });
	const logs: string[] = [];
	const at = Date.now();
	const o = await installBuilt(spec({ serve: [{ ...SERVE, wait_s: 300 }] }), target, {
		...ctx(box),
		log: (l) => logs.push(l),
	});
	expect(Date.now() - at).toBeLessThan(1500);
	expect(o).toMatchObject({
		result: "rolled_back",
		detail: "Would not start after the update. Restored f2918cabb.",
	});
	expect(logs).toContain("srv restarted on its own before it answered: it is crashing.");
	// The unit reads down while it waits out its restart delay; the rollback stops it anyway before the files go back.
	expect(argvs(box.calls).filter((a) => a === "sudo -n stop srv")).toHaveLength(2);
	expect(box.svc).toMatchObject({ running: true, servedVersion: "f2918cabb" });
});

test("a unit that died after its start rolls back after two looks, not after wait_s", async () => {
	const box = fakeBox({ crashes: "dead" });
	const logs: string[] = [];
	const at = Date.now();
	const o = await installBuilt(spec({ serve: [{ ...SERVE, since: undefined, wait_s: 300 }] }), target, {
		...ctx(box),
		log: (l) => logs.push(l),
	});
	expect(Date.now() - at).toBeLessThan(4000);
	expect(o).toMatchObject({
		result: "rolled_back",
		detail: "Would not start after the update. Restored f2918cabb.",
	});
	expect(logs).toContain("srv is not running, so it will not answer.");
	expect(box.svc.servedVersion).toBe("f2918cabb");
});

test("a restore point taken before setup moved its files into terminal/ puts the old layout back", async () => {
	// Strata 0.2.15 to 0.2.16: the build's own setup moves .venv, the run configs and the built engine into
	// terminal/, and the table keeps and holds both places. Only the old ones exist when the point is taken.
	put(join(dir, ".venv/bin/python"), "python 1");
	put(join(dir, "engine/strata"), "engine 1");
	put(join(dir, "strata-swift.json"), '{"port":8092}');
	symlinkSync("strata-swift.json", join(dir, "strata-active.json"));
	const box = fakeBox({
		startFails: 1,
		onBuild: () => {
			mkdirSync(join(dir, "terminal"));
			for (const n of [".venv", "engine", "strata-swift.json"]) renameSync(join(dir, n), join(dir, "terminal", n));
			rmSync(join(dir, "strata-active.json"));
			put(join(dir, "terminal/engine/strata"), "engine 2");
			symlinkSync("strata-swift.json", join(dir, "terminal/strata-active.json"));
		},
	});
	const keep = [".venv", "engine", "strata-*.json", "terminal/.venv", "terminal/engine", "terminal/strata-*.json"];
	const o = await installBuilt(
		spec({
			keep: ["bin", "lib", ...keep],
			hold: ["engine", "terminal/engine"],
		}),
		target,
		ctx(box),
	);
	expect(o).toMatchObject({ result: "rolled_back", installed: "f2918cabb" });
	expect(readFileSync(join(dir, ".venv/bin/python"), "utf8")).toBe("python 1");
	expect(readFileSync(join(dir, "engine/strata"), "utf8")).toBe("engine 1");
	expect(readFileSync(join(dir, "strata-swift.json"), "utf8")).toBe('{"port":8092}');
	expect(readlinkSync(join(dir, "strata-active.json"))).toBe("strata-swift.json");
	expect(existsSync(join(dir, "engine.upkeep-live"))).toBe(false);
	// What setup put in terminal/ was not there when the point was taken, so the rollback leaves it.
	expect(readFileSync(join(dir, "terminal/engine/strata"), "utf8")).toBe("engine 2");
});

test("an inactive serve entry is never stopped or started, and the row says no restart happened", async () => {
	const box = fakeBox();
	box.svc.running = false;
	const o = await installBuilt(spec(), target, ctx(box));
	expect(o).toMatchObject({
		result: "done",
		detail: "Updated without a restart: none of its services was running.",
	});
	expect(argvs(box.calls).some((a) => a.startsWith("sudo -n stop") || a.startsWith("sudo -n start"))).toBe(false);
});

test("the version after is read as written: equal to before is a failed check, a new commit is done", async () => {
	const same = fakeBox({ newVersion: "f2918cabb" });
	expect(await installBuilt(spec(), target, ctx(same))).toMatchObject({
		result: "rolled_back",
		detail: "Failed its test after the update: the version check. Restored f2918cabb.",
	});
	t.cleanup();
	t = tempHome("built-install");
	dir = join(t.paths.home, "srv");
	put(join(dir, "bin/srv"), "version f2918cabb");
	put(join(dir, "lib/core.so"), "core 1");
	mkdirSync(proc, { recursive: true });
	expect(await installBuilt(spec(), target, ctx(fakeBox()))).toMatchObject({
		result: "done",
		installed: "a1b2c3d4e",
	});
});

test("prune is skipped when needs prints nothing, and url tests are skipped when nothing ran", async () => {
	put(join(t.paths.home, "builds/old-1/x"), "x");
	const box = fakeBox();
	box.svc.running = false;
	const s = spec({
		needs: ["needs"],
		prune: ["~/builds/old-*"],
		test: [
			{
				name: "an answer",
				url: "http://127.0.0.1:1/c",
				body: "{}",
				expect: "never",
			},
			{ name: "runs", run: ["print-version"] },
		],
	});
	// needs prints nothing: the restore point refuses, so give it one line for takeTree, then nothing after.
	let n = 0;
	const run: KindCtx["run"] = async (argv, opts) => {
		if (argv[0] === "needs") return ++n === 1 ? ok(`${join(t.paths.home, "builds/live")}\n`) : ok("");
		return box.run(argv, opts);
	};
	const o = await installBuilt(s, target, { ...ctx(box), run });
	expect(o).toMatchObject({ result: "done" });
	expect(existsSync(join(t.paths.home, "builds/old-1"))).toBe(true);
	expect(statSync(join(t.paths.home, "builds/old-1")).isDirectory()).toBe(true);
});

test("a kill between the two place renames still puts the old directory back", async () => {
	const pkg = join(t.paths.home, "share/pkg");
	put(join(pkg, "index.js"), "pkg 1");
	const box = fakeBox();
	const s = spec({
		stage: "~/stage-{tag}",
		build: ["make all", "make pkg {stage}"],
		place: [{ from: "{stage}", to: "~/share/pkg" }],
	});
	const run: KindCtx["run"] = async (argv, opts) => {
		const step = argv[2] ?? "";
		if (argv[0] === "bash" && step.startsWith("make pkg ")) {
			put(join(step.slice("make pkg ".length), "index.js"), "pkg 2");
			return ok();
		}
		return box.run(argv, opts);
	};
	let cut = false;
	// The first move of the live directory happens, then the process dies before anything else runs.
	const rename = (a: string, b: string) => {
		renameSync(a, b);
		if (!cut && a === pkg) {
			cut = true;
			throw new Error("killed");
		}
	};
	const o = await installBuilt(s, target, { ...ctx(box), run, rename });
	expect(cut).toBe(true);
	expect(o.result).toBe("rolled_back");
	expect(readFileSync(join(pkg, "index.js"), "utf8")).toBe("pkg 1");
});

test("a stage of the home directory, dir or a live place target refuses before any command runs", async () => {
	for (const extra of [
		{ stage: "~" },
		{ stage: "~/srv" },
		{ stage: "/" },
		{ stage: "~/share", place: [{ from: "{stage}", to: "~/share/pkg" }] },
		{ stage: "~/st", place: [{ from: "{stage}", to: "~" }] },
		{ stage: "~/st", place: [{ from: "~/elsewhere", to: "~/share/pkg" }] },
		{ stage: "~/st", place: [{ from: "{stage}", to: "~/Documents" }] },
		{ stage: "~/st", place: [{ from: "{stage}", to: t.paths.data }] },
	]) {
		const box = fakeBox();
		// oxlint-disable-next-line no-await-in-loop -- one table at a time
		const o = await installBuilt(spec(extra), target, ctx(box));
		expect(o.result).toBe("failed");
		expect(o.detail).toStartWith("Refused ");
		expect(o.detail).toEndWith("Nothing was changed.");
		expect(box.calls).toEqual([]);
		expect(existsSync(t.paths.home)).toBe(true);
	}
});

test("prune never deletes a directory outside dir, whatever its pattern names", async () => {
	put(join(t.paths.home, "outside/x"), "x");
	put(join(dir, "build-old/x"), "x");
	const box = fakeBox();
	const live = join(dir, "build-live");
	put(join(live, "x"), "x");
	const run: KindCtx["run"] = async (argv, opts) => (argv[0] === "needs" ? ok(`${live}\n`) : box.run(argv, opts));
	const o = await installBuilt(spec({ needs: ["needs"], prune: ["~/*", "~/srv/build-*"] }), target, {
		...ctx(box),
		run,
	});
	expect(o.result).toBe("done");
	expect(existsSync(join(t.paths.home, "outside/x"))).toBe(true);
	expect(existsSync(dir)).toBe(true);
	expect(existsSync(live)).toBe(true);
	expect(existsSync(join(dir, "build-old"))).toBe(false);
});

test("a rollback whose stop fails puts nothing back, keeps the marker and says so", async () => {
	const box = fakeBox({ healthFails: true, stopFailsAfter: 1 });
	const o = await installBuilt(spec(), target, ctx(box));
	expect(o).toMatchObject({
		result: "failed",
		detail: "Could not stop srv to put f2918cabb back. See the log.",
	});
	expect(readFileSync(join(dir, "bin/srv"), "utf8")).toBe("version a1b2c3d4e");
	expect(readInflight(t.paths)?.tree?.step).toBe("stopping");
	expect(box.svc.running).toBe(true);
});

test("a held directory is still there to roll back to when a test fails after the start", async () => {
	const box = fakeBox();
	const run: KindCtx["run"] = async (argv, opts) => (argv[0] === "a-test" ? fail("no") : box.run(argv, opts));
	const s = spec({
		keep: ["lib"],
		hold: ["bin"],
		test: [{ name: "a test", run: ["a-test"] }],
	});
	const o = await installBuilt(s, target, { ...ctx(box), run });
	expect(o).toMatchObject({
		result: "rolled_back",
		detail: "Failed its test after the update: a test. Restored f2918cabb.",
	});
	expect(readFileSync(join(dir, "bin/srv"), "utf8")).toBe("version f2918cabb");
	expect(existsSync(join(dir, "bin.upkeep-live"))).toBe(false);
	expect(existsSync(join(dir, "bin.upkeep-gone"))).toBe(false);
});

test("after a verified update the held copy is gone", async () => {
	const box = fakeBox();
	const o = await installBuilt(spec({ hold: ["bin"] }), target, ctx(box));
	expect(o.result).toBe("done");
	expect(readFileSync(join(dir, "bin/srv"), "utf8")).toBe("version a1b2c3d4e");
	expect(existsSync(join(dir, "bin.upkeep-live"))).toBe(false);
	expect(existsSync(join(dir, "bin.upkeep-gone"))).toBe(false);
});

test("config values are written into the app's JSON files: a key, and the value after a flag in an array", async () => {
	put(join(dir, "app.json"), JSON.stringify({ keep: true, flags: ["--port", "1", "--v"] }));
	const s = spec({
		config: [
			{ file: "~/srv/app.json", key: "mode", value: "fast" },
			{ file: "~/srv/app.json", array: "flags", flag: "--port", value: 2 },
			{ file: "~/srv/app.json", array: "flags", flag: "--host", value: "lan" },
		],
	});
	expect(await installBuilt(s, target, ctx(fakeBox()))).toMatchObject({
		result: "done",
	});
	expect(JSON.parse(readFileSync(join(dir, "app.json"), "utf8"))).toEqual({
		keep: true,
		mode: "fast",
		flags: ["--port", 2, "--v", "--host", "lan"],
	});
});

test("a config file that holds a list, not an object, stops the update and is left as it was", async () => {
	put(join(dir, "app.json"), "[1, 2]");
	const s = spec({
		config: [{ file: "~/srv/app.json", key: "mode", value: "fast" }],
	});
	const o = await installBuilt(s, target, ctx(fakeBox()));
	expect(o.result).not.toBe("done");
	expect(o.detail).toBe("The build did not pass its check: config. Nothing was changed.");
	expect(readFileSync(join(dir, "app.json"), "utf8")).toBe("[1, 2]");
});

test("a url test passes on a matching answer and rolls back on a fail_on match or an unreachable url", async () => {
	const named = (extra: Partial<NonNullable<AppSpec["test"]>[number]>) =>
		spec({
			test: [
				{
					name: "the answer",
					url: "http://127.0.0.1:1/c",
					body: "{}",
					...extra,
				},
			],
		});
	expect(await installBuilt(named({ expect: "ok" }), target, ctx(fakeBox()))).toMatchObject({ result: "done" });
	t.cleanup();
	t = tempHome("built-install");
	dir = join(t.paths.home, "srv");
	put(join(dir, "bin/srv"), "version f2918cabb");
	put(join(dir, "lib/core.so"), "core 1");
	mkdirSync(proc, { recursive: true });
	expect(await installBuilt(named({ fail_on: "ok" }), target, ctx(fakeBox()))).toMatchObject({
		result: "rolled_back",
		detail: "Failed its test after the update: the answer. Restored f2918cabb.",
	});
	const box = fakeBox();
	const unreachable: KindCtx["fetch"] = async (url, init) => {
		if (String(url).endsWith("/c")) throw new Error("connection refused");
		return box.fetch(url, init);
	};
	expect(
		await installBuilt(named({ timeout_s: 0 }), target, {
			...ctx(box),
			fetch: unreachable,
		}),
	).toMatchObject({
		result: "rolled_back",
	});
});

/** Resets the temp home to the starting tree, then runs one update with the given move and returns its git argv. */
async function moveCommand(move: "reset" | "detach" | "ff"): Promise<string> {
	t.cleanup();
	t = tempHome("built-install");
	dir = join(t.paths.home, "srv");
	put(join(dir, "bin/srv"), "version f2918cabb");
	put(join(dir, "lib/core.so"), "core 1");
	mkdirSync(proc, { recursive: true });
	const box = fakeBox();
	expect(await installBuilt(spec({ move }), target, ctx(box))).toMatchObject({
		result: "done",
	});
	const argv = argvs(box.calls).find((a) => /^git -C \S+ (reset|checkout|merge) /.test(a)) ?? "";
	return argv.replace(/^git -C \S+ /, "");
}

test("move picks the git command: reset or detach for those tables, a fast-forward merge otherwise", async () => {
	expect(await moveCommand("reset")).toBe("reset -q --hard v0.9.0");
	expect(await moveCommand("detach")).toBe("checkout -q --detach v0.9.0");
	expect(await moveCommand("ff")).toBe("merge -q --ff-only v0.9.0");
});

test("a tree that cannot move to the tag without a merge changes nothing and starts nothing", async () => {
	const before = hashTree(dir);
	const box = fakeBox();
	const run: KindCtx["run"] = async (argv, opts) =>
		argv[0] === "git" && argv.includes("merge") ? fail("not possible to fast-forward") : box.run(argv, opts);
	const o = await installBuilt(spec(), target, { ...ctx(box), run });
	expect(o).toMatchObject({
		result: "failed",
		detail: expect.stringContaining("cannot move to v0.9.0 without a merge"),
	});
	expect(hashTree(dir)).toEqual(before);
	expect(argvs(box.calls).some((a) => a.startsWith("sudo -n stop"))).toBe(false);
});

test("a restore point that cannot be taken refuses the update with nothing changed", async () => {
	const box = fakeBox();
	const run: KindCtx["run"] = async (argv, opts) => (argv[0] === "cp" ? fail("no space left") : box.run(argv, opts));
	const o = await installBuilt(spec(), target, { ...ctx(box), run });
	expect(o).toMatchObject({
		result: "failed",
		detail: expect.stringContaining("Could not take a restore point"),
	});
	expect(readFileSync(join(dir, "bin/srv"), "utf8")).toBe("version f2918cabb");
});

test("Stop now during a build step puts the files back and never stops the service", async () => {
	const before = hashTree(dir);
	const stop = new AbortController();
	// The press lands while make runs; the fake step then ends as a cut one would.
	const box = fakeBox({ onBuild: () => stop.abort() });
	const o = await installBuilt(spec(), target, {
		...ctx(box),
		run: withCancel(box.run, stop.signal),
		cancel: stop.signal,
	});
	expect(o).toMatchObject({
		result: "stopped",
		installed: "f2918cabb",
		detail: "Stopped. f2918cabb is back in place.",
	});
	expect(box.calls.find((c) => c.argv.join(" ") === "bash -c make all")?.opts.cuttable).toBe(true);
	expect(argvs(box.calls).filter((a) => a.startsWith("sudo -n stop"))).toEqual([]);
	expect(hashTree(dir)).toEqual(before);
	expect(readInflight(t.paths)).toBeNull();
});

test("Stop now during the health check after the start rolls the old version back in", async () => {
	const before = hashTree(dir);
	const stop = new AbortController();
	const box = fakeBox();
	const fetch: FetchLike = async (url, init) => {
		if (box.svc.servedVersion !== "f2918cabb" && !stop.signal.aborted) {
			stop.abort();
			return new Response("down", { status: 503 });
		}
		return box.fetch(url, init);
	};
	const o = await installBuilt(spec({ serve: [{ ...SERVE, wait_s: 30 }] }), target, {
		...ctx(box),
		fetch,
		run: withCancel(box.run, stop.signal),
		cancel: stop.signal,
	});
	expect(o).toMatchObject({
		result: "stopped",
		installed: "f2918cabb",
		detail: "Stopped. f2918cabb is back in place.",
	});
	expect(hashTree(dir)).toEqual(before);
	expect(box.svc).toMatchObject({ running: true, servedVersion: "f2918cabb" });
	// The root stop and start are never cut; only the forward steps are offered to Stop now.
	expect(box.calls.filter((c) => c.argv[0] === "sudo" && c.argv[2] !== "-l").every((c) => !c.opts.cuttable)).toBe(true);
});

test("Stop now may cut a built app's fetch, build, check and verify read; root stops and starts and undos never", async () => {
	const box = fakeBox();
	// check_built runs as the build does; the fake box answers it like the build step.
	const run: Run = (argv, opts) =>
		argv.join(" ") === "bash -c make check" ? box.run(["bash", "-c", "make all"], opts) : box.run(argv, opts);
	const checks: RunOpts[] = [];
	const watched: Run = (argv, opts = {}) => {
		if (argv.join(" ") === "bash -c make check") checks.push(opts);
		return run(argv, opts);
	};
	expect(
		await installBuilt(spec({ check_built: ["make check"] }), target, { ...ctx(box), run: watched }),
	).toMatchObject({
		result: "done",
	});
	const cut = box.calls.filter((c) => c.opts.cuttable).map((c) => c.argv.join(" "));
	expect(cut).toEqual([
		expect.stringMatching(/^git -C .* fetch --no-tags origin tag v0\.9\.0$/),
		"bash -c make all",
		"bash -c make all",
		"print-version",
	]);
	expect(checks.map((o) => o.cuttable)).toEqual([true]);
});

test("a fetched tag that points elsewhere than the check saw fails before the backup, with both commits logged", async () => {
	const before = hashTree(dir);
	const box = fakeBox();
	const logged: string[] = [];
	const o = await installBuilt(spec(), { ...target, commit: "beef" }, { ...ctx(box), log: (l) => logged.push(l) });
	expect(o).toMatchObject({
		result: "failed",
		installed: "f2918cabb",
		detail:
			"The tag v0.9.0 points at another commit than the one the check saw, so nothing was built. Check again before you install.",
	});
	expect(hashTree(dir)).toEqual(before);
	expect(box.calls.some((c) => c.argv.join(" ") === "bash -c make all")).toBe(false);
	expect(box.calls.map((c) => c.argv.join(" "))).toContainEqual(
		expect.stringMatching(/^git -C .* rev-parse --verify v0\.9\.0\^\{commit\}$/),
	);
	expect(logged).toContain("v0.9.0 pointed at beef at check time, and at c0ffee now.");
	// The commit the check saw is still there: the build goes on.
	expect(await installBuilt(spec(), { ...target, commit: "c0ffee" }, ctx(fakeBox()))).toMatchObject({ result: "done" });
});

test("a unit's stop or start is cuttable on the way forward only when it does not run as root", async () => {
	const seen: [string, boolean][] = [];
	const run: Run = async (argv, opts = {}) => {
		seen.push([argv.join(" "), opts.cuttable === true]);
		return ok();
	};
	const user = {
		name: "u",
		active: ["is-active"],
		stop: ["systemctl", "--user", "stop", "u"],
		start: ["systemctl", "--user", "start", "u"],
	};
	const root = { ...user, stop: ["sudo", "systemctl", "stop", "u"], start: ["sudo", "systemctl", "start", "u"] };
	await stopService(run, user, true);
	await startService(run, user, true);
	await stopService(run, root, true);
	await startService(run, root, true);
	await stopService(run, user);
	expect(seen).toEqual([
		["systemctl --user stop u", true],
		["systemctl --user start u", true],
		["sudo -n systemctl stop u", false],
		["sudo -n systemctl start u", false],
		["systemctl --user stop u", false],
	]);
});

test("Stop now never cuts a built app's step that runs as root: a sudo table, or sudo in the step's own text", async () => {
	const box = fakeBox();
	const run: Run = (argv, opts) =>
		argv[0] === "bash" && argv[2]?.includes("sudo") ? box.run(["bash", "-c", "make all"], opts) : box.run(argv, opts);
	const seen: [string, boolean][] = [];
	const watched: Run = (argv, opts = {}) => {
		if (argv[0] === "bash") seen.push([argv[2] ?? "", opts.cuttable === true]);
		return run(argv, opts);
	};
	expect(await installBuilt(spec({ build: ["sudo make all"] }), target, { ...ctx(box), run: watched })).toMatchObject({
		result: "done",
	});
	expect(seen).toEqual([["sudo -n make all", false]]);
	const box2 = fakeBox();
	expect(await installBuilt(spec({ sudo: true }), target, ctx(box2))).toMatchObject({ result: "done" });
	expect(box2.calls.find((c) => c.argv.join(" ") === "bash -c make all")?.opts.cuttable).toBe(false);
});

test("Stop now pressed after verify passed keeps the update: the run just ends", async () => {
	const stop = new AbortController();
	const box = fakeBox();
	// The last version read, after the new unit answered, is where the press lands; that read still passes.
	const run: Run = (argv, opts) => {
		if (argv[0] === "print-version" && box.svc.servedVersion === "a1b2c3d4e") stop.abort();
		return box.run(argv, opts);
	};
	const o = await installBuilt(spec(), target, {
		...ctx(box),
		run: withCancel(run, stop.signal),
		cancel: stop.signal,
	});
	expect(stop.signal.aborted).toBe(true);
	expect(o).toMatchObject({ result: "done", installed: "a1b2c3d4e" });
	expect(box.svc).toMatchObject({ running: true, servedVersion: "a1b2c3d4e" });
	expect(readInflight(t.paths)).toBeNull();
});

test("Stop now pressed before the health check starts ends it without a poll, and the old version goes back", async () => {
	const stop = new AbortController();
	const box = fakeBox();
	let polls = 0;
	// The press lands on the new unit's since read, just before health would poll.
	const run: Run = (argv, opts) => {
		if (argv.join(" ") === "since srv" && box.svc.servedVersion === "a1b2c3d4e" && !stop.signal.aborted) stop.abort();
		return box.run(argv, opts);
	};
	const fetch: FetchLike = async (url, init) => {
		if (box.svc.servedVersion === "a1b2c3d4e") polls += 1;
		return box.fetch(url, init);
	};
	const o = await installBuilt(spec({ serve: [{ ...SERVE, wait_s: 30 }] }), target, {
		...ctx(box),
		fetch,
		run: withCancel(run, stop.signal),
		cancel: stop.signal,
	});
	expect(o).toMatchObject({ result: "stopped", installed: "f2918cabb" });
	expect(polls).toBe(0);
	expect(box.svc).toMatchObject({ running: true, servedVersion: "f2918cabb" });
});
