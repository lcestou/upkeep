/**
 * `bun run i18n:check`: fails when the catalogs in `src/mainview/locales/` are not what an extraction would
 * write today (from svelte-wlm-tools).
 *
 * A stale catalog lies both ways. A string written since the last extraction is in no catalog, so
 * it renders English and the catalog tests cannot know. A string deleted since then is still
 * listed, so it reads as covered.
 *
 * The extraction runs for real, through wuchale's own code, but everything it would write is kept
 * in memory and compared with the files. Nothing on disk changes, on success or failure, and a
 * running dev server never notices: it owns the compiled catalogs in `src/mainview/locales/.wuchale/`, and
 * this never touches them.
 *
 * @module scripts/i18n/check
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { getConfig, Hub } from "wuchale";

import { parseCatalog } from "./po";

const started = performance.now();

/** What the extraction would have written, by absolute path. */
const written = new Map<string, string>();

/** Reads a file as it is on disk, or null when there is none. */
async function onDisk(file: string): Promise<string | null> {
	return existsSync(file) ? readFile(file, "utf8") : null;
}

/** wuchale's file access: reads go to the disk, writes stay in `written`. */
const memory: Parameters<typeof Hub.create>[5] = {
	// With the dev server's process id hidden, wuchale runs the whole extraction instead of
	// standing back as a second process. That is safe here because nothing is written.
	read: async (file) => written.get(file) ?? (file.endsWith("dev.pid") ? null : onDisk(file)),
	write: (file, content) => {
		written.set(file, content);
	},
	mkdir: () => {},
	exists: (path) => written.has(path) || existsSync(path),
	unlink: () => true,
};

const config = await getConfig();
config.logLevel = "error";
const hub = await Hub.create("cli", config, process.cwd(), [], 0, memory);
// `true` drops the strings no file uses any more, as `bun run i18n` does
await hub.directVisit(true, false, false);

/** The catalogs that would change, as path from the repository root and new contents. */
const catalogs = [...written].filter(([file]) => file.endsWith(".po"));
const onDiskNow = await Promise.all(catalogs.map(([file]) => onDisk(file)));
const changed: [string, string][] = catalogs
	.filter(([, content], i) => content !== onDiskNow[i])
	.map(([file, content]) => [relative(process.cwd(), file), content]);

const seconds = ((performance.now() - started) / 1000).toFixed(1);
if (changed.length === 0) {
	console.log(`i18n:check: the catalogs are up to date (${seconds}s)`);
	process.exit(0);
}

/** A string for the report: one line, cut to fit. */
const shown = (text: string) => `    ${text.replaceAll("\n", " ").slice(0, 96)}`;

const lines = ["i18n:check FAILED: an extraction would change these catalogs:"];
lines.push(...changed.map(([file]) => `  ${file}`).toSorted());

const source = changed.find(([file]) => file.endsWith("/en.po"));
if (source) {
	const before = new Set(parseCatalog((await onDisk(source[0])) ?? "").map((entry) => entry.english));
	const after = new Set(parseCatalog(source[1]).map((entry) => entry.english));
	const arrived = [...after].filter((text) => !before.has(text));
	const left = [...before].filter((text) => !after.has(text));
	if (arrived.length) lines.push("", `New in the source, ${arrived.length}:`, ...arrived.map(shown));
	if (left.length) lines.push("", `No longer in the source, ${left.length}:`, ...left.map(shown));
}

for (const language of config.locales.filter((l) => l !== "en")) {
	const catalog = changed.find(([file]) => file.endsWith(`/${language}.po`));
	if (!catalog) continue;
	const empty = parseCatalog(catalog[1]).filter((entry) => entry.translation.trim() === "");
	if (empty.length === 0) continue;
	lines.push("", `${language}: ${empty.length} without a translation, so they would read English:`);
	lines.push(...empty.map((entry) => shown(entry.english)));
}

lines.push(
	"",
	"Stop the dev server, run `bun run i18n`, fill in the empty msgstr in each catalog,",
	`and start the dev server again. (${seconds}s)`,
);
console.error(lines.join("\n"));
process.exit(1);
