import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppSpec, Serve } from "../../shared/types";
import type { FetchLike } from "../github";
import type { RunOpts, ProcessResult } from "../run";
import { readInflight } from "../store";
import { ok, strictRun, tempHome } from "../testkit";
import { installBuilt } from "./built";
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
const fail = (stderr = "no"): ProcessResult => ({ code: 1, stdout: "", stderr, timedOut: false });

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
		if (key === "is-active srv") return svc.running ? ok() : fail();
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
		if (key === "since srv") return ok(`${svc.starts}\n`);
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
		if (cmd === "git") return ok();
		if (cmd === "needs") return ok("");
		if (key === "bash -c make all") {
			opts.onStart?.(4242);
			if (o.buildFails) return fail("compile error");
			put(join(dir, "bin/srv"), `version ${newVersion}`);
			put(join(dir, "lib/core.so"), "core 2");
			return ok();
		}
		return undefined;
	});
	const fetch: FetchLike = async () =>
		svc.running && !o.healthFails ? new Response('{"status":"ok"}') : new Response("down", { status: 503 });
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
		settings: { keepBackups: 1, notify: true, checkAtLogin: false } as KindCtx["settings"],
		log: () => {},
		stage: () => {},
		procRoot: proc,
	};
}
const argvs = (calls: { argv: string[] }[]) => calls.map((c) => c.argv.join(" "));

test("end to end: a good update stops, swaps, starts, proves the restart, and reads the new commit as written", async () => {
	const box = fakeBox();
	const o = await installBuilt(spec(), target, ctx(box));
	expect(o).toMatchObject({ result: "done", installed: "a1b2c3d4e", restartToApply: false });
	expect(Object.keys(o.stages)).toEqual(["download", "backup", "build", "install", "verify"]);
	expect(box.svc).toMatchObject({ running: true, starts: 2, servedVersion: "a1b2c3d4e" });
	expect(readInflight(t.paths)).toBeNull();
	expect(existsSync(join(t.paths.data, "backups/srv/f2918cabb/meta.json"))).toBe(true);
});

test("end to end: a build that fails never issues a stop, and the tree is as it was", async () => {
	const before = hashTree(dir);
	const box = fakeBox({ buildFails: true });
	const o = await installBuilt(spec(), target, ctx(box));
	expect(o).toMatchObject({ result: "failed", detail: "Build step failed: make all. Nothing was changed." });
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

test("an inactive serve entry is never stopped or started, and the row says no restart happened", async () => {
	const box = fakeBox();
	box.svc.running = false;
	const o = await installBuilt(spec(), target, ctx(box));
	expect(o).toMatchObject({ result: "done", detail: "Updated without a restart: none of its services was running." });
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
	expect(await installBuilt(spec(), target, ctx(fakeBox()))).toMatchObject({ result: "done", installed: "a1b2c3d4e" });
});

test("prune is skipped when needs prints nothing, and url tests are skipped when nothing ran", async () => {
	put(join(t.paths.home, "builds/old-1/x"), "x");
	const box = fakeBox();
	box.svc.running = false;
	const s = spec({
		needs: ["needs"],
		prune: ["~/builds/old-*"],
		test: [
			{ name: "an answer", url: "http://127.0.0.1:1/c", body: "{}", expect: "never" },
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
	expect(o).toMatchObject({ result: "failed", detail: "Could not stop srv to put f2918cabb back. See the log." });
	expect(readFileSync(join(dir, "bin/srv"), "utf8")).toBe("version a1b2c3d4e");
	expect(readInflight(t.paths)?.tree?.step).toBe("stopping");
	expect(box.svc.running).toBe(true);
});

test("a held directory is still there to roll back to when a test fails after the start", async () => {
	const box = fakeBox();
	const run: KindCtx["run"] = async (argv, opts) => (argv[0] === "a-test" ? fail("no") : box.run(argv, opts));
	const s = spec({ keep: ["lib"], hold: ["bin"], test: [{ name: "a test", run: ["a-test"] }] });
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
