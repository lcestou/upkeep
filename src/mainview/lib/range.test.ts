import { describe, expect, test } from "bun:test";
import { rangeClicks } from "./range";

const ids = ["a", "b", "c", "d", "e"];

describe("rangeClicks", () => {
	test("a plain click changes only its own row", () => {
		const span = rangeClicks();
		expect(span(ids, "b", false)).toEqual(["b"]);
		expect(span(ids, "d", false)).toEqual(["d"]);
	});

	test("a Shift-click reaches back to the last click, downward or upward", () => {
		const span = rangeClicks();
		span(ids, "b", false);
		expect(span(ids, "d", true)).toEqual(["b", "c", "d"]);
		expect(span(ids, "a", true)).toEqual(["a", "b", "c", "d"]);
	});

	test("a first Shift-click, or one whose earlier row left the list, changes only its own row", () => {
		const span = rangeClicks();
		expect(span(ids, "c", true)).toEqual(["c"]);
		expect(span(["a", "b", "d"], "a", true)).toEqual(["a"]);
	});

	test("each keeper remembers its own list", () => {
		const one = rangeClicks();
		const two = rangeClicks();
		one(ids, "a", false);
		expect(two(ids, "e", true)).toEqual(["e"]);
	});
});
