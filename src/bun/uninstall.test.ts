import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths, type Paths } from "../engine/paths";
import { script } from "../engine/testkit";
import { autostartFile, syncAutostart } from "./autostart";
import { commandFile, syncCommand } from "./command";
import { entryArgv, SELF_FILES } from "./self-shim";
import { desktopShortcuts, FINISH, LAUNCH, uninstallUpkeep } from "./uninstall";

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

/** A pid no process has: the finish has nothing to wait out. */
const GONE = Bun.spawnSync(["sh", "-c", "echo $$"]).stdout.toString().trim();
/** The context a real uninstall gets, around this test's install. */
const ctx = (purge: boolean, spawnDetached: (argv: string[]) => void) => ({
	root,
	launcher,
	menu,
	shortcuts: desktopShortcuts(p.home, dirname(p.config)),
	pid: Number(GONE),
	paths: p,
	purge,
	spawnDetached,
});

/** Runs the detached finish at once, in the foreground. */
const now = (argv: string[]) => {
	expect(argv.slice(0, 5)).toEqual(["sh", "-c", LAUNCH, "upkeep-uninstall", FINISH]);
	expect(Bun.spawnSync(["sh", "-c", FINISH, ...argv.slice(5)]).exitCode).toBe(0);
};

test("uninstall removes the entries, the command, the self-update's files and the install, and keeps the data", () => {
	expect(uninstallUpkeep(ctx(false, now))).toBe(true);
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
	expect(uninstallUpkeep(ctx(true, now))).toBe(true);
	for (const d of [p.config, p.state, p.cache, p.data]) expect(existsSync(d)).toBe(false);
	expect(readFileSync(join(p.home, "keep.txt"), "utf8")).toBe("mine");
});

test("a menu entry the person changed stays; a root outside home or not a plain path is refused before anything", () => {
	writeFileSync(menu, "[Desktop Entry]\nName=Upkeep\nExec=my-wrapper --upkeep\n");
	expect(uninstallUpkeep(ctx(false, now))).toBe(true);
	expect(existsSync(menu)).toBe(true);
	const ran: string[][] = [];
	for (const bad of ["/opt/upkeep/stable", join(p.home, "a b/c/d"), join(p.home, "x")]) {
		expect(uninstallUpkeep({ ...ctx(true, (a) => ran.push(a)), root: bad })).toBe(false);
	}
	// A launcher that is not the root's own is not an install this may remove.
	expect(uninstallUpkeep({ ...ctx(true, (a) => ran.push(a)), launcher: "/usr/bin/true" })).toBe(false);
	expect(ran).toEqual([]);
	expect(existsSync(p.config)).toBe(true);
});

test("the launch passes the finish and its arguments on whole, through whichever way it starts", () => {
	// A stand-in for both starters, on PATH ahead of the real ones: each prints what it would run.
	const bin = join(dir, "bin");
	script(join(bin, "systemd-run"), "exit 1");
	script(join(bin, "setsid"), 'shift; printf "%s|" "$@"');
	const r = Bun.spawnSync(["sh", "-c", LAUNCH, "upkeep-uninstall", "the finish", "/r o/ot", "/d"], {
		env: { PATH: `${bin}:/usr/bin:/bin` },
	});
	expect(r.stdout.toString()).toBe("sh|-c|the finish|/r o/ot|/d|");
});

test("the finish waits for Upkeep's process to end before it deletes anything", () => {
	// Not this test's own child, as Upkeep is not the finish's: init reaps it, so it does not linger as a zombie.
	const pid = Bun.spawnSync(["sh", "-c", "sleep 1.5 >/dev/null 2>&1 & echo $!"]).stdout.toString().trim();
	const t0 = Date.now();
	expect(Bun.spawnSync(["sh", "-c", FINISH, root, pid]).exitCode).toBe(0);
	expect(Date.now() - t0).toBeGreaterThan(1000);
	expect(existsSync(root)).toBe(false);
});

test("the installer's desktop shortcut goes with the install, in a translated desktop folder too; one the person made stays", () => {
	// The installer's own shortcut in ~/Desktop, and one in the desktop folder user-dirs.dirs names.
	const plain = join(p.home, "Desktop/Upkeep.desktop");
	const named = join(p.home, "Escritorio/Upkeep.desktop");
	for (const f of [plain, named]) {
		mkdirSync(dirname(f), { recursive: true });
		writeFileSync(f, `[Desktop Entry]\nName=Upkeep\nExec=${launcher}\n`);
	}
	writeFileSync(join(dirname(p.config), "user-dirs.dirs"), 'XDG_DESKTOP_DIR="$HOME/Escritorio"\n');
	expect(desktopShortcuts(p.home, dirname(p.config))).toEqual([named, plain]);
	expect(uninstallUpkeep(ctx(false, now))).toBe(true);
	expect(existsSync(plain)).toBe(false);
	expect(existsSync(named)).toBe(false);
});

test("a desktop shortcut the person made with Upkeep's name but another command stays", () => {
	const mine = join(p.home, "Desktop/Upkeep.desktop");
	mkdirSync(dirname(mine), { recursive: true });
	writeFileSync(mine, "[Desktop Entry]\nName=Upkeep\nExec=my-wrapper --upkeep\n");
	expect(uninstallUpkeep(ctx(false, now))).toBe(true);
	expect(readFileSync(mine, "utf8")).toContain("my-wrapper");
	// No user-dirs.dirs, or one naming a relative path: ~/Desktop only.
	expect(desktopShortcuts(p.home, join(dir, "nowhere"))).toEqual([mine]);
	writeFileSync(join(dirname(p.config), "user-dirs.dirs"), 'XDG_DESKTOP_DIR="Escritorio"\n');
	expect(desktopShortcuts(p.home, dirname(p.config))).toEqual([mine]);
});
