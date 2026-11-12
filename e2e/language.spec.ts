import { readFileSync } from "node:fs";
import { parseCatalog } from "../scripts/i18n/po";
import { LANGUAGES } from "../src/shared/languages";
import { expect, load, test } from "./helpers";

/** A string's translation in one language, read from its catalog, so the spec follows the catalog's wording. */
function inLanguage(code: string, english: string): string {
	const text = readFileSync(new URL(`../src/mainview/locales/${code}.po`, import.meta.url), "utf8");
	const entry = parseCatalog(text).find((e) => e.english === english);
	if (!entry?.translation) throw new Error(`${code} has no translation of "${english}"`);
	return entry.translation;
}

test("Settings picks the language; the whole window switches at once, and back", async ({ page }) => {
	await load(page);
	await page.getByTestId("tab-settings").click();
	await expect(page.getByTestId("setting-language-label")).toHaveText("Language");
	const pick = page.getByTestId("setting-language");
	await expect(pick).toHaveText("Same as the system");
	await pick.click();
	const list = page.getByTestId("setting-language-list");
	await expect(list.getByRole("option")).toHaveText(["Same as the system", ...LANGUAGES.map((l) => l.name)]);
	await expect(list.getByRole("option", { selected: true })).toHaveText("Same as the system");
	// The list is the page's own and fits in the window: no native menu to run off its edge.
	const box = await list.boundingBox();
	const view = page.viewportSize();
	expect(box && view && box.y >= 0 && box.y + box.height <= view.height).toBe(true);
	await page.getByTestId("setting-language-es").click();
	await expect(list).toHaveCount(0);
	await expect(page.locator("html")).toHaveAttribute("lang", "es");
	await expect(page.getByTestId("tab-settings")).toHaveText(inLanguage("es", "Settings"));
	await expect(page.getByTestId("setting-language-label")).toHaveText(inLanguage("es", "Language"));
	await expect(page.getByTestId("setting-check-every").locator("option").first()).toHaveText(
		inLanguage("es", "Every 6 hours"),
	);
	await page.getByTestId("tab-updates").click();
	await expect(page.getByTestId("tab-updates")).toHaveText(inLanguage("es", "Updates"));
	await page.getByTestId("tab-settings").click();
	// By keyboard: open with Enter, Home to the first entry, Enter to pick it.
	await page.getByTestId("setting-language").focus();
	await page.keyboard.press("Enter");
	await page.keyboard.press("Home");
	await page.keyboard.press("Enter");
	await expect(page.locator("html")).toHaveAttribute("lang", "en");
	await expect(page.getByTestId("setting-language")).toBeFocused();
	await expect(page.getByTestId("tab-settings")).toHaveText("Settings");
});

test.describe("a desktop in German", () => {
	test.use({ locale: "de-DE" });
	test("follows the system language until a language is picked", async ({ page }) => {
		await load(page);
		await expect(page.locator("html")).toHaveAttribute("lang", "de");
		await expect(page.getByTestId("tab-history")).toHaveText(inLanguage("de", "History"));
		await page.getByTestId("tab-settings").click();
		await page.getByTestId("setting-language").click();
		await page.getByTestId("setting-language-en").click();
		await expect(page.getByTestId("tab-history")).toHaveText("History");
	});
});

test("the language list closes on Escape and on a click elsewhere, and keeps the choice", async ({ page }) => {
	await load(page);
	await page.getByTestId("tab-settings").click();
	const pick = page.getByTestId("setting-language");
	await pick.click();
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("setting-language-list")).toHaveCount(0);
	await expect(pick).toBeFocused();
	await expect(pick).toHaveText("Same as the system");
	await pick.click();
	await page.getByTestId("setting-language-label").click();
	await expect(page.getByTestId("setting-language-list")).toHaveCount(0);
});

test("Export and Import in Settings say what they did", async ({ page }) => {
	await load(page);
	await page.getByTestId("tab-settings").click();
	const note = page.getByTestId("setup-note");
	await expect(note).toHaveText(
		"Export saves the settings and the app list as one file, for another computer or a script. Import replaces them from such a file.",
	);
	await page.getByTestId("export-setup").click();
	await expect(note).toHaveText("Saved /home/you/upkeep-settings-2026-11-12.json.");
	await page.getByTestId("import-setup").click();
	await expect(note).toHaveText(/^Imported a list of \d+ apps\.$/);
});
