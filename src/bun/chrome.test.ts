import { expect, test } from "bun:test";
import type { Settings } from "../shared/types";
import { parseButtonLayout, type SystemLayout, windowChrome } from "./chrome";

const settings: Settings = {
	keepBackups: 1,
	notify: true,
	checkAtLogin: false,
	frame: "own",
	buttons: "auto",
	corners: "rounded",
};

test("button layouts as the desktop writes them", () => {
	expect(parseButtonLayout("'close,maximize,minimize:'")).toEqual({
		side: "left",
		order: ["close", "maximize", "minimize"],
	});
	expect(parseButtonLayout("':minimize,maximize,close'")).toEqual({
		side: "right",
		order: ["minimize", "maximize", "close"],
	});
	expect(parseButtonLayout("menu:minimize,close")).toEqual({ side: "right", order: ["minimize", "close"] });
	// The side with close wins when both sides hold buttons.
	expect(parseButtonLayout("close:minimize,maximize")).toEqual({ side: "left", order: ["close"] });
});

test("an unreadable layout falls back to buttons on the right", () => {
	const fallback: SystemLayout = { side: "right", order: ["minimize", "maximize", "close"] };
	expect(parseButtonLayout("")).toEqual(fallback);
	expect(parseButtonLayout("nonsense")).toEqual(fallback);
	expect(parseButtonLayout("menu:")).toEqual(fallback);
});

test("auto follows the desktop; a forced side mirrors the order so close stays at the edge", () => {
	const system = parseButtonLayout("close,maximize,minimize:");
	expect(windowChrome(settings, system, false)).toEqual({
		own: true,
		side: "left",
		order: ["close", "maximize", "minimize"],
		maximized: false,
		rounded: true,
	});
	expect(windowChrome({ ...settings, buttons: "right" }, system, true)).toEqual({
		own: true,
		side: "right",
		order: ["minimize", "maximize", "close"],
		maximized: true,
		rounded: true,
	});
	expect(windowChrome({ ...settings, frame: "system" }, system, false).own).toBe(false);
});

test("only Upkeep's own frame can be rounded", () => {
	const system = parseButtonLayout("");
	expect(windowChrome({ ...settings, corners: "square" }, system, false).rounded).toBe(false);
	expect(windowChrome({ ...settings, frame: "system" }, system, false).rounded).toBe(false);
});
