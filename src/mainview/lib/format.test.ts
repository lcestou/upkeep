import { describe, expect, test } from "bun:test";
import { clockTime, formatBytes, formatDuration, formatRunTime, plural, relativeTime } from "./format";

describe("formatBytes", () => {
	test.each([
		[0, "0 B"],
		[999, "999 B"],
		[1_203_456, "1.2 MB"],
		[108_940_288, "109 MB"],
		[999_960, "1.0 MB"],
		[2_500_000_000, "2.5 GB"],
	])("%d bytes reads %s", (n, text) => {
		expect(formatBytes(n)).toBe(text);
	});
});

describe("relativeTime", () => {
	const now = Date.parse("2026-11-10T10:00:00Z");
	test.each([
		["2026-11-10T09:59:40Z", "just now"],
		["2026-11-10T09:59:01Z", "just now"],
		["2026-11-10T09:59:00Z", "1 minute ago"],
		["2026-11-10T09:58:01Z", "1 minute ago"],
		["2026-11-10T09:58:00Z", "2 minutes ago"],
		["2026-11-10T07:00:00Z", "3 hours ago"],
		["2026-11-09T10:00:00Z", "yesterday"],
		["2026-11-07T10:00:00Z", "3 days ago"],
		["2026-08-10T10:00:00Z", "3 months ago"],
		["2024-12-10T10:00:00Z", "last year"],
	])("%s reads %s", (iso, text) => {
		expect(relativeTime(iso, now)).toBe(text);
	});
	test("an unreadable date comes back unchanged", () => {
		expect(relativeTime("soon", now)).toBe("soon");
	});
});

test("plural picks the form for the count, with # as the number, by the language's own categories", () => {
	expect(plural(1, ["# app", "# apps"])).toBe("1 app");
	expect(plural(0, ["# app", "# apps"])).toBe("0 apps");
	expect(plural(3, ["# app", "# apps"])).toBe("3 apps");
	// Polish: one, few, many, other.
	const pl = ["# aplikacja", "# aplikacje", "# aplikacji", "# aplikacji"];
	expect([1, 3, 5, 22].map((n) => plural(n, pl, "pl"))).toEqual([
		"1 aplikacja",
		"3 aplikacje",
		"5 aplikacji",
		"22 aplikacje",
	]);
	// Japanese has one form; a form missing for a category falls back to the last.
	expect(plural(2, ["# 個"], "ja")).toBe("2 個");
	expect(plural(1, ["only"], "en")).toBe("only");
});

test("formatDuration", () => {
	expect(formatDuration(2400)).toBe("2.4 s");
	expect(formatDuration(21_800)).toBe("22 s");
	expect(formatDuration(64_000)).toBe("1 min");
	expect(formatDuration(100_000)).toBe("2 min");
	expect(formatDuration(120_000)).toBe("2 min");
});

describe("run and clock times", () => {
	test("a run time is the short day and the 24-hour time of the local clock", () => {
		const iso = new Date(2026, 10, 10, 9, 41).toISOString();
		expect(formatRunTime(iso)).toMatch(/^Tue,? 10 Nov,? 09:41$/);
	});
	test("a clock time carries seconds", () => {
		expect(clockTime(new Date(2026, 10, 10, 9, 41, 7).toISOString())).toBe("09:41:07");
	});
	test("an unreadable date comes back unchanged from both", () => {
		expect(formatRunTime("soon")).toBe("soon");
		expect(clockTime("soon")).toBe("soon");
	});
});
