import { expect, test } from "bun:test";
import { kreadconfig, lightPanel } from "./panel";

const kde = { XDG_CURRENT_DESKTOP: "KDE" };
const reads = (values: Record<string, string>) => (file: string, group: string, key: string) =>
	values[`${file}/${group}/${key}`] ?? null;

test("Plasma with the default theme follows its colour scheme", () => {
	expect(lightPanel(kde, reads({ "kdeglobals/General/ColorScheme": "BreezeLight" }))).toBe(true);
	expect(lightPanel(kde, reads({ "kdeglobals/General/ColorScheme": "BreezeDark" }))).toBe(false);
	// Nothing set: Plasma's out-of-the-box Breeze is light.
	expect(lightPanel(kde, reads({}))).toBe(true);
});

test("a Plasma theme of its own decides by its name", () => {
	const dark = reads({ "plasmarc/Theme/name": "breeze-dark", "kdeglobals/General/ColorScheme": "BreezeLight" });
	expect(lightPanel(kde, dark)).toBe(false);
	expect(lightPanel(kde, reads({ "plasmarc/Theme/name": "oxygen" }))).toBe(true);
});

test("GNOME, Cinnamon and an unknown desktop keep the light pictures, and nothing is read", () => {
	const never = () => {
		throw new Error("read on a desktop that is not Plasma");
	};
	for (const desktop of ["ubuntu:GNOME", "X-Cinnamon", undefined])
		expect(lightPanel({ XDG_CURRENT_DESKTOP: desktop }, never)).toBe(false);
});

test("no kreadconfig answers null rather than throwing", () => {
	expect(kreadconfig("no-such-file-upkeep-test", "General", "ColorScheme")).toBeNull();
});
