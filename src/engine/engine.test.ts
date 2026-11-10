import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSpec, EngineEvent } from "../shared/types";
import { createEngine, type EngineDeps, REASON_CHECKING, REASON_NOTHING, REASON_OLD } from "./engine";
import type { FetchLike } from "./github";
import { loadManifest } from "./manifest";
import { claimLock, readInflight, readRunLog, writeInflight } from "./store";
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

[apps.cursor]
name = "Cursor"
kind = "legacy"
legacy_key = "cursor"
legacy_name = "Cursor"

[apps.plugins]
name = "Claude Code plugins"
kind = "legacy"
legacy_key = "claude-plugins"
versionless = true
auto = true

[apps.strata]
name = "Strata"
kind = "manual"
legacy_name = "strata"
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

function oldScript(): string {
	const state = join(t.dir, "old-state");
	writeFileSync(state, "2.0.1");
	return script(
		join(t.dir, "lutechi-updater"),
		`case "$1" in
--check)
	read -r cur < "${state}"
	if [ "$cur" = "2.1.0" ]; then echo "  OK:     Cursor $cur"; else echo "  UPDATE: Cursor $cur -> 2.1.0"; fi
	echo "  UPDATE: strata 0.2.10 -> 0.2.13 (run: strata-update)"
	;;
cursor)
	echo 2.1.0 > "${state}"
	echo "[x] Successfully updated Cursor to 2.1.0" >> "${join(t.dir, "old.log")}"
	;;
claude-plugins)
	echo "[x] claude plugin a@b is up to date" >> "${join(t.dir, "old.log")}"
	;;
esac
exit 0`,
	);
}

async function deps(): Promise<EngineDeps> {
	writeFileSync(join(t.dir, "seed.toml"), MANIFEST);
	bin = join(t.paths.home, ".local/bin");
	script(join(bin, "boom"), 'echo "boom 1.0.0"');
	script(join(bin, "fd"), 'echo "fd 10.5.1"');
	script(join(bin, "bat"), 'echo "bat 0.26.1"');
	const claudeState = join(t.dir, "claude-version");
	writeFileSync(claudeState, "2.1.322");
	script(join(bin, "claude"), `read -r v < "${claudeState}"; echo "$v (Claude Code)"`);
	script(join(bin, "claude-up"), `echo 2.1.400 > "${claudeState}"`);
	releases = {
		"o/boom": { tag: "v1.1.0", assets: {} },
		"sharkdp/fd": {
			tag: "v10.5.2",
			assets: { "fd-v10.5.2-x86_64-unknown-linux-gnu.tar.gz": await tarball("fd", 'echo "fd 10.5.2"') },
		},
		"sharkdp/bat": { tag: "v0.26.1", assets: { "bat-x86_64-unknown-linux-gnu.tar.gz": bytes("x") } },
	};
	// boom's release lists an asset whose download is missing, so its install throws.
	releases["o/boom"] = { tag: "v1.1.0", assets: { boom: bytes("never served") } };
	const { run } = recordingRun(t.paths, (argv) =>
		argv[0] === "gh" ? { code: 1, stdout: "", stderr: "not logged in", timedOut: false } : undefined,
	);
	return {
		paths: t.paths,
		seedManifest: join(t.dir, "seed.toml"),
		fetch: async (url, init) =>
			url === "https://dl.test/o/boom/boom" ? new Response("gone", { status: 404 }) : fakeFetch(url, init),
		run,
		now: () => new Date(),
		oldScript: oldScript(),
		oldLock: join(t.dir, "lutechi-updater.lock"),
		oldLog: join(t.dir, "old.log"),
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

test("check: native and legacy apps land in manifest order, absent apps are left out", async () => {
	const engine = createEngine(await deps());
	const events: EngineEvent[] = [];
	engine.subscribe((e) => events.push(e));
	await engine.check();
	expect(statuses(engine)).toEqual({
		boom: "ready",
		fd: "ready",
		bat: "fresh",
		claude: "ready",
		cursor: "ready",
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
	expect(engine.readyKeys(false)).toEqual(["boom", "fd", "claude", "cursor"]);
	expect(engine.readyKeys(true)).toEqual(["fd", "claude", "plugins"]);
});

test("one app's exception fails that app and the run continues", async () => {
	const engine = createEngine(await deps());
	await engine.check();
	const r = await engine.install(["boom", "fd", "claude", "cursor", "plugins", "bat", "strata"]);
	expect(r).toEqual({ started: true });
	await engine.idle();
	const snap = engine.snapshot();
	expect(snap.run.phase).toBe("summary");
	expect(snap.run.results.map((x) => [x.key, x.result])).toEqual([
		["boom", "failed"],
		["fd", "updated"],
		["claude", "updated"],
		["cursor", "updated"],
		["plugins", "updated"],
	]);
	expect(snap.run.results[0]?.detail).toBe("Download failed: the server answered 404.");
	expect(statuses(engine)).toMatchObject({
		boom: "failed",
		fd: "done",
		claude: "done",
		cursor: "done",
		bat: "fresh",
		strata: "manual",
	});
	const claude = snap.apps.find((a) => a.key === "claude");
	expect(claude).toMatchObject({ installed: "2.1.400", restartToApply: true });
	expect(snap.apps.find((a) => a.key === "fd")?.restorePoints.map((p) => p.version)).toEqual(["10.5.1"]);
	const history = engine.history(10);
	expect(history.map((h) => h.key)).toEqual(["plugins", "cursor", "claude", "fd", "boom"]);
	const runId = history[0]?.runId ?? "";
	expect(
		engine.runLog(runId).some((l) => l.key === "cursor" && l.text === "old: [x] Successfully updated Cursor to 2.1.0"),
	).toBe(true);
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

test("install refuses while checking, with nothing ready, and while the old updater runs", async () => {
	const engine = createEngine(await deps());
	const checking = engine.check();
	expect(await engine.install(["fd"])).toEqual({ started: false, reason: REASON_CHECKING });
	await checking;
	expect(await engine.install(["bat", "strata"])).toEqual({ started: false, reason: REASON_NOTHING });
	mkdirSync(join(proc, "4321"));
	writeFileSync(join(proc, "4321/cmdline"), "/bin/bash\0/home/u/.local/bin/lutechi-updater\0");
	writeFileSync(join(t.dir, "lutechi-updater.lock"), "4321");
	expect(await engine.install(["fd"])).toEqual({ started: false, reason: REASON_OLD });
	expect(statuses(engine).fd).toBe("ready");
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
		frame: "own",
		buttons: "auto",
		corners: "rounded",
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

test("a legacy app whose install throws is in the results as failed", async () => {
	const engine = createEngine(await deps());
	await engine.check();
	rmSync(join(t.paths.cache, "shim"), { recursive: true, force: true });
	writeFileSync(join(t.paths.cache, "shim"), ""); // prepareShims cannot make its directory
	await engine.install(["cursor"]);
	await engine.idle();
	expect(engine.snapshot().run.results.map((r) => [r.key, r.result])).toEqual([["cursor", "failed"]]);
	expect(statuses(engine).cursor).toBe("failed");
	const log = readRunLog(t.paths, engine.snapshot().run.id ?? "").map((l) => l.text);
	expect(log.some((l) => l.startsWith("failed: "))).toBe(true);
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

test("a check whose old updater did not finish keeps the legacy rows' last versions", async () => {
	const d = await deps();
	const engine = createEngine(d);
	await engine.check();
	expect(engine.snapshot().apps.find((a) => a.key === "cursor")).toMatchObject({ installed: "2.0.1", status: "ready" });
	script(d.oldScript, "exit 2");
	await engine.check();
	expect(engine.snapshot().apps.find((a) => a.key === "cursor")).toMatchObject({
		installed: "2.0.1",
		latest: "2.1.0",
		status: "problem",
		detail: "The old updater's check did not finish.",
	});
});

test("a legacy app whose script has ended waits for the verdict check in stage verify", async () => {
	const engine = createEngine(await deps());
	await engine.check();
	const seen: [string | undefined, number | null | undefined][] = [];
	engine.subscribe((e) => {
		if (e.type === "app" && e.app.key === "cursor" && e.app.status === "working")
			seen.push([e.app.stage, e.app.stagePct]);
	});
	await engine.install(["cursor"]);
	await engine.idle();
	expect(seen.at(-1)).toEqual(["verify", null]);
	expect(seen.some(([, p]) => p === 100)).toBe(false);
	expect(statuses(engine).cursor).toBe("done");
});

test("every legacy failure writes its reason to the run log", async () => {
	const d = await deps();
	const engine = createEngine(d);
	await engine.check();
	script(d.oldScript, 'case "$1" in --check) echo "  UPDATE: Cursor 2.0.1 -> 2.1.0";; esac');
	await engine.install(["cursor"]);
	await engine.idle();
	const id = engine.snapshot().run.id ?? "";
	expect(readRunLog(t.paths, id).map((l) => l.text)).toContain(
		"failed: The old script did not finish this update. See the log.",
	);
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
			{ key: "rg", detail: "rg: kind is not one of appimage, archive, file, deb" },
			{ key: "rg", detail: "rg: asset is not a valid regular expression" },
		],
	});
	expect(readFileSync(file, "utf8")).toBe(before);
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
	expect(await engine.removeApp("bat")).toEqual({ ok: true });
	expect(events).toContainEqual({ type: "removed", key: "bat" });
	expect(engine.snapshot().apps.some((a) => a.key === "bat")).toBe(false);
	const file = join(t.paths.config, "apps.toml");
	expect(readFileSync(file, "utf8")).not.toContain("[apps.bat]");
	expect(loadManifest(file).apps.map((a) => a.key)).toEqual([
		"boom",
		"fd",
		"gone",
		"claude",
		"cursor",
		"plugins",
		"strata",
	]);
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
const restartEntry = () => JSON.parse(readFileSync(join(t.paths.state, "state.json"), "utf8")).restart?.fd;

test("a restart reminder outlives Done and a later check while the old process runs, and clears once it is gone", async () => {
	const engine = createEngine(await deps());
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
	const engine = createEngine(await deps());
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

/** A seed list of old-script apps; `pra` and `tg` carry check and latest, `curs` does not. */
async function portedDeps(withOld: boolean): Promise<EngineDeps & { marks: string }> {
	const d = await deps();
	const marks = join(t.dir, "old-runs");
	const ver = join(t.dir, "pra-ver");
	writeFileSync(ver, "2.1.322");
	script(join(bin, "pra-version"), `cat "${ver}"`);
	script(join(bin, "tg-version"), "exit 127");
	const seed = join(t.dir, "ported.toml");
	writeFileSync(
		seed,
		`[apps.pra]
name = "pr-agent"
kind = "legacy"
legacy_key = "pr-agent"
legacy_name = "pr-agent"
check = ["~/.local/bin/pra-version"]
latest = "npm:@anthropic-ai/claude-code"

[apps.tg]
name = "claude-code-telegram"
kind = "manual"
legacy_name = "claude-code-telegram"
run = "uv tool install"
check = ["~/.local/bin/tg-version"]
latest = "npm:@anthropic-ai/claude-code"

[apps.strata]
name = "Strata"
kind = "manual"
legacy_name = "strata"
run = "strata-update"
check = ["~/.local/bin/strata-version"]
latest = "npm:@anthropic-ai/claude-code"

[apps.plugins]
name = "Claude Code plugins"
kind = "legacy"
legacy_key = "claude-plugins"
versionless = true
${
	withOld
		? `
[apps.cursor]
name = "Cursor"
kind = "legacy"
legacy_key = "cursor"
legacy_name = "Cursor"
`
		: ""
}`,
	);
	script(join(bin, "strata-version"), 'echo "strata 0.2.10"');
	// The old script records every call; its --check also prints a pr-agent line the engine must ignore.
	const old = script(
		join(t.dir, "lutechi-updater-ported"),
		`echo "$1" >> "${marks}"
case "$1" in
--check) echo "  OK:     pr-agent 9.9.9"; echo "  UPDATE: Cursor 2.0.1 -> 2.1.0" ;;
pr-agent) printf 2.1.400 > "${ver}"; echo "[x] pr-agent updated" >> "${join(t.dir, "old.log")}" ;;
esac
exit 0`,
	);
	return { ...d, seedManifest: seed, oldScript: old, marks };
}

const runsOf = (marks: string) => (existsSync(marks) ? readFileSync(marks, "utf8").trim().split("\n") : []);

test("old-script apps with check and latest are looked up natively, and the old --check is not run for them", async () => {
	const d = await portedDeps(false);
	const engine = createEngine(d);
	await engine.check();
	expect(runsOf(d.marks)).toEqual([]);
	const row = (k: string) => engine.snapshot().apps.find((a) => a.key === k);
	expect(row("pra")).toMatchObject({ kind: "legacy", installed: "2.1.322", latest: "2.1.400", status: "ready" });
	// A manual app with an update stays manual, and one whose check is not there is left out.
	expect(row("strata")).toMatchObject({ kind: "manual", installed: "0.2.10", status: "manual" });
	expect(row("tg")).toBeUndefined();
	expect(row("plugins")).toMatchObject({ status: "fresh" });
	// Install still goes through the old script, and the verdict comes from the native lookup.
	await engine.install(["pra"]);
	await engine.idle();
	expect(runsOf(d.marks)).toEqual(["pr-agent"]);
	expect(row("pra")).toMatchObject({ status: "done", installed: "2.1.400" });
});

test("a mixed list runs both paths: the old --check only answers for the apps it alone checks", async () => {
	const d = await portedDeps(true);
	const engine = createEngine(d);
	await engine.check();
	expect(runsOf(d.marks)).toEqual(["--check"]);
	const row = (k: string) => engine.snapshot().apps.find((a) => a.key === k);
	expect(row("cursor")).toMatchObject({ installed: "2.0.1", latest: "2.1.0", status: "ready" });
	expect(row("pra")).toMatchObject({ installed: "2.1.322", latest: "2.1.400" });
	// Installing only the ported app needs no second --check, even with Cursor still on the old script.
	await engine.install(["pra"]);
	await engine.idle();
	expect(runsOf(d.marks)).toEqual(["--check", "pr-agent"]);
	expect(row("pra")).toMatchObject({ status: "done", installed: "2.1.400" });
});

test("a native check of an old-script app that fails is a problem with a sentence, not a hang", async () => {
	const d = await portedDeps(false);
	script(join(bin, "pra-version"), "echo nothing here");
	const slow = script(join(bin, "strata-version"), "sleep 30");
	const engine = createEngine({ ...d, fetch: async () => new Response("", { status: 503 }) });
	const t0 = Date.now();
	await engine.check();
	expect(Date.now() - t0).toBeLessThan(20_000);
	const row = (k: string) => engine.snapshot().apps.find((a) => a.key === k);
	expect(row("pra")).toMatchObject({ status: "problem" });
	expect(row("pra")?.detail).toMatch(/\.$/);
	expect(row("strata")).toMatchObject({ status: "problem" });
	expect(slow).toBeDefined();
}, 30_000);
