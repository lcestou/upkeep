/**
 * Reads the translation catalogs in `src/mainview/locales/` for `bun run i18n:check` (from svelte-wlm-tools).
 *
 * @module scripts/i18n/po
 */
/**
 * One catalog entry: the English, the translation and the files that use it.
 *
 * A count (`msgid_plural`, the catalog format) also carries `plural`, the English for more than one,
 * and `forms`, one translation per plural form of the language in the order of the catalog's
 * `X-Plurals-Order` header. Its `translation` is the forms on a line each, and empty while any
 * form is, so a reader that asks only "is it translated" needs no second question.
 */
export interface Entry {
	english: string;
	translation: string;
	files: string[];
	plural?: string;
	forms?: string[];
}

/** The text of a `msgid` or `msgstr`, which a `.po` file may wrap over several quoted lines. */
function unquote(lines: string): string {
	const quoted = [...lines.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(([, text]) => text);
	return quoted.join("").replaceAll("\\n", "\n").replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

/**
 * Reads the entries of a catalog, header left out.
 * @param text The contents of a `.po` file
 * @returns Its entries in file order
 */
export function parseCatalog(text: string): Entry[] {
	return text
		.split("\n\n")
		.slice(1)
		.flatMap((block) => {
			const files = [...block.matchAll(/^#: (.+)$/gm)].flatMap(([, list]) => (list ?? "").split(" "));
			const count = /^msgid ([\s\S]*?)\nmsgid_plural ([\s\S]*?)\n(msgstr\[0\] [\s\S]*)$/m.exec(block);
			if (count) {
				const forms = (count[3] ?? "")
					.split(/^msgstr\[\d+\] /m)
					.slice(1)
					.map(unquote);
				const translation = forms.every((form) => form.trim()) ? forms.join("\n") : "";
				return [{ english: unquote(count[1] ?? ""), plural: unquote(count[2] ?? ""), translation, forms, files }];
			}
			const parts = /^msgid ([\s\S]*?)\nmsgstr ([\s\S]*)$/m.exec(block);
			if (!parts) return [];
			return [{ english: unquote(parts[1] ?? ""), translation: unquote(parts[2] ?? ""), files }];
		});
}
