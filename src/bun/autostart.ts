import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Where the desktop session looks for programs to start at login. `configDir` is Upkeep's own config directory. */
export function autostartFile(configDir: string): string {
	return join(dirname(configDir), "autostart", "upkeep.desktop");
}

/**
 * The login entry. Background mode travels as an environment variable because the framework's
 * launcher drops command-line arguments on Linux.
 */
export function autostartEntry(launcher: string, icon: string): string {
	return [
		"[Desktop Entry]",
		"Type=Application",
		"Name=Upkeep",
		"Comment=Check app updates at login and stay in the tray",
		`Exec=env UPKEEP_BACKGROUND=1 "${launcher}"`,
		`Icon=${icon}`,
		"Terminal=false",
		"StartupWMClass=Upkeep",
		"X-GNOME-Autostart-enabled=true",
		// Mint's own login entries wait 20 to 40 s; the network and the tray host should be up first.
		"X-GNOME-Autostart-Delay=45",
		"",
	].join("\n");
}

/** Makes the login entry match the setting. Returns true when the file was written or removed. */
export function syncAutostart(configDir: string, on: boolean, launcher: string, icon: string): boolean {
	const file = autostartFile(configDir);
	if (!on) {
		if (!existsSync(file)) return false;
		rmSync(file);
		return true;
	}
	const wanted = autostartEntry(launcher, icon);
	if (existsSync(file) && readFileSync(file, "utf8") === wanted) return false;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, wanted);
	return true;
}
