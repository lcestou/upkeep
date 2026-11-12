import { expect, test } from "bun:test";
import { isLanguage, LANGUAGES, pickLanguage, resolveLanguage, systemLanguages } from "./languages";

test("the interface languages are the catalogs wuchale keeps, English first", async () => {
	const text = await Bun.file(new URL("../../wuchale.config.js", import.meta.url)).text();
	const locales = JSON.parse(/locales: (\[[^\]]*\])/.exec(text)?.[1] ?? "[]");
	expect(LANGUAGES.map((l) => l.code)).toEqual(locales);
	expect(LANGUAGES[0].code).toBe("en");
});

test("a language is picked by its primary subtag, from browser tags and locale names alike", () => {
	expect(pickLanguage(["es-MX", "en"])).toBe("es");
	expect(pickLanguage(["pt_BR.UTF-8"])).toBe("pt");
	expect(pickLanguage(["zh-Hans-CN"])).toBe("zh");
	expect(pickLanguage(["sr@latin", "de_DE"])).toBe("de");
	// A bare system says C or POSIX; a language Upkeep lacks is passed over; nothing at all is English.
	expect(pickLanguage(["C.UTF-8", "POSIX", "ko_KR"])).toBe("en");
	expect(pickLanguage([])).toBe("en");
	expect(isLanguage("ja")).toBe(true);
	expect(isLanguage("ar")).toBe(false);
	expect(isLanguage(undefined)).toBe(false);
});

test("a setting of system follows the preferred tags; a pick stands on its own", () => {
	expect(resolveLanguage("system", ["fr_FR.UTF-8"])).toBe("fr");
	expect(resolveLanguage("ja", ["fr_FR.UTF-8"])).toBe("ja");
});

test("the desktop's languages come from LANGUAGE first, then LC_ALL, LC_MESSAGES and LANG", () => {
	expect(systemLanguages({ LANGUAGE: "pl:en", LC_ALL: "", LC_MESSAGES: "ru_RU.UTF-8", LANG: "en_US.UTF-8" })).toEqual([
		"pl",
		"en",
		"ru_RU.UTF-8",
		"en_US.UTF-8",
	]);
	expect(resolveLanguage("system", systemLanguages({ LANG: "it_IT.UTF-8" }))).toBe("it");
	expect(systemLanguages({})).toEqual([]);
});
