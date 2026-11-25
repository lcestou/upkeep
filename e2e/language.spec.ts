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
	// Space opens it once and leaves it open: no second toggle from the button's own click.
	await pick.focus();
	await page.keyboard.press(" ");
	await expect(page.getByTestId("setting-language-list")).toHaveCount(1);
	await page.keyboard.press("Escape");
	await page.keyboard.press("ArrowDown");
	await expect(page.getByTestId("setting-language-list")).toHaveCount(1);
	await page.keyboard.press("Tab");
	await expect(page.getByTestId("setting-language-list")).toHaveCount(0);
	await expect(pick).toBeFocused();
	await pick.click();
	await page.getByTestId("setting-language-label").click();
	await expect(page.getByTestId("setting-language-list")).toHaveCount(0);
	// Scrolling Settings under the open list closes it; scrolling the list itself does not.
	await pick.click();
	await page.getByTestId("setting-language-list").evaluate((el) => {
		el.scrollTop = 60;
		el.dispatchEvent(new Event("scroll"));
	});
	await expect(page.getByTestId("setting-language-list")).toHaveCount(1);
	await page.getByTestId("settings").evaluate((el) => el.dispatchEvent(new Event("scroll")));
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

test("Import of a file whose apps run commands shows them first; Cancel writes nothing, Import goes ahead", async ({
	page,
}) => {
	await load(page, "fixture=built");
	await page.getByTestId("tab-settings").click();
	const note = page.getByTestId("setup-note");
	await page.getByTestId("import-setup").click();
	await expect(page.getByTestId("import-ask")).toHaveText(
		"This file has apps that run these commands on this computer. Import it only if you trust where it came from.",
	);
	await expect(page.getByTestId("import-app-name")).toHaveText(["llama.cpp"]);
	await expect(page.getByTestId("import-command")).toHaveText([
		"source: ggml-org/llama.cpp",
		"build: cmake -B build -DGGML_CUDA=ON",
		"build: cmake --build build -j",
		"restart: systemctl --user restart llama-server",
	]);
	await expect(page.getByTestId("import-plain")).toHaveText(
		/^It also has \d+ apps that only install their release files, without root\.$/,
	);
	await expect(page.getByTestId("import-auto-off")).toHaveText(
		"Automatic installs come in off for every app that is new to this computer or differs from its table here. You can turn them on again for each app.",
	);
	await expect(page.getByTestId("import-turns-on")).toHaveText(
		"It turns on these settings, which are off on this computer:",
	);
	await expect(page.getByTestId("import-switch")).toHaveText(["Update Upkeep automatically"]);
	await expect(page.getByTestId("import-turns-off")).toHaveText(
		"It turns off these settings, which are on on this computer:",
	);
	await expect(page.getByTestId("import-switch-off")).toHaveText([
		"Wait for an unmetered connection and mains power for automatic app updates",
	]);
	// Focus starts on Cancel, so a stray Enter writes nothing.
	await expect(page.getByTestId("import-cancel")).toBeFocused();
	await expect(page.getByTestId("import-cancel")).toHaveText("Cancel");
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("import-ask")).toHaveCount(0);
	await expect(note).toHaveText(
		"Export saves the settings and the app list as one file, for another computer or a script. Import replaces them from such a file.",
	);
	await page.getByTestId("import-setup").click();
	await expect(page.getByTestId("import-confirm")).toHaveText("Import");
	await page.getByTestId("import-confirm").click();
	await expect(page.getByTestId("import-ask")).toHaveCount(0);
	await expect(note).toHaveText(
		/^Imported a list of \d+ apps\. Automatic installs came in off for 1 app that is new here or changed\.$/,
	);
});

test("what the engine reports follows the language: a row's problem is worded from the catalog", async ({ page }) => {
	await load(page, "fixture=problems");
	const line = page.getByTestId("sentence-borg");
	await expect(line).toHaveText("BorgBackup will not start (~/.local/bin/borg).");
	await page.getByTestId("tab-settings").click();
	await page.getByTestId("setting-language").click();
	await page.getByTestId("setting-language-es").click();
	await page.getByTestId("tab-updates").click();
	const es = inLanguage("es", "{0} will not start ({1}).")
		.replace("{0}", "BorgBackup")
		.replace("{1}", "~/.local/bin/borg");
	await expect(line).toHaveText(es);
	expect(es).not.toBe("BorgBackup will not start (~/.local/bin/borg).");
});
