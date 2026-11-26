import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEngine, type EngineDeps } from "../engine/engine";
import { createExtras } from "../engine/extras/extras";
import { MESSAGES } from "../shared/messages";
import type { SelfState } from "../shared/types";
import { claimLock, loadState, readWebhook, releaseLock, saveRows, updateState } from "../engine/store";
import { recordingRun, tempHome } from "../engine/testkit";
import { HOME } from "./about";
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
let selfState: SelfState = { phase: "none" };
// Only the test about the snapshot hook listens for it.
let watchSnapshots = false;
// What each request asked the main process to apply: the frame and entries, or the entries alone with the upkeep
// command setting as it read then.
let applied: string[] = [];

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
		pickFolder: async () => [""],
		spawnDetached: (argv) => void did.push(`spawn ${argv.join(" ")}`),
		osRelease: () => 'PRETTY_NAME="Test Linux 1"\n',
		...over,
	};
	const hooks = {
		onSettings: () => {
			applied.push("frame and entries");
			throw new Error("no login entry here");
		},
		applyEntries: () => {
			applied.push(`entries, upkeepCommand ${engine.snapshot().settings.upkeepCommand}`);
			throw new Error("no login entry here");
		},
		chrome: () => ({ own: true, side: "right" as const, order: [], maximized: false, rounded: true }),
		windowOp: (op: string) => void did.push(`window ${op}`),
		languages: () => ["de_DE.UTF-8"],
		extras: createExtras({ paths: t.paths, run, now: deps.now }),
		env: { XDG_CURRENT_DESKTOP: "X-Cinnamon", XDG_SESSION_TYPE: "x11" },
		self: {
			snapshot: () => selfState,
			prepare: async () => void did.push("self prepare"),
			restart: async () => void did.push("self restart"),
			dismiss: () => void did.push("self dismiss"),
		},
		onSnapshot: () => {
			if (watchSnapshots) did.push("snapshot asked");
		},
		uninstall: (purge: boolean) => {
			did.push(`uninstall ${purge}`);
			return { ok: true };
		},
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
	// Stop now outside a run changes nothing, and says it is not stopping.
	expect(await r.stopNow({})).toEqual({ stopping: false });
	expect(await r.dismissSummary({})).toEqual({ ok: true });
	expect(await r.setSkip({ key: "nope", version: "1" })).toEqual({ ok: false });
	expect(await r.setPause({ key: "tool", days: 7 })).toEqual({ ok: true });
	expect(await r.setPause({ key: "tool", days: null })).toEqual({ ok: true });
	expect(await r.setHold({ key: "tool", held: true })).toEqual({ ok: true });
	// A hold wins over a pause, so a held app refuses one.
	expect(await r.setPause({ key: "tool", days: 7 })).toEqual({ ok: false });
	expect(await r.setAuto({ key: "nope", auto: true })).toEqual({ ok: false });
	expect(await r.setPrerelease({ key: "nope", prerelease: true })).toEqual({ ok: false });
	expect(await r.versions({ key: "nope" })).toEqual({ versions: [], problem: "No app nope." });
	expect(await r.releaseNotes({ key: "nope" })).toMatchObject({ releases: [], problem: "No app nope." });
	expect(await r.installVersion({ key: "nope", tag: "v1" })).toMatchObject({ started: false });
	// A login entry that cannot be written does not lose the setting.
	expect((await r.setSettings({ keepBackups: 3 })).keepBackups).toBe(3);
	expect(await r.history({ limit: 5 })).toEqual([]);
	expect(await r.runLog({ runId: "none" })).toEqual([]);
	expect(await r.restore({ key: "nope", version: "1" })).toMatchObject({ ok: false });
	expect(await r.removeApp({ key: "nope" })).toMatchObject({ ok: false });
	expect(await r.restartApp({ key: "nope" })).toEqual({ ok: false, detail: "No app nope." });
	expect(await r.addApps({ specs: [] })).toEqual({ added: [], problems: [] });
	expect((await r.chrome({})).own).toBe(true);
	expect(await r.languages({})).toEqual(["de_DE.UTF-8"]);
	expect(await r.window({ op: "close" })).toEqual({ ok: true });
	expect(await r.copy({ text: "x y" })).toEqual({ ok: true });
	expect((await r.extras({})).settings.system).toBe("off");
	expect((await r.setExtras({ system: "off" })).system).toBe("off");
	expect(await r.systemCheck({})).toEqual({ started: false });
	// Installing is off, so nothing is planned and nothing starts.
	expect(await r.systemPlan({ ids: ["apt:perl"] })).toEqual({ commands: [], reason: MESSAGES.systemNothing() });
	expect(await r.systemInstall({ ids: ["apt:perl"], commands: [] })).toEqual({
		started: false,
		reason: MESSAGES.systemNothing(),
	});
	expect(did).toEqual(["window close", "copy x y"]);
});

test("Cleanup's requests go to the extras, and with Cleanup off nothing is measured or deleted", async () => {
	const { r } = setup();
	expect(await r.cleanupMeasure({})).toEqual({ started: false });
	expect(await r.cleanupReview({ picks: [{ id: "thumbnails", partIds: ["all"] }] })).toEqual({
		bytes: 0,
		commands: [],
		reason: MESSAGES.cleanNothing(),
	});
	expect(await r.cleanupRun({ picks: [{ id: "thumbnails", partIds: ["all"] }], commands: [] })).toEqual({
		started: false,
		reason: MESSAGES.cleanNothing(),
	});
});

test("an advisory opens only the page the engine built for one of the row's own IDs", async () => {
	saveRows(t.paths, {
		tool: { installed: "1.0.0", latest: "1.1.0", status: "ready", checkedAt: "2026-11-12T07:00:00Z" },
	});
	mkdirSync(t.paths.state, { recursive: true });
	const url = "https://www.cve.org/CVERecord?id=CVE-2026-0001";
	updateState(t.paths, (st) => {
		st.security.tool = { latest: "1.1.0", fix: { ids: [{ id: "CVE-2026-0001", url }] }, complete: true };
	});
	const { r, did } = setup();
	expect(await r.open({ what: "advisory", key: "tool", id: "CVE-2026-0001" })).toEqual({ ok: true });
	expect(await r.open({ what: "advisory", key: "tool", id: "CVE-2026-9999" })).toEqual({ ok: false });
	expect(did).toEqual([`url ${url}`]);
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

test("the self-update requests pass the press on, and What's new opens the offered version's release page", async () => {
	selfState = { phase: "none" };
	const { r, did } = setup();
	expect(await r.self({})).toEqual({ phase: "none" });
	// Nothing is offered: there is no page to open.
	expect(await r.open({ what: "self-notes" })).toEqual({ ok: false });
	selfState = { phase: "ready", from: "0.1.0", version: "0.1.1" };
	expect(await r.self({})).toEqual(selfState);
	expect(await r.selfUpdate({})).toEqual({ ok: true });
	expect(await r.selfRestart({})).toEqual({ ok: true });
	expect(await r.selfDismiss({})).toEqual({ ok: true });
	expect(await r.open({ what: "self-notes" })).toEqual({ ok: true });
	watchSnapshots = true;
	await r.snapshot({});
	watchSnapshots = false;
	expect(did).toEqual([
		"self prepare",
		"self restart",
		"self dismiss",
		`url ${HOME}/releases/tag/v0.1.1`,
		"snapshot asked",
	]);
	selfState = { phase: "none" };
});

test("About opens Upkeep's own pages, and a bug report carries the version and the system", async () => {
	const { r, did } = setup();
	expect(await r.open({ what: "repo" })).toEqual({ ok: true });
	expect(await r.open({ what: "changelog" })).toEqual({ ok: true });
	expect(await r.open({ what: "bug" })).toEqual({ ok: true });
	expect(did.slice(0, 2)).toEqual([`url ${HOME}`, `url ${HOME}/blob/main/CHANGELOG.md`]);
	const body = new URL((did[2] ?? "").slice(4)).searchParams.get("body") ?? "";
	expect(body).toContain("Test Linux 1, X-Cinnamon, x11");
	// A system with no os-release file still names its desktop.
	const bare = setup({ osRelease: () => "" });
	expect(await bare.r.open({ what: "bug" })).toEqual({ ok: true });
	expect(new URL((bare.did[0] ?? "").slice(4)).searchParams.get("body")).toContain("\nX-Cinnamon, x11");
	// A browser that would not open is reported, not hidden.
	const refused = setup({ openExternal: () => false });
	expect(await refused.r.open({ what: "repo" })).toEqual({ ok: false });
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

test("Export saves to the picked folder and Import replaces the setup from a picked file; a cancel does nothing", async () => {
	// Cancelled dialogs: nothing written, nothing said.
	const none = setup();
	expect(await none.r.exportSetup({})).toEqual({ ok: false });
	expect(await none.r.importSetup({})).toEqual({ ok: false });

	const folder = join(t.dir, "out");
	mkdirSync(folder, { recursive: true });
	const saved = setup({ pickFolder: async () => [folder] });
	const exported = await saved.r.exportSetup({});
	expect(exported).toEqual({ ok: true, file: join(folder, "upkeep-settings-2026-11-12.json") });
	const file = exported.file ?? "";
	expect(JSON.parse(readFileSync(file, "utf8")).upkeep).toBe(1);

	const loaded = setup({ pickFile: async () => [file] });
	// The list's one app runs commands, so Import asks first and writes on sure.
	expect((await loaded.r.importSetup({})).ask?.apps).toHaveLength(1);
	expect(await loaded.r.importSetup({ sure: true })).toEqual({ ok: true, apps: 1, autoOff: 0 });
	await loaded.engine.idle();

	writeFileSync(join(t.dir, "bad.json"), "{");
	const bad = setup({ pickFile: async () => [join(t.dir, "bad.json")] });
	const refused = await bad.r.importSetup({});
	expect(refused.ok).toBe(false);
	expect(refused.problems?.[0]).toStartWith("not JSON");
	const missing = setup({ pickFile: async () => [join(t.dir, "absent.json")] });
	expect((await missing.r.importSetup({})).ok).toBe(false);
	const unwritable = setup({ pickFolder: async () => [join(t.dir, "no", "such")] });
	expect((await unwritable.r.exportSetup({})).problem).toBeTruthy();
});

test("Import applies the entries from the imported settings at once, never the frame, and a failure there does not fail it", async () => {
	const folder = join(t.dir, "out");
	mkdirSync(folder, { recursive: true });
	const exported = await setup({ pickFolder: async () => [folder] }).r.exportSetup({});
	const file = exported.file ?? "";
	const doc = JSON.parse(readFileSync(file, "utf8"));
	doc.settings.upkeepCommand = true;
	doc.settings.frame = "system";
	writeFileSync(file, JSON.stringify(doc));
	const loaded = setup({ pickFile: async () => [file] });
	await loaded.r.importSetup({});
	applied = [];
	expect(await loaded.r.importSetup({ sure: true })).toEqual({ ok: true, apps: 1, autoOff: 0 });
	// Applied once, after the import wrote the settings, so the entries see the imported value.
	expect(applied).toEqual(["entries, upkeepCommand true"]);
	expect(loaded.engine.snapshot().settings.frame).toBe("system");
	await loaded.engine.idle();
});

test("Import of a list that runs commands asks first, writes the text it asked about on sure, and turns auto off", async () => {
	const folder = join(t.dir, "out3");
	mkdirSync(folder, { recursive: true });
	const exported = await setup({ pickFolder: async () => [folder] }).r.exportSetup({});
	const file = exported.file ?? "";
	const doc = JSON.parse(readFileSync(file, "utf8"));
	doc.apps +=
		'\n[apps.glow]\nname = "Glow"\nkind = "command"\ncheck = ["glow", "--version"]\nlatest = "npm:glow"\nupdate = ["sh", "-c", "curl x | sh"]\nauto = true\n';
	doc.auto = { glow: true };
	writeFileSync(file, JSON.stringify(doc));
	const before = readFileSync(join(t.paths.config, "apps.toml"), "utf8");
	const r = setup({ pickFile: async () => [file] });
	// Import on an ask that never came does nothing.
	expect(await r.r.importSetup({ sure: true })).toEqual({
		ok: false,
		problems: ["There is no file waiting to import. Press Import and pick it again."],
	});
	expect(await r.r.importSetup({})).toEqual({
		ok: false,
		ask: {
			apps: [
				{ key: "tool", name: "Tool", commands: ["source: npm:tool", "check: tool --version", "update: tool up"] },
				{
					key: "glow",
					name: "Glow",
					commands: ["source: npm:glow", "check: glow --version", "update: sh -c 'curl x | sh'"],
				},
			],
			plain: 0,
			turnsOn: [],
			turnsOff: [],
		},
	});
	expect(readFileSync(join(t.paths.config, "apps.toml"), "utf8")).toBe(before);
	// A confirm whose write fails writes nothing and keeps the ask answerable, as the window keeps it open.
	chmodSync(t.paths.config, 0o500);
	const failed = await r.r.importSetup({ sure: true });
	chmodSync(t.paths.config, 0o700);
	expect(failed.ok).toBe(false);
	expect(failed.problems?.length).toBeGreaterThan(0);
	expect(readFileSync(join(t.paths.config, "apps.toml"), "utf8")).toBe(before);
	// The file changing after the ask does not change what lands.
	writeFileSync(file, "{");
	expect(await r.r.importSetup({ sure: true })).toEqual({ ok: true, apps: 2, autoOff: 1 });
	// tool's table matches this machine's, so it keeps this machine's pick (off); glow is new, so it comes in off.
	expect(loadState(t.paths).auto).toEqual({ tool: false, glow: false });
	expect(await r.r.importSetup({ sure: true })).toEqual({
		ok: false,
		problems: ["There is no file waiting to import. Press Import and pick it again."],
	});
	await r.engine.idle();
});

test("Import asks before turning off the wait for an unmetered connection, and not when it is off here", async () => {
	const folder = join(t.dir, "out4");
	mkdirSync(folder, { recursive: true });
	const here = setup({ pickFolder: async () => [folder] });
	const file = (await here.r.exportSetup({})).file ?? "";
	const doc = JSON.parse(readFileSync(file, "utf8"));
	doc.settings.waitUnmetered = false;
	writeFileSync(file, JSON.stringify(doc));
	here.engine.setSettings({ waitUnmetered: true });
	const on = setup({ pickFile: async () => [file] });
	expect((await on.r.importSetup({})).ask?.turnsOff).toEqual(["waitUnmetered"]);
	await on.engine.idle();
	on.engine.setSettings({ waitUnmetered: false });
	const off = setup({ pickFile: async () => [file] });
	expect((await off.r.importSetup({})).ask?.turnsOff).toEqual([]);
	await off.engine.idle();
	await here.engine.idle();
});

test("Import waits for no run: with the run lock held elsewhere it refuses", async () => {
	const file = join(t.dir, "upkeep.json");
	const folder = join(t.dir, "out2");
	mkdirSync(folder, { recursive: true });
	const saved = setup({ pickFolder: async () => [folder] });
	const exported = await saved.r.exportSetup({});
	writeFileSync(file, readFileSync(exported.file ?? "", "utf8"));
	expect(claimLock(t.paths, process.ppid)).toBe(true);
	const busy = setup({ pickFile: async () => [file] });
	expect(await busy.r.importSetup({})).toEqual({
		ok: false,
		problems: ["An Upkeep run is in progress. Try again when it ends."],
	});
	releaseLock(t.paths, process.ppid);
	// A run that starts between the ask and the press refuses the press but keeps the ask's text for the next one.
	expect((await busy.r.importSetup({})).ask).toBeDefined();
	expect(claimLock(t.paths, process.ppid)).toBe(true);
	expect((await busy.r.importSetup({ sure: true })).problems).toEqual([
		"An Upkeep run is in progress. Try again when it ends.",
	]);
	releaseLock(t.paths, process.ppid);
	expect(await busy.r.importSetup({ sure: true })).toEqual({ ok: true, apps: 1, autoOff: 0 });
	await busy.engine.idle();
});

test("uninstall goes to the main process's hook with the purge choice, and only true purges", async () => {
	const { r, did } = setup();
	expect(await r.uninstall({ purge: false })).toEqual({ ok: true });
	// SAFETY: a malformed request from the view; only the boolean true may purge.
	expect(await r.uninstall({ purge: "yes" as unknown as boolean })).toEqual({ ok: true });
	expect(await r.uninstall({ purge: true })).toEqual({ ok: true });
	expect(did.filter((d) => d.startsWith("uninstall"))).toEqual([
		"uninstall false",
		"uninstall false",
		"uninstall true",
	]);
});

test("a notice address is kept whole on disk and only ever answered masked; a refused one changes nothing", async () => {
	const { r } = setup();
	expect(await r.webhook({})).toEqual({ masked: null });
	expect(await r.setWebhook({ address: "ntfy.sh/topic" })).toEqual({ ok: false, problem: "address", masked: null });
	expect(await r.setWebhook({ address: "http://ntfy.sh/topic" })).toEqual({
		ok: false,
		problem: "plain",
		masked: null,
	});
	expect(await r.setWebhook({ address: " https://ntfy.sh/secret?auth=x " })).toEqual({
		ok: true,
		masked: "https://ntfy.sh/…",
	});
	expect(readWebhook(t.paths)).toBe("https://ntfy.sh/secret?auth=x");
	expect(await r.webhook({})).toEqual({ masked: "https://ntfy.sh/…" });
	expect(await r.setWebhook({ address: "http://192.168.1.9:2586/upkeep" })).toEqual({
		ok: true,
		masked: "http://192.168.1.9:2586/…",
	});
	expect(await r.setWebhook({ address: null })).toEqual({ ok: true, masked: null });
	expect(readWebhook(t.paths)).toBeNull();
});
