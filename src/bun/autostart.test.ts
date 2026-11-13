import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autostartEntry, autostartFile, syncAutostart, syncMenuExec } from "./autostart";
import { entryArgv } from "./self-shim";

const dirs: string[] = [];
function configDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "upkeep-autostart-"));
	dirs.push(dir);
	return join(dir, ".config", "upkeep");
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("the entry sits beside Upkeep's config directory, under autostart", () => {
	expect(autostartFile("/h/.config/upkeep")).toBe("/h/.config/autostart/upkeep.desktop");
});

test("the entry starts the launcher in background mode through the environment", () => {
	const text = autostartEntry("/h/.local/share/dev.afk.upkeep/stable/app/bin/launcher", "/h/icon.png");
	expect(text).toContain('Exec=env UPKEEP_BACKGROUND=1 "/h/.local/share/dev.afk.upkeep/stable/app/bin/launcher"\n');
	expect(text).toContain("X-Upkeep-Managed=true\n");
	// A path with characters the Desktop Entry spec reserves is escaped for the quoted argument and then for the value.
	expect(autostartEntry('/x/a"b$c`d\\e%f', "/i")).toContain(
		'Exec=env UPKEEP_BACKGROUND=1 "/x/a\\\\"b\\\\$c\\\\`d\\\\\\\\e%%f"\n',
	);
	expect(text).toContain("Icon=/h/icon.png\n");
	expect(text).toContain("X-GNOME-Autostart-Delay=45\n");
	expect(text.startsWith("[Desktop Entry]\n")).toBe(true);
});

test("on writes the file once, off removes it, and neither repeats work", () => {
	const dir = configDir();
	const file = autostartFile(dir);
	expect(syncAutostart(dir, false, "/l", "/i")).toBe(false);
	expect(syncAutostart(dir, true, "/l", "/i")).toBe(true);
	expect(readFileSync(file, "utf8")).toBe(autostartEntry("/l", "/i"));
	expect(syncAutostart(dir, true, "/l", "/i")).toBe(false);
	// A moved install rewrites the entry.
	expect(syncAutostart(dir, true, "/elsewhere", "/i")).toBe(true);
	expect(readFileSync(file, "utf8")).toContain('"/elsewhere"');
	expect(syncAutostart(dir, false, "/l", "/i")).toBe(true);
	expect(existsSync(file)).toBe(false);
});

test("a login entry the owner wrote by hand is never rewritten or removed", () => {
	const dir = configDir();
	const file = autostartFile(dir);
	mkdirSync(join(dir, "..", "autostart"), { recursive: true });
	writeFileSync(file, "[Desktop Entry]\nExec=my-own-launcher\n");
	expect(syncAutostart(dir, false, "/l", "/i")).toBe(false);
	expect(syncAutostart(dir, true, "/l", "/i")).toBe(false);
	expect(readFileSync(file, "utf8")).toBe("[Desktop Entry]\nExec=my-own-launcher\n");
});

test("an entry can start Upkeep through the start script, and what it writes runs with odd paths", () => {
	const dir = configDir();
	mkdirSync(dir, { recursive: true });
	const root = join(dir, 'a "quoted" $root `x`');
	const argv = entryArgv(root);
	const text = autostartEntry(argv, "/i");
	const exec = text.split("\n").find((l) => l.startsWith("Exec=")) ?? "";
	expect(exec.startsWith('Exec=env UPKEEP_BACKGROUND=1 "sh" "-c" "')).toBe(true);
	// Undo the two escapes a desktop entry applies, then let a shell read the line as the session would.
	const line = exec.slice("Exec=".length).replaceAll("%%", "%").replaceAll("\\\\", "\\");
	mkdirSync(join(root, "app", "bin"), { recursive: true });
	const log = join(dir, "started");
	writeFileSync(join(root, "app", "bin", "launcher"), `#!/bin/sh\necho "bg=$UPKEEP_BACKGROUND" >> "${log}"\n`, {
		mode: 0o755,
	});
	expect(Bun.spawnSync(["sh", "-c", line]).exitCode).toBe(0);
	expect(readFileSync(log, "utf8")).toBe("bg=1\n");
});

test("a menu entry's own Exec line is replaced once; the person's line, other sections and line endings are left alone", () => {
	const dir = configDir();
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "Upkeep.desktop");
	const launcher = "/h/stable/app/bin/launcher";
	const sync = (command: string[]) => syncMenuExec(file, command, launcher, "upkeep-start.sh");
	expect(sync(["sh", "-c", "x"])).toBe(false);
	// As the installer writes it: the line starts this install's launcher.
	writeFileSync(file, `[Desktop Entry]\nName=Upkeep\nExec=${launcher}\nIcon=/i\n`);
	expect(sync(["sh", "-c", 'echo "$0" upkeep-start.sh', "/root dir"])).toBe(true);
	const mine = 'Exec="sh" "-c" "echo \\\\"\\\\$0\\\\" upkeep-start.sh" "/root dir"';
	expect(readFileSync(file, "utf8")).toBe(`[Desktop Entry]\nName=Upkeep\n${mine}\nIcon=/i\n`);
	expect(sync(["sh", "-c", 'echo "$0" upkeep-start.sh', "/root dir"])).toBe(false);
	// A line that already runs the start script is Upkeep's too, and follows a moved install.
	expect(sync(["sh", "-c", "upkeep-start.sh", "/moved"])).toBe(true);

	// A line the person wrote themselves is never replaced, even when it wraps this install's launcher or
	// mentions the start script.
	for (const exec of [
		"env GDK_SCALE=2 /opt/my-upkeep-wrapper",
		`env GDK_SCALE=2 "${launcher}"`,
		`${launcher} --flag`,
		"/opt/run-upkeep-start.sh",
	]) {
		const theirs = `[Desktop Entry]\nName=Upkeep\nExec=${exec}\n`;
		writeFileSync(file, theirs);
		expect(sync(["sh"]), exec).toBe(false);
		expect(readFileSync(file, "utf8")).toBe(theirs);
	}
	// The installer quotes the path; both spellings are its line.
	writeFileSync(file, `[Desktop Entry]\nExec="${launcher}"\n`);
	expect(sync(["sh"])).toBe(true);

	// Only the main section's line: an action listed first keeps its own command.
	writeFileSync(
		file,
		`[Desktop Action Check]\nExec=${launcher} --check\n\n[Desktop Entry]\nName=Upkeep\nExec=${launcher}\n`,
	);
	expect(sync(["sh", "x"])).toBe(true);
	expect(readFileSync(file, "utf8")).toBe(
		`[Desktop Action Check]\nExec=${launcher} --check\n\n[Desktop Entry]\nName=Upkeep\nExec="sh" "x"\n`,
	);

	// Windows line endings stay as they were, on the changed line too.
	writeFileSync(file, `[Desktop Entry]\r\nName=Upkeep\r\nExec=${launcher}\r\nIcon=/i\r\n`);
	expect(sync(["sh"])).toBe(true);
	expect(readFileSync(file, "utf8")).toBe('[Desktop Entry]\r\nName=Upkeep\r\nExec="sh"\r\nIcon=/i\r\n');

	writeFileSync(file, "[Desktop Entry]\nName=Upkeep\n");
	expect(sync(["sh"])).toBe(false);
});
