import { expect, test } from "bun:test";
import type { Release } from "./github";
import { BREAKING_MAX, breakingLines, NOTES_BUDGET, notesSpan } from "./notes";

/** A release of version v with notes, as a forge list holds it. */
const rel = (v: string, notes = "", prerelease = false): Release => ({
	tag: `v${v}`,
	version: v,
	url: "",
	publishedAt: "2026-11-01T00:00:00Z",
	notes,
	assets: [],
	prerelease,
});

test("the span holds the releases after installed up to latest, newest by version first", () => {
	// A backport published after a newer release still sorts by version.
	const list = [rel("1.1.1"), rel("2.0.0"), rel("1.2.0"), rel("1.1.0"), rel("1.0.0")];
	const span = notesSpan(list, "1.1.0", "1.2.0", false);
	expect(span.releases.map((r) => r.version)).toEqual(["1.2.0", "1.1.1"]);
	expect(span).toMatchObject({ older: 0, more: false });
});

test("pre-releases count only when the app follows them or one is the latest", () => {
	const list = [rel("2.0.0"), rel("2.0.0-rc.1", "", true), rel("1.0.0")];
	expect(notesSpan(list, "1.0.0", "2.0.0", false).releases.map((r) => r.version)).toEqual(["2.0.0"]);
	expect(notesSpan(list, "1.0.0", "2.0.0", true).releases.map((r) => r.version)).toEqual(["2.0.0", "2.0.0-rc.1"]);
	expect(notesSpan(list, "1.0.0", "2.0.0-rc.1", false).releases.map((r) => r.version)).toEqual(["2.0.0-rc.1"]);
});

test("a list that never reaches the installed version says older ones may be missing", () => {
	expect(notesSpan([rel("3.0.0"), rel("2.9.0")], "1.0.0", "3.0.0", false).more).toBe(true);
	// No release in the span: nothing to say.
	expect(notesSpan([], "1.0.0", "3.0.0", false).more).toBe(false);
});

test("notes past the size budget are counted, never cut, and the newest always shows", () => {
	const big = "x".repeat(NOTES_BUDGET);
	const span = notesSpan(
		[rel("4.0.0", big), rel("3.0.0", "small"), rel("2.0.0"), rel("1.0.0")],
		"1.0.0",
		"4.0.0",
		false,
	);
	expect(span.releases.map((r) => r.version)).toEqual(["4.0.0"]);
	expect(span.older).toBe(2);
});

test("breaking lines are matched by the marker list, trimmed, deduplicated and capped", () => {
	const lines = breakingLines([
		{
			version: "2.0.0",
			tag: "v2.0.0",
			publishedAt: "",
			notes: [
				"## BREAKING CHANGE",
				"- Removed the old flag (deprecated in 1.4, now removed).",
				"* Fixes a crash",
				"1. The plugin API is incompatible with 1.x.",
			].join("\n"),
		},
		{ version: "1.9.0", tag: "v1.9.0", publishedAt: "", notes: "## BREAKING CHANGE\nRequires manual steps." },
	]);
	expect(lines).toEqual([
		{ version: "2.0.0", line: "BREAKING CHANGE" },
		{ version: "2.0.0", line: "Removed the old flag (deprecated in 1.4, now removed)." },
		{ version: "2.0.0", line: "The plugin API is incompatible with 1.x." },
	]);
	expect(lines.length).toBe(BREAKING_MAX);
	expect(
		breakingLines([
			{ version: "1.9.0", tag: "", publishedAt: "", notes: "BREAKING CHANGE\nbreaking change\nRequires manual steps." },
		]),
	).toEqual([
		{ version: "1.9.0", line: "BREAKING CHANGE" },
		{ version: "1.9.0", line: "breaking change" },
		{ version: "1.9.0", line: "Requires manual steps." },
	]);
});

test("words that only look like a marker do not match, and a long line is cut", () => {
	const notes = ["Deprecated the --old flag.", "Migratory birds.", "Non-breaking fix", `Breaking: ${"y".repeat(300)}`];
	const lines = breakingLines([{ version: "1.0.0", tag: "", publishedAt: "", notes: notes.join("\n") }]);
	expect(lines.map((l) => l.line.slice(0, 12))).toEqual(["Breaking: yy"]);
	expect(lines[0]?.line.length).toBe(200);
	expect(lines[0]?.line.endsWith("…")).toBe(true);
});
