/** Reads one key of a KDE config file; null when it is unset or there is no kreadconfig. */
export type KdeRead = (file: string, group: string, key: string) => string | null;

/**
 * True when the panel the tray sits on is light, so the tray needs its dark pictures. Only Plasma is read: its default
 * panel follows a light colour scheme, while GNOME's top bar and Cinnamon's default panel stay dark whatever the
 * theme, and those desktops keep the light pictures. A Plasma theme other than "default" decides by its own name;
 * "default" follows the colour scheme. A light panel on another desktop (a light Xfce panel) still gets the light set.
 */
export function lightPanel(env: Record<string, string | undefined>, read: KdeRead): boolean {
	if (!/\bKDE\b/i.test(env.XDG_CURRENT_DESKTOP ?? "")) return false;
	const theme = read("plasmarc", "Theme", "name") ?? "default";
	if (theme !== "default") return !/dark/i.test(theme);
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
