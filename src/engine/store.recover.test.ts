import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { HistoryRow } from "../shared/types";
import { appendHistory, loadState, readHistory, updateState } from "./store";
import { tempHome } from "./testkit";

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("store-recover");
});
afterEach(() => t.cleanup());

const row = (key: string): HistoryRow => ({
	key,
	name: key,
	from: "1",
	to: "2",
	result: "updated",
	ms: 1,
	runId: "r",
	at: "2026-11-11T00:00:00.000Z",
	stages: {},
});

test("a row appended after a line cut short by a crash is kept", () => {
	appendHistory(t.paths, [row("first")]);
	appendFileSync(join(t.paths.data, "history.jsonl"), '{"key":"torn","na');
	appendHistory(t.paths, [row("next")]);
	expect(readHistory(t.paths, 10).map((r) => r.key)).toEqual(["next", "first"]);
});

test("a state file that cannot be read is kept beside the new one, not written over", () => {
	mkdirSync(t.paths.state, { recursive: true });
	const file = join(t.paths.state, "state.json");
	writeFileSync(file, '{"auto":{"fd":true');
	expect(loadState(t.paths).auto).toEqual({});
	updateState(t.paths, (s) => {
		s.hold.zen = true;
	});
	const kept = readdirSync(t.paths.state).filter((n) => n.startsWith("state.json.unreadable-"));
	expect(kept.map((n) => readFileSync(join(t.paths.state, n), "utf8"))).toEqual(['{"auto":{"fd":true']);
	expect(loadState(t.paths).hold).toEqual({ zen: true });
});
