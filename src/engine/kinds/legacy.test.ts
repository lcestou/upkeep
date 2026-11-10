import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSpec, Stage } from "../../shared/types";
import curlShim from "../shim/curl.sh" with { type: "text" };
import notifyShim from "../shim/notify-send.sh" with { type: "text" };
import zenityShim from "../shim/zenity.sh" with { type: "text" };
import { realRun, tempHome } from "../testkit";
import {
	checkLegacy,
	installLegacy,
	legacyVerdict,
	matchLine,
	NO_SCRIPT,
	NOT_FINISHED,
	OLD_RUNNING,
	type LegacyCtx,
	sweepShims,
} from "./legacy";

let t: ReturnType<typeof tempHome>;
let lines: string[] = [];
let stages: [Stage, number | null][] = [];
let proc = "";
let state = "";
let oldScript = "";
let oldLog = "";

beforeEach(() => {
	t = tempHome("legacy");
	lines = [];
	stages = [];
	proc = join(t.dir, "proc");
	mkdirSync(proc);
	state = join(t.dir, "state-old");
	mkdirSync(state);
	writeFileSync(join(state, "cursor"), "2.0.1");
	writeFileSync(join(state, "pr-agent"), "0.48.0");
	oldLog = join(t.dir, "lutechi-updater.log");
	writeFileSync(oldLog, "[2026-11-09 09:00:00] an older line\n");
	oldScript = join(t.dir, "lutechi-updater");
	// Calls zenity the way the real script does (old lines 584 to 593 and 628 to 634).
	writeFileSync(
		oldScript,
		`#!/bin/bash
case "$1" in
--check)
	echo "  OK:     bat 0.26.1"
	read -r cur < "${state}/cursor"
	if [ "$cur" = "2.1.0" ]; then echo "  OK:     Cursor $cur"; else echo "  UPDATE: Cursor $cur -> 2.1.0"; fi
	read -r pra < "${state}/pr-agent"
	echo "  OK:     pr-agent $pra"
	echo "  SKIP:   headroom 0.9.1 (PyPI lookup failed)"
	echo "  UPDATE: strata 0.2.10 -> 0.2.13 (run: strata-update)"
	echo "  BROKEN: dsh will not start (/x/dsh) - see log"
	if [ -n "$UPKEEP_CURL_AUTH" ] && [ -r "$UPKEEP_CURL_AUTH" ]; then read -r l < "$UPKEEP_CURL_AUTH"; echo "$l" > "${t.dir}/auth-seen"; fi
	;;
cursor)
	printf '%s\\n' "Resolving downloader.cursor.sh" 0 45 100 | \\
	zenity --progress \\
	       --title="Downloading Cursor 2.1.0" \\
	       --text="Downloading Cursor..." \\
	       --percentage=0 \\
	       --auto-close \\
	       --no-cancel \\
	       --width=450 \\
	       2>/dev/null
	echo 2.1.0 > "${state}/cursor"
	echo "[2026-11-10 10:00:00] Successfully updated Cursor to 2.1.0" >> "${oldLog}"
	if zenity --question --timeout=120 \\
	          --title="Installation Complete!" \\
	          --text="<big><b>Cursor installed successfully!</b></big>\\n\\n<b>Launch Cursor now?</b>" \\
	          --width=400 \\
	          --height=200 \\
	          2>/dev/null; then
		echo yes > "${t.dir}/launched"
	fi
	;;
claude-plugins)
	echo "[2026-11-10 10:00:01] Claude plugin foo update failed" >> "${oldLog}"
	;;
omp-plugins)
	echo "[2026-11-10 10:00:01] omp plugins refreshed" >> "${oldLog}"
	;;
esac
exit 0
`,
		{ mode: 0o755 },
	);
});
afterEach(() => t.cleanup());

function ctx(extra: Partial<LegacyCtx> = {}): LegacyCtx {
	return {
		paths: t.paths,
		run: realRun(t.paths, ""),
		fetch: async () => new Response(""),
		token: null,
		settings: { keepBackups: 1, notify: true, checkAtLogin: false },
		log: (l) => lines.push(l),
		stage: (s, p) => stages.push([s, p]),
		procRoot: proc,
		oldScript,
		oldLock: join(t.dir, "lutechi-updater.lock"),
		oldLog,
		pollMs: 20,
		...extra,
	};
}

const SPECS: AppSpec[] = [
	{ key: "cursor", name: "Cursor", kind: "legacy", legacy_key: "cursor", legacy_name: "Cursor", process: "cursor" },
	{ key: "pr-agent", name: "pr-agent", kind: "legacy", legacy_key: "pr-agent", legacy_name: "pr-agent", auto: true },
	{ key: "headroom", name: "headroom", kind: "legacy", legacy_key: "headroom", legacy_name: "headroom" },
	{ key: "strata", name: "Strata", kind: "manual", legacy_name: "strata", run: "strata-update" },
	{ key: "dsh", name: "dsh", kind: "manual", legacy_name: "dsh", run: "lutechi-updater dsh" },
	{ key: "cct", name: "claude-code-telegram", kind: "manual", legacy_name: "claude-code-telegram", run: "x" },
	{
		key: "claude-plugins",
		name: "Claude Code plugins",
		kind: "legacy",
		legacy_key: "claude-plugins",
		versionless: true,
	},
	{ key: "omp-plugins", name: "omp plugins", kind: "legacy", legacy_key: "omp-plugins", versionless: true },
];
const spec = (key: string): AppSpec => {
	const s = SPECS.find((x) => x.key === key);
	if (!s) throw new Error(key);
	return s;
};

test("checkLegacy maps the old --check lines onto the specs", async () => {
	const seen: string[] = [];
	const got = await checkLegacy(SPECS, ctx({ token: "tok" }), (k) => seen.push(k));
	expect(got.get("cursor")).toEqual({
		installed: "2.0.1",
		latest: "2.1.0",
		status: "ready",
		target: { from: "2.0.1", version: "2.1.0", tag: "2.1.0" },
	});
	expect(got.get("pr-agent")).toEqual({ installed: "0.48.0", latest: "0.48.0", status: "fresh" });
	expect(got.get("headroom")).toEqual({
		installed: null,
		latest: null,
		status: "problem",
		detail: "0.9.1 (PyPI lookup failed)",
	});
	expect(got.get("strata")).toMatchObject({ installed: "0.2.10", latest: "0.2.13", status: "ready" });
	expect(got.get("dsh")).toMatchObject({ status: "problem", detail: "will not start (/x/dsh) - see log" });
	expect(got.get("cct")).toBeNull();
	expect(got.get("claude-plugins")).toEqual({ installed: null, latest: null, status: "fresh" });
	expect(seen).toContain("cursor");
	expect(readFileSync(join(t.dir, "auth-seen"), "utf8")).toBe("Authorization: Bearer tok\n");
	expect(existsSync(join(t.paths.cache, "shim/curl-auth"))).toBe(false);
});

test("a missing old script makes every legacy and manual app a problem", async () => {
	const got = await checkLegacy(SPECS.slice(0, 2), ctx({ oldScript: join(t.dir, "gone") }));
	expect([...got.values()]).toEqual([
		{ installed: null, latest: null, status: "problem", detail: NO_SCRIPT },
		{ installed: null, latest: null, status: "problem", detail: NO_SCRIPT },
	]);
});

test("the longest legacy_name followed by a space wins", () => {
	const specs: AppSpec[] = [
		{ key: "claude", name: "c", kind: "manual", legacy_name: "claude", run: "x" },
		{ key: "cct", name: "t", kind: "manual", legacy_name: "claude-code-telegram", run: "x" },
	];
	expect(matchLine(specs, "  OK:     claude-code-telegram 1.0")?.spec.key).toBe("cct");
	expect(matchLine(specs, "  OK:     claude 2.0")?.spec.key).toBe("claude");
	expect(matchLine(specs, "  OK:     claudeX 2.0")).toBeNull();
	expect(matchLine(specs, "something else")).toBeNull();
});

test("installLegacy turns progress into stages, answers dialogs, and copies the old log's new lines", async () => {
	const c = ctx();
	const run = await installLegacy(spec("cursor"), c);
	expect(run).toEqual({ oldLines: ["[2026-11-10 10:00:00] Successfully updated Cursor to 2.1.0"], code: 0 });
	expect(stages.filter(([, p]) => p !== 0).map(([, p]) => p)).toEqual([45, 100]);
	expect(lines).toContain("dialog question: Installation Complete! answered no");
	expect(lines).toContain("old: [2026-11-10 10:00:00] Successfully updated Cursor to 2.1.0");
	expect(lines).toContain("The old script exited 0.");
	const after = await checkLegacy(SPECS, c);
	expect(legacyVerdict(spec("cursor"), "2.0.1", after.get("cursor"), run)).toEqual({
		result: "done",
		installed: "2.1.0",
		restartToApply: false,
	});
});

test("an app that was closed is not launched after its update", async () => {
	await installLegacy(spec("cursor"), ctx());
	expect(existsSync(join(t.dir, "launched"))).toBe(false);
});

test("an app that was running is reopened after its update", async () => {
	mkdirSync(join(proc, "777"));
	writeFileSync(join(proc, "777/comm"), "cursor\n");
	await installLegacy(spec("cursor"), ctx());
	expect(readFileSync(join(t.dir, "launched"), "utf8")).toBe("yes\n");
});

test("verdicts: a version that did not move, and versionless apps judged by the old log", async () => {
	const fresh = { installed: "0.48.0", latest: "0.48.0", status: "fresh" as const };
	expect(legacyVerdict(spec("pr-agent"), "0.48.0", fresh, { oldLines: [] })).toMatchObject({
		result: "failed",
		detail: NOT_FINISHED,
	});
	const still = { installed: "2.0.1", latest: "2.1.0", status: "ready" as const };
	expect(legacyVerdict(spec("cursor"), "2.0.1", still, { oldLines: [] })).toMatchObject({
		result: "failed",
		detail: NOT_FINISHED,
	});
	const bad = await installLegacy(spec("claude-plugins"), ctx());
	expect(legacyVerdict(spec("claude-plugins"), null, undefined, bad)).toMatchObject({
		result: "failed",
		detail: NOT_FINISHED,
	});
	const good = await installLegacy(spec("omp-plugins"), ctx());
	expect(legacyVerdict(spec("omp-plugins"), null, undefined, good)).toEqual({
		result: "done",
		installed: null,
		restartToApply: false,
	});
});

test("the old script's live lock is waited on, then refused", async () => {
	mkdirSync(join(proc, "555"));
	writeFileSync(join(t.dir, "lutechi-updater.lock"), "555\n");
	expect(await installLegacy(spec("cursor"), ctx({ lockWaitMs: 50 }))).toEqual({ failed: OLD_RUNNING, oldLines: [] });
	writeFileSync(join(t.dir, "lutechi-updater.lock"), "556\n");
	expect((await installLegacy(spec("cursor"), ctx({ lockWaitMs: 50 }))).failed).toBeUndefined();
});

function writeShim(name: string, text: string): string {
	const f = join(t.dir, "shims", name);
	mkdirSync(join(t.dir, "shims"), { recursive: true });
	writeFileSync(f, text, { mode: 0o755 });
	return f;
}

test("the zenity shim writes escaped events and reads progress to the end", async () => {
	const z = writeShim("zenity", zenityShim);
	const events = join(t.dir, "ev.ndjson");
	const env = { UPKEEP_SHIM_EVENTS: events };
	const run = realRun(t.paths, "");
	expect((await run([z, "--error", "--title=Download Failed", '--text=Could not "get"\nit\\'], { env })).code).toBe(0);
	expect((await run([z, "--question", "--title", "Update?"], { env })).code).toBe(0);
	const feed = join(t.dir, "feed.sh");
	writeFileSync(
		feed,
		`#!/bin/bash\nprintf '%s\\n' banner 007 "# step two" 100 | "${z}" --progress --pulsate --title=x\n`,
		{ mode: 0o755 },
	);
	expect((await run([feed], { env })).code).toBe(0);
	const got = readFileSync(events, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
	expect(got).toEqual([
		{ dialog: "error", title: "Download Failed", text: 'Could not "get"\nit\\' },
		{ dialog: "question", title: "Update?", answer: true },
		{ pct: null },
		{ pct: 7 },
		{ text: " step two" },
		{ pct: 100 },
	]);
});

test("the notify-send shim records the title and body, never a notification", async () => {
	const n = writeShim("notify-send", notifyShim);
	const events = join(t.dir, "ev.ndjson");
	await realRun(t.paths, "")(
		[n, "-u", "critical", "-i", "software-update-available", "zen update skipped", "1.2 was offered"],
		{
			env: { UPKEEP_SHIM_EVENTS: events },
		},
	);
	expect(JSON.parse(readFileSync(events, "utf8"))).toEqual({
		dialog: "notify",
		title: "zen update skipped",
		text: "1.2 was offered",
	});
});

test("the curl shim adds the token header for api.github.com only", async () => {
	const c = writeShim("curl", curlShim);
	const fake = writeShim("real-curl", '#!/bin/bash\nprintf "%s|" "$@"\n');
	const auth = join(t.dir, "auth");
	writeFileSync(auth, "Authorization: Bearer x\n", { mode: 0o600 });
	const run = realRun(t.paths, "");
	const env = { UPKEEP_REAL_CURL: fake, UPKEEP_CURL_AUTH: auth };
	expect((await run([c, "-sL", "https://api.github.com/repos/a/b/releases/latest"], { env })).stdout).toBe(
		`-H|@${auth}|-sL|https://api.github.com/repos/a/b/releases/latest|`,
	);
	expect((await run([c, "-sL", "https://example.com/x"], { env })).stdout).toBe("-sL|https://example.com/x|");
	expect((await run([c, "https://api.github.com/x"], { env: { UPKEEP_REAL_CURL: fake } })).stdout).toBe(
		"https://api.github.com/x|",
	);
});

test("installLegacy removes its shim directory, token file and all, when the old script ends", async () => {
	await installLegacy(spec("omp-plugins"), ctx({ token: "tok" }));
	expect(readdirSync(join(t.paths.cache, "shim"))).toEqual([]);
});

test("the sweep removes a dead process's shim directory and leaves a live one's alone", () => {
	const root = join(t.paths.cache, "shim");
	mkdirSync(join(root, "run-4242-abcdef"), { recursive: true });
	writeFileSync(join(root, "run-4242-abcdef/curl-auth"), "Authorization: Bearer old\n");
	mkdirSync(join(root, "run-777-ghijkl"), { recursive: true });
	mkdirSync(join(proc, "777"));
	sweepShims(t.paths, proc);
	expect(readdirSync(root)).toEqual(["run-777-ghijkl"]);
});

test("an old script stopped at its time limit fails the app", async () => {
	const run = await installLegacy(
		spec("cursor"),
		ctx({ run: async () => ({ code: 137, stdout: "", stderr: "", timedOut: true }) }),
	);
	expect(run.failed).toBe("The old script ran past 35 minutes and was stopped.");
	expect(legacyVerdict(spec("cursor"), "2.0.1", undefined, run)).toMatchObject({ result: "failed" });
});

test("a versionless app whose old log says FAILED is failed", () => {
	expect(
		legacyVerdict(spec("omp-plugins"), null, undefined, { oldLines: ["[t] omp plugin x FAILED to build"], code: 0 }),
	).toMatchObject({ result: "failed", detail: NOT_FINISHED });
});

const v = (run: { oldLines: string[]; code?: number }) => legacyVerdict(spec("omp-plugins"), null, undefined, run);

test("a versionless app fails on a non-zero exit, on no new old-log line, and on a lookup or refresh failure", () => {
	expect(v({ oldLines: ["[t] omp plugins refreshed"], code: 3 })).toMatchObject({
		result: "failed",
		detail: NOT_FINISHED,
	});
	expect(v({ oldLines: [], code: 0 })).toMatchObject({ result: "failed", detail: NOT_FINISHED });
	expect(v({ oldLines: ["[t] omp plugin p: version lookup failed"], code: 0 })).toMatchObject({ result: "failed" });
	expect(v({ oldLines: ["[t] claude plugins: marketplace refresh failed"], code: 0 })).toMatchObject({
		result: "failed",
	});
	expect(v({ oldLines: ["[t] omp plugins refreshed"], code: 0 })).toMatchObject({ result: "done" });
});

test("an old log that shrank during the run is read from its start", async () => {
	writeFileSync(oldScript, `#!/bin/bash\nprintf '%s\\n' "[t] omp plugin a update failed" > "${oldLog}"\nexit 0\n`, {
		mode: 0o755,
	});
	writeFileSync(oldLog, `${"[old] a much longer line that was here before the run\n".repeat(5)}`);
	const run = await installLegacy(spec("omp-plugins"), ctx());
	expect(run.oldLines).toEqual(["[t] omp plugin a update failed"]);
	expect(legacyVerdict(spec("omp-plugins"), null, undefined, run)).toMatchObject({ result: "failed" });
});
