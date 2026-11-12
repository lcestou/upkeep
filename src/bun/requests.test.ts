import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEngine, type EngineDeps } from "../engine/engine";
import { createExtras } from "../engine/extras/extras";
import { recordingRun, tempHome } from "../engine/testkit";
import { type Desktop, upkeepRequests } from "./requests";

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("requests");
});
afterEach(() => t.cleanup());

const MANIFEST = `[apps.tool]
name = "Tool"
kind = "command"
check = ["tool", "--version"]
latest = "npm:tool"
update = ["tool", "up"]
`;

/** A real engine on an empty temp home, a recording desktop, and hooks that note what they were asked. */
function setup(over: Partial<Desktop> = {}) {
	writeFileSync(join(t.dir, "seed.toml"), MANIFEST);
	const { run } = recordingRun(t.paths, () => ({ code: 127, stdout: "", stderr: "", timedOut: false }));
	const deps: EngineDeps = {
		paths: t.paths,
		seedManifest: join(t.dir, "seed.toml"),
		fetch: async () => new Response("", { status: 404 }),
		run,
		now: () => new Date("2026-11-12T08:00:00Z"),
		procRoot: join(t.dir, "proc"),
	};
	const engine = createEngine(deps);
	const did: string[] = [];
	const desktop: Desktop = {
		openPath: (p) => (did.push(`open ${p}`), true),
		openExternal: (u) => (did.push(`url ${u}`), true),
		clipboardWriteText: (x) => void did.push(`copy ${x}`),
		pickFile: async () => [""],
		spawnDetached: (argv) => void did.push(`spawn ${argv.join(" ")}`),
		...over,
	};
	const hooks = {
		onSettings: () => {
			throw new Error("no login entry here");
		},
		chrome: () => ({ own: true, side: "right" as const, order: [], maximized: false, rounded: true }),
		windowOp: (op: string) => void did.push(`window ${op}`),
		extras: createExtras({ paths: t.paths, run, now: deps.now }),
	};
	return { r: upkeepRequests(engine, deps, hooks, desktop), did, engine };
}

test("the requests answer from the engine, and refuse what the engine refuses", async () => {
	const { r, did } = setup();
	// Before any check there are no rows yet, and nothing runs.
	expect((await r.snapshot({})).run.phase).toBe("idle");
	expect(await r.check({})).toEqual({ started: true });
	expect(await r.install({ keys: ["nope"] })).toMatchObject({ started: false });
	expect(await r.stopAfterCurrent({})).toEqual({ stopping: false });
	expect(await r.dismissSummary({})).toEqual({ ok: true });
	expect(await r.setSkip({ key: "nope", version: "1" })).toEqual({ ok: false });
	expect(await r.setHold({ key: "tool", held: true })).toEqual({ ok: true });
	expect(await r.setAuto({ key: "nope", auto: true })).toEqual({ ok: false });
	// A login entry that cannot be written does not lose the setting.
	expect((await r.setSettings({ keepBackups: 3 })).keepBackups).toBe(3);
	expect(await r.history({ limit: 5 })).toEqual([]);
	expect(await r.runLog({ runId: "none" })).toEqual([]);
	expect(await r.restore({ key: "nope", version: "1" })).toMatchObject({ ok: false });
	expect(await r.removeApp({ key: "nope" })).toMatchObject({ ok: false });
	expect(await r.restartApp({ key: "nope" })).toEqual({ ok: false, detail: "No app nope." });
	expect(await r.addApps({ specs: [] })).toEqual({ added: [], problems: [] });
	expect((await r.chrome({})).own).toBe(true);
	expect(await r.window({ op: "close" })).toEqual({ ok: true });
	expect(await r.copy({ text: "x y" })).toEqual({ ok: true });
	expect((await r.extras({})).settings.system).toBe("off");
	expect((await r.setExtras({ system: "off" })).system).toBe("off");
	expect(await r.systemCheck({})).toEqual({ started: false });
	expect(did).toEqual(["window close", "copy x y"]);
});

test("open goes only to apps.toml, a run log, or a release page the engine fetched", async () => {
	const { r, did } = setup();
	expect(await r.open({ what: "manifest" })).toEqual({ ok: true });
	expect(await r.open({ what: "log" })).toEqual({ ok: false });
	mkdirSync(join(t.paths.state, "logs"), { recursive: true });
	writeFileSync(join(t.paths.state, "logs", "20261112-080000-a.log"), "");
	writeFileSync(join(t.paths.state, "logs", "20261112-090000-b.log"), "");
	expect(await r.open({ what: "log" })).toEqual({ ok: true });
	// No release page fetched for this row: nothing is opened.
	expect(await r.open({ what: "release", key: "tool" })).toEqual({ ok: false });
	expect(did).toEqual([
		`open ${join(t.paths.config, "apps.toml")}`,
		`open ${join(t.paths.state, "logs", "20261112-090000-b.log")}`,
	]);
});

test("a cancelled file dialog picks nothing, and Update Manager opens detached or says it could not", async () => {
	const { r, did } = setup();
	expect(await r.pickFile({})).toEqual({ path: null });
	expect(await r.openTool({ what: "update-manager" })).toEqual({ ok: true });
	expect(did).toEqual(["spawn mintupdate"]);
	const chosen = setup({
		pickFile: async () => ["", "/home/x/app.AppImage"],
		spawnDetached: () => {
			throw new Error("not installed");
		},
	});
	expect(await chosen.r.pickFile({})).toEqual({ path: "/home/x/app.AppImage" });
	expect(await chosen.r.openTool({ what: "update-manager" })).toEqual({ ok: false });
	expect(await chosen.r.suggest({ input: "" })).toMatchObject({ suggestions: [] });
});
