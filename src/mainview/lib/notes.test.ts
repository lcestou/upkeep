import { expect, test } from "bun:test";
import { ZEN_NOTES } from "./fixture";
import { inline, parseNotes } from "./notes";

// The shape of a real Zen and fd release body, headings, bullets, links, code and a raw tag included.
const BODY = `# Zen Stable Release

## Security
- Fixes from [Firefox 146.0.1](https://www.mozilla.org/en-US/firefox/146.0.1/releasenotes/)
- See https://www.mozilla.org/en-US/security/advisories/mfsa2026-42/ for details.

## Bugfixes
* Fix \`--exec-batch\` when combined with **--max-results**.
<details><summary>Checksums</summary>
sha256 abc
</details>`;

test("a real release body", () => {
	const blocks = parseNotes(BODY);
	expect(blocks.map((b) => b.t)).toEqual(["heading", "heading", "list", "heading", "list", "para"]);
	expect(blocks[0]).toEqual({ t: "heading", inline: [{ t: "text", s: "Zen Stable Release" }] });
	const security = blocks[2];
	if (security?.t !== "list") throw new Error("list expected");
	expect(security.items[0]).toEqual([{ t: "text", s: "Fixes from Firefox 146.0.1" }]);
	expect(security.items[1]).toEqual([
		{ t: "text", s: "See " },
		{ t: "url", s: "https://www.mozilla.org/en-US/security/advisories/mfsa2026-42/" },
		{ t: "text", s: " for details." },
	]);
	const fixes = blocks[4];
	if (fixes?.t !== "list") throw new Error("list expected");
	expect(fixes.items[0]).toEqual([
		{ t: "text", s: "Fix " },
		{ t: "code", s: "--exec-batch" },
		{ t: "text", s: " when combined with " },
		{ t: "bold", s: "--max-results" },
		{ t: "text", s: "." },
	]);
	// Raw HTML is dropped, its text stays.
	expect(blocks[5]).toEqual({ t: "para", inline: [{ t: "text", s: "Checksums sha256 abc" }] });
});

test("a bare URL drops trailing punctuation", () => {
	expect(inline("Go to https://example.org/a.")).toEqual([
		{ t: "text", s: "Go to " },
		{ t: "url", s: "https://example.org/a" },
		{ t: "text", s: "." },
	]);
});

test("Zen's real body keeps its sections apart", () => {
	const blocks = parseNotes(ZEN_NOTES);
	expect(blocks.map((b) => b.t)).toEqual([
		"heading",
		"heading",
		"list",
		"heading",
		"list",
		"heading",
		"list",
		"heading",
		"list",
	]);
	const fixes = blocks[6];
	if (fixes?.t !== "list") throw new Error("list expected");
	expect(fixes.items.length).toBe(5);
});

test("a single newline joins a paragraph; a blank line starts the next", () => {
	expect(parseNotes("one\ntwo\n\nthree").map((b) => (b.t === "para" ? b.inline.map((i) => i.s).join("") : ""))).toEqual(
		["one two", "three"],
	);
});
