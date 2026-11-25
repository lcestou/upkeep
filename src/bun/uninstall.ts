import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { removeMenuFiles } from "../engine/menu";
import type { Paths } from "../engine/paths";
import { loadState } from "../engine/store";
import { removeMenuEntry, syncAutostart } from "./autostart";
import { syncCommand } from "./command";
import { SELF_FILES } from "./self-shim";

// Upkeep's own uninstall. The framework's uninstaller removes the app folder and itself, but not what Upkeep writes
// for itself: the login entry, the menu entry it rewrote, the upkeep command, the menu entries it wrote for
// AppImages, the start script and the copies a self-update keeps. This removes those first, then hands the rest to a detached shell that waits for Upkeep to quit.

/** An install root Upkeep will hand to rm: absolute and made of plain characters only (…/dev.afk.upkeep/stable). */
const ROOT = /^\/[A-Za-z0-9._/+@-]+\/[A-Za-z0-9._+@-]+\/[A-Za-z0-9._+@-]+$/;

/**
 * The detached finish: wait for Upkeep's process ($1) to end, for at most a minute, run the framework's uninstaller,
 * then remove what is left of the install folder (the start script, the self-update's copies and markers, the web
 * view's cache) and its emptied parent, then any data folder passed after the pid. $0 is the root, checked by
 * uninstallUpkeep.
 */
export const FINISH =
	`p=$1; shift; i=0; while kill -0 "$p" 2>/dev/null && [ $i -lt 120 ]; do sleep 0.5; i=$((i+1)); done; ` +
	`[ -x "$0/uninstall" ] && "$0/uninstall" --quiet; ` +
	`rm -rf "$0"; rmdir "$(dirname "$0")" 2>/dev/null; ` +
	`for d in "$@"; do rm -rf "$d"; done`;

/**
 * Starts the finish outside Upkeep's own process group and cgroup, so it outlives the quit: as a transient systemd
 * user unit where there is a user manager (a service manager that stops Upkeep's unit would kill a mere child), else
 * in a new session. $1 is the finish; the rest are its arguments.
 */
export const LAUNCH =
	'f=$1; shift; systemd-run --user --collect --quiet -- sh -c "$f" "$@" 2>/dev/null || setsid -f sh -c "$f" "$@"';

export type UninstallCtx = {
	/** The install root, …/dev.afk.upkeep/stable. */
	root: string;
	/** <root>/app/bin/launcher; anything else is not an install this can remove. */
	launcher: string;
	/** The menu entry the installer wrote and Upkeep rewrote. */
	menu: string;
	/** Where the installer may have put its desktop shortcut; each goes only when it starts Upkeep's own launcher. */
	shortcuts: string[];
	/** Upkeep's own process, which the finish waits out before it deletes anything. */
	pid: number;
	paths: Paths;
	/** Also delete settings, the app list, history, restore points and the cache. */
	purge: boolean;
	spawnDetached: (argv: string[]) => void;
};

/**
 * The desktop shortcut the installer writes, Upkeep.desktop: in the desktop folder the person's user-dirs.dirs names
 * (a translated one, ~/Escritorio) and in ~/Desktop, which the installer may use whatever the system calls it. A
 * user-dirs.dirs that cannot be read, or that names a relative path, leaves ~/Desktop alone.
 */
export function desktopShortcuts(home: string, configHome: string): string[] {
	const dirs = [join(home, "Desktop")];
	try {
		const named = /^XDG_DESKTOP_DIR="([^"]+)"/m.exec(readFileSync(join(configHome, "user-dirs.dirs"), "utf8"))?.[1];
		const dir = named?.replace(/^\$HOME(?=\/|$)/, home);
		// A relative path would land wherever Upkeep runs from: only an absolute one names a folder.
		if (dir?.startsWith("/")) dirs.unshift(dir);
	} catch {
		// no user-dirs.dirs: ~/Desktop only
	}
	return [...new Set(dirs)].map((d) => join(d, "Upkeep.desktop"));
}

/** A data folder purge may delete: Upkeep's own, named upkeep, inside home. */
const ownData = (p: string, home: string) => p.startsWith(`${home}/`) && p.endsWith("/upkeep");

/**
 * Removes the login entry, the menu entry, the upkeep command and the menu entries written for AppImages where they
 * are Upkeep's own, then starts the
 * detached finish. A root that is not a plain <XDG data>/<identifier>/<channel> path under home, holding the
 * launcher, is refused before anything is touched, since the finish deletes inside it. Returns false when refused; the caller quits Upkeep after true.
 */
export function uninstallUpkeep(c: UninstallCtx): boolean {
	const home = c.paths.home;
	// The framework installs to <XDG data>/<identifier>/<channel>: nothing else is handed to rm.
	if (
		!ROOT.test(c.root) ||
		dirname(dirname(c.root)) !== dirname(c.paths.data) ||
		!c.root.startsWith(`${home}/`) ||
		c.launcher !== join(c.root, "app", "bin", "launcher")
	)
		return false;
	syncAutostart(c.paths.config, false, c.launcher, "");
	removeMenuEntry(c.menu, c.launcher, SELF_FILES.shim);
	for (const s of c.shortcuts) removeMenuEntry(s, c.launcher, SELF_FILES.shim);
	syncCommand(home, false, c.root);
	// The menu entries and icons Upkeep wrote for AppImages go too; the AppImages themselves stay.
	for (const files of Object.values(loadState(c.paths).menu)) removeMenuFiles(files, c.paths);
	const data = c.purge
		? [c.paths.config, c.paths.state, c.paths.cache, c.paths.data].filter((p) => ownData(p, home))
		: [];
	c.spawnDetached(["sh", "-c", LAUNCH, "upkeep-uninstall", FINISH, c.root, String(c.pid), ...data]);
	return true;
}
