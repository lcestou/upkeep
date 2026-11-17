import { existsSync } from "node:fs";
import { join } from "node:path";

/** Reads one key of a KDE config file; null when it is unset or there is no kreadconfig. */
export type KdeRead = (file: string, group: string, key: string) => string | null;

/**
 * True when the panel the tray sits on is light, so the tray needs its dark pictures. Only Plasma is read: its default
 * panel follows a light colour scheme, while GNOME's top bar and Cinnamon's default panel stay dark whatever the
 * theme, and those desktops keep the light pictures. In order: a Plasma theme named dark or light ("breeze-dark")
 * decides; else the colour scheme's window background, which the panel is drawn in (Bazzite's and SteamOS's Vapor is
 * dark though its name says nothing); else a scheme named dark; else light, Plasma's own default. Xfce is read by
 * xfceLightPanel; a light panel on another desktop (MATE, LXQt) still gets the light set.
 */
export function lightPanel(env: Record<string, string | undefined>, read: KdeRead): boolean {
	if (!onPlasma(env)) return false;
	const theme = read("plasmarc", "Theme", "name") ?? "";
	if (/dark/i.test(theme)) return false;
	if (/light/i.test(theme)) return true;
	const rgb = /^(\d+),(\d+),(\d+)/.exec(read("kdeglobals", "Colors:Window", "BackgroundNormal") ?? "");
	if (rgb) return 0.2126 * Number(rgb[1]) + 0.7152 * Number(rgb[2]) + 0.0722 * Number(rgb[3]) > 127.5;
	return !/dark/i.test(read("kdeglobals", "General", "ColorScheme") ?? "");
}

/** True on a KDE Plasma session, by XDG_CURRENT_DESKTOP. */
export const onPlasma = (env: Record<string, string | undefined>) => /\bKDE\b/i.test(env.XDG_CURRENT_DESKTOP ?? "");

/** KDE's own reader, kreadconfig6 (Plasma 6) then kreadconfig5; an empty answer counts as unset. */
export function kreadconfig(file: string, group: string, key: string): string | null {
	for (const tool of ["kreadconfig6", "kreadconfig5"]) {
		try {
			const out = Bun.spawnSync([tool, "--file", file, "--group", group, "--key", key], {
				stdin: "ignore",
				stderr: "ignore",
			});
			if (out.exitCode === 0) return out.stdout.toString().trim() || null;
		} catch {
			// Not installed: try the next one.
		}
	}
	return null;
}

/** True on an Xfce session, by XDG_CURRENT_DESKTOP. */
export const onXfce = (env: Record<string, string | undefined>) => /\bXFCE\b/i.test(env.XDG_CURRENT_DESKTOP ?? "");

/**
 * True when Xfce's panel is light. The panel takes the GTK theme's colours, and its dark mode (on by default) only
 * darkens it where the theme has a dark variant: Xubuntu's Greybird has one and its panel is dark, Debian's default
 * "Xfce" theme has none and its panel is light (both checked 2026-11-17). A theme named dark is dark either way.
 * theme is xsettings' /Net/ThemeName, darkMode xfce4-panel's /panels/dark-mode.
 */
export function xfceLightPanel(
	theme: string | null,
	darkMode: string | null,
	hasDark: (theme: string) => boolean,
): boolean {
	if (/dark/i.test(theme ?? "")) return false;
	return !(darkMode === "true" && theme !== null && hasDark(theme));
}

/** One Xfce setting through xfconf-query; null when it is unset or there is no xfconf-query. */
export function xfconfQuery(channel: string, property: string): string | null {
	try {
		// The env given explicitly, so the PATH it is looked up in is the current one.
		const out = Bun.spawnSync(["xfconf-query", "-c", channel, "-p", property], {
			env: process.env,
			stdin: "ignore",
			stderr: "ignore",
		});
		return out.exitCode === 0 ? out.stdout.toString().trim() || null : null;
	} catch {
		return null;
	}
}

/**
 * Whether a GTK theme has a dark variant, gtk-3.0/gtk-dark.css, in any of the folders GTK reads themes from: the
 * person's own (~/.themes, the data home) and the system's (XDG_DATA_DIRS, else /usr/local/share and /usr/share).
 */
export function themeHasDark(env: Record<string, string | undefined>, theme: string): boolean {
	const home = env.HOME ?? "";
	const dataHome = env.XDG_DATA_HOME || join(home, ".local/share");
	const dataDirs = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean);
	const roots = [join(home, ".themes"), ...[dataHome, ...dataDirs].map((d) => join(d, "themes"))];
	return roots.some((r) => existsSync(join(r, theme, "gtk-3.0", "gtk-dark.css")));
}
