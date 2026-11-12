import { expect, test } from "bun:test";
import { parseCatalog } from "../../../scripts/i18n/po";
import { LANGUAGES } from "../../shared/languages";

/** A catalog's entries, read from src/mainview/locales. */
const catalog = async (code: string) =>
	parseCatalog(await Bun.file(new URL(`../locales/${code}.po`, import.meta.url)).text());

/** What a translation must keep: the placeholders, in any order. */
const marks = (s: string) => [...s.matchAll(/\{\d+\}/g)].map((m) => m[0]).toSorted();

/**
 * English words a language writes the same, so a translation equal to the English is right there: names, codes and
 * words the language borrows. Anything else equal to its English was left untranslated (pewtron's test).
 */
const SAME_IN: Record<string, readonly string[]> = {
	zh: ["Root"],
	es: ["Plugins", "App", "Root", "Auto", "Extras", "Kernel"],
	pt: ["Plugins", "App", "Status", "Root", "Auto", "Extras", "Kernel", "Driver"],
	de: ["Name", "Plugins", "App", "Version", "Status", "Root", "Auto", "Version {0}", "System", "Extras", "Kernel"],
	fr: ["Plugins", "Version", "Root", "Auto", "Source", "Version {0}", "Extras"],
	it: ["Download", "App", "Root", "Auto", "Kernel", "Driver"],
	pl: ["Root", "Auto"],
	ru: ["Root"],
	ja: ["Root"],
};

/** Strings that hold no word to translate: a number and a unit, or a placeholder alone. */
const NO_WORDS = /^[\s{}0-9#%:.,·()-]*(s|min)?$/u;

const english = await catalog("en");

for (const { code } of LANGUAGES.filter((l) => l.code !== "en")) {
	test(`${code}: every string is translated, keeps its placeholders and its count`, async () => {
		const entries = new Map((await catalog(code)).map((e) => [e.english, e]));
		const problems: string[] = [];
		for (const source of english) {
			const entry = entries.get(source.english);
			if (!entry) {
				problems.push(`missing: ${source.english}`);
				continue;
			}
			if (!entry.translation.trim()) {
				problems.push(`empty: ${source.english}`);
				continue;
			}
			for (const form of entry.forms ?? [entry.translation]) {
				if (marks(form).join() !== marks(source.english).join()) problems.push(`marks: ${source.english} -> ${form}`);
				if (source.plural && source.english.includes("#") && !form.includes("#"))
					problems.push(`count: ${source.english} -> ${form}`);
			}
			const same = entry.translation === source.english && !NO_WORDS.test(source.english);
			if (same && !(SAME_IN[code] ?? []).includes(source.english)) problems.push(`left in English: ${source.english}`);
		}
		expect(problems).toEqual([]);
	});
}

test("the catalog reader reads escapes in one pass: an escaped backslash before n is not a line break", () => {
	const [entry] = parseCatalog('header\n\nmsgid "a \\\\n b \\"q\\"\\nc"\nmsgstr "x"\n');
	expect(entry?.english).toBe('a \\n b "q"\nc');
});
