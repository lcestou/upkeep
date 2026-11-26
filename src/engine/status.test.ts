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
	expect(countsOf(apps)).toEqual({ apps: 10, upToDate: 2, ready: 2, held: 1, failing: 4 });
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
