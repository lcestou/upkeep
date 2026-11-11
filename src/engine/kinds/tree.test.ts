import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AppSpec } from "../../shared/types";
import type { RunOpts, ProcessResult } from "../run";
import { ok, strictRun, tempHome } from "../testkit";
import { expandGlob, notePlaced, restoreTree, revertFiles, safePath, takeTree, type TreeCtx } from "./tree";

let t: ReturnType<typeof tempHome>;
let app = "";
beforeEach(() => {
	t = tempHome("tree");
	app = join(t.paths.home, "app");
	put(join(app, "engine/bin"), "engine 1");
	put(join(app, ".venv/lib.so"), "venv 1");
	put(join(app, "cfg-a.json"), '{"port":1}');
	symlinkSync("cfg-a.json", join(app, "active.json"));
	put(join(t.paths.home, "bin/srv"), "srv 1");
	put(join(t.paths.home, "share/pkg/index.js"), "pkg 1");
});
afterEach(() => t.cleanup());

function put(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}
const read = (f: string) => readFileSync(f, "utf8");

const spec = (extra: Partial<AppSpec> = {}): AppSpec => ({
	key: "app",
	name: "App",
	kind: "source",
	repo: "o/app",
	dir: "~/app",
	move: "ff",
	build: ["make"],
	check: ["v"],
	keep: ["engine", ".venv", "cfg-*.json", "active.json"],
	hold: ["engine"],
	place: [{ from: "{stage}/srv", to: "~/bin/srv" }],
	undo: ["echo undone {point}"],
	...extra,
});

const done = (stdout = ""): ProcessResult => ok(stdout);

/** The fake box: cp, ln, install, mv, rm and git act on the temp tree; anything else throws. */
function fakeBox() {
	return strictRun((argv: string[], opts: RunOpts) => {
		const [cmd, ...rest] = argv;
		if (cmd === "cp" && rest[0] === "-a") {
			cpSync(rest[1] ?? "", rest[2] ?? "", { recursive: true, verbatimSymlinks: true });
			return done();
		}
		if (cmd === "ln" && rest[0] === "-sfn") {
			rmSync(rest[2] ?? "", { force: true });
			symlinkSync(rest[1] ?? "", rest[2] ?? "");
			return done();
		}
		if (cmd === "install") {
			cpSync(rest[2] ?? "", rest[3] ?? "");
			return done();
		}
		if (cmd === "mv" && rest[0] === "-f") {
			renameSync(rest[1] ?? "", rest[2] ?? "");
			return done();
		}
		if (cmd === "rm") return done();
		if (cmd === "git" && rest[2] === "rev-parse") return done("c0ffee\n");
		if (cmd === "git") return done();
		if (cmd === "bash") {
			opts.onStart?.(4242);
			return done();
		}
		return undefined;
	});
}

function ctx(run: TreeCtx["run"], extra: Partial<TreeCtx> = {}): TreeCtx {
	return { paths: t.paths, run, log: () => {}, ...extra };
}

/** The state an update leaves before its rollback: hold taken, tree rebuilt, links and files changed. */
function changeEverything(): void {
	renameSync(join(app, "engine"), join(app, "engine.upkeep-live"));
	put(join(app, "engine/bin"), "engine 2");
	rmSync(join(app, ".venv"), { recursive: true });
	put(join(app, ".venv/lib.so"), "venv 2");
	writeFileSync(join(app, "cfg-a.json"), '{"port":2}');
	rmSync(join(app, "active.json"));
	symlinkSync("cfg-b.json", join(app, "active.json"));
	writeFileSync(join(t.paths.home, "bin/srv"), "srv 2");
}

function expectOld(): void {
	expect(read(join(app, "engine/bin"))).toBe("engine 1");
	expect(read(join(app, ".venv/lib.so"))).toBe("venv 1");
	expect(read(join(app, "cfg-a.json"))).toBe('{"port":1}');
	expect(readlinkSync(join(app, "active.json"))).toBe("cfg-a.json");
	for (const p of ["engine", ".venv"])
		for (const suffix of [".upkeep-live", ".upkeep-failed", ".upkeep-new"])
			expect(existsSync(join(app, p + suffix))).toBe(false);
}

test("a restore point keeps a directory, a file and a link, with HEAD and the place target", async () => {
	const { run } = fakeBox();
	const { point, tree } = await takeTree(spec(), ctx(run), {
		version: "1.0",
		at: "2026-11-11T00:00:00Z",
		vars: { stage: "/s" },
	});
	expect(tree.kept).toEqual([
		{ rel: "engine", link: false },
		{ rel: ".venv", link: false },
		{ rel: "cfg-a.json", link: false },
		{ rel: "active.json", link: true },
	]);
	expect(tree.commit).toBe("c0ffee");
	expect(tree.placed).toEqual([{ to: join(t.paths.home, "bin/srv"), name: "placed-0" }]);
	expect(tree.dir).toBe(app);
	expect(read(join(point, "keep/engine/bin"))).toBe("engine 1");
	expect(lstatSync(join(point, "keep/active.json")).isSymbolicLink()).toBe(true);
	expect(read(join(point, "placed-0"))).toBe("srv 1");
	expect(existsSync(`${point}.upkeep-tmp`)).toBe(false);
});

test("a revert puts everything back by rename: every copy lands in .upkeep-new, never on a live path", async () => {
	const { run, calls } = fakeBox();
	const { point } = await takeTree(spec(), ctx(run), { version: "1.0", at: "x", vars: {} });
	changeEverything();
	calls.length = 0;
	await restoreTree(point, ctx(run));
	expectOld();
	expect(read(join(t.paths.home, "bin/srv"))).toBe("srv 1");
	const copies = calls.filter((c) => c.argv[0] === "cp");
	expect(copies.length).toBeGreaterThan(0);
	expect(copies.every((c) => (c.argv[3] ?? "").endsWith(".upkeep-new"))).toBe(true);
	// After the stop the kept copy is the truth: keep copies the engine even though hold renamed one back.
	expect(copies.some((c) => (c.argv[2] ?? "").endsWith("/keep/engine"))).toBe(true);
	expect(calls.some((c) => c.argv.join(" ") === `git -C ${app} reset -q --keep c0ffee`)).toBe(true);
	expect(calls.find((c) => c.argv[0] === "bash")?.argv[2]).toBe(`echo undone ${point}`);
});

test("restoreTree run twice is the same as once", async () => {
	const { run } = fakeBox();
	const { point } = await takeTree(spec(), ctx(run), { version: "1.0", at: "x", vars: {} });
	changeEverything();
	await restoreTree(point, ctx(run));
	await restoreTree(point, ctx(run));
	expectOld();
	expect(read(join(t.paths.home, "bin/srv"))).toBe("srv 1");
});

test("a revert stopped after each of its renames finishes on the next run, and nothing is ever left missing", async () => {
	const pkg = join(t.paths.home, "share/pkg");
	const placeDir = spec({ place: [{ from: "{stage}/pkg", to: "~/share/pkg" }] });
	for (let stopAt = 1; stopAt <= 8; stopAt++) {
		t.cleanup();
		t = tempHome("tree");
		app = join(t.paths.home, "app");
		put(join(app, "engine/bin"), "engine 1");
		put(join(app, ".venv/lib.so"), "venv 1");
		put(join(app, "cfg-a.json"), '{"port":1}');
		symlinkSync("cfg-a.json", join(app, "active.json"));
		put(join(t.paths.home, "bin/srv"), "srv 1");
		put(join(pkg, "index.js"), "pkg 1");
		const { run } = fakeBox();
		// oxlint-disable-next-line no-await-in-loop -- each stop point is its own scenario
		const { point } = await takeTree(placeDir, ctx(run), { version: "1.0", at: "x", vars: {} });
		changeEverything();
		// place moved the old package into the point and a new one into its place.
		renameSync(pkg, join(point, "placed-0"));
		notePlaced(point, { to: pkg, name: "placed-0" });
		put(join(pkg, "index.js"), "pkg 2");
		let n = 0;
		const failing = (a: string, b: string) => {
			n += 1;
			if (n === stopAt) throw new Error("power cut");
			renameSync(a, b);
		};
		// oxlint-disable-next-line no-await-in-loop -- each stop point is its own scenario
		await restoreTree(point, ctx(run, { rename: failing })).catch(() => {});
		// oxlint-disable-next-line no-await-in-loop -- each stop point is its own scenario
		await restoreTree(point, ctx(run));
		expectOld();
		expect(read(join(pkg, "index.js"))).toBe("pkg 1");
		expect(existsSync(`${pkg}.upkeep-failed`)).toBe(false);
	}
});

test("an undo step reports its pid, and paths and globs stay under the engine's home", async () => {
	const pids: number[] = [];
	const { run } = fakeBox();
	const { point } = await takeTree(spec(), ctx(run), { version: "1.0", at: "x", vars: {} });
	await revertFiles(point, ctx(run, { onStart: (pid) => pids.push(pid) }));
	expect(pids).toEqual([4242]);
	expect(expandGlob("cfg-*.json", t.paths, app)).toEqual([join(app, "cfg-a.json")]);
	expect(expandGlob("~/app/*.json", t.paths, null)).toEqual([join(app, "active.json"), join(app, "cfg-a.json")]);
	expect(expandGlob("~/app/missing", t.paths, null)).toEqual([]);
});

test("a copy that fails takes no restore point and leaves no half-written one", async () => {
	const { run } = strictRun((argv) =>
		argv[0] === "cp" ? { code: 1, stdout: "", stderr: "No space left on device", timedOut: false } : undefined,
	);
	await expect(takeTree(spec(), ctx(run), { version: "1.0", at: "x", vars: {} })).rejects.toThrow(
		"cp engine: No space left on device",
	);
	expect(existsSync(join(t.paths.data, "backups/app/1.0"))).toBe(false);
	expect(existsSync(join(t.paths.data, "backups/app/1.0.upkeep-tmp"))).toBe(false);
});

/** The engine's four files as read now, null where one is missing. */
const engineFiles = () =>
	["a", "b", "c", "bin"].map((f) => (existsSync(join(app, "engine", f)) ? read(join(app, "engine", f)) : null));

test("a cut while .upkeep-live was being deleted: restoreTree puts back the kept copy, and a second run changes nothing", async () => {
	for (const f of ["a", "b", "c"]) put(join(app, "engine", f), `${f} 1`);
	const { run } = fakeBox();
	const { point } = await takeTree(spec(), ctx(run), { version: "1.0", at: "x", vars: {} });
	changeEverything();
	// The delete of the held copy ran at step starting and was cut after removing two of its files.
	for (const f of ["a", "b"]) rmSync(join(app, "engine.upkeep-live", f));
	await restoreTree(point, ctx(run));
	expect(engineFiles()).toEqual(["a 1", "b 1", "c 1", "engine 1"]);
	await restoreTree(point, ctx(run));
	expect(engineFiles()).toEqual(["a 1", "b 1", "c 1", "engine 1"]);
	expectOld();
	expect(readdirSync(point).filter((f) => f.startsWith("hold-done"))).toEqual([]);
});

test("before the stop, revertFiles renames the held copy back and keep skips it; no marks or .upkeep-gone stay", async () => {
	const { run, calls } = fakeBox();
	const { point } = await takeTree(spec(), ctx(run), { version: "1.0", at: "x", vars: {} });
	changeEverything();
	put(join(app, "engine.upkeep-gone/half"), "x");
	calls.length = 0;
	await revertFiles(point, ctx(run));
	expectOld();
	expect(calls.some((c) => c.argv[0] === "cp" && (c.argv[2] ?? "").endsWith("/keep/engine"))).toBe(false);
	expect(existsSync(join(app, "engine.upkeep-gone"))).toBe(false);
	expect(readdirSync(point).filter((f) => f.startsWith("hold-done"))).toEqual([]);
});

test("a put-back stopped just before its last delete leaves a stale .upkeep-failed, and the next run still finishes", async () => {
	const pkg = join(t.paths.home, "share/pkg");
	const { run } = fakeBox();
	const { point } = await takeTree(spec({ place: [{ from: "{stage}/pkg", to: "~/share/pkg" }] }), ctx(run), {
		version: "1.0",
		at: "x",
		vars: {},
	});
	changeEverything();
	renameSync(pkg, join(point, "placed-0"));
	notePlaced(point, { to: pkg, name: "placed-0" });
	put(join(pkg, "index.js"), "pkg 2");
	// The state a cut leaves after a rename put the path back but before the moved-aside copy was deleted.
	for (const p of [join(app, ".venv"), join(app, "engine"), pkg]) put(join(`${p}.upkeep-failed`, "stale"), "x");
	await restoreTree(point, ctx(run));
	expectOld();
	expect(read(join(pkg, "index.js"))).toBe("pkg 1");
	for (const p of [join(app, ".venv"), join(app, "engine"), pkg]) expect(existsSync(`${p}.upkeep-failed`)).toBe(false);
});

test("keep or hold outside dir, a record path and a version that names a folder are refused before anything is copied", async () => {
	const { run, calls } = fakeBox();
	const o = { at: "x", vars: {} };
	await expect(takeTree(spec({ keep: [".."] }), ctx(run), { ...o, version: "1.0" })).rejects.toThrow("Refused");
	await expect(takeTree(spec({ keep: ["~/bin"] }), ctx(run), { ...o, version: "1.0" })).rejects.toThrow("Refused");
	await expect(takeTree(spec({ keep: ["."] }), ctx(run), { ...o, version: "1.0" })).rejects.toThrow("Refused");
	expect(calls.filter((c) => c.argv[0] === "cp")).toEqual([]);
	await expect(
		takeTree(spec({ keep: [], record: [{ file: "../../x", run: ["v"] }] }), ctx(run), { ...o, version: "1.0" }),
	).rejects.toThrow("not a plain file name");
	expect(existsSync(join(t.paths.home, "x"))).toBe(false);
	for (const version of ["..", ".", "", "a/b"])
		// oxlint-disable-next-line no-await-in-loop -- one version at a time
		await expect(takeTree(spec(), ctx(run), { ...o, version })).rejects.toThrow("cannot name a restore point");
	expect(readdirSync(join(t.paths.data, "backups/app"))).toEqual([]);
	expect(() => safePath(t.paths.home, t.paths, { dir: null })).toThrow("Refused");
	expect(() => safePath(dirname(t.paths.home), t.paths, { dir: null })).toThrow("Refused");
	expect(() => safePath(`${app}/../x`, t.paths, { dir: null })).toThrow("Refused");
	expect(safePath(join(app, "engine"), t.paths, { dir: app, under: [app] })).toBe(join(app, "engine"));
});

test("a path through a link that leads outside dir is refused, and a link named itself is kept as a link", () => {
	const outside = join(t.paths.home, "outside");
	mkdirSync(join(outside, "victim"), { recursive: true });
	mkdirSync(app, { recursive: true });
	symlinkSync(outside, join(app, "link"));
	const inApp = { dir: app, under: [app], not: [app] };
	expect(() => safePath(join(app, "link/victim"), t.paths, inApp)).toThrow("a link inside it leads outside");
	for (const found of expandGlob("link/*", t.paths, app))
		expect(() => safePath(found, t.paths, inApp)).toThrow("Refused");
	expect(safePath(join(app, "link"), t.paths, inApp)).toBe(join(app, "link"));
	expect(safePath(join(app, "new/sub"), t.paths, inApp)).toBe(join(app, "new/sub"));
});

test("the copy of a kept directory into .upkeep-new reports its pid and is killed as a tree", async () => {
	const { run, calls } = fakeBox();
	const { point } = await takeTree(spec(), ctx(run), { version: "1.0", at: "x", vars: {} });
	changeEverything();
	calls.length = 0;
	await restoreTree(point, ctx(run, { onStart: () => {} }));
	const copies = calls.filter((c) => c.argv[0] === "cp" && (c.argv[3] ?? "").endsWith(".upkeep-new"));
	expect(copies.length).toBeGreaterThan(0);
	expect(copies.every((c) => c.opts.onStart !== undefined && c.opts.killTree === true)).toBe(true);
});
