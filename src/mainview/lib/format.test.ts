import { describe, expect, test } from "bun:test";
import { formatBytes, formatDuration, plural, relativeTime } from "./format";

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
		["2026-11-10T09:59:40Z", "now"],
		["2026-11-10T09:58:00Z", "2 minutes ago"],
		["2026-11-10T07:00:00Z", "3 hours ago"],
		["2026-11-09T10:00:00Z", "yesterday"],
		["2026-11-07T10:00:00Z", "3 days ago"],
		["2026-08-10T10:00:00Z", "3 months ago"],
	])("%s reads %s", (iso, text) => {
		expect(relativeTime(iso, now)).toBe(text);
	});
	test("an unreadable date comes back unchanged", () => {
		expect(relativeTime("soon", now)).toBe("soon");
	});
});

test("plural", () => {
	expect(plural(1, "app", "apps")).toBe("app");
	expect(plural(0, "app", "apps")).toBe("apps");
});

test("formatDuration", () => {
	expect(formatDuration(2400)).toBe("2.4 s");
	expect(formatDuration(21_800)).toBe("22 s");
	expect(formatDuration(64_000)).toBe("1 min 4 s");
	expect(formatDuration(120_000)).toBe("2 min");
});
