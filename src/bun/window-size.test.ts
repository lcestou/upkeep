import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SIZE, loadWindowSize, saveWindowSize } from "./window-size";

const dirs: string[] = [];
function file(): string {
	const dir = mkdtempSync(join(tmpdir(), "upkeep-window-"));
	dirs.push(dir);
	return join(dir, "state", "window.json");
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("no file, or a file that is not a size, gives the default", () => {
	const f = file();
	expect(loadWindowSize(f)).toEqual(DEFAULT_SIZE);
	saveWindowSize(f, { width: 1200, height: 800 });
	writeFileSync(f, "not json");
	expect(loadWindowSize(f)).toEqual(DEFAULT_SIZE);
	writeFileSync(f, '{"width":"wide","height":800}');
	expect(loadWindowSize(f)).toEqual(DEFAULT_SIZE);
	writeFileSync(f, "null");
	expect(loadWindowSize(f)).toEqual(DEFAULT_SIZE);
});

test("a saved size comes back, rounded", () => {
	const f = file();
	saveWindowSize(f, { width: 1234.4, height: 801.6 });
	expect(loadWindowSize(f)).toEqual({ width: 1234, height: 802 });
});

test("a size outside what the layout supports is pulled back in", () => {
	const f = file();
	saveWindowSize(f, { width: 200, height: 100 });
	expect(loadWindowSize(f)).toEqual({ width: 760, height: 520 });
	saveWindowSize(f, { width: 99999, height: 99999 });
	expect(loadWindowSize(f)).toEqual({ width: 3840, height: 2160 });
});
