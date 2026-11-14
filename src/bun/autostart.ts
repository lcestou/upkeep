import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LANGUAGES } from "../shared/languages";
import { TRAY_TEXT } from "./tray-text";

/** Where the desktop session looks for programs to start at login. `configDir` is Upkeep's own config directory. */
export function autostartFile(configDir: string): string {
	return join(dirname(configDir), "autostart", "upkeep.desktop");
}

// Marks a file as Upkeep's own. A login entry without it was written by the owner and is left alone.
const MARK = "X-Upkeep-Managed=true";

/** Desktop Entry spec: escape for a quoted Exec argument, then for a string value; % starts a field code. */
const execArg = (s: string) => `"${s.replace(/[\\"`$]/g, "\\$&")}"`.replaceAll("\\", "\\\\").replaceAll("%", "%%");

/** An Exec line's command from an argument list, each argument quoted for a desktop entry. */
export const execLine = (argv: string[]) => argv.map(execArg).join(" ");

/**
 * The login entry. Background mode travels as an environment variable because the framework's
 * launcher drops command-line arguments on Linux. The Comment carries every interface language.
 * `command` is what starts Upkeep: its launcher, or the start script's argument list.
 */
export function autostartEntry(command: string | string[], icon: string): string {
	return [
		"[Desktop Entry]",
		"Type=Application",
		"Name=Upkeep",
		`Comment=${TRAY_TEXT.en.loginComment}`,
		// The desktop shows the Comment in the person's own language, whichever Upkeep shows.
		...LANGUAGES.filter((l) => l.code !== "en").map((l) => `Comment[${l.code}]=${TRAY_TEXT[l.code].loginComment}`),
		`Exec=env UPKEEP_BACKGROUND=1 ${execLine(Array.isArray(command) ? command : [command])}`,
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

/** The index of the [Desktop Entry] section's Exec line among a desktop file's lines, or -1 when it has none. */
function execLineOf(lines: string[]): number {
	let section = "";
	return lines.findIndex((raw) => {
		const line = raw.trimEnd();
		if (line.startsWith("[")) section = line;
		return section === "[Desktop Entry]" && line.startsWith("Exec=");
	});
}

/**
 * True for an Exec line that is Upkeep's own: the line the installer wrote (the launcher alone, bare or quoted) or one
 * Upkeep wrote before (a shell line that runs the start script). A wrapper the person put around the launcher is theirs.
 */
function upkeepsExec(line: string, launcher: string, script: string): boolean {
	const value = line.trimEnd().slice("Exec=".length);
	const installers = value === launcher || value === `"${launcher}"` || value === execLine([launcher]);
	return installers || (value.startsWith('"sh" "-c" ') && value.includes(script));
}

/**
 * Deletes the menu entry when its Exec line is Upkeep's own, for an uninstall. A menu entry the person changed to run
 * something else is left. Returns true when the file was removed.
 */
export function removeMenuEntry(file: string, launcher: string, script: string): boolean {
	let text = "";
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return false;
	}
	const line = text.split("\n")[execLineOf(text.split("\n"))];
	if (line === undefined || !upkeepsExec(line, launcher, script)) return false;
	rmSync(file);
	return true;
}

/**
 * Makes a menu entry start Upkeep through `command`. Only the Exec line of the [Desktop Entry] section is replaced,
 * and only when it is Upkeep's own: the line the installer wrote, which is `launcher` and nothing else, or a line
 * Upkeep wrote before, which runs `script` through sh. A line the person wrote themselves, even one that wraps the
 * launcher, a file that is not there, and a file with no such line are left alone. Line endings
 * are kept as they were. Returns true when the file was written.
 */
export function syncMenuExec(file: string, command: string[], launcher: string, script: string): boolean {
	let text = "";
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return false;
	}
	const lines = text.split("\n");
	const at = execLineOf(lines);
	const current = lines[at];
	if (current === undefined) return false;
	if (!upkeepsExec(current, launcher, script)) return false;
	const wanted = `Exec=${execLine(command)}${current.endsWith("\r") ? "\r" : ""}`;
	if (current === wanted) return false;
	lines[at] = wanted;
	writeFileSync(file, lines.join("\n"));
	return true;
}

/** Makes the login entry match the setting. Returns true when the file was written or removed. */
export function syncAutostart(configDir: string, on: boolean, launcher: string | string[], icon: string): boolean {
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
