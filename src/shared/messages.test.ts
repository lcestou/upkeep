import { expect, test } from "bun:test";
import { MESSAGES, type Value } from "./messages";

const templates: Record<string, (...values: Value[]) => string> = MESSAGES;

test("every template fills each value it takes and leaves nothing undefined", () => {
	const ids = Object.keys(templates);
	expect(ids.length).toBeGreaterThan(0);
	for (const id of ids) {
		const template = templates[id];
		if (!template) throw new Error(`no template ${id}`);
		// Distinct markers, so a value written twice or dropped shows; one number, since a count or status can be one.
		const values: Value[] = Array.from({ length: template.length }, (_, i) => (i === 0 ? 900 : `<${id}:${i}>`));
		const text = template(...values);
		expect(text.trim(), id).not.toBe("");
		expect(text, id).not.toContain("undefined");
		for (const v of values) expect(text, `${id} keeps ${v}`).toContain(String(v));
	}
});
