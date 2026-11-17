import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	kreadconfig,
	kwinButtons,
	lightPanel,
	onXfce,
	panelIsLight,
	themeHasDark,
	xfceLightPanel,
	xfconfQuery,
} from "./panel";

const kde = { XDG_CURRENT_DESKTOP: "KDE" };
const reads = (values: Record<string, string>) => (file: string, group: string, key: string) =>
	values[`${file}/${group}/${key}`] ?? null;

test("Plasma with the default theme follows its colour scheme", () => {
	expect(lightPanel(kde, reads({ "kdeglobals/General/ColorScheme": "BreezeLight" }))).toBe(true);
	expect(lightPanel(kde, reads({ "kdeglobals/General/ColorScheme": "BreezeDark" }))).toBe(false);
	// Nothing set: Plasma's out-of-the-box Breeze is light.
	expect(lightPanel(kde, reads({}))).toBe(true);
});

test("a Plasma theme named dark or light decides by its name", () => {
	const dark = reads({ "plasmarc/Theme/name": "breeze-dark", "kdeglobals/General/ColorScheme": "BreezeLight" });
	expect(lightPanel(kde, dark)).toBe(false);
	expect(
		lightPanel(kde, reads({ "plasmarc/Theme/name": "breeze-light", "kdeglobals/General/ColorScheme": "BreezeDark" })),
	).toBe(true);
});

test("a theme name that says neither follows the colour scheme", () => {
	expect(
		lightPanel(kde, reads({ "plasmarc/Theme/name": "breeze", "kdeglobals/General/ColorScheme": "BreezeDark" })),
	).toBe(false);
	expect(
		lightPanel(kde, reads({ "plasmarc/Theme/name": "default", "kdeglobals/General/ColorScheme": "BreezeLight" })),
	).toBe(true);
	expect(lightPanel(kde, reads({ "plasmarc/Theme/name": "oxygen" }))).toBe(true);
});

test("the colour scheme's window background decides before its name: Bazzite's dark Vapor, a light custom scheme", async () => {
	const vapor = { "plasmarc/Theme/name": "Vapor", "kdeglobals/General/ColorScheme": "Vapor" };
	expect(lightPanel(kde, reads({ ...vapor, "kdeglobals/Colors:Window/BackgroundNormal": "36,39,44" }))).toBe(false);
	expect(lightPanel(kde, reads({ ...vapor, "kdeglobals/Colors:Window/BackgroundNormal": "239,240,241" }))).toBe(true);
	// A theme named dark still wins over a light background.
	const named = { "plasmarc/Theme/name": "breeze-dark", "kdeglobals/Colors:Window/BackgroundNormal": "239,240,241" };
	expect(lightPanel(kde, reads(named))).toBe(false);
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

test("Xfce's panel is dark only with dark mode on and a theme that has a dark variant, or a theme named dark", () => {
	const greybird = (t: string) => t === "Greybird";
	// Xubuntu: Greybird, dark mode on.
	expect(xfceLightPanel("Greybird", "true", greybird)).toBe(false);
	// Debian: the "Xfce" theme has no GTK 3 dark variant, so dark mode changes nothing.
	expect(xfceLightPanel("Xfce", "true", greybird)).toBe(true);
	expect(xfceLightPanel("Greybird", "false", greybird)).toBe(true);
	expect(xfceLightPanel("Adwaita-dark", null, greybird)).toBe(false);
	expect(xfceLightPanel(null, "true", greybird)).toBe(true);
	expect(onXfce({ XDG_CURRENT_DESKTOP: "XFCE" })).toBe(true);
	expect(onXfce({ XDG_CURRENT_DESKTOP: "KDE" })).toBe(false);
});

test("a theme's dark variant is found in ~/.themes or a data folder, by gtk-3.0/gtk-dark.css", () => {
	const dir = mkdtempSync(join(tmpdir(), "upkeep-theme-"));
	try {
		mkdirSync(join(dir, "home/.themes/Mine/gtk-3.0"), { recursive: true });
		writeFileSync(join(dir, "home/.themes/Mine/gtk-3.0/gtk-dark.css"), "");
		mkdirSync(join(dir, "share/themes/Sys/gtk-3.0"), { recursive: true });
		writeFileSync(join(dir, "share/themes/Sys/gtk-3.0/gtk-dark.css"), "");
		mkdirSync(join(dir, "share/themes/Plain/gtk-3.0"), { recursive: true });
		const env = { HOME: join(dir, "home"), XDG_DATA_DIRS: join(dir, "share") };
		expect(themeHasDark(env, "Mine")).toBe(true);
		expect(themeHasDark(env, "Sys")).toBe(true);
		expect(themeHasDark(env, "Plain")).toBe(false);
		expect(themeHasDark(env, "Absent")).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("xfconfQuery answers null where there is no xfconf-query or the setting is unset", () => {
	const dir = mkdtempSync(join(tmpdir(), "upkeep-xfconf-"));
	const path = process.env.PATH;
	try {
		writeFileSync(
			join(dir, "xfconf-query"),
			'#!/bin/sh\n[ "$4" = /Net/ThemeName ] && echo Greybird && exit 0\nexit 1\n',
		);
		chmodSync(join(dir, "xfconf-query"), 0o755);
		process.env.PATH = `${dir}:${path}`;
		expect(xfconfQuery("xsettings", "/Net/ThemeName")).toBe("Greybird");
		expect(xfconfQuery("xfce4-panel", "/panels/dark-mode")).toBeNull();
		process.env.PATH = dir.concat("/nowhere");
		expect(xfconfQuery("xsettings", "/Net/ThemeName")).toBeNull();
	} finally {
		process.env.PATH = path;
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Runs fn with stub tools first on PATH: each name answers with the script body given. */
function withTools(tools: Record<string, string>, fn: (dir: string) => void) {
	const dir = mkdtempSync(join(tmpdir(), "upkeep-tools-"));
	const path = process.env.PATH;
	try {
		for (const [name, body] of Object.entries(tools)) {
			writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
			chmodSync(join(dir, name), 0o755);
		}
		process.env.PATH = `${dir}:${path}`;
		fn(dir);
	} finally {
		process.env.PATH = path;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("panelIsLight reads Xfce through xfconf-query and the theme folders, and nothing on other desktops", () => {
	withTools(
		{ "xfconf-query": 'case "$4" in /Net/ThemeName) echo Greybird;; /panels/dark-mode) echo true;; esac' },
		(dir) => {
			mkdirSync(join(dir, "share/themes/Greybird/gtk-3.0"), { recursive: true });
			const xfce = { XDG_CURRENT_DESKTOP: "XFCE", HOME: dir, XDG_DATA_DIRS: join(dir, "share") };
			// Greybird with a dark variant: a dark panel.
			writeFileSync(join(dir, "share/themes/Greybird/gtk-3.0/gtk-dark.css"), "");
			expect(panelIsLight(xfce)).toBe(false);
			// The same theme without one, as Debian's default: light.
			rmSync(join(dir, "share/themes/Greybird/gtk-3.0/gtk-dark.css"));
			expect(panelIsLight(xfce)).toBe(true);
			expect(panelIsLight({ XDG_CURRENT_DESKTOP: "X-Cinnamon" })).toBe(false);
		},
	);
});

test("kwinButtons reads both sides from kwinrc, null where unset", () => {
	withTools({ kreadconfig6: '[ "$6" = ButtonsOnLeft ] && echo XIA; exit 0' }, () => {
		expect(kwinButtons()).toEqual(["XIA", null]);
	});
});
