import { closeSync, openSync, readSync } from "node:fs";

/** What an ELF program asks of the machine it starts on, as far as its headers say. */
export type ElfNeeds = {
	/** The highest GLIBC_x.y symbol version it links against; null for a static, musl or versionless program. */
	glibc: string | null;
	/** The x86-64 ISA level its GNU property note asks for (1 to 4); null when not x86-64 or no note says. */
	x86Level: number | null;
	/** The program loader it names (PT_INTERP); null for a static program. */
	interp: string | null;
};

const PT_INTERP = 3;
const PT_NOTE = 4;
const PT_GNU_PROPERTY = 0x6474e553;
const SHT_GNU_VERNEED = 0x6ffffffe;
const EM_X86_64 = 62;
const NT_GNU_PROPERTY_TYPE_0 = 5;
/** vna_flags bit for a weak version need: ld.so starts the program without it, so it asks nothing of the system. */
const VER_FLG_WEAK = 0x2;
const GNU_PROPERTY_X86_ISA_1_NEEDED = 0xc0008002;
/** No header table or section the reader needs is this big in a real program; a bigger one is a damaged file. */
const MAX_PART = 16 * 1024 * 1024;

/** count bytes of the file at offset; throws when the file is shorter, so a cut-off file reads as unreadable. */
function readAt(fd: number, offset: number, count: number): DataView {
	if (count < 0 || count > MAX_PART || !Number.isSafeInteger(offset)) throw new Error("ELF part out of range");
	const buf = Buffer.alloc(count);
	if (readSync(fd, buf, 0, count, offset) !== count) throw new Error("ELF file cut short");
	return new DataView(buf.buffer, buf.byteOffset, count);
}

/** The NUL-ended string at offset in a string table; a missing end reads to the table's end. */
function strAt(table: DataView, offset: number): string {
	let end = offset;
	while (end < table.byteLength && table.getUint8(end) !== 0) end++;
	return Buffer.from(table.buffer, table.byteOffset + offset, Math.max(0, end - offset)).toString("latin1");
}

/** Whether version a ("2.39") is above b, compared part by part as numbers, so 2.4 sits below 2.39. */
export function versionAbove(a: string, b: string): boolean {
	const x = a.split(".").map(Number);
	const y = b.split(".").map(Number);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d !== 0) return d > 0;
	}
	return false;
}

/** f's answer, or null when it throws: one damaged part of a file is unknown, and the other parts are still read. */
function part<T>(f: () => T | null): T | null {
	try {
		return f();
	} catch {
		return null;
	}
}

/** n rounded up to a multiple of a, as note fields are padded. */
const up = (n: number, a: number) => Math.ceil(n / a) * a;

/** The highest ISA level bit in an X86_ISA_1_NEEDED mask: bit 0 baseline, 1 v2, 2 v3, 3 v4; null for none. */
function levelOf(mask: number): number | null {
	for (let level = 4; level >= 1; level--) if (mask & (1 << (level - 1))) return level;
	return null;
}

/**
 * The ISA level in a run of ELF notes, from a GNU property note's X86_ISA_1_NEEDED. Only the 2020 property number is
 * read: binutils before 2.36 used another one with other bits, and a program built then says nothing here.
 */
function isaInNotes(notes: DataView, little: boolean, wide: boolean): number | null {
	const align = wide ? 8 : 4;
	let at = 0;
	while (at + 12 <= notes.byteLength) {
		const namesz = notes.getUint32(at, little);
		const descsz = notes.getUint32(at + 4, little);
		const type = notes.getUint32(at + 8, little);
		const desc = at + 12 + up(namesz, 4);
		if (desc + descsz > notes.byteLength) return null;
		if (type === NT_GNU_PROPERTY_TYPE_0 && strAt(notes, at + 12) === "GNU") {
			let p = desc;
			while (p + 8 <= desc + descsz) {
				const prType = notes.getUint32(p, little);
				const size = notes.getUint32(p + 4, little);
				if (prType === GNU_PROPERTY_X86_ISA_1_NEEDED && size >= 4) return levelOf(notes.getUint32(p + 8, little));
				p += 8 + up(size, align);
			}
		}
		at = desc + up(descsz, 4);
	}
	return null;
}

/**
 * The highest GLIBC_x.y in a .gnu.version_r section, its names read from the string table it links to. A weak need is
 * left out: the loader starts the program without it.
 */
function glibcIn(verneed: DataView, strings: DataView, little: boolean): string | null {
	let best: string | null = null;
	let need = 0;
	// Each record and aux entry carries the offset to the next; a zero ends the chain, the guards end a looped one.
	for (let n = 0; n < 4096 && need + 16 <= verneed.byteLength; n++) {
		const cnt = verneed.getUint16(need + 2, little);
		let aux = need + verneed.getUint32(need + 8, little);
		for (let i = 0; i < cnt && aux + 16 <= verneed.byteLength; i++) {
			const weak = (verneed.getUint16(aux + 4, little) & VER_FLG_WEAK) !== 0;
			const m = weak ? null : /^GLIBC_(\d+\.\d+(?:\.\d+)?)$/.exec(strAt(strings, verneed.getUint32(aux + 8, little)));
			if (m?.[1] && (best === null || versionAbove(m[1], best))) best = m[1];
			const next = verneed.getUint32(aux + 12, little);
			if (next === 0) break;
			aux += next;
		}
		const next = verneed.getUint32(need + 12, little);
		if (next === 0) break;
		need += next;
	}
	return best;
}

/**
 * What the ELF file at path needs to start, read from its headers without running it: 32 or 64 bit, either byte
 * order. Null when it is not an ELF file or its header or program headers cannot be read, which is never a reason to
 * refuse it. Past those, each part (loader, ISA note, glibc needs) is read on its own, and a damaged one is null while
 * the others stand. A program stripped of its section headers still gives its loader and ISA note, but no glibc.
 */
export function elfNeeds(path: string): ElfNeeds | null {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return null;
	}
	try {
		const head = readAt(fd, 0, 64);
		if (head.getUint32(0, false) !== 0x7f454c46) return null;
		const wide = head.getUint8(4) === 2;
		const little = head.getUint8(5) === 1;
		const word = (v: DataView, at: number) => (wide ? Number(v.getBigUint64(at, little)) : v.getUint32(at, little));
		const machine = head.getUint16(18, little);
		const phoff = word(head, wide ? 32 : 28);
		const shoff = word(head, wide ? 40 : 32);
		const phentsize = head.getUint16(wide ? 54 : 42, little);
		const phnum = head.getUint16(wide ? 56 : 44, little);
		const shentsize = head.getUint16(wide ? 58 : 46, little);
		const shnum = head.getUint16(wide ? 60 : 48, little);

		let interp: string | null = null;
		let x86Level: number | null = null;
		const phs = readAt(fd, phoff, phentsize * phnum);
		const segments = Array.from({ length: phnum }, (_, i) => {
			const at = i * phentsize;
			return {
				type: phs.getUint32(at, little),
				offset: word(phs, at + (wide ? 8 : 4)),
				size: word(phs, at + (wide ? 32 : 16)),
			};
		});
		for (const s of segments)
			if (s.type === PT_INTERP) interp = part(() => strAt(readAt(fd, s.offset, s.size), 0) || null);
		if (machine === EM_X86_64) {
			// The property segment holds exactly the note the level is in; older links only have it among the notes.
			const property = segments.filter((s) => s.type === PT_GNU_PROPERTY);
			for (const seg of property.length ? property : segments.filter((s) => s.type === PT_NOTE)) {
				x86Level = part(() => isaInNotes(readAt(fd, seg.offset, seg.size), little, wide));
				if (x86Level !== null) break;
			}
		}

		const glibc =
			shnum && shoff
				? part(() => {
						const shs = readAt(fd, shoff, shentsize * shnum);
						const section = (i: number) => {
							const at = i * shentsize;
							return {
								type: shs.getUint32(at + 4, little),
								offset: word(shs, at + (wide ? 24 : 16)),
								size: word(shs, at + (wide ? 32 : 20)),
								link: shs.getUint32(at + (wide ? 40 : 24), little),
							};
						};
						for (let i = 0; i < shnum; i++) {
							const s = section(i);
							if (s.type !== SHT_GNU_VERNEED || s.link >= shnum) continue;
							const str = section(s.link);
							return glibcIn(readAt(fd, s.offset, s.size), readAt(fd, str.offset, str.size), little);
						}
						return null;
					})
				: null;
		return { glibc, x86Level, interp };
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}
