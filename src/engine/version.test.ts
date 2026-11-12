import { expect, test } from "bun:test";
import table from "./version.fixture.json";
import { extractVersion, isNewer, tagVersion } from "./version";

const rows = table as [string, string, boolean][];

test.each(rows)("isNewer(%p, %p) is %p, as the bash version_compare says", (installed, latest, expected) => {
	expect(isNewer(installed, latest)).toBe(expected);
});

test("null never compares as a version", () => {
	expect(isNewer(null, "1.0.0")).toBe(false);
	expect(isNewer("1.0.0", null)).toBe(false);
});

test("extractVersion takes the first version-looking run", () => {
	expect(extractVersion("fd 10.5.1")).toBe("10.5.1");
	expect(extractVersion("tmux 3.6a")).toBe("3.6a");
	expect(extractVersion("v1.21.9b (release)")).toBe("1.21.9b");
	expect(extractVersion("no digits here")).toBeNull();
	expect(extractVersion("2.1.322 (Claude Code)")).toBe("2.1.322");
	// A dotted version wins over an earlier hash or bare number; a bare number still counts when nothing is dotted.
	expect(extractVersion("commit=0fbfd3a, build date=2026-01-02, version=0.66.3, os=linux")).toBe("0.66.3");
	expect(extractVersion("build 42")).toBe("42");
});

test("tagVersion drops tags whose version has no dot", () => {
	expect(tagVersion("v10.5.2")).toBe("10.5.2");
	expect(tagVersion("b4938")).toBeNull();
	expect(tagVersion("release-2026")).toBeNull();
	expect(tagVersion("1.12.3")).toBe("1.12.3");
});

test("a -V tie between different strings falls back to byte order, as sort does", () => {
	expect(isNewer("1.01", "1.1")).toBe(true);
	expect(isNewer("1.1", "1.01")).toBe(false);
});
