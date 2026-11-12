/**
 * The language the window shows. It switches wuchale's catalogs and `<html lang>`, and gives dates and counts their
 * locale. The choice itself lives in Upkeep's settings (`language`), so the tray follows it too; this module only
 * shows what the settings say.
 */
import { type LanguageCode, type LanguageSetting, resolveLanguage } from "../../shared/languages";
import { setLocale } from "../locales/main.loader.svelte.js";

let current = $state<LanguageCode>("en");

/** The language shown now. Reading `language.code` or `language.locale` inside a component follows changes. */
export const language = {
	get code(): LanguageCode {
		return current;
	},
	/**
	 * The locale for dates and numbers. English keeps day-before-month ("Mon 10 Nov"), as Upkeep always showed it.
	 * Chinese is Simplified and Portuguese is Brazil's, as the catalogs are.
	 */
	get locale(): string {
		return current === "en" ? "en-GB" : current === "zh" ? "zh-CN" : current === "pt" ? "pt-BR" : current;
	},
};

/** Shows a language: the catalogs, `<html lang>`, and every date and count drawn from now on. */
export function showLanguage(code: LanguageCode): void {
	current = code;
	setLocale(code);
	// No document under bun test.
	globalThis.document?.documentElement.setAttribute("lang", code);
}

/**
 * Shows what a setting asks for. "system" follows the desktop's languages as the main process reads them from its
 * environment (the list the tray uses); with none given, the webview's own list, which comes from the C locale.
 */
export function followSetting(setting: LanguageSetting, desktop: readonly string[] = []): void {
	const nav = globalThis.navigator;
	const own = [...(nav?.languages ?? [nav?.language])].filter((tag): tag is string => Boolean(tag));
	showLanguage(resolveLanguage(setting, desktop.length > 0 ? desktop : own));
}
