import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { elfNeeds, versionAbove } from "./elf";
import { elfFile, type ElfFixture, tempHome } from "./testkit";

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("elf");
});
afterEach(() => t.cleanup());

/** elfNeeds of a crafted file written into the test's temp dir. */
function read(f: ElfFixture | Uint8Array) {
	const file = join(t.dir, "prog");
	writeFileSync(file, f instanceof Uint8Array ? f : elfFile(f));
	return elfNeeds(file);
}

const full: ElfFixture = {
	interp: "/lib64/ld-linux-x86-64.so.2",
	versions: ["GLIBC_2.2.5", "GLIBC_2.39", "GLIBC_2.4", "GLIBC_PRIVATE", "GLIBC_ABI_DT_RELR"],
	isa: 0b0101,
};

test("reads the loader, the highest glibc and the ISA level of a 64-bit little-endian program", () => {
	expect(read(full)).toEqual({ glibc: "2.39", x86Level: 3, interp: "/lib64/ld-linux-x86-64.so.2" });
});

test("reads a 32-bit big-endian program the same way", () => {
	expect(read({ ...full, wide: false, little: false })).toEqual({
		glibc: "2.39",
		x86Level: 3,
		interp: "/lib64/ld-linux-x86-64.so.2",
	});
});

test("finds the ISA note in a plain note segment, and reads it only for x86-64", () => {
	expect(read({ isa: 0b1111, plainNote: true })?.x86Level).toBe(4);
	expect(read({ isa: 0b1111, machine: 183 })?.x86Level).toBeNull();
});

test("a static program needs nothing, and a program with no sections gives no glibc", () => {
	expect(read({})).toEqual({ glibc: null, x86Level: null, interp: null });
	expect(read({ interp: "/lib/ld-musl-x86_64.so.1" })).toEqual({
		glibc: null,
		x86Level: null,
		interp: "/lib/ld-musl-x86_64.so.1",
	});
});

test("a file that is not ELF, is cut short or is missing reads as nothing", () => {
	expect(read(new TextEncoder().encode("#!/bin/sh\necho hi\n"))).toBeNull();
	expect(read(elfFile(full).slice(0, 600))).toBeNull();
	expect(elfNeeds(join(t.dir, "absent"))).toBeNull();
});

test("versions compare part by part as numbers", () => {
	expect(versionAbove("2.39", "2.4")).toBe(true);
	expect(versionAbove("2.4", "2.39")).toBe(false);
	expect(versionAbove("2.35", "2.35")).toBe(false);
	expect(versionAbove("2.35.1", "2.35")).toBe(true);
});
