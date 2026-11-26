import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cannotRun, cpuLevel, hostGlibc } from "./preflight";
import type { ProcessResult } from "./run";
import { elfFile, type ElfFixture, ok, strictRun, tempHome } from "./testkit";

let t: ReturnType<typeof tempHome>;
let proc = "";
let lines: string[] = [];
beforeEach(() => {
	t = tempHome("preflight");
	proc = join(t.dir, "proc");
	mkdirSync(proc);
	lines = [];
});
afterEach(() => t.cleanup());

const V2 = "cx16 lahf_lm popcnt sse4_1 sse4_2 ssse3";
const V3 = `${V2} avx avx2 bmi1 bmi2 f16c fma abm movbe xsave`;
const V4 = `${V3} avx512f avx512bw avx512cd avx512dq avx512vl`;
const cpu = (flags: string) => writeFileSync(join(proc, "cpuinfo"), `processor\t: 0\nflags\t\t: fpu sse2 ${flags}\n\n`);
const glibc = (answer: ProcessResult) =>
	strictRun((argv) => (argv.join(" ") === "getconf GNU_LIBC_VERSION" ? answer : undefined));
const prog = (name: string, f: ElfFixture) => {
	const file = join(t.dir, name);
	writeFileSync(file, elfFile(f));
	return file;
};
const loader = () => {
	const file = join(t.dir, "ld.so");
	writeFileSync(file, "");
	return file;
};
const app = { name: "Bat", version: "0.25.0" };

test("the CPU level is the highest whose flags are all there", () => {
	cpu("");
	expect(cpuLevel(proc)).toBe(1);
	cpu(V2);
	expect(cpuLevel(proc)).toBe(2);
	cpu(V3);
	expect(cpuLevel(proc)).toBe(3);
	cpu(V4);
	expect(cpuLevel(proc)).toBe(4);
	cpu(`${V2} avx512f avx512bw avx512cd avx512dq avx512vl`);
	expect(cpuLevel(proc)).toBe(2);
	writeFileSync(join(proc, "cpuinfo"), "processor\t: 0\nFeatures\t: fp asimd\n");
	expect(cpuLevel(proc)).toBeNull();
	expect(cpuLevel(join(t.dir, "none"))).toBeNull();
});

test("the system's glibc comes from getconf, and musl's failure is no answer", async () => {
	expect(await hostGlibc(glibc(ok("glibc 2.35\n")).run)).toBe("2.35");
	expect(
		await hostGlibc(glibc({ code: 1, stdout: "", stderr: "Unrecognized variable", timedOut: false }).run),
	).toBeNull();
	expect(await hostGlibc(glibc(ok("something else\n")).run)).toBeNull();
});

test("a program that needs a newer glibc than the system's is refused, and an older one passes", async () => {
	const ld = loader();
	const { run } = glibc(ok("glibc 2.35\n"));
	const ctx = { run, procRoot: proc, log: (l: string) => lines.push(l) };
	const files = [
		prog("a", { interp: ld, versions: ["GLIBC_2.17"] }),
		prog("b", { interp: ld, versions: ["GLIBC_2.39"] }),
	];
	expect(await cannotRun(files, app, ctx)).toBe(
		"Bat 0.25.0 needs glibc 2.39; this system has 2.35, so nothing was installed.",
	);
	expect(lines).toEqual([
		`Pre-flight ${files[0]}: loader ${ld}, glibc 2.17, x86-64 level not stated`,
		`Pre-flight ${files[1]}: loader ${ld}, glibc 2.39, x86-64 level not stated`,
	]);
	expect(await cannotRun(files.slice(0, 1), app, ctx)).toBeNull();
});

test("a program whose loader is not on this system is refused before glibc is asked", async () => {
	const { run, calls } = glibc(ok("glibc 2.39\n"));
	const file = prog("musl", { interp: "/nonexistent/ld-musl-x86_64.so.1", versions: ["GLIBC_2.99"] });
	expect(await cannotRun([file], app, { run, log: () => {} })).toBe(
		"Bat 0.25.0 needs /nonexistent/ld-musl-x86_64.so.1, which this system does not have, so nothing was installed.",
	);
	expect(calls).toEqual([]);
});

test("a program built for a higher x86-64 level than the CPU is refused", async () => {
	cpu(V2);
	const { run, calls } = glibc(ok("glibc 2.39\n"));
	const ctx = { run, procRoot: proc, log: () => {} };
	expect(await cannotRun([prog("v3", { isa: 0b0101 })], app, ctx)).toBe(
		"Bat 0.25.0 is built for x86-64-v3; this processor is x86-64-v2, so nothing was installed.",
	);
	expect(await cannotRun([prog("v2", { isa: 0b0011 })], app, ctx)).toBeNull();
	// A static program asks nothing of glibc.
	expect(calls).toEqual([]);
});

test("what cannot be read or is not known passes", async () => {
	const { run } = glibc({ code: 127, stdout: "", stderr: "not found", timedOut: false });
	const script = join(t.dir, "script");
	writeFileSync(script, "#!/bin/sh\n");
	const files = [script, join(t.dir, "absent"), prog("new", { versions: ["GLIBC_9.0"], isa: 0b1000 })];
	// No getconf answer, no cpuinfo.
	expect(await cannotRun(files, app, { run, procRoot: join(t.dir, "noproc"), log: () => {} })).toBeNull();
	expect(await cannotRun([], app, { run, log: () => {} })).toBeNull();
});
