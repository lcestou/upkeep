import { expect, test } from "bun:test";
import { relativeTime } from "./format";
import { followSetting, language, showLanguage } from "./language.svelte";

test("a shown language sets the locale dates use; English keeps day before month", () => {
	showLanguage("en");
	expect([language.code, language.locale]).toEqual(["en", "en-GB"]);
	showLanguage("pt");
	expect(language.locale).toBe("pt-BR");
	showLanguage("zh");
	expect(language.locale).toBe("zh-CN");
	showLanguage("de");
	expect(language.locale).toBe("de");
	// Relative times are read at each call, so they switch with the language.
	const now = Date.parse("2026-11-12T12:00:00Z");
	expect(relativeTime("2026-11-10T12:00:00Z", now)).toBe("vorgestern");
	showLanguage("en");
	expect(relativeTime("2026-11-10T12:00:00Z", now)).toBe("2 days ago");
});

test("a setting of system follows the webview's languages; a pick is shown as is", () => {
	followSetting("ja");
	expect(language.code).toBe("ja");
	// bun test reports no languages, so system falls back to English.
	followSetting("system");
	expect(language.code).toBe("en");
	// The desktop's list from the main process wins over the webview's own, LANGUAGE included.
	followSetting("system", ["ja", "en_US.UTF-8"]);
	expect(language.code).toBe("ja");
	followSetting("pl", ["ja"]);
	expect(language.code).toBe("pl");
	showLanguage("en");
});
