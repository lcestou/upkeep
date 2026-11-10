import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autostartEntry, autostartFile, syncAutostart } from "./autostart";

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
