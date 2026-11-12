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
	await expect(pick).toHaveValue("system");
	await expect(pick.locator("option")).toHaveText(["Same as the system", ...LANGUAGES.map((l) => l.name)]);
	await pick.selectOption("es");
	await expect(page.locator("html")).toHaveAttribute("lang", "es");
	await expect(page.getByTestId("tab-settings")).toHaveText(inLanguage("es", "Settings"));
	await expect(page.getByTestId("setting-language-label")).toHaveText(inLanguage("es", "Language"));
	await expect(page.getByTestId("setting-check-every").locator("option").first()).toHaveText(
		inLanguage("es", "Every 6 hours"),
	);
	await page.getByTestId("tab-updates").click();
	await expect(page.getByTestId("tab-updates")).toHaveText(inLanguage("es", "Updates"));
	await page.getByTestId("tab-settings").click();
	await page.getByTestId("setting-language").selectOption("system");
	await expect(page.locator("html")).toHaveAttribute("lang", "en");
	await expect(page.getByTestId("tab-settings")).toHaveText("Settings");
});

test.describe("a desktop in German", () => {
	test.use({ locale: "de-DE" });
	test("follows the system language until a language is picked", async ({ page }) => {
		await load(page);
		await expect(page.locator("html")).toHaveAttribute("lang", "de");
		await expect(page.getByTestId("tab-history")).toHaveText(inLanguage("de", "History"));
		await page.getByTestId("tab-settings").click();
		await page.getByTestId("setting-language").selectOption("en");
		await expect(page.getByTestId("tab-history")).toHaveText("History");
	});
});
