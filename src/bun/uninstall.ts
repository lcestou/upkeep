import { dirname, join } from "node:path";
import type { Paths } from "../engine/paths";
import { removeMenuEntry, syncAutostart } from "./autostart";
import { syncCommand } from "./command";
import { SELF_FILES } from "./self-shim";

// Upkeep's own uninstall. The framework's uninstaller removes the app folder and itself, but not what Upkeep writes
// for itself: the login entry, the menu entry it rewrote, the upkeep command, the start script and the copies a
// self-update keeps. This removes those first, then hands the rest to a detached shell that waits for Upkeep to quit.

/** An install root Upkeep will hand to rm: absolute and made of plain characters only (…/dev.afk.upkeep/stable). */
const ROOT = /^\/[A-Za-z0-9._/+@-]+\/[A-Za-z0-9._+@-]+\/[A-Za-z0-9._+@-]+$/;

/**
 * The detached finish: wait for Upkeep to quit, run the framework's uninstaller, then remove what is left of the
 * install folder (the start script, the self-update's copies and markers, the web view's cache) and its emptied parent,
 * then any data folder passed after the root. $0 is the root, checked by uninstallUpkeep; "$@" the data folders.
 */
export const FINISH =
	`sleep 3; [ -x "$0/uninstall" ] && "$0/uninstall" --quiet; ` +
	`rm -rf "$0"; rmdir "$(dirname "$0")" 2>/dev/null; ` +
	`for d in "$@"; do rm -rf "$d"; done`;

export type UninstallCtx = {
	/** The install root, …/dev.afk.upkeep/stable. */
	root: string;
	launcher: string;
	paths: Paths;
	/** Also delete settings, the app list, history, restore points and the cache. */
	purge: boolean;
	spawnDetached: (argv: string[]) => void;
};

/** A data folder purge may delete: Upkeep's own, named upkeep, inside home. */
const ownData = (p: string, home: string) => p.startsWith(`${home}/`) && p.endsWith("/upkeep");

/**
 * Removes the login entry, the menu entry and the upkeep command where they are Upkeep's own, then starts the
 * detached finish. A root that is not a plain <XDG data>/<identifier>/<channel> path under home is refused before
 * anything is touched, since the finish deletes inside it. Returns false when refused; the caller quits Upkeep after true.
 */
export function uninstallUpkeep(c: UninstallCtx): boolean {
	const home = c.paths.home;
	// The framework installs to <XDG data>/<identifier>/<channel>: nothing else is handed to rm.
	if (!ROOT.test(c.root) || dirname(dirname(c.root)) !== dirname(c.paths.data) || !c.root.startsWith(`${home}/`))
		return false;
	syncAutostart(c.paths.config, false, c.launcher, "");
	removeMenuEntry(join(dirname(c.paths.data), "applications", "Upkeep.desktop"), c.launcher, SELF_FILES.shim);
	syncCommand(home, false, c.root);
	const data = c.purge
		? [c.paths.config, c.paths.state, c.paths.cache, c.paths.data].filter((p) => ownData(p, home))
		: [];
	// setsid: its own session, so the shell outlives Upkeep's quit.
	c.spawnDetached(["setsid", "-f", "sh", "-c", FINISH, c.root, ...data]);
	return true;
}
