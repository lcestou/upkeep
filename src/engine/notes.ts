/**
 * The release notes of every version a person skips over, and the lines in them that read as a breaking change.
 * Plain rules, no model: BREAKING_MARKERS is the whole word list, and docs/window.md documents it. The line
 * only informs; nothing here holds or blocks an update.
 */
import type { BreakingLine, NotesSpan, ReleaseNotes } from "../shared/types";
import type { Release } from "./github";
import { isNewer } from "./version";

/**
 * What marks a line of release notes as a breaking change, matched case-insensitively against one line at a time.
 * "deprecated" alone is not enough (it warns of a later removal); it counts only with "removed" on the same line.
 * Keep the list in docs/window.md in step with this one.
 */
export const BREAKING_MARKERS: readonly RegExp[] = [
	// "Non-breaking" says the opposite.
	/(?<!non-)\bbreaking\b/i,
	/\bmigrat(e|es|ed|ing|ion|ions)\b/i,
	/\bdeprecated\b.*\bremoved\b/i,
	/\bincompatib(le|ility)\b/i,
	/\brequires? manual\b/i,
];

/** The most breaking lines quoted above the notes. */
export const BREAKING_MAX = 3;

/** The longest a quoted line runs before it is cut with an ellipsis. */
const LINE_MAX = 200;

/** The total size of notes shown at once; releases past it are counted as not shown, never cut in the middle. */
export const NOTES_BUDGET = 40_000;

/**
 * The releases after installed up to latest, newest first, with their notes. A release whose tag holds no version is
 * left out, as is a pre-release unless withPre (the app follows pre-releases): a person on stable never installs one.
 * Releases are kept while their notes fit NOTES_BUDGET (the newest always does); the rest are counted in older. more
 * says the list (the forge's newest few) ran out before reaching installed, so how many older ones exist is unknown;
 * it is never set when no release is in the span.
 */
export function notesSpan(list: Release[], installed: string, latest: string, withPre: boolean): NotesSpan {
	const inRange = list
		.filter((r) => r.version !== null && isNewer(installed, r.version) && !isNewer(latest, r.version))
		.filter((r) => withPre || !r.prerelease || r.version === latest)
		.toSorted((a, b) => (isNewer(a.version, b.version) ? 1 : isNewer(b.version, a.version) ? -1 : 0));
	const releases: ReleaseNotes[] = [];
	let size = 0;
	for (const r of inRange) {
		size += r.notes.length;
		if (releases.length > 0 && size > NOTES_BUDGET) break;
		releases.push({ version: r.version ?? r.tag, tag: r.tag, publishedAt: r.publishedAt, notes: r.notes.trim() });
	}
	const reached = list.some((r) => r.version !== null && !isNewer(installed, r.version));
	return {
		releases,
		breaking: breakingLines(releases),
		older: inRange.length - releases.length,
		more: inRange.length > 0 && !reached,
	};
}

/**
 * A line of notes as plain text: a leading heading, list or number mark and the inline marks **, __ and backticks
 * dropped. Other markdown (links, single * or _) stays as written: those can be part of the words.
 */
function plain(raw: string): string {
	// Inline marks first, so "**Breaking:**" does not leave a stray "*" for the list mark; a mark needs its space after
	// it, so "2.0 is breaking" and "#123 …" keep their numbers.
	return raw
		.replaceAll(/\*\*|__|`/g, "")
		.replace(/^\s*(?:#+\s+|[-*+]\s+|\d+[.)]\s+)/, "")
		.trim();
}

/**
 * The first BREAKING_MAX lines across releases (newest first) that a marker matches, trimmed of list and heading marks
 * and inline marks, and cut at LINE_MAX. A heading that matches ("## Breaking changes") is not quoted itself: the first line under it
 * is, whatever it says, and the heading only when nothing follows it. The same line in two releases is quoted once,
 * with the newer version.
 */
export function breakingLines(releases: ReleaseNotes[]): BreakingLine[] {
	const found: BreakingLine[] = [];
	const seen = new Set<string>();
	/** Quotes line with its version unless it is already quoted or the quota is full; a long line is cut at LINE_MAX. */
	const take = (version: string, line: string) => {
		if (seen.has(line) || found.length === BREAKING_MAX) return;
		seen.add(line);
		found.push({ version, line: line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line });
	};
	for (const r of releases) {
		// A matching heading waiting for the first line under it.
		let heading: string | null = null;
		for (const raw of r.notes.split("\n")) {
			const line = plain(raw);
			if (!line) continue;
			const marked = BREAKING_MARKERS.some((m) => m.test(line));
			// A heading is "#" marks then a space: "#42 breaking: …" is an issue number, not a heading.
			if (/^\s*#+\s/.test(raw)) {
				if (heading !== null) take(r.version, heading);
				heading = marked ? line : null;
			} else if (heading !== null || marked) {
				heading = null;
				take(r.version, line);
			}
		}
		if (heading !== null) take(r.version, heading);
	}
	return found;
}
