/**
 * The app menu entry Upkeep may write for an AppImage it manages, when the person turns it on for that row. The entry
 * and its icon come from the AppImage's own files, read with the runtime's --appimage-extract into a temp folder;
 * the AppImage is never started any other way, and only a type-2 AppImage is asked. Upkeep records the files it
 * wrote and deletes exactly those.
 */
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { MESSAGES } from "../shared/messages";
import { head, isAppImage } from "./discover";
import type { Paths } from "./paths";
import type { Run } from "./run";

/** Where menu entries live for this person: $XDG_DATA_HOME/applications. paths.data is $XDG_DATA_HOME/upkeep. */
export const appsDir = (paths: Paths) => join(dirname(paths.data), "applications");

/** The file name Upkeep gives an app's entry, so it never takes the name of an entry another tool wrote. */
const entryName = (key: string) => `upkeep-${key}.desktop`;

/** Every file Upkeep writes for a menu entry starts with this, which is how a leftover one is told from another tool's. */
const OWN = "upkeep-";

/**
 * Undoes the desktop entry spec's string escapes (\s \n \t \r \\), which apply before Exec's own quoting. An unknown
 * escape keeps its character.
 */
function unescapeValue(v: string): string {
	return v.replace(/\\(.)/g, (_, c: string) => ({ s: " ", n: "\n", t: "\t", r: "\r" })[c] ?? c);
}

/** The string layer for a value written back: only the backslash needs it in an Exec line. */
const escapeValue = (v: string) => v.replaceAll("\\", "\\\\");

type Word = { text: string; start: number; end: number };

/**
 * The words of an Exec value whose string escapes are already undone, by the spec's quoting rule: a quoted word keeps
 * its spaces and its backslash escapes are undone. An unclosed quote runs to the end.
 */
function words(exec: string): Word[] {
	const out: Word[] = [];
	let i = 0;
	while (i < exec.length) {
		if (/\s/.test(exec[i] ?? "")) {
			i++;
			continue;
		}
		const start = i;
		let text = "";
		if (exec[i] === '"') {
			i++;
			while (i < exec.length && exec[i] !== '"') {
				if (exec[i] === "\\" && i + 1 < exec.length) i++;
				text += exec[i++];
			}
			i++;
		} else {
			while (i < exec.length && !/\s/.test(exec[i] ?? "")) text += exec[i++];
		}
		out.push({ text, start, end: Math.min(i, exec.length) });
	}
	return out;
}

/**
 * Which word starts the program: the first, or after `env` the first that is neither a VAR=value nor a flag. Wrong for
 * an env flag that takes its own argument (-u NAME), which reads NAME as the program.
 */
function programAt(ws: Word[]): number {
	if (ws[0]?.text !== "env" && !ws[0]?.text.endsWith("/env")) return 0;
	let i = 1;
	while (ws[i] && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i]?.text ?? "") || ws[i]?.text.startsWith("-"))) i++;
	return i;
}

/** The program an Exec= value starts, past an env prefix, with both escape layers undone. */
export function execProgram(exec: string): string {
	const ws = words(unescapeValue(exec.trim()));
	return ws[programAt(ws)]?.text ?? "";
}

/**
 * A path as an Exec= word inside the quotes: the spec's four escapes, % doubled so it is never a field code. Throws on
 * a control character, which no escape keeps on one line; writeMenu refuses such a dest before it gets here.
 */
function quoteWord(path: string): string {
	if (hasControl(path)) throw new Error(MESSAGES.menuNoEntry(JSON.stringify(path)));
	return `"${path.replace(/[\\"`$]/g, (c) => `\\${c}`).replaceAll("%", "%%")}"`;
}

/** A line break or other control character, which no Exec= escape keeps on one line. */
// oxlint-disable-next-line no-control-regex -- control characters are what it finds
const hasControl = (v: string) => /[\x00-\x1f\x7f]/.test(v);

/** file, when it sits directly in dir; else throws, so a key that slipped past the manifest never writes elsewhere. */
function directlyIn(dir: string, file: string): string {
	if (dirname(resolve(file)) !== resolve(dir)) throw new Error(MESSAGES.menuNoEntry(file));
	return file;
}

/** A path as an Exec= program, as written in the file: quoted, then string-escaped. */
export const quoteExec = (path: string) => escapeValue(quoteWord(path));

/** The Exec= value with its program replaced by dest; an env prefix and every argument (%U, flags) stay. */
function rewriteExec(exec: string, dest: string): string {
	const value = unescapeValue(exec.trim());
	const ws = words(value);
	const w = ws[programAt(ws)];
	// No program after an env prefix (or no value at all): dest goes at the end.
	if (!w) return escapeValue(`${value}${value ? " " : ""}${quoteWord(dest)}`);
	return escapeValue(`${value.slice(0, w.start)}${quoteWord(dest)}${value.slice(w.end)}`);
}

/**
 * The AppImage's entry, made Upkeep's: every Exec= (the main one and each action's) starts dest with the arguments it
 * had; TryExec= goes (it names AppRun, which is not on PATH, and would hide the entry) and so does DBusActivatable=
 * (the desktop would start it over D-Bus, where no service file exists); the main group's Icon= is the written icon's
 * path when there is one. CRLF lines come back as LF.
 */
export function rewriteEntry(text: string, dest: string, icon: string | null): string {
	let group = "";
	const lines = text.split(/\r?\n/).flatMap((line) => {
		if (line.startsWith("[")) group = line.trim();
		if (/^(TryExec|DBusActivatable)\s*=/.test(line)) return [];
		const exec = /^Exec\s*=(.*)$/.exec(line);
		if (exec) return [`Exec=${rewriteExec(exec[1] ?? "", dest)}`];
		if (icon && group === "[Desktop Entry]" && /^Icon\s*=/.test(line)) return [`Icon=${icon}`];
		return [line];
	});
	return lines.join("\n").replace(/\n*$/, "\n");
}

/** A key's value in the [Desktop Entry] group, trimmed, or null. Another group's key of the same name is not read. */
function mainValue(text: string, key: string): string | null {
	let main = false;
	for (const line of text.split(/\r?\n/)) {
		if (line.startsWith("[")) main = line.trim() === "[Desktop Entry]";
		else if (main) {
			const m = new RegExp(`^${key}\\s*=\\s*(.*?)\\s*$`).exec(line);
			if (m) return m[1] ?? "";
		}
	}
	return null;
}

/** The icon's extension by its first bytes: .png, .svg, or null for anything else. */
function iconExt(file: string): ".png" | ".svg" | null {
	const b = head(file, 256);
	if (!b) return null;
	if (b.subarray(1, 4).toString("latin1") === "PNG") return ".png";
	const start = b.toString("utf8").trimStart();
	return start.startsWith("<svg") || start.startsWith("<?xml") ? ".svg" : null;
}

/** A regular file inside root, following at most one symlink that stays inside it. */
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
 * A top-level file of the image as a regular file in the temp folder. A link (linuxdeploy's `App.desktop ->
 * usr/share/applications/App.desktop`) has its target extracted too; a target outside the image is refused.
 */
async function pull(dest: string, tmp: string, name: string, run: Run): Promise<string | null> {
	const p = join(tmp, "squashfs-root", name);
	const st = lstatSync(p, { throwIfNoEntry: false });
	if (!st) return null;
	if (st.isSymbolicLink()) {
		const target = readlinkSync(p);
		if (!target.startsWith("/")) await extract(dest, target, tmp, run);
	}
	return insideFile(join(tmp, "squashfs-root"), p);
}

/** Temp folders a crash or kill left, older than an hour, so a write under way in another call is never touched. */
function sweep(cache: string): void {
	try {
		for (const n of readdirSync(cache))
			if (n.startsWith("menu-") && Date.now() - statSync(join(cache, n)).mtimeMs > 3_600_000)
				rmSync(join(cache, n), { recursive: true, force: true });
	} catch {
		// no cache folder yet
	}
}

/**
 * Writes the app's menu entry and icon from the AppImage at dest and returns every file written, or the sentence for
 * why not: nothing at dest, not a type-2 AppImage, no entry inside, or an entry that asks to stay out of the menu
 * (NoDisplay, Hidden, X-AppImage-Integrate=false). It does not look for another tool's entry first; the caller does.
 * Its search covers the top level of the image, where the AppImage format puts the entry and the icon.
 */
export async function writeMenu(
	key: string,
	dest: string,
	ctx: MenuCtx,
): Promise<{ files: string[] } | { problem: string }> {
	try {
		return await writeMenuFiles(key, dest, ctx);
	} catch (err) {
		// A full disk or a folder Upkeep may not write is a sentence for the row, never an error out of the request.
		return { problem: MESSAGES.menuCouldNotWrite(err instanceof Error ? err.message : String(err)) };
	}
}

/** writeMenu's work; it may throw on a write that fails, which writeMenu turns into a sentence. */
async function writeMenuFiles(
	key: string,
	dest: string,
	ctx: MenuCtx,
): Promise<{ files: string[] } | { problem: string }> {
	// The manifest refuses both; a dest with a line break would add a line of its own to the entry.
	if (hasControl(dest) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) return { problem: MESSAGES.menuNoEntry(dest) };
	if (!existsSync(dest)) return { problem: MESSAGES.menuNotInstalled(dest) };
	// Only the type-2 runtime answers --appimage-extract; anything else would start the app itself.
	if (!isAppImage(head(dest, 16))) return { problem: MESSAGES.menuNoEntry(dest) };
	const cache = ctx.paths.cache;
	mkdirSync(cache, { recursive: true });
	sweep(cache);
	const tmp = mkdtempSync(join(cache, "menu-"));
	try {
		const root = join(tmp, "squashfs-root");
		await extract(dest, "*.desktop", tmp, ctx.run);
		const names = existsSync(root) ? readdirSync(root).filter((n) => n.endsWith(".desktop")) : [];
		let desktop: string | null = null;
		for (const n of names) {
			// oxlint-disable-next-line no-await-in-loop -- the first entry that reads is the one, in order
			desktop = await pull(dest, tmp, n, ctx.run);
			if (desktop) break;
		}
		if (!desktop) return { problem: MESSAGES.menuNoEntry(dest) };
		const text = readFileSync(desktop, "utf8");
		const hidden = (k: string, v: string) => mainValue(text, k)?.toLowerCase() === v;
		if (hidden("NoDisplay", "true") || hidden("Hidden", "true") || hidden("X-AppImage-Integrate", "false"))
			return { problem: MESSAGES.menuStaysOut(dest) };
		const name = mainValue(text, "Icon");
		// The icon named by Icon= at the top level, else .DirIcon, which the format requires.
		let icon: string | null = null;
		if (name && !name.includes("/")) {
			await extract(dest, `${name}.*`, tmp, ctx.run);
			const hit = readdirSync(root).find((n) => n === `${name}.png` || n === `${name}.svg`);
			icon = hit ? await pull(dest, tmp, hit, ctx.run) : null;
		}
		if (!icon) {
			await extract(dest, ".DirIcon", tmp, ctx.run);
			icon = await pull(dest, tmp, ".DirIcon", ctx.run);
		}
		const files: string[] = [];
		const ext = icon ? iconExt(icon) : null;
		// Icon= names the file by its full path, so it shows whatever its size, with no icon theme cache to update.
		const icons = join(dirname(ctx.paths.data), "icons");
		const iconDest = ext ? directlyIn(icons, join(icons, `${OWN}${key}${ext}`)) : null;
		if (icon && iconDest) {
			mkdirSync(dirname(iconDest), { recursive: true });
			writeFileSync(iconDest, readFileSync(icon));
			files.push(iconDest);
		}
		const entry = directlyIn(appsDir(ctx.paths), join(appsDir(ctx.paths), entryName(key)));
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
 * state.json cannot point it anywhere else. Synchronous and quiet, for Uninstall Upkeep too.
 */
export function removeMenuFiles(files: string[], paths: Paths): void {
	const share = `${resolve(dirname(paths.data))}/`;
	for (const f of files)
		try {
			if (
				resolve(f).startsWith(share) &&
				basename(f).startsWith(OWN) &&
				lstatSync(f, { throwIfNoEntry: false })?.isFile()
			)
				rmSync(f, { force: true });
		} catch {
			// A file in a folder Upkeep may no longer write stays; the others still go.
		}
}

/** removeMenuFiles, then the menu's database refreshed. */
export async function removeMenu(files: string[], ctx: MenuCtx): Promise<void> {
	removeMenuFiles(files, ctx.paths);
	await refreshDatabase(ctx);
}

/** update-desktop-database on the person's own folder, when the system has it; a missing tool is fine (code 127). */
async function refreshDatabase(ctx: MenuCtx): Promise<void> {
	await ctx.run(["update-desktop-database", appsDir(ctx.paths)], { timeoutMs: 30_000 });
}

/** A path with its links resolved, or as given when it does not exist. */
function real(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

/**
 * Every other tool's entry in the person's applications folder, by the real path of the program its Exec= starts
 * (AppImageLauncher, Gear Lever, an app's own prompt). Upkeep's own upkeep-* files are left out, a leftover one
 * included, since writing the entry takes that name again. A bare program name is looked up on PATH, so it is skipped.
 */
export function entryOwners(paths: Paths): Map<string, string> {
	const out = new Map<string, string>();
	const dir = appsDir(paths);
	let names: string[];
	try {
		names = readdirSync(dir).filter((n) => n.endsWith(".desktop") && !n.startsWith(OWN));
	} catch {
		return out;
	}
	for (const n of names) {
		try {
			const exec = mainValue(readFileSync(join(dir, n), "utf8"), "Exec");
			const program = exec ? execProgram(exec) : "";
			if (program.startsWith("/") && !out.has(real(program))) out.set(real(program), join(dir, n));
		} catch {
			// an unreadable entry is not this app's
		}
	}
	return out;
}

/** The other tool's entry for dest among owners, matched through links on either side, or null. */
export const foreignEntry = (owners: Map<string, string>, dest: string) => owners.get(real(dest)) ?? null;
