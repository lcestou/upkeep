import { expect, test } from "bun:test";
import { MESSAGES, type MessageId } from "../../shared/messages";
import { match, say, sentencesOf } from "./engine-say";
import { ENGINE_COPY } from "./engine-text";

const ids = Object.keys(MESSAGES) as MessageId[];
/** Distinct values that read like real ones and could not be mistaken for a template's fixed words. */
const sample = (n: number) => Array.from({ length: n }, (_, i) => `v${i}-q${i}x`);

test("the window words every engine sentence the same as the engine, in English", () => {
	for (const id of ids) {
		const engine = MESSAGES[id] as (...v: string[]) => string;
		const window = ENGINE_COPY[id] as (...v: string[]) => string;
		const values = sample(engine.length);
		expect(`${id}: ${window(...values)}`).toBe(`${id}: ${engine(...values)}`);
	}
});

test("every engine sentence is read back as its own template, with its values", () => {
	const wrong: string[] = [];
	for (const id of ids) {
		const engine = MESSAGES[id] as (...v: string[]) => string;
		const values = sample(engine.length);
		const found = match(engine(...values));
		if (found?.id !== id || JSON.stringify(found.values) !== JSON.stringify(values))
			wrong.push(`${id} read as ${found?.id ?? "nothing"} ${JSON.stringify(found?.values ?? [])}`);
	}
	expect(wrong).toEqual([]);
});

test("text the engine did not write comes back unchanged; nested sentences are worded too", () => {
	expect(say("cp: cannot stat '/x': No such file or directory")).toBe(
		"cp: cannot stat '/x': No such file or directory",
	);
	expect(say(null)).toBe("");
	expect(say("")).toBe("");
	const inner = MESSAGES.noApp("fd");
	expect(match(inner)?.id).toBe("noApp");
	// In English the wording is the same, so a nested sentence reads back unchanged.
	const outer = MESSAGES.lastTryFailed(inner);
	expect(say(outer)).toBe(outer);
});

test("a long tool output that is no engine sentence is turned away quickly, not backtracked over", () => {
	// Separators of several templates, many times over: the bare patterns took about two seconds on this.
	const junk = Array.from({ length: 400 }, (_, i) => `line ${i}: error: entry ${i} needs x (y) -> `).join("\n");
	const started = performance.now();
	expect(say(junk)).toBe(junk);
	expect(performance.now() - started).toBeLessThan(250);
});

test("of two templates that fit alike, the one that reads its value back as an engine sentence wins", () => {
	const wrapped = MESSAGES.busySayNothingChanged(MESSAGES.noApp("fd"));
	expect(match(wrapped)).toEqual({ id: "busySayNothingChanged", values: [MESSAGES.noApp("fd")] });
	expect(match(MESSAGES.refusedNothingChanged("disk full"))).toEqual({
		id: "refusedNothingChanged",
		values: ["disk full"],
	});
});

test("a sentence nested many times over is read in bounded time", () => {
	// Uncapped, every "Could not restore" inside the value was read again: about 3 s at this size, then a stack overflow.
	const text = `${"Could not restore x: ".repeat(30000)}end`;
	const started = performance.now();
	expect(match(text)?.id).toBe("couldNotRestoreFile");
	expect(performance.now() - started).toBeLessThan(250);
});

test("a line of several engine sentences, as Add app's why is, is read sentence by sentence", () => {
	const parts = [
		MESSAGES.matchedAsset("fd.tar.gz"),
		MESSAGES.itInstalls("fd"),
		MESSAGES.nothingInstalledAt("~/.local/bin/fd"),
	];
	expect(sentencesOf(parts.join(" "))).toEqual(parts);
	// A sentence with a full stop inside is one template, not two.
	expect(sentencesOf(MESSAGES.refusedNothingChanged("disk full"))).toEqual([
		MESSAGES.refusedNothingChanged("disk full"),
	]);
	// Text no template starts is left whole.
	expect(sentencesOf("cp: cannot stat. No such file")).toEqual(["cp: cannot stat. No such file"]);
	expect(say(parts.join(" "))).toBe(parts.join(" "));
});
