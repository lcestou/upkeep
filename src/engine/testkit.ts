import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Paths, paths } from "./paths";
import { FWUPD_UPDATES } from "./extras/firmware";
import { SNAPSHOT_PROBES } from "./extras/snapshot";
import { USR_MOUNT } from "./kinds/package";
import { createRunner, type Run, type RunOpts, type ProcessResult } from "./run";

/** A temp home with every Upkeep directory under it. Tests never touch the real one. */
export function tempHome(prefix: string) {
	const dir = mkdtempSync(join(tmpdir(), `upkeep-${prefix}-`));
	const p = paths({
		HOME: join(dir, "home"),
		XDG_CONFIG_HOME: join(dir, "config"),
		XDG_STATE_HOME: join(dir, "state"),
		XDG_DATA_HOME: join(dir, "data"),
		XDG_CACHE_HOME: join(dir, "cache"),
		XDG_RUNTIME_DIR: join(dir, "run"),
	});
	mkdirSync(p.home, { recursive: true });
	return { dir, paths: p, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Writes an executable bash script. */
export function script(file: string, body: string): string {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `#!/bin/bash\n${body}\n`);
	chmodSync(file, 0o755);
	return file;
}

/** A real runner whose PATH holds only the system directories, under a temp home. */
export function realRun(p: Paths, basePath = "/usr/bin:/bin"): Run {
	return createRunner(p.home, join(p.cache, "tmp"), basePath);
}

export type Call = { argv: string[]; opts: RunOpts };

/**
 * A recording runner. Each argv is offered to handle first; returning undefined
 * passes it to the real runner, which tests only use for bash, tar, unzip, install and cp in temp dirs.
 */
export function recordingRun(
	p: Paths,
	handle: (argv: string[], opts: RunOpts) => ProcessResult | undefined | Promise<ProcessResult | undefined>,
) {
	const calls: Call[] = [];
	const real = realRun(p);
	const run: Run = Object.assign(
		async (argv: string[], opts: RunOpts = {}) => {
			calls.push({ argv, opts });
			const r = await handle(argv, opts);
			return r ?? real(argv, opts);
		},
		{ start: real.start },
	);
	return { run, calls };
}

/** A clean exit with this stdout and nothing on stderr. */
export const ok = (stdout = ""): ProcessResult => ({ code: 0, stdout, stderr: "", timedOut: false });

/**
 * A runner that never reaches a real process: every argv must be answered by handle, and any other argv throws,
 * except the read-only /usr question, which gets "rw" when handle leaves it. The extras tests use only this one.
 */
export function strictRun(
	handle: (argv: string[], opts: RunOpts) => ProcessResult | undefined | Promise<ProcessResult | undefined>,
) {
	const calls: Call[] = [];
	const run: Run = async (argv, opts = {}) => {
		const call = { argv, opts };
		calls.push(call);
		const r = await handle(argv, opts);
		if (r) return r;
		// Every fake machine has a writable /usr unless a test says otherwise; the question stays out of the call log.
		if (argv.join(" ") === USR_MOUNT.join(" ")) {
			calls.splice(calls.indexOf(call), 1);
			return ok("rw,relatime\n");
		}
		// Nor fwupd, Timeshift or Snapper, unless a test says otherwise; those questions stay out of the call log too.
		if ([FWUPD_UPDATES, ...SNAPSHOT_PROBES].some((q) => q.join(" ") === argv.join(" "))) {
			calls.splice(calls.indexOf(call), 1);
			return { code: 127, stdout: "", stderr: "", timedOut: false };
		}
		throw new Error(`strictRun: no answer for ${argv.join(" ")}`);
	};
	return { run, calls };
}

/** run with the run's Stop now on every call, as the engine's kind context passes it. Keeps start. */
export function withCancel(run: Run, cancel: AbortSignal): Run {
	const wrapped: Run = (argv, opts) => run(argv, { cancel, ...opts });
	return run.start ? Object.assign(wrapped, { start: run.start }) : wrapped;
}

/** What a crafted ELF file carries; every field left out is absent from the file. */
export type ElfFixture = {
	/** 32-bit when false; default 64-bit. */
	wide?: boolean;
	/** Big-endian when false; default little-endian. */
	little?: boolean;
	/** e_machine; default 62, x86-64. */
	machine?: number;
	interp?: string;
	/** Symbol version names libc.so.6 is needed at, as GLIBC_2.39. */
	versions?: string[];
	/** Of versions, the ones needed weakly (VER_FLG_WEAK). */
	weak?: string[];
	/** The string table's offset in its section header, in place of the real one, to make a damaged file. */
	stringsAt?: number;
	/** The verneed record's entry count, in place of the real one. */
	count?: number;
	/** The X86_ISA_1_NEEDED mask in a GNU property note. */
	isa?: number;
	/** The note goes in a plain PT_NOTE segment instead of PT_GNU_PROPERTY, as older links do. */
	plainNote?: boolean;
};

/**
 * The bytes of a minimal ELF file with only the parts the pre-flight reads: the loader, a GNU property note and a
 * .gnu.version_r section with its string table. Nothing in it runs; it is for reading, never for starting.
 */
export function elfFile(f: ElfFixture): Uint8Array<ArrayBuffer> {
	const wide = f.wide ?? true;
	const little = f.little ?? true;
	const buf = new DataView(new ArrayBuffer(4096));
	const w8 = (at: number, v: number) => buf.setUint8(at, v);
	const w16 = (at: number, v: number) => buf.setUint16(at, v, little);
	const w32 = (at: number, v: number) => buf.setUint32(at, v, little);
	const word = (at: number, v: number) => (wide ? buf.setBigUint64(at, BigInt(v), little) : w32(at, v));
	const bytes = (at: number, s: string) => [...Buffer.from(`${s}\0`, "latin1")].forEach((b, i) => w8(at + i, b));
	let end = 512;
	const put = (size: number) => {
		const at = end;
		end += Math.ceil(size / 8) * 8;
		return at;
	};
	const phs: [number, number, number][] = [];
	if (f.interp !== undefined) {
		const at = put(f.interp.length + 1);
		bytes(at, f.interp);
		phs.push([3, at, f.interp.length + 1]);
	}
	if (f.isa !== undefined) {
		const desc = wide ? 16 : 12;
		const at = put(16 + desc);
		w32(at, 4);
		w32(at + 4, desc);
		w32(at + 8, 5);
		bytes(at + 12, "GNU");
		w32(at + 16, 0xc0008002);
		w32(at + 20, 4);
		w32(at + 24, f.isa);
		phs.push([f.plainNote ? 4 : 0x6474e553, at, 16 + desc]);
	}
	// type, offset, size, link; sh_info is the one verneed record for the version section.
	const sections: [number, number, number, number][] = [[0, 0, 0, 0]];
	const versions = f.versions;
	if (versions) {
		const names = ["libc.so.6", ...versions];
		const str = put(names.join("\0").length + 2);
		const offsets: number[] = [];
		let o = 1;
		for (const n of names) {
			offsets.push(o);
			bytes(str + o, n);
			o += n.length + 1;
		}
		const need = put(16 + 16 * versions.length);
		w16(need, 1);
		w16(need + 2, f.count ?? versions.length);
		w32(need + 4, offsets[0] ?? 0);
		w32(need + 8, 16);
		versions.forEach((v, i) => {
			const aux = need + 16 + 16 * i;
			if (f.weak?.includes(v)) w16(aux + 4, 0x2);
			w32(aux + 8, offsets[i + 1] ?? 0);
			w32(aux + 12, i === versions.length - 1 ? 0 : 16);
		});
		sections.push([3, f.stringsAt ?? str, o + 1, 0], [0x6ffffffe, need, 16 + 16 * versions.length, 1]);
	}
	buf.setUint32(0, 0x7f454c46, false);
	w8(4, wide ? 2 : 1);
	w8(5, little ? 1 : 2);
	w8(6, 1);
	w16(16, 2);
	w16(18, f.machine ?? 62);
	const phent = wide ? 56 : 32;
	const shent = wide ? 64 : 40;
	const phoff = 64;
	word(wide ? 32 : 28, phoff);
	w16(wide ? 54 : 42, phent);
	w16(wide ? 56 : 44, phs.length);
	phs.forEach(([type, at, size], i) => {
		const p = phoff + i * phent;
		w32(p, type);
		word(p + (wide ? 8 : 4), at);
		word(p + (wide ? 32 : 16), size);
	});
	if (sections.length > 1) {
		const shoff = put(shent * sections.length);
		word(wide ? 40 : 32, shoff);
		w16(wide ? 58 : 46, shent);
		w16(wide ? 60 : 48, sections.length);
		sections.forEach(([type, at, size, link], i) => {
			const s = shoff + i * shent;
			w32(s + 4, type);
			word(s + (wide ? 24 : 16), at);
			word(s + (wide ? 32 : 20), size);
			w32(s + (wide ? 40 : 24), link);
			w32(s + (wide ? 44 : 28), type === 0x6ffffffe ? 1 : 0);
		});
	}
	return new Uint8Array(buf.buffer.slice(0, end));
}
