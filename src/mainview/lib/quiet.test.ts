import { expect, test } from "bun:test";
import { QUIET_MS, quietOf } from "./quiet";

const at = (ms: number) => new Date(ms).toISOString();
const NOW = Date.parse("2026-11-25T12:00:00Z");

test("a working row is quiet only after two minutes without a log line or download progress", () => {
	const step = { at: at(NOW - 3 * 60_000), limitMs: 10 * 60_000 };
	expect(quietOf({ status: "working", activeAt: at(NOW - QUIET_MS + 1000), step }, undefined, NOW)).toBeNull();
	expect(quietOf({ status: "working", activeAt: at(NOW - 3 * 60_000), step }, undefined, NOW)).toEqual({ m: 3, n: 7 });
	// The newer of the two times counts: a log line a minute ago means it spoke.
	expect(quietOf({ status: "working", activeAt: at(NOW - 3 * 60_000), step }, at(NOW - 60_000), NOW)).toBeNull();
});

test("a step with no limit gives no minutes left, and a row that is not working is never quiet", () => {
	const old = at(NOW - 5 * 60_000);
	expect(quietOf({ status: "working", activeAt: old, step: { at: old, limitMs: null } }, undefined, NOW)).toEqual({
		m: 5,
		n: null,
	});
	expect(quietOf({ status: "working", activeAt: old }, undefined, NOW)).toEqual({ m: 5, n: null });
	expect(quietOf({ status: "queued", activeAt: old }, undefined, NOW)).toBeNull();
	expect(quietOf({ status: "working" }, undefined, NOW)).toBeNull();
	// A limit already passed reads 0, never a negative count.
	expect(quietOf({ status: "working", activeAt: old, step: { at: old, limitMs: 60_000 } }, undefined, NOW)?.n).toBe(0);
});
