import { expect, test } from "bun:test";
import { probeProblem } from "./context";

test("a broken app says the line it failed on when it printed one", () => {
	expect(probeProblem("Helix", "/h/hx", { state: "broken", detail: "dlopen(): error loading libfuse.so.2" })).toBe(
		"Helix will not start (/h/hx): dlopen(): error loading libfuse.so.2",
	);
	expect(probeProblem("Helix", "/h/hx", { state: "broken" })).toBe("Helix will not start (/h/hx).");
	expect(probeProblem("Helix", "/h/hx", { state: "unknown", detail: "odd" })).toBe("Version probe failed: odd");
});
