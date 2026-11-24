/**
 * The app menu entry Upkeep may write for an AppImage it manages, when the person turns it on for that row. The entry
 * and its icon come from the AppImage's own files, read with the runtime's --appimage-extract into a temp folder;
 * the AppImage is never started any other way. Upkeep records the files it wrote and deletes exactly those.
 */
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { MESSAGES } from "../shared/messages";
import type { Paths } from "./paths";
import type { Run } from "./run";

/** Where menu entries live for this person: $XDG_DATA_HOME/applications. paths.data is $XDG_DATA_HOME/upkeep. */
export const appsDir = (paths: Paths) => join(dirname(paths.data), "applications");

/** The file name Upkeep gives an app's entry, so it never takes the name of an entry another tool wrote. */
const entryName = (key: string) => `upkeep-${key}.desktop`;

/** The sizes hicolor's index.theme lists; a PNG of another size goes to pixmaps, which the Icon= path still reaches. */
const HICOLOR = new Set([16, 22, 24, 32, 48, 64, 96, 128, 192, 256, 512]);

/**
 * The program an Exec= line starts, unquoted as the desktop entry spec says: a quoted first word keeps its spaces and
 * its backslash escapes are undone. Wrong for an Exec that starts with env VAR=x, which names env, not the app.
 */
export function execProgram(exec: string): string {
	const s = exec.trim();
	if (!s.startsWith('"')) return s.split(/\s+/)[0] ?? "";
	let out = "";
	for (let i = 1; i < s.length; i++) {
		const c = s[i];
		if (c === "\\" && i + 1 < s.length) out += s[++i];
		else if (c === '"') break;
		else out += c;
	}
	return out;
}

/** The rest of an Exec= line after its program, with its leading space, so %U and the app's own flags stay. */
function execArgs(exec: string): string {
	const s = exec.trim();
	if (!s.startsWith('"')) return s.replace(/^\S+/, "");
	for (let i = 1; i < s.length; i++) {
		if (s[i] === "\\") i++;
		else if (s[i] === '"') return s.slice(i + 1);
	}
	return "";
}

/** A path as an Exec= program: always quoted, with the spec's four escapes and % doubled so it is never a field code. */
export const quoteExec = (path: string) => `"${path.replace(/[\\"`$]/g, (c) => `\\${c}`).replaceAll("%", "%%")}"`;

/**
 * The AppImage's entry, made Upkeep's: every Exec= (the main one and each action's) starts dest with the arguments it
 * had, TryExec= goes (it names AppRun, which is not on PATH, and would hide the entry), and Icon= is the written icon's
 * path, or the AppImage's own name when there is no icon file.
 */
export function rewriteEntry(text: string, dest: string, icon: string | null): string {
	const lines = text.split("\n").flatMap((line) => {
		if (/^TryExec\s*=/.test(line)) return [];
		const exec = /^Exec\s*=(.*)$/.exec(line);
		if (exec) return [`Exec=${quoteExec(dest)}${execArgs(exec[1] ?? "")}`];
		if (icon && /^Icon\s*=/.test(line)) return [`Icon=${icon}`];
		return [line];
	});
	return lines.join("\n").replace(/\n*$/, "\n");
}

/** The Icon= name of the [Desktop Entry] group, or null. */
function iconName(text: string): string | null {
	return /^Icon\s*=\s*(.+?)\s*$/m.exec(text)?.[1] ?? null;
}

/** A PNG's width and height from its IHDR, or null for a file that is not a PNG. */
function pngSize(file: string): { w: number; h: number } | null {
	const b = Buffer.alloc(24);
	const fd = openSync(file, "r");
	try {
		readSync(fd, b, 0, 24, 0);
	} finally {
		closeSync(fd);
	}
	if (b.toString("latin1", 1, 4) !== "PNG") return null;
	return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/**
 * Where the icon goes under $XDG_DATA_HOME: an SVG in hicolor/scalable, a PNG of a listed square size in
 * hicolor/<n>x<n>, any other PNG in pixmaps. Null for anything that is neither.
 */
function iconPath(paths: Paths, key: string, file: string): string | null {
	const share = dirname(paths.data);
	const ext = extname(file).toLowerCase();
	if (ext === ".svg") return join(share, "icons/hicolor/scalable/apps", `upkeep-${key}.svg`);
	const size = pngSize(file);
	if (!size) return null;
	if (size.w === size.h && HICOLOR.has(size.w))
		return join(share, `icons/hicolor/${size.w}x${size.w}/apps`, `upkeep-${key}.png`);
	return join(share, "pixmaps", `upkeep-${key}.png`);
}

/** A regular file inside root, following at most one symlink that stays inside it (.DirIcon is often a link). */
function insideFile(root: string, p: string): string | null {
	try {
		let file = p;
		if (lstatSync(file).isSymbolicLink()) file = resolve(dirname(file), readlinkSync(file));
		if (!resolve(file).startsWith(`${resolve(root)}/`)) return null;
		return lstatSync(file).isFile() ? file : null;
	} catch {
		return null;
	}
}

export type MenuCtx = { paths: Paths; run: Run };

/**
 * Extracts one pattern of the AppImage into root/squashfs-root. A failed extraction leaves nothing, which the caller
 * reads as the file missing.
 */
async function extract(dest: string, pattern: string, root: string, run: Run): Promise<void> {
	await run([dest, "--appimage-extract", pattern], { cwd: root, timeoutMs: 60_000 });
}

/**
 * Writes the app's menu entry and icon from the AppImage at dest and returns every file written, or the sentence for
 * why not. It does not look for another tool's entry first; the caller does (foreignEntry). Its icon search covers the
 * top level of the image only, where the AppImage format puts it.
 */
export async function writeMenu(
	key: string,
	dest: string,
	ctx: MenuCtx,
): Promise<{ files: string[] } | { problem: string }> {
	const cache = ctx.paths.cache;
	mkdirSync(cache, { recursive: true });
	const tmp = mkdtempSync(join(cache, "menu-"));
	try {
		const root = join(tmp, "squashfs-root");
		await extract(dest, "*.desktop", tmp, ctx.run);
		const desktop = existsSync(root)
			? readdirSync(root)
					.filter((n) => n.endsWith(".desktop"))
					.map((n) => insideFile(root, join(root, n)))
					.find((f) => f !== null)
			: undefined;
		if (!desktop) return { problem: MESSAGES.menuNoEntry(dest) };
		const text = readFileSync(desktop, "utf8");
		const name = iconName(text);
		// The icon named by Icon= at the top level, else .DirIcon, which the format requires.
		let icon: string | null = null;
		if (name && !name.includes("/")) {
			await extract(dest, `${name}.*`, tmp, ctx.run);
			const hit = readdirSync(root).find((n) => n === `${name}.png` || n === `${name}.svg`);
			icon = hit ? insideFile(root, join(root, hit)) : null;
		}
		if (!icon) {
			await extract(dest, ".DirIcon", tmp, ctx.run);
			const link = join(root, ".DirIcon");
			const st = lstatSync(link, { throwIfNoEntry: false });
			// A .DirIcon that links to a file needs that file extracted too.
			if (st?.isSymbolicLink()) await extract(dest, readlinkSync(link), tmp, ctx.run);
			if (st) icon = insideFile(root, link);
		}
		const files: string[] = [];
		const iconDest = icon ? iconPath(ctx.paths, key, icon) : null;
		if (icon && iconDest) {
			mkdirSync(dirname(iconDest), { recursive: true });
			writeFileSync(iconDest, readFileSync(icon));
			files.push(iconDest);
		}
		const entry = join(appsDir(ctx.paths), entryName(key));
		mkdirSync(dirname(entry), { recursive: true });
		writeFileSync(entry, rewriteEntry(text, dest, iconDest));
		files.push(entry);
		await refreshDatabase(ctx);
		return { files };
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/**
 * Deletes the files given, each only when it is a regular file named upkeep-* under $XDG_DATA_HOME, so a hand edit of
 * state.json cannot point it anywhere else; then refreshes the menu's database.
 */
export async function removeMenu(files: string[], ctx: MenuCtx): Promise<void> {
	const share = `${resolve(dirname(ctx.paths.data))}/`;
	for (const f of files)
		if (
			resolve(f).startsWith(share) &&
			basename(f).startsWith("upkeep-") &&
			lstatSync(f, { throwIfNoEntry: false })?.isFile()
		)
			rmSync(f, { force: true });
	await refreshDatabase(ctx);
}

/** update-desktop-database on the person's own folder, when the system has it; a missing tool is fine (code 127). */
async function refreshDatabase(ctx: MenuCtx): Promise<void> {
	await ctx.run(["update-desktop-database", appsDir(ctx.paths)], { timeoutMs: 30_000 });
}

/**
 * Another tool's entry for the same AppImage (AppImageLauncher, Gear Lever, the app's own prompt): a .desktop in the
 * person's applications folder whose Exec= starts dest. Upkeep's own files are skipped. Null when there is none.
 */
export function foreignEntry(paths: Paths, dest: string, own: string[]): string | null {
	const dir = appsDir(paths);
	let names: string[];
	try {
		names = readdirSync(dir).filter((n) => n.endsWith(".desktop"));
	} catch {
		return null;
	}
	const want = resolve(dest);
	for (const n of names) {
		const file = join(dir, n);
		if (own.includes(file)) continue;
		try {
			const exec = /^Exec\s*=(.*)$/m.exec(readFileSync(file, "utf8"))?.[1];
			const program = exec ? execProgram(exec) : "";
			// A bare name is looked up on PATH, so it is never this file.
			if (program.startsWith("/") && resolve(program) === want) return file;
		} catch {
			// an unreadable entry is not this app's
		}
	}
	return null;
}
