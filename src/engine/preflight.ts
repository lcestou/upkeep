import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MESSAGES } from "../shared/messages";
import { elfNeeds, versionAbove } from "./elf";
import type { Run } from "./run";

/** The cpuinfo flags each x86-64 level past the baseline adds, as the psABI lists them (abm is Linux's lzcnt). */
const LEVEL_FLAGS: [number, string[]][] = [
	[2, ["cx16", "lahf_lm", "popcnt", "sse4_1", "sse4_2", "ssse3"]],
	[3, ["avx", "avx2", "bmi1", "bmi2", "f16c", "fma", "abm", "movbe", "xsave"]],
	[4, ["avx512f", "avx512bw", "avx512cd", "avx512dq", "avx512vl"]],
];

/**
 * The x86-64 level this CPU reaches, from the first processor's flags in procRoot's cpuinfo: each level needs every
 * flag of the ones below it too. Null when there is no cpuinfo or no flags line, as on an ARM machine.
 */
export function cpuLevel(procRoot = "/proc"): number | null {
	let text: string;
	try {
		text = readFileSync(join(procRoot, "cpuinfo"), "utf8");
	} catch {
		return null;
	}
	const line = /^flags\s*:(.*)$/m.exec(text)?.[1];
	if (line === undefined) return null;
	const flags = new Set(line.trim().split(/\s+/));
	let level = 1;
	for (const [next, need] of LEVEL_FLAGS) {
		if (!need.every((f) => flags.has(f))) break;
		level = next;
	}
	return level;
}

/** This system's glibc version from `getconf GNU_LIBC_VERSION` ("glibc 2.39"); null on musl or when getconf fails. */
export async function hostGlibc(run: Run): Promise<string | null> {
	const r = await run(["getconf", "GNU_LIBC_VERSION"], { timeoutMs: 10_000 });
	return r.code === 0 ? (/^glibc (\d+\.\d+(?:\.\d+)?)/.exec(r.stdout.trim())?.[1] ?? null) : null;
}

/**
 * Whether the programs just downloaded can start here, before anything on disk changes: the sentence that says why not,
 * or null. A program needs its loader to exist (a musl program on a glibc system, or the reverse), no newer glibc than
 * the system's, and no higher x86-64 level than the CPU's. A file that is not ELF, or that cannot be read, passes, and
 * so does any check whose answer about this system is unknown. It reads only headers, so a program that loads a newer
 * library late, or the program inside an AppImage's squashfs, is not seen; the start check after the install stays the
 * real judge.
 */
export async function cannotRun(
	files: string[],
	app: { name: string; version: string },
	ctx: { run: Run; procRoot?: string; log: (line: string) => void },
): Promise<string | null> {
	const read = files.flatMap((file) => {
		const needs = elfNeeds(file);
		if (needs)
			ctx.log(
				`Pre-flight ${file}: loader ${needs.interp ?? "none"}, glibc ${needs.glibc ?? "none"}, x86-64 level ${needs.x86Level ?? "not stated"}`,
			);
		return needs ? [needs] : [];
	});
	const lost = read.find((n) => n.interp && !existsSync(n.interp))?.interp;
	if (lost) return MESSAGES.cannotRunLoader(app.name, app.version, lost);
	const glibcs = read.flatMap((n) => (n.glibc ? [n.glibc] : []));
	const needGlibc = glibcs.reduce<string | null>((a, b) => (a === null || versionAbove(b, a) ? b : a), null);
	const glibc = needGlibc ? await hostGlibc(ctx.run) : null;
	if (needGlibc && glibc && versionAbove(needGlibc, glibc))
		return MESSAGES.cannotRunGlibc(app.name, app.version, needGlibc, glibc);
	const needLevel = Math.max(0, ...read.map((n) => n.x86Level ?? 0));
	const level = needLevel > 1 ? cpuLevel(ctx.procRoot) : null;
	if (level && needLevel > level)
		return MESSAGES.cannotRunCpu(app.name, app.version, `x86-64-v${needLevel}`, `x86-64-v${level}`);
	return null;
}
