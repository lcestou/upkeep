import { language } from "./language.svelte";

const UNITS = ["B", "kB", "MB", "GB", "TB"] as const;

/** Decimal units, as file managers on this desktop show them. */
export function formatBytes(bytes: number): string {
	let value = bytes;
	let unit = 0;
	while (unit < UNITS.length - 1 && Math.round(value * 10) / 10 >= 1000) {
		value /= 1000;
		unit++;
	}
	const text = unit === 0 || value >= 10 ? String(Math.round(value)) : value.toFixed(1);
	return `${text} ${UNITS[unit]}`;
}

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
	["second", 60],
	["minute", 60],
	["hour", 24],
	["day", 30],
	["month", 12],
	["year", Number.POSITIVE_INFINITY],
];

/** Relative times in the language shown; read at each call, so a language switch shows at once. */
const rtf = () => new Intl.RelativeTimeFormat(language.locale, { numeric: "auto" });

/**
 * "3 days ago" style text, in whole units counted down: 1 minute 59 seconds is "1 minute ago", never rounded up to 2.
 * Anything under a minute reads "just now"; an unparseable date comes back unchanged.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return iso;
	let value = (then - now) / 1000;
	// @wc-include
	if (Math.abs(value) < 60) return "just now";
	for (const [unit, size] of STEPS) {
		if (Math.abs(value) < size) return rtf().format(Math.trunc(value), unit);
		value /= size;
	}
	return rtf().format(Math.trunc(value), "year");
}

/** Every plural category, in the order wuchale lists a language's forms. */
const ORDER: Intl.LDMLPluralRule[] = ["zero", "one", "two", "few", "many", "other"];

/**
 * The wording a count takes: `plural(3, ["# app", "# apps"])` is "3 apps". Write the two English forms, for one and
 * for more; `#` stands for the number. wuchale reads a call by this name as one catalog entry with a form for each
 * plural category of a language, in the order of that catalog's `X-Plurals-Order`, and passes in the language's
 * forms and its code (svelte-wlm-tools' helper). A form missing for a category falls back to the last one.
 */
export function plural(count: number, forms: string[], locale = "en"): string {
	const rules = new Intl.PluralRules(locale);
	const categories = ORDER.filter((c) => rules.resolvedOptions().pluralCategories.includes(c));
	const form = forms[categories.indexOf(rules.select(count))] ?? forms.at(-1) ?? "";
	return form.replace("#", String(count));
}

/** Seconds with one decimal under 10 s, whole seconds under a minute, whole minutes after that. */
export function formatDuration(ms: number): string {
	const s = ms / 1000;
	if (s < 10) return `${s.toFixed(1)} s`;
	if (s < 60) return `${Math.round(s)} s`;
	return `${Math.round(s / 60)} min`;
}

/** "Mon 10 Nov, 09:41", the heading of one run in History. */
export function formatRunTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const day = d.toLocaleDateString(language.locale, { weekday: "short", day: "numeric", month: "short" });
	const time = d.toLocaleTimeString(language.locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
	return `${day}, ${time}`;
}

/** "Nov 27": a day and short month in the language shown, without the year. An unparseable date comes back unchanged. */
export function shortDate(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString(language.locale, { month: "short", day: "numeric" });
}

/** Local 24-hour time with seconds, for log lines. An unparseable date comes back unchanged. */
export function clockTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleTimeString(language.locale, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	});
}
