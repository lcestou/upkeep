import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Marks the file as Upkeep's own. An `upkeep` without it belongs to someone else and is never rewritten or removed.
const MARK = "# X-Upkeep-Managed";

/** Where the `upkeep` command goes: the per-user program folder the XDG base directory spec names, ~/.local/bin. */
export function commandFile(home: string): string {
	return join(home, ".local", "bin", "upkeep");
}

/** A path as one single-quoted shell word; a quote inside it closes the word, adds an escaped quote and reopens. */
const shellWord = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * The `upkeep` script for the install at `root` (the folder that holds `app`). It runs the command line with the
 * install's own Bun. Bun reads a bunfig.toml and a .env from the folder it is started in, so a project folder could
 * slip a preload script or variables into Upkeep; `--config=/dev/null` and `--no-env-file` stop both. The path is
 * the install's fixed folder, which a self-update swaps underneath, so the script outlives every update. It does not
 * outlive the uninstaller, which knows nothing of it: it then says so and exits 127, the shell's "not found".
 */
export function commandScript(root: string): string {
	return [
		"#!/bin/sh",
		"# Upkeep's command line. Upkeep wrote this file for its 'upkeep command' setting and removes it when that is off.",
		MARK,
		`app=${shellWord(join(root, "app"))}`,
		'[ -x "$app/bin/bun" ] || { echo "upkeep: Upkeep is not installed at $app any more; remove $0" >&2; exit 127; }',
		'exec "$app/bin/bun" --config=/dev/null --no-env-file "$app/Resources/app/cli/cli.js" "$@"',
		"",
	].join("\n");
}

/**
 * Makes ~/.local/bin/upkeep match the setting for the install at `root`. A file there without Upkeep's mark is
 * someone else's (another program called upkeep, or the person's own) and is left alone whichever way the setting
 * goes, so the switch can read on while the command is not Upkeep's; the setting's hint says so. Written through a
 * temp file and a rename, so a terminal never runs half a script. Returns true when the file was written or removed.
 */
export function syncCommand(home: string, on: boolean, root: string): boolean {
	const file = commandFile(home);
	const stat = lstatSync(file, { throwIfNoEntry: false });
	// Upkeep writes a plain file, so a link (a dangling one included) or a folder there is someone else's.
	if (stat && !stat.isFile()) return false;
	const current = stat ? readFileSync(file, "utf8") : null;
	if (current !== null && !current.includes(MARK)) return false;
	if (!on) {
		if (current === null) return false;
		rmSync(file);
		return true;
	}
	const wanted = commandScript(root);
	if (current === wanted) return false;
	mkdirSync(dirname(file), { recursive: true });
	const temp = `${file}.upkeep-new`;
	writeFileSync(temp, wanted);
	chmodSync(temp, 0o755);
	renameSync(temp, file);
	return true;
}
