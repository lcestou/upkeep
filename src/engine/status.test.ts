import { expect, test } from "bun:test";
import type { AppState, AppStatus, Snapshot } from "../shared/types";
import { countsOf, metricsText, statusLines, statusOf } from "./status";
import { DEFAULT_SETTINGS } from "./store";

/** A row with only what status reads; the rest takes a plain default. */
function row(key: string, status: AppStatus, extra: Partial<AppState> = {}): AppState {
	return {
		key,
		name: key.toUpperCase(),
		kind: "file",
		installed: "1.0",
		latest: "1.1",
		status,
		running: false,
		restartToApply: false,
		restorePoints: [],
		canRestore: false,
		auto: false,
		sudo: false,
		versionless: false,
		held: false,
		stages: [],
		...extra,
	};
}

/** A snapshot of the given rows, checked at a fixed time. */
const snap = (apps: AppState[], checkedAt: string | null = "2026-11-25T10:00:00.000Z"): Snapshot => ({
	apps,
	run: { id: null, phase: "idle", index: 0, total: 0, currentKey: null, stopping: false, results: [], retry: false },
	settings: DEFAULT_SETTINGS,
	rate: null,
	checkedAt,
	version: "0.2.0",
});

test("every state lands in one bucket, and rows still checking count only in apps", () => {
	const apps = (
		["fresh", "done", "ready", "manual", "held", "problem", "failed", "rolled_back", "stopped", "checking"] as const
	).map((s, i) => row(`a${i}`, s));
	expect(countsOf(apps)).toEqual({ apps: 10, upToDate: 2, ready: 1, manual: 1, held: 1, failing: 4, unchecked: 0 });
	// A listed app with no row counts in apps and as unchecked; a listed app with a row counts once.
	expect(countsOf(apps, [{ key: "a0" }, { key: "new" }])).toMatchObject({ apps: 11, unchecked: 1 });
});

test("the status lists ready and held apps with versions, and failing ones with why", () => {
	const s = statusOf(
		snap([row("bat", "fresh"), row("borg", "ready"), row("gh", "held"), row("jq", "problem", { detail: "404" })]),
		false,
	);
	expect(s.ready).toEqual([{ key: "borg", name: "BORG", installed: "1.0", latest: "1.1" }]);
	expect(s.failing).toEqual([{ key: "jq", name: "JQ", installed: "1.0", latest: "1.1", detail: "404" }]);
	expect(statusLines(s)).toEqual([
		"Upkeep 0.2.0",
		"Last check: 2026-11-25T10:00:00.000Z",
		"4 apps: 1 up to date, 1 ready, 1 held, 1 failing",
		"  UPDATE: BORG 1.0 -> 1.1",
		"  HELD:   GH 1.0 -> 1.1",
		"  FAILED: JQ 404",
	]);
});

test("a waiting security fix is marked in the lines, the JSON and the metrics", () => {
	const fix = { ids: [{ id: "CVE-2026-0001", url: "https://www.cve.org/CVERecord?id=CVE-2026-0001" }] };
	const s = statusOf(
		snap([
			row("borg", "ready", { security: fix }),
			row("gh", "held", { security: { ids: [] }, settles: "2026-11-27T10:00:00.000Z" }),
			row("jq", "ready"),
		]),
		false,
	);
	expect(s.ready[0]?.security).toEqual(fix);
	expect(statusLines(s)).toContain("  UPDATE: BORG 1.0 -> 1.1 (security fix: CVE-2026-0001)");
	expect(statusLines(s).find((l) => l.includes("HELD"))).toContain("(security fix)");
	expect(metricsText(s)).toContain("upkeep_security_fixes 2\n");
});

test("metrics are Prometheus text: escaped labels, the check time in seconds, and a closing newline", () => {
	const s = statusOf(snap([row('we"ird\\key', "ready", { installed: null, latest: "2\n0" })]), true);
	const text = metricsText(s);
	expect(text.endsWith("\n")).toBe(true);
	expect(text).toContain("upkeep_last_check_timestamp_seconds 1795600800\n");
	expect(text).toContain("upkeep_run_in_progress 1\n");
	expect(text).toContain('upkeep_apps{state="ready"} 1\n');
	expect(text).toContain('upkeep_update_ready{app="we\\"ird\\\\key",installed="",latest="2\\n0"} 1\n');
	// Every sample line is a metric name, optional labels and a number.
	for (const line of text.trimEnd().split("\n"))
		if (!line.startsWith("#")) expect(line).toMatch(/^upkeep_[a-z_]+(\{.*\})? \d+$/);
});

test("before the first check the time reads 0 and the text says no check has run", () => {
	const s = statusOf(snap([], null), false);
	expect(metricsText(s)).toContain("upkeep_last_check_timestamp_seconds 0\n");
	expect(statusLines(s)).toEqual(["Upkeep 0.2.0", "No check has run yet."]);
});

test("a held row says what holds it, and a reason shows on held, ready and up-to-date rows alike", () => {
	const s = statusOf(
		snap([
			row("pz", "held", { paused: "2026-12-09T12:00:00.000Z", skipped: "1.1" }),
			row("sk", "held", { skipped: "1.1" }),
			row("st", "held", { settles: "2026-11-27T12:00:00.000Z" }),
			row("sw", "held", { detail: "The repo now answers as another repository." }),
			row("bv", "ready", { detail: "Passed over 1.2, listed as bad." }),
			row("ok", "fresh", { detail: "Kept on 1.0: 1.1 is listed as bad." }),
			row("plain", "fresh"),
		]),
		false,
	);
	expect(s.held[0]).toEqual({
		key: "pz",
		name: "PZ",
		installed: "1.0",
		latest: "1.1",
		paused: "2026-12-09T12:00:00.000Z",
		skipped: "1.1",
	});
	expect(s.noted.map((a) => a.key)).toEqual(["ok"]);
	expect(statusLines(s).slice(3)).toEqual([
		"  UPDATE: BV 1.0 -> 1.1 Passed over 1.2, listed as bad.",
		`  HELD:   PZ 1.0 -> 1.1 (paused until ${new Date("2026-12-09T12:00:00.000Z").toLocaleDateString("sv-SE")})`,
		"  HELD:   SK 1.0 -> 1.1 (skipping 1.1)",
		`  HELD:   ST 1.0 -> 1.1 (offered from ${new Date("2026-11-27T12:00:00.000Z").toLocaleDateString("sv-SE")})`,
		"  HELD:   SW 1.0 -> 1.1 The repo now answers as another repository.",
		"  NOTE:   OK 1.0 Kept on 1.0: 1.1 is listed as bad.",
	]);
});

test("a manual app is its own by-hand count and line, apart from ready, in the text, JSON and metrics", () => {
	const s = statusOf(snap([row("bat", "ready"), row("hand", "manual")]), false);
	expect(s.counts).toMatchObject({ ready: 1, manual: 1 });
	expect(s.manual.map((a) => a.key)).toEqual(["hand"]);
	expect(statusLines(s).slice(2)).toEqual([
		"2 apps: 0 up to date, 1 ready, 0 held, 0 failing, 1 by hand",
		"  UPDATE: BAT 1.0 -> 1.1",
		"  BY HAND: HAND 1.0 -> 1.1",
	]);
	const text = metricsText(s);
	expect(text).toContain('upkeep_apps{state="manual"} 1\n');
	expect(text).not.toContain('upkeep_update_ready{app="hand"');
});
