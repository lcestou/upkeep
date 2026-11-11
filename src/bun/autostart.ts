import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Where the desktop session looks for programs to start at login. `configDir` is Upkeep's own config directory. */
export function autostartFile(configDir: string): string {
	return join(dirname(configDir), "autostart", "upkeep.desktop");
}

// Marks a file as Upkeep's own. A login entry without it was written by the owner and is left alone.
const MARK = "X-Upkeep-Managed=true";

/** Desktop Entry spec: escape for a quoted Exec argument, then for a string value; % starts a field code. */
const execArg = (s: string) => `"${s.replace(/[\\"`$]/g, "\\$&")}"`.replaceAll("\\", "\\\\").replaceAll("%", "%%");

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
		`Exec=env UPKEEP_BACKGROUND=1 ${execArg(launcher)}`,
		`Icon=${icon}`,
		"Terminal=false",
		"StartupWMClass=Upkeep",
		"X-GNOME-Autostart-enabled=true",
		// Mint's own login entries wait 20 to 40 s; the network and the tray host should be up first.
		"X-GNOME-Autostart-Delay=45",
		MARK,
		"",
	].join("\n");
}

/** Makes the login entry match the setting. Returns true when the file was written or removed. */
export function syncAutostart(configDir: string, on: boolean, launcher: string, icon: string): boolean {
	const file = autostartFile(configDir);
	const current = existsSync(file) ? readFileSync(file, "utf8") : null;
	// A file Upkeep did not write is the owner's: it is never rewritten or removed.
	if (current !== null && !current.includes(MARK)) return false;
	if (!on) {
		if (current === null) return false;
		rmSync(file);
		return true;
	}
	const wanted = autostartEntry(launcher, icon);
	if (current === wanted) return false;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, wanted);
	return true;
}
