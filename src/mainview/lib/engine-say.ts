/**
 * Shows an engine sentence in the language shown. The engine writes English through the templates in
 * src/shared/messages.ts, and the window gets only the finished text, so this reads it back: it finds the template
 * the text came from, takes the values out, and words the same template from engine-text.ts, which wuchale
 * translates. A value that is itself an engine sentence (a probe's message inside "Version probe failed: …") is shown
 * the same way. Text that matches no template, such as a tool's own output, comes back unchanged.
 */
import { MESSAGES, type MessageId } from "../../shared/messages";
import { ENGINE_COPY } from "./engine-text";

/** Marks where a value goes when a template is drawn to learn its shape; never in real text. */
const MARK = (i: number) => `\u{E000}${i}\u{E001}`;

type Pattern = { id: MessageId; re: RegExp; order: number[] };

/** A RegExp source that matches the text literally. */
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The patterns, once built. */
let built: Pattern[] | null = null;

/**
 * Every template as a pattern, the most specific first (the most fixed letters), so a short template such as
 * "{0} exited {1}." never takes a sentence a longer one fits. Built once, on first use.
 */
function patterns(): Pattern[] {
	if (built) return built;
	// SAFETY: Object.keys of the MESSAGES literal is exactly its ids.
	const all = (Object.keys(MESSAGES) as MessageId[]).map((id) => {
		// SAFETY: every template takes its values as strings or numbers and reads only the ones it names.
		const fn = MESSAGES[id] as (...v: string[]) => string;
		const drawn = fn(...Array.from({ length: fn.length }, (_, i) => MARK(i)));
		const order: number[] = [];
		const source = drawn
			.split(/(\u{E000}\d+\u{E001})/u)
			.map((part) => {
				const at = /^\u{E000}(\d+)\u{E001}$/u.exec(part);
				if (!at) return literal(part);
				order.push(Number(at[1]));
				return "([\\s\\S]*?)";
			})
			.join("");
		const fixed = drawn.replace(/\u{E000}\d+\u{E001}/gu, "").replace(/[^\p{L}]/gu, "").length;
		return { id, re: new RegExp(`^${source}$`, "u"), order, fixed };
	});
	all.sort((a, b) => b.fixed - a.fixed);
	built = all;
	return built;
}

/** The template a text was written from, with its values in the template's own order; null when none fits. */
export function match(text: string): { id: MessageId; values: string[] } | null {
	for (const s of patterns()) {
		const m = s.re.exec(text);
		if (!m) continue;
		const values: string[] = [];
		s.order.forEach((slot, k) => {
			values[slot] = m[k + 1] ?? "";
		});
		return { id: s.id, values };
	}
	return null;
}

/**
 * An engine sentence in the language shown, or the text unchanged when it is not one. Values that are engine
 * sentences themselves are worded too, three deep at most.
 */
export function say(text: string | null | undefined, depth = 0): string {
	if (!text) return text ?? "";
	const found = depth < 3 ? match(text) : null;
	if (!found) return text;
	// SAFETY: ENGINE_COPY has a function for every id, taking as many string values as the template matched.
	const fn = ENGINE_COPY[found.id] as (...v: string[]) => string;
	return fn(...found.values.map((v) => say(v, depth + 1)));
}
