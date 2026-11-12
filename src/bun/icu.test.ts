import { expect, test } from "bun:test";
import { dlopen, FFIType } from "bun:ffi";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cEnv, dropStrayIcuData, holdsIcuData } from "./icu";

/** The launcher sets ICU_DATA with libc's setenv; process.env in Bun does not reach libc, so the test does the same. */
const libc = dlopen("libc.so.6", {
	setenv: { args: [FFIType.cstring, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
});
const setC = (name: string, value: string) =>
	libc.symbols.setenv(Buffer.from(`${name}\0`), Buffer.from(`${value}\0`), 1);

const dir = mkdtempSync(join(tmpdir(), "upkeep-icu-"));

test("only a folder with an ICU data file counts as ICU data", () => {
	const empty = join(dir, "bin");
	mkdirSync(empty);
	writeFileSync(join(empty, "launcher"), "");
	expect(holdsIcuData(empty)).toBe(false);
	expect(holdsIcuData(join(dir, "gone"))).toBe(false);
	const icu = join(dir, "icu");
	mkdirSync(icu);
	writeFileSync(join(icu, "icudt78l.dat"), "");
	expect(holdsIcuData(icu)).toBe(true);
	// A file named in ICU_DATA is not a folder to list.
	expect(holdsIcuData(join(icu, "icudt78l.dat"))).toBe(false);
	// A folder Upkeep cannot list may be someone's own ICU data: it is left alone.
	const locked = join(dir, "locked");
	mkdirSync(locked, { mode: 0o000 });
	expect(holdsIcuData(locked)).toBe(true);
	chmodSync(locked, 0o700);
});

test("a stray ICU_DATA is cleared where libc sees it; one that holds data, or none, is left", () => {
	// Nothing set: nothing to do.
	expect(dropStrayIcuData()).toBe(false);
	setC("ICU_DATA", join(dir, "bin"));
	expect(cEnv("ICU_DATA")).toBe(join(dir, "bin"));
	expect(dropStrayIcuData()).toBe(true);
	expect(cEnv("ICU_DATA")).toBeNull();
	expect(process.env.ICU_DATA).toBeUndefined();
	setC("ICU_DATA", join(dir, "icu"));
	expect(dropStrayIcuData()).toBe(false);
	expect(cEnv("ICU_DATA")).toBe(join(dir, "icu"));
	rmSync(dir, { recursive: true, force: true });
	// The folder is gone, so the value is stray again, and the test process is left as it found it.
	expect(dropStrayIcuData()).toBe(true);
});
