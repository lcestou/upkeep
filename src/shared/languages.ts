/**
 * The interface languages, each named in itself, and the rule for which one a person gets. Shared by the window, the
 * tray and the engine's settings check. Left to right only: a right-to-left language needs the layout mirrored first.
 * wuchale does not read this file, so the names are never translated. The codes match `locales` in wuchale.config.js;
 * a test holds the two lists together.
 */
export const LANGUAGES = [
	{ code: "en", name: "English" },
	{ code: "zh", name: "中文（简体）" },
	{ code: "es", name: "Español" },
	{ code: "pt", name: "Português (Brasil)" },
	{ code: "de", name: "Deutsch" },
	{ code: "fr", name: "Français" },
	{ code: "it", name: "Italiano" },
	{ code: "pl", name: "Polski" },
	{ code: "ru", name: "Русский" },
	{ code: "ja", name: "日本語" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

/** "system" follows the desktop's language; a code is the person's own pick. */
export type LanguageSetting = "system" | LanguageCode;

/** Whether a value is one of the interface languages, such as one read back from the settings file. */
export function isLanguage(v: string | null | undefined): v is LanguageCode {
	return LANGUAGES.some((l) => l.code === v);
}

/**
 * The first of the preferred tags Upkeep has, by its primary subtag (`es-MX` and `es_MX.UTF-8` count as `es`);
 * English when none is. A tag of `C` or `POSIX`, as a bare system has, is skipped.
 */
export function pickLanguage(preferred: readonly string[]): LanguageCode {
	for (const tag of preferred) {
		const base = tag.toLowerCase().split(/[-_.@]/)[0];
		if (isLanguage(base)) return base;
	}
	return "en";
}

/** The language shown for a setting: the pick itself, or for "system" the first preferred tag Upkeep has. */
export function resolveLanguage(setting: LanguageSetting, preferred: readonly string[]): LanguageCode {
	return setting === "system" ? pickLanguage(preferred) : setting;
}

/**
 * The desktop's languages from the environment, most preferred first, as gettext reads them: LANGUAGE (a colon
 * list), then LC_ALL, LC_MESSAGES and LANG.
 */
export function systemLanguages(env: Record<string, string | undefined>): string[] {
	const list = (env.LANGUAGE ?? "").split(":").filter(Boolean);
	for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
		const v = env[name];
		if (v) list.push(v);
	}
	return list;
}
