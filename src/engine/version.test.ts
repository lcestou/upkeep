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

test("a pre-release suffix stays on the version it is read with", () => {
	expect(tagVersion("v2.0.0-rc.1")).toBe("2.0.0-rc.1");
	expect(extractVersion("tool-1.3.0-beta2-linux.tar.gz")).toBe("1.3.0-beta2");
	expect(extractVersion("app 2.10rc1")).toBe("2.10rc1");
	expect(extractVersion("v0.9.0-alpha")).toBe("0.9.0-alpha");
	// Some projects write the word in capitals.
	expect(tagVersion("v1.0.0-RC1")).toBe("1.0.0-RC1");
	expect(tagVersion("v0.7.2-Beta")).toBe("0.7.2-Beta");
	expect(extractVersion("1.2.3-PREBUILT")).toBe("1.2.3");
	// A word that only starts like one is no suffix.
	expect(extractVersion("1.2.3-prebuilt")).toBe("1.2.3");
	expect(extractVersion("1.2.3-linux")).toBe("1.2.3");
});

test.each([
	["2.0.0-rc.1", "2.0.0", true],
	["2.0.0", "2.0.0-rc.1", false],
	["1.9.0", "2.0.0-rc.1", true],
	["2.0.0-rc.1", "1.9.0", false],
	["2.0.0-rc.1", "2.0.0-rc.2", true],
	["2.0.0-rc.2", "2.0.0-rc.1", false],
	["2.0.0-beta.3", "2.0.0-rc.1", true],
	["2.0.0-rc.1", "2.0.0-beta.3", false],
	["2.0.0-alpha", "2.0.0-alpha.1", true],
	["2.0.0-rc.1", "2.0.0-rc.1", false],
	["2.0.0-rc.1", "2.0.1", true],
	["2.10rc1", "2.10", true],
	["2.0.0-rc.1", "2.0.0-rc1", false],
	["1.0.0-RC1", "1.0.0", true],
	["0.7.2-Beta", "0.7.2-rc.1", true],
	["0.7.2", "0.7.2-Beta", false],
	// A base written with fewer parts is the same release: its candidate is never newer than it, either way round.
	["2.0", "2.0.0-rc.1", false],
	["2.0.0-rc.1", "2.0", true],
	["2.0.0", "2.0-rc.1", false],
	["2.0-rc.1", "2.0.0", true],
	["1.2", "1.2.0-beta", false],
	["1.2.0-beta", "1.2", true],
	["2", "2.0.0-rc.1", false],
	["2.0.0-rc.1", "2", true],
	["2-rc.1", "2.0.0", true],
	["2.0", "2.0.1-rc.1", true],
	["2.0.1-rc.1", "2.0", false],
	["2.0-rc.1", "2.0.0-rc.2", true],
])("isNewer(%p, %p) is %p across pre-releases", (installed, latest, expected) => {
	expect(isNewer(installed, latest)).toBe(expected);
});
