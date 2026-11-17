/** Reads one key of a KDE config file; null when it is unset or there is no kreadconfig. */
export type KdeRead = (file: string, group: string, key: string) => string | null;

/**
 * True when the panel the tray sits on is light, so the tray needs its dark pictures. Only Plasma is read: its default
 * panel follows a light colour scheme, while GNOME's top bar and Cinnamon's default panel stay dark whatever the
 * theme, and those desktops keep the light pictures. In order: a Plasma theme named dark or light ("breeze-dark")
 * decides; else the colour scheme's window background, which the panel is drawn in (Bazzite's and SteamOS's Vapor is
 * dark though its name says nothing); else a scheme named dark; else light, Plasma's own default. A light panel on
 * another desktop (a light Xfce panel) still gets the light set.
 */
export function lightPanel(env: Record<string, string | undefined>, read: KdeRead): boolean {
	if (!/\bKDE\b/i.test(env.XDG_CURRENT_DESKTOP ?? "")) return false;
	const theme = read("plasmarc", "Theme", "name") ?? "";
	if (/dark/i.test(theme)) return false;
	if (/light/i.test(theme)) return true;
	const rgb = /^(\d+),(\d+),(\d+)/.exec(read("kdeglobals", "Colors:Window", "BackgroundNormal") ?? "");
	if (rgb) return 0.2126 * Number(rgb[1]) + 0.7152 * Number(rgb[2]) + 0.0722 * Number(rgb[3]) > 127.5;
	return !/dark/i.test(read("kdeglobals", "General", "ColorScheme") ?? "");
}

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
