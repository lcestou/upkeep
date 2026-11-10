import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineEvent } from "../shared/types";
import { createEngine, type EngineDeps, REASON_CHECKING, REASON_NOTHING, REASON_OLD } from "./engine";
import type { FetchLike } from "./github";
import { readInflight, writeInflight } from "./store";
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

test("retry from the summary runs only the failed app again", async () => {
	const engine = createEngine(await deps());
	await engine.check();
	await engine.install(["boom", "fd"]);
	await engine.idle();
	expect(engine.snapshot().run.phase).toBe("summary");
	expect(statuses(engine)).toMatchObject({ boom: "failed", fd: "done" });
	const r = await engine.install(["boom"]);
	expect(r).toEqual({ started: true });
	await engine.idle();
	const snap = engine.snapshot();
	expect(snap.run.results.map((x) => [x.key, x.result])).toEqual([["boom", "failed"]]);
	// The app that succeeded in the first run is not touched again and reads as up to date.
	expect(statuses(engine)).toMatchObject({ boom: "failed", fd: "fresh" });
});

test("install refuses while checking, with nothing ready, and while the old updater runs", async () => {
	const engine = createEngine(await deps());
	const checking = engine.check();
	expect(await engine.install(["fd"])).toEqual({ started: false, reason: REASON_CHECKING });
	await checking;
	expect(await engine.install(["bat", "strata"])).toEqual({ started: false, reason: REASON_NOTHING });
	mkdirSync(join(proc, "4321"));
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
	expect(engine.snapshot().apps.find((a) => a.key === "fd")).toMatchObject({ installed: "10.5.1", status: "ready" });
	expect(readFileSync(join(bin, "fd"), "utf8")).toContain("fd 10.5.1");
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
