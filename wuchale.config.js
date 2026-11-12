/**
 * Interface translation with wuchale. It reads the English in the view, keeps one `.po` catalog per language in
 * `src/mainview/locales/`, and swaps each string for a catalog lookup when Vite builds. `bun run i18n` extracts new
 * strings into the catalogs; the `msgstr` lines are written by hand, and `bun run i18n:check` (part of the gate) fails
 * on a string that is new, gone or left untranslated.
 *
 * Almost all copy lives in `src/mainview/lib/copy.ts`. A string there is read when its getter or function runs, so
 * a language switch shows at once; a plain top-level value would be read once, at load, and never switch. Counts go
 * through `plural()` (format.ts), which wuchale turns into one entry with a form per plural category.
 *
 * Every language is bundled (`loading: { direct: true }`): a few hundred strings, one window, no download on switch.
 * The tray and notifications are drawn by the Bun process, which Vite never builds; their strings are a typed table
 * in `src/bun/tray-text.ts`.
 *
 * To add a language: add it to LANGUAGES in src/shared/languages.ts and to `locales` here (a test holds the two
 * together), run `bun run i18n`, and fill in the new catalog.
 */
import { adapter as svelte } from "@wuchale/svelte";
import { createHeuristic, defaultHeuristicOpts, defineConfig } from "wuchale";
import { getFuncNameNested } from "wuchale/adapter-utils";

/** wuchale's stock rules: script strings that start lower-case, are all capitals or hold no letter are not copy. */
const stock = createHeuristic(defaultHeuristicOpts);

/**
 * Literals that are compared, not shown: keyboard key names in the components' key handlers, and names that stay as
 * they are in every language. Translating one would break that key or name in one language only.
 */
const NOT_COPY = new Set([
	"Escape",
	"Enter",
	"Tab",
	"Home",
	"End",
	"PageUp",
	"PageDown",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"Files",
	"Flatpak",
	"AppImage",
	"Upkeep",
	"GitHub",
]);

/** Attributes a person reads or hears; the stock rules drop a value that starts lower-case. */
const COPY_ATTRIBUTE = new Set(["title", "aria-label", "alt", "placeholder"]);

/**
 * Decides whether a string wuchale found is copy: `false` rejects it, `"message"` takes it, anything else from the
 * stock rules passes through. Return `false`, never `null`, to reject: `null` falls back to the stock rules.
 * @param {import('wuchale').Text} text The string and where it sits
 * @param {string} file The file it came from
 * @returns {import('wuchale').HeuristicResult} The verdict
 */
function isCopy(text, file) {
	const body = [text.body].flat().join("\n").trim();
	if (NOT_COPY.has(body)) return false;
	const attribute = text.path.findLast((step) => step.type === "attribute")?.name;
	if (attribute && COPY_ATTRIBUTE.has(attribute) && text.path.at(-1)?.type === "attribute") {
		return /\p{L}/u.test(body) ? "message" : false;
	}
	return stock(text, file);
}

/**
 * Whether a string sits outside every function, and whether its file runs once (a plain module or a
 * `<script module>`). wuchale's own test only knows `.svelte.js`, so a `.svelte.ts` module read the catalog inside
 * functions without setting it up (`_w_runtime_ is not defined`); the same fix as sveltekit-boilerplate.
 * @param {import('wuchale').Scope[]} path Where the string sits
 * @param {string} file The file it came from
 * @param {{ module: boolean }} context Whether this is a `<script module>`
 * @returns {{ isTopLevel: boolean, runsOnce: boolean }} The two facts the runtime rules need
 */
function placeOf(path, file, context) {
	const [functionName] = getFuncNameNested(path);
	return {
		isTopLevel: functionName == null,
		runsOnce: !file.endsWith(".svelte") || /\.svelte\.[jt]s$/.test(file) || context.module,
	};
}

export default defineConfig({
	locales: ["en", "zh", "es", "pt", "de", "fr", "it", "pl", "ru", "ja"],
	// No machine translation at build time: the catalogs are written by hand.
	ai: null,
	// The dev server reads the catalogs as they are; only `bun run i18n` writes them (a writing dev server raced
	// hand edits in sveltekit-boilerplate).
	dev: "read",
	localesDir: "src/mainview/locales",
	adapters: {
		main: svelte({
			loader: "svelte",
			loading: { direct: true },
			heuristic: isCopy,
			// Copies: wuchale changes the arrays it is given (svelte-wlm-tools).
			files: [
				"src/mainview/**/*.svelte",
				"src/mainview/lib/copy.ts",
				"src/mainview/lib/format.ts",
			].slice(),
			runtime: {
				initReactive: (...where) => {
					const { isTopLevel, runsOnce } = placeOf(...where);
					return runsOnce ? isTopLevel : isTopLevel ? true : null;
				},
				useReactive: (...where) => {
					const { isTopLevel, runsOnce } = placeOf(...where);
					return runsOnce ? isTopLevel : true;
				},
			},
		}),
	},
});
