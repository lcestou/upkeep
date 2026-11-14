import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths, type Paths } from "../engine/paths";
import { script } from "../engine/testkit";
import { autostartFile, syncAutostart } from "./autostart";
import { commandFile, syncCommand } from "./command";
import { entryArgv, SELF_FILES } from "./self-shim";
import { FINISH, uninstallUpkeep } from "./uninstall";

let dir = "";
let p: Paths;
let root = "";
let launcher = "";
let menu = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "upkeep-uninstall-"));
	// Every XDG folder under home, as on a real desktop.
	p = paths({ HOME: join(dir, "home") });
	root = join(p.home, ".local/share/dev.afk.upkeep/stable");
	launcher = join(root, "app/bin/launcher");
	script(launcher, "exit 0");
	// The framework's uninstaller, faked: it removes the app folder and itself, as the real one does.
	script(join(root, "uninstall"), `rm -rf "$(dirname "$0")/app" "$0"; echo ran > "${join(dir, "uninstalled")}"`);
	// Whatever else lives beside the app: the start script, a self-update's files, a start test's marker.
	for (const f of [SELF_FILES.shim, SELF_FILES.attempt, ".upkeep-ok-abc123"]) writeFileSync(join(root, f), "x");
	mkdirSync(join(root, "WebKit/cache"), { recursive: true });
	mkdirSync(join(root, SELF_FILES.keep), { recursive: true });
	syncAutostart(p.config, true, entryArgv(root), "/i");
	menu = join(dirname(p.data), "applications", "Upkeep.desktop");
	mkdirSync(dirname(menu), { recursive: true });
	writeFileSync(menu, `[Desktop Entry]\nName=Upkeep\nExec=${launcher}\n`);
	syncCommand(p.home, true, root);
	for (const d of [p.config, p.state, p.cache, p.data]) mkdirSync(d, { recursive: true });
	writeFileSync(join(p.config, "apps.toml"), "");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Runs the detached finish at once, without its wait for Upkeep to quit. */
const now = (argv: string[]) => {
	expect(argv.slice(0, 5)).toEqual(["setsid", "-f", "sh", "-c", FINISH]);
	expect(Bun.spawnSync(["sh", "-c", FINISH.replace("sleep 3; ", ""), ...argv.slice(5)]).exitCode).toBe(0);
};

test("uninstall removes the entries, the command, the self-update's files and the install, and keeps the data", () => {
	expect(uninstallUpkeep({ root, launcher, paths: p, purge: false, spawnDetached: now })).toBe(true);
	expect(existsSync(autostartFile(p.config))).toBe(false);
	expect(existsSync(menu)).toBe(false);
	expect(existsSync(commandFile(p.home))).toBe(false);
	expect(readFileSync(join(dir, "uninstalled"), "utf8")).toBe("ran\n");
	expect(existsSync(dirname(root))).toBe(false);
	// Settings, the list, history and restore points stay for a later install.
	expect(existsSync(join(p.config, "apps.toml"))).toBe(true);
	expect(existsSync(p.data)).toBe(true);
});

test("uninstall with purge also deletes Upkeep's own data folders, and nothing else in home", () => {
	writeFileSync(join(p.home, "keep.txt"), "mine");
	expect(uninstallUpkeep({ root, launcher, paths: p, purge: true, spawnDetached: now })).toBe(true);
	for (const d of [p.config, p.state, p.cache, p.data]) expect(existsSync(d)).toBe(false);
	expect(readFileSync(join(p.home, "keep.txt"), "utf8")).toBe("mine");
});

test("a menu entry the person changed stays; a root outside home or not a plain path is refused before anything", () => {
	writeFileSync(menu, "[Desktop Entry]\nName=Upkeep\nExec=my-wrapper --upkeep\n");
	expect(uninstallUpkeep({ root, launcher, paths: p, purge: false, spawnDetached: now })).toBe(true);
	expect(existsSync(menu)).toBe(true);
	const ran: string[][] = [];
	for (const bad of ["/opt/upkeep/stable", join(p.home, "a b/c/d"), join(p.home, "x")]) {
		expect(uninstallUpkeep({ root: bad, launcher, paths: p, purge: true, spawnDetached: (a) => ran.push(a) })).toBe(
			false,
		);
	}
	expect(ran).toEqual([]);
	expect(existsSync(p.config)).toBe(true);
});
