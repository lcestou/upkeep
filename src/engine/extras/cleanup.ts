import { lstat, readdir, readFile, realpath, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { MESSAGES } from "../../shared/messages";
import type { CleanupId, CleanupItem, CleanupOutcome, CleanupPart, CleanupPick } from "../../shared/types";
import type { Paths } from "../paths";
import type { ProcessResult, Run } from "../run";
import { SUDO_CHECK } from "./install";
import { DRIVER_GL } from "./system";

// Cleanup: a fixed list of candidates, each measured by its own rule and deleted by its own step, never a general
// file deleter. Files are deleted in-process only below a candidate's own folder, one entry at a time after lstat,
// never through a link and never on another file system. Everything outside the home folder is read or changed only
// through the runner, with the literal argv lists below, so the review sheet can show them as they run.

/** apt's downloaded packages, sized as the person: the folder is readable without root. */
export const APT_CACHE_SIZES = [
	"find",
	"/var/cache/apt/archives",
	"-maxdepth",
	"1",
	"-name",
	"*.deb",
	"-printf",
	"%s\\n",
];
export const APT_CLEAN = ["sudo", "-n", "apt-get", "clean"];
/** A dry run of autoremove: its "Remv <pkg>" lines are what the real one would remove. No root. */
export const AUTOREMOVE_SIM = ["apt-get", "-s", "autoremove"];
export const AUTOREMOVE = ["sudo", "-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "autoremove", "-y"];
export const FLATPAK_RUNTIME_SIZES = [
	"flatpak",
	"list",
	"--runtime",
	"--columns=application,arch,branch,installation,size",
];
export const TMP_SIZE = ["du", "-sxb", "/tmp"];
export const JOURNAL_SIZE = ["journalctl", "--disk-usage"];
export const RUNNING_KERNEL = ["uname", "-r"];
export const KERNELS = ["dpkg-query", "-W", "-f", "${Package}\\n", "linux-image-[0-9]*"];
export const TIMESHIFT_SNAPSHOTS = ["ls", "/timeshift/snapshots"];
/** The word typed before packages are removed. A value in every language, never translated. */
export const TYPE_WORD = "remove";

/** The developer tools whose caches Cleanup clears with their own command, and where each keeps it. */
const DEV_CACHES = {
	uv: { probe: ["uv", "--version"], clear: ["uv", "cache", "clean"], dir: (c: Dirs) => join(c.cache, "uv") },
	bun: {
		probe: ["bun", "--version"],
		clear: ["bun", "pm", "cache", "rm"],
		dir: (c: Dirs) => join(c.home, ".bun/install/cache"),
	},
	npm: {
		probe: ["npm", "--version"],
		clear: ["npm", "cache", "clean", "--force"],
		dir: (c: Dirs) => join(c.home, ".npm/_cacache"),
	},
	pip: { probe: ["pip", "--version"], clear: ["pip", "cache", "purge"], dir: (c: Dirs) => join(c.cache, "pip") },
} satisfies Record<"uv" | "bun" | "npm" | "pip", { probe: string[]; clear: string[]; dir: (c: Dirs) => string }>;

/** Browser page caches, shown only: deleting under a running browser can break its cache or session. */
const BROWSER_CACHES = ["google-chrome", "chromium", "mozilla", "zen", "BraveSoftware", "vivaldi"];
/** Playwright's test browsers, shown only: projects pin them by version. */
const PLAYWRIGHT = "ms-playwright";
/** Thumbnail sizes the freedesktop spec names, and fail/ for files it could not preview. */
const THUMBNAIL_DIRS = ["normal", "large", "x-large", "xx-large", "fail"];
/** Upkeep's own leftovers that Upkeep itself deletes when it gets to them; never .upkeep-live, which can be the only good copy. */
const LEFTOVER = /^(.+)\.upkeep-(new|tmp|gone)$/;
/** Copies made by hand or by another tool, shown only. */
const HAND_COPY = /\.(bak|backup|orig|old)([-._]|$)/i;
/** Flatpak's GPU runtime for one NVIDIA driver version: org.freedesktop.Platform.GL.nvidia-580-159-03. */
const NVIDIA_GL = /^org\.freedesktop\.Platform\.GL(?:32)?\.nvidia-(\d+(?:-\d+)+)$/;

export type CleanupCtx = {
	run: Run;
	paths: Paths;
	/** Upkeep's own pid, which pkcheck asks about. */
	pid: number;
	/** /proc, or a test's stand-in, for the loaded NVIDIA module's version. */
	procRoot: string;
	devCaches: boolean;
	/** The folders apps are installed into: leftovers and hand-made copies are looked for here. */
	leftoverDirs: string[];
	/** One line of the run log. */
	log: (line: string) => void;
	/** The pid of the command now running, so a quit can end its process group. */
	onStart?: (pid: number) => void;
};

/** The home folder and the XDG cache and data folders, taken from where Upkeep's own folders sit. */
type Dirs = { home: string; cache: string; data: string };
/** Upkeep's own folders are <xdg>/upkeep, so their parents are the XDG folders, wherever the environment put them. */
const dirsOf = (p: Paths): Dirs => ({ home: p.home, cache: dirname(p.cache), data: dirname(p.data) });

/** A tree's sole-link bytes and its newest change: what the review saw, and what confirm compares against. */
export type Sig = { bytes: number; newest: number };

/** How one part is measured again and deleted. key fingerprints a measure; a part whose key moved is skipped. */
type Target = {
	root: boolean;
	measure: () => Promise<{ bytes: number; key: string }>;
	seen: string;
	/** The literal command it runs, shown in the review; absent for a delete in-process. */
	argv?: string[];
	/** Deletes the part. Returns a failure sentence, or null when it went. */
	remove: () => Promise<string | null>;
	/** A polkit action that must pass before the command runs. */
	pkcheck?: string;
};

/** What a measure found: the items the tab lists, and how each part is deleted. */
export type Measured = { items: CleanupItem[]; targets: Map<string, Target> };

/** A part's key in Measured.targets; a newline cannot occur in an item id. */
const targetKey = (id: CleanupId, partId: string) => `${id}\n${partId}`;
/** A tree's fingerprint: any file added, removed, grown or touched moves it. */
const sigKey = (s: Sig) => `${s.bytes}:${s.newest}`;
/** A command that did not exit 0 in time. */
const bad = (r: ProcessResult) => r.code !== 0 || r.timedOut;
/** A command's output as trimmed, non-empty lines. */
const lines = (text: string) =>
	text
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);

/** True when target lies strictly below root, by path alone. root itself, and anything ".." leads to, is not. */
export function insideRoot(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

/** lstat, or null when the path is gone or unreadable. */
async function statOf(path: string) {
	try {
		return await lstat(path);
	} catch {
		return null;
	}
}

/**
 * The bytes of regular files below root that have one hard link, and the newest mtime of anything below it. Files
 * that share an inode with something else free nothing when deleted, so they count zero: the figure is what a delete
 * gives back, never what du shows. It never follows a link and never enters a directory on another device. Each
 * directory is read and its entries stat'ed in batches on the thread pool, so a cache of two million files keeps the
 * window answering. A file linked twice inside the tree itself counts zero, so the figure can be low, never high.
 */
export async function measureTree(root: string): Promise<Sig> {
	const top = await statOf(root);
	if (!top) return { bytes: 0, newest: 0 };
	if (!top.isDirectory()) return { bytes: top.isFile() && top.nlink === 1 ? top.size : 0, newest: top.mtimeMs };
	const sig = { bytes: 0, newest: top.mtimeMs };
	const stack = [root];
	for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
		let names: string[];
		try {
			// oxlint-disable-next-line no-await-in-loop -- one directory at a time is the point: it bounds memory on a tree of millions
			names = await readdir(dir);
		} catch {
			continue;
		}
		for (let i = 0; i < names.length; i += 128) {
			const from = dir;
			// oxlint-disable-next-line no-await-in-loop -- one batch at a time is the point: it bounds open files on a tree of millions
			const stats = await Promise.all(
				names.slice(i, i + 128).map((n) => statOf(join(from, n)).then((s) => ({ n, s }))),
			);
			for (const { n, s } of stats) {
				if (!s) continue;
				if (s.mtimeMs > sig.newest) sig.newest = s.mtimeMs;
				if (s.isDirectory()) {
					if (s.dev === top.dev) stack.push(join(from, n));
				} else if (s.isFile() && s.nlink === 1) sig.bytes += s.size;
			}
		}
	}
	return sig;
}

/** The sum of several trees, as one fingerprint. */
async function measureAll(roots: string[]): Promise<Sig> {
	const sigs = await Promise.all(roots.map(measureTree));
	return { bytes: sigs.reduce((a, s) => a + s.bytes, 0), newest: Math.max(0, ...sigs.map((s) => s.newest)) };
}

/** A path the delete would not touch: a link out, another folder, another file system. Its message is the sentence. */
class Refused extends Error {}

/**
 * Deletes path and everything below it without following a link: a link is removed itself and its target stays. A
 * directory on another device than dev (a mount point) is left with everything in it, so the folder holding it is not
 * empty and its rmdir throws. Throws on the first entry it cannot delete.
 */
export async function removeTree(path: string, dev: number): Promise<void> {
	const st = await lstat(path);
	if (st.dev !== dev) throw new Refused(MESSAGES.cleanRefusedPath(path));
	if (!st.isDirectory()) return unlink(path);
	for (const name of await readdir(path))
		// oxlint-disable-next-line no-await-in-loop -- one entry at a time is the point: the first failure stops the delete
		await removeTree(join(path, name), dev);
	await rmdir(path);
}

/**
 * Deletes one path below root, after checking it three ways: by name it lies below root; the real folder holding it
 * lies below root's real folder, so no linked folder on the way leads out; and it sits on root's own device. root
 * itself must be a real folder, not a link. Returns a failure sentence, or null.
 */
export async function removeBelow(root: string, path: string): Promise<string | null> {
	try {
		const top = await lstat(root);
		const realRoot = await realpath(root);
		const real = join(await realpath(dirname(path)), basename(path));
		const st = await lstat(path);
		if (!top.isDirectory() || !insideRoot(root, path) || !insideRoot(realRoot, real) || st.dev !== top.dev)
			return MESSAGES.cleanRefusedPath(path);
		await removeTree(path, top.dev);
		return null;
	} catch (err) {
		if (err instanceof Refused) return err.message;
		return MESSAGES.cleanCouldNotDelete(path, err instanceof Error ? err.message : String(err));
	}
}

/** Deletes what is inside each folder below root, keeping the folders themselves. A folder that is a link is passed by. */
async function removeContents(root: string, dirs: string[]): Promise<string | null> {
	for (const dir of dirs) {
		// oxlint-disable-next-line no-await-in-loop -- one folder at a time is the point: the first failure stops the delete
		const st = await statOf(dir);
		if (!st?.isDirectory()) continue;
		let names: string[];
		try {
			// oxlint-disable-next-line no-await-in-loop -- as above
			names = await readdir(dir);
		} catch (err) {
			return MESSAGES.cleanCouldNotDelete(dir, err instanceof Error ? err.message : String(err));
		}
		for (const name of names) {
			// oxlint-disable-next-line no-await-in-loop -- as above
			const why = await removeBelow(root, join(dir, name));
			if (why) return why;
		}
	}
	return null;
}

/** A part deleted in-process: the contents of dirs, or one path, below root. */
async function treeTarget(root: string, what: { dirs: string[] } | { path: string }): Promise<Target & { sig: Sig }> {
	const roots = "dirs" in what ? what.dirs : [what.path];
	const measure = async () => {
		const s = await measureAll(roots);
		return { bytes: s.bytes, key: sigKey(s) };
	};
	const sig = await measureAll(roots);
	return {
		root: false,
		sig,
		seen: sigKey(sig),
		measure,
		remove: () => ("dirs" in what ? removeContents(root, what.dirs) : removeBelow(root, what.path)),
	};
}

/**
 * A part one command deletes. measure reads it again by the same read-only command; a fingerprint that moved since
 * the review means the command would now delete something else, so the part is skipped.
 */
function commandTarget(
	ctx: CleanupCtx,
	argv: string[],
	measure: () => Promise<{ bytes: number; key: string }>,
	seen: string,
	pkcheck?: string,
): Target {
	return {
		root: argv[0] === "sudo",
		argv,
		measure,
		seen,
		pkcheck,
		async remove() {
			const command = argv.join(" ");
			ctx.log(`Running ${command}`);
			const r = await ctx.run(argv, { timeoutMs: 600_000, group: true, onLine: ctx.log, onStart: ctx.onStart });
			if (r.timedOut) return MESSAGES.systemTimedOut(command);
			return r.code === 0 ? null : MESSAGES.commandExited(command, r.code);
		},
	};
}

/** "40.8M", "901.9 MB", "1.2G" as bytes; base is 1024 for journalctl, 1000 for Flatpak. null when it reads as neither. */
export function parseSize(text: string, base: number): number | null {
	const m = /([\d.]+)\s*([kKMGT]?)i?B?/.exec(text);
	if (!m?.[1]) return null;
	const power = ["", "K", "M", "G", "T"].indexOf((m[2] ?? "").toUpperCase());
	return Math.round(Number(m[1]) * base ** Math.max(0, power));
}

/** Dotted version of a dashed one: 580-159-03 to 580.159.03. */
const dotted = (dashed: string) => dashed.replaceAll("-", ".");

/** The NVIDIA driver versions in use: dpkg's installed GL libraries and the loaded kernel module. Empty without one. */
async function driverVersions(ctx: CleanupCtx): Promise<Set<string>> {
	const out = new Set<string>();
	const gl = await ctx.run(DRIVER_GL, { timeoutMs: 60_000 });
	if (!bad(gl))
		for (const l of lines(gl.stdout)) {
			const [status, version] = l.split("\t");
			const v = status?.trim() === "ii" ? /^(\d+(?:\.\d+)+)/.exec(version ?? "")?.[1] : undefined;
			if (v) out.add(v);
		}
	try {
		const module = await readFile(join(ctx.procRoot, "driver/nvidia/version"), "utf8");
		const v = /\s(\d+\.\d+(?:\.\d+)?)\s/.exec(module.split("\n")[0] ?? "")?.[1];
		if (v) out.add(v);
	} catch {
		// no NVIDIA module loaded
	}
	return out;
}

/** An item built from its parts; bytes is their sum. */
function item(
	id: CleanupId,
	group: CleanupItem["group"],
	parts: CleanupPart[],
	rest: Partial<Omit<CleanupItem, "id" | "group" | "parts">> = {},
): CleanupItem {
	return {
		id,
		group,
		parts,
		bytes: parts.reduce((a, p) => a + p.bytes, 0),
		root: false,
		undo: "none",
		typeToConfirm: false,
		...rest,
	};
}

type Found = { item: CleanupItem; targets: [string, Target][] } | null;

/** Thumbnails: the contents of each size folder. Listed when they hold anything. Cinnamon makes them again. */
async function thumbnails(ctx: CleanupCtx): Promise<Found> {
	const root = join(dirsOf(ctx.paths).cache, "thumbnails");
	const t = await treeTarget(root, { dirs: THUMBNAIL_DIRS.map((d) => join(root, d)) });
	if (t.sig.bytes === 0) return null;
	return {
		item: item("thumbnails", "safe", [{ id: "all", label: root, bytes: t.sig.bytes, ticked: true }], {
			undo: "regrows",
		}),
		targets: [[targetKey("thumbnails", "all"), t]],
	};
}

/** The home folder's Trash, files and their info together. Listed only when files/ holds something. */
async function trash(ctx: CleanupCtx): Promise<Found> {
	const root = join(dirsOf(ctx.paths).data, "Trash");
	const files = join(root, "files");
	const names = await readdir(files).catch(() => []);
	if (names.length === 0) return null;
	const t = await treeTarget(root, { dirs: [files, join(root, "info")] });
	return {
		item: item("trash", "safe", [{ id: "all", label: root, bytes: t.sig.bytes, ticked: true }]),
		targets: [[targetKey("trash", "all"), t]],
	};
}

/**
 * Upkeep's own leftovers beside installed apps and restore points: <file>.upkeep-new, -tmp or -gone. One is listed
 * only when its live file exists, and is ticked only when older than it: a copy newer than the installed file may be
 * the only good one, so it starts unticked with a note. A leftover whose live file is gone is never listed, even when
 * it is plain junk, because it may be the only copy left.
 */
async function leftovers(ctx: CleanupCtx): Promise<Found> {
	const backups = join(ctx.paths.data, "backups");
	const keys = await readdir(backups).catch(() => []);
	const dirs = [...new Set([...ctx.leftoverDirs, ...keys.map((k) => join(backups, k))])];
	const parts: CleanupPart[] = [];
	const targets: [string, Target][] = [];
	for (const dir of dirs) {
		// oxlint-disable-next-line no-await-in-loop -- one folder at a time keeps the part order stable
		const names = (await readdir(dir).catch(() => [])).toSorted();
		for (const name of names) {
			const live = LEFTOVER.exec(name)?.[1];
			if (!live) continue;
			const path = join(dir, name);
			// oxlint-disable-next-line no-await-in-loop -- as above
			const [copy, installed] = await Promise.all([statOf(path), statOf(join(dir, live))]);
			if (!copy || !installed) continue;
			// oxlint-disable-next-line no-await-in-loop -- as above
			const t = await treeTarget(dir, { path });
			const newer = copy.mtimeMs > installed.mtimeMs;
			const part: CleanupPart = { id: path, label: path, bytes: t.sig.bytes, ticked: !newer };
			if (newer) part.note = "newer-copy";
			parts.push(part);
			targets.push([targetKey("leftovers", path), t]);
		}
	}
	if (parts.length === 0) return null;
	return { item: item("leftovers", "safe", parts), targets };
}

/** Each restore point, <key>/<version>, unticked: deleting one means that version cannot be put back. */
async function restorePoints(ctx: CleanupCtx): Promise<Found> {
	const root = join(ctx.paths.data, "backups");
	const parts: CleanupPart[] = [];
	const targets: [string, Target][] = [];
	for (const key of (await readdir(root).catch(() => [])).toSorted()) {
		// oxlint-disable-next-line no-await-in-loop -- one app at a time keeps the part order stable
		const versions = (await readdir(join(root, key)).catch(() => [])).toSorted();
		for (const version of versions) {
			if (version.includes(".upkeep-")) continue;
			const path = join(root, key, version);
			// oxlint-disable-next-line no-await-in-loop -- as above
			if (!(await statOf(path))?.isDirectory()) continue;
			// oxlint-disable-next-line no-await-in-loop -- as above
			const t = await treeTarget(root, { path });
			const id = `${key}/${version}`;
			parts.push({ id, label: `${key} ${version}`, bytes: t.sig.bytes, ticked: false });
			targets.push([targetKey("restore-points", id), t]);
		}
	}
	if (parts.length === 0) return null;
	return { item: item("restore-points", "choice", parts), targets };
}

/** apt's downloaded packages, cleared by apt-get clean as root. Listed when any are there. */
async function aptCache(ctx: CleanupCtx): Promise<Found> {
	const measure = async () => {
		const r = await ctx.run(APT_CACHE_SIZES, { timeoutMs: 60_000 });
		const sizes = bad(r) ? [] : lines(r.stdout).map(Number);
		const bytes = sizes.reduce((a, n) => a + (Number.isFinite(n) ? n : 0), 0);
		return { bytes, key: `${sizes.length}:${bytes}` };
	};
	const seen = await measure();
	if (seen.bytes === 0) return null;
	return {
		item: item(
			"apt-cache",
			"safe",
			[{ id: "all", label: "/var/cache/apt/archives", bytes: seen.bytes, ticked: true }],
			{
				root: true,
				undo: "redownload",
			},
		),
		targets: [[targetKey("apt-cache", "all"), commandTarget(ctx, APT_CLEAN, measure, seen.key)]],
	};
}

/** Packages apt's dry run would autoremove, as one part: the command removes them all or none. Root, typed. */
async function autoremove(ctx: CleanupCtx): Promise<Found> {
	const measure = async () => {
		const r = await ctx.run(AUTOREMOVE_SIM, { timeoutMs: 60_000 });
		const names = bad(r) ? [] : r.stdout.split("\n").flatMap((l) => /^Remv (\S+)/.exec(l)?.[1] ?? []);
		return { bytes: 0, key: names.toSorted().join(",") };
	};
	const seen = await measure();
	if (seen.key === "") return null;
	return {
		item: item(
			"autoremove",
			"choice",
			[{ id: "all", label: seen.key.replaceAll(",", ", "), bytes: 0, ticked: false }],
			{
				bytes: null,
				root: true,
				typeToConfirm: true,
			},
		),
		targets: [[targetKey("autoremove", "all"), commandTarget(ctx, AUTOREMOVE, measure, seen.key)]],
	};
}

type GlRuntime = { ref: string; installation: string; bytes: number };

/**
 * NVIDIA GL runtimes for driver versions no longer in use: a ref is offered only when its version matches neither
 * dpkg's GL libraries nor the loaded module. With no driver found at all, none is offered, since nothing says which one
 * the GPU needs. Rolling the driver back means downloading that runtime again.
 */
async function staleGl(ctx: CleanupCtx): Promise<GlRuntime[]> {
	const [list, inUse] = await Promise.all([ctx.run(FLATPAK_RUNTIME_SIZES, { timeoutMs: 60_000 }), driverVersions(ctx)]);
	if (bad(list) || inUse.size === 0) return [];
	return lines(list.stdout).flatMap((l) => {
		const [app = "", arch = "", branch = "", installation = "", size = ""] = l.split("\t").map((c) => c.trim());
		const dashed = NVIDIA_GL.exec(app)?.[1];
		if (!dashed || inUse.has(dotted(dashed))) return [];
		return [{ ref: `${app}/${arch}/${branch}`, installation, bytes: parseSize(size, 1000) ?? 0 }];
	});
}

/** Each old NVIDIA GL runtime, uninstalled by flatpak after pkcheck says polkit lets it without a dialog. */
async function flatpakGl(ctx: CleanupCtx): Promise<Found> {
	const stale = await staleGl(ctx);
	if (stale.length === 0) return null;
	const targets: [string, Target][] = stale.map((g) => {
		const measure = async () => {
			const now = (await staleGl(ctx)).find((x) => x.ref === g.ref);
			return { bytes: now?.bytes ?? 0, key: now ? `${now.ref}:${now.bytes}` : "" };
		};
		const scope = g.installation === "user" ? "--user" : "--system";
		const argv = ["flatpak", "uninstall", scope, "-y", "--noninteractive", g.ref];
		const action = scope === "--system" ? "org.freedesktop.Flatpak.runtime-uninstall" : undefined;
		return [targetKey("flatpak-gl", g.ref), commandTarget(ctx, argv, measure, `${g.ref}:${g.bytes}`, action)];
	});
	const parts = stale.map((g) => ({ id: g.ref, label: g.ref, bytes: g.bytes, ticked: true }));
	return { item: item("flatpak-gl", "safe", parts, { undo: "redownload" }), targets };
}

/** One developer cache, behind the second switch, cleared by its own tool. A tool not on PATH leaves it out. */
async function devCache(ctx: CleanupCtx, id: keyof typeof DEV_CACHES): Promise<Found> {
	const tool = DEV_CACHES[id];
	const dir = tool.dir(dirsOf(ctx.paths));
	const probe = await ctx.run(tool.probe, { timeoutMs: 60_000 });
	if (bad(probe) || !(await statOf(dir))?.isDirectory()) return null;
	const measure = async () => {
		const s = await measureTree(dir);
		return { bytes: s.bytes, key: sigKey(s) };
	};
	const seen = await measure();
	return {
		item: item(id, "choice", [{ id: "all", label: dir, bytes: seen.bytes, ticked: false }], { undo: "redownload" }),
		targets: [[targetKey(id, "all"), commandTarget(ctx, tool.clear, measure, seen.key)]],
	};
}

/** A shown-only item: measured, never deleted, so it has no parts. */
function shown(id: CleanupId, bytes: number | null, info?: CleanupItem["info"]): Found {
	const it = { ...item(id, "shown", []), bytes };
	if (info) it.info = info;
	return { item: it, targets: [] };
}

/** /tmp on its own file system, as du counts it. The system clears it at every boot and after 30 days untouched. */
async function tmp(ctx: CleanupCtx): Promise<Found> {
	const r = await ctx.run(TMP_SIZE, { timeoutMs: 60_000 });
	// du exits 1 for a folder it cannot read and still prints the total.
	const bytes = Number(/^(\d+)/.exec(r.stdout)?.[1] ?? Number.NaN);
	return Number.isFinite(bytes) && !r.timedOut ? shown("tmp", bytes) : null;
}

/** journald's own figure for its files. */
async function journal(ctx: CleanupCtx): Promise<Found> {
	const r = await ctx.run(JOURNAL_SIZE, { timeoutMs: 60_000 });
	const bytes = bad(r) ? null : parseSize(/take up (\S+)/.exec(r.stdout)?.[1] ?? "", 1024);
	return bytes === null ? null : shown("journal", bytes);
}

/** The running kernel and the newest installed, when more than one is installed. */
async function kernels(ctx: CleanupCtx): Promise<Found> {
	const [running, list] = await Promise.all([
		ctx.run(RUNNING_KERNEL, { timeoutMs: 60_000 }),
		ctx.run(KERNELS, { timeoutMs: 60_000 }),
	]);
	if (bad(running) || bad(list)) return null;
	const versions = lines(list.stdout)
		.map((p) => p.replace(/^linux-image-/, ""))
		.toSorted((a, b) => a.localeCompare(b, "en", { numeric: true }));
	const newest = versions.at(-1);
	if (!newest || versions.length < 2) return null;
	return shown("kernels", null, { running: running.stdout.trim(), newest, count: versions.length });
}

/** Timeshift's snapshots by name, which is their date: how many and the newest. */
async function timeshift(ctx: CleanupCtx): Promise<Found> {
	const r = await ctx.run(TIMESHIFT_SNAPSHOTS, { timeoutMs: 60_000 });
	const names = bad(r) ? [] : lines(r.stdout).toSorted();
	const newest = names.at(-1);
	return newest ? shown("timeshift", null, { count: names.length, newest }) : null;
}

/** A shown item measured as the sum of the folders that exist; left out when none does. */
async function shownTrees(id: CleanupId, roots: string[]): Promise<Found> {
	const there = (await Promise.all(roots.map(async (r) => ((await statOf(r))?.isDirectory() ? r : null)))).filter(
		(r): r is string => r !== null,
	);
	if (there.length === 0) return null;
	return shown(id, (await measureAll(there)).bytes);
}

/** Copies made by hand or by another updater beside installed apps: counted and sized, never deleted. */
async function handBackups(ctx: CleanupCtx): Promise<Found> {
	let bytes = 0;
	let count = 0;
	for (const dir of ctx.leftoverDirs) {
		// oxlint-disable-next-line no-await-in-loop -- one folder at a time is enough for a handful of folders
		for (const name of await readdir(dir).catch(() => [])) {
			if (!HAND_COPY.test(name)) continue;
			// oxlint-disable-next-line no-await-in-loop -- as above
			const s = await measureTree(join(dir, name));
			bytes += s.bytes;
			count += 1;
		}
	}
	return count === 0 ? null : shown("hand-backups", bytes, { count });
}

/** Every candidate in the order the tab lists them. */
function candidates(ctx: CleanupCtx): (() => Promise<Found>)[] {
	const d = dirsOf(ctx.paths);
	const dev = ctx.devCaches ? (["uv", "bun", "npm", "pip"] as const).map((id) => () => devCache(ctx, id)) : [];
	return [
		() => thumbnails(ctx),
		() => trash(ctx),
		() => leftovers(ctx),
		() => aptCache(ctx),
		() => flatpakGl(ctx),
		() => restorePoints(ctx),
		() => autoremove(ctx),
		...dev,
		() => tmp(ctx),
		() => journal(ctx),
		() => kernels(ctx),
		() => timeshift(ctx),
		() =>
			shownTrees(
				"browser",
				BROWSER_CACHES.map((b) => join(d.cache, b)),
			),
		() => shownTrees("playwright", [join(d.cache, PLAYWRIGHT)]),
		() => handBackups(ctx),
		() => shownTrees("upkeep-cache", [ctx.paths.cache]),
	];
}

/**
 * Measures every candidate at once and reports each item as it lands, in the tab's order, so a slow cache does not
 * hold back the quick ones. A candidate that throws is left out. Nothing is deleted.
 */
export async function measureCandidates(ctx: CleanupCtx, onItem?: (items: CleanupItem[]) => void): Promise<Measured> {
	const all = candidates(ctx);
	const found: Found[] = all.map(() => null);
	await Promise.all(
		all.map(async (c, i) => {
			try {
				found[i] = await c();
			} catch (err) {
				ctx.log(`Measuring failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			onItem?.(found.flatMap((f) => (f ? [f.item] : [])));
		}),
	);
	const items = found.flatMap((f) => (f ? [f.item] : []));
	const targets = new Map(found.flatMap((f) => f?.targets ?? []));
	return { items, targets };
}

/** The picked parts that a measure knows, in the tab's order, each with its target. Unknown ids are dropped. */
function pickedParts(picks: CleanupPick[], m: Measured) {
	const wanted = new Map(picks.map((p) => [p.id, new Set(p.partIds)]));
	return m.items.flatMap((it) =>
		it.group === "shown"
			? []
			: it.parts.flatMap((p) => {
					const t = m.targets.get(targetKey(it.id, p.id));
					return wanted.get(it.id)?.has(p.id) && t ? [{ item: it, part: p, target: t }] : [];
				}),
	);
}

/**
 * What the review sheet names: the bytes the picks free and the commands they run, each as its literal argv, with how
 * many parts and which items that is. Read-only commands (sudo -n true, pkcheck, the re-measures) are not listed.
 */
export function review(picks: CleanupPick[], m: Measured) {
	const parts = pickedParts(picks, m);
	return {
		bytes: parts.reduce((a, p) => a + p.part.bytes, 0),
		commands: parts.flatMap((p) => (p.target.argv ? [p.target.argv] : [])),
		parts: parts.length,
		items: [...new Set(parts.map((p) => p.item.id))],
	};
}

/** Whether a pick removes packages, which is the one that needs the word typed. */
export const needsTyping = (picks: CleanupPick[], m: Measured) =>
	pickedParts(picks, m).some((p) => p.item.typeToConfirm);

/**
 * Deletes the picked parts in the tab's order, each only after it measures the same as at review: a part whose size
 * or time moved is skipped with a sentence, so what goes is exactly what the person saw. Root parts need sudo -n true
 * first, a system Flatpak runtime needs pkcheck; a part that fails either is skipped. A failed part does not stop the
 * next. onItem gets each item's outcome as it changes. The caller holds the run lock.
 */
export async function clean(
	picks: CleanupPick[],
	m: Measured,
	ctx: CleanupCtx,
	onItem: (o: CleanupOutcome) => void,
): Promise<CleanupOutcome[]> {
	const parts = pickedParts(picks, m);
	const sudo = parts.some((p) => p.target.root) ? !bad(await ctx.run(SUDO_CHECK, { timeoutMs: 60_000 })) : false;
	const outcomes: CleanupOutcome[] = [];
	for (const it of new Set(parts.map((p) => p.item))) {
		const o: CleanupOutcome = { id: it.id, status: "working", freed: 0 };
		onItem({ ...o });
		let done = 0;
		let skip: string | undefined;
		let fail: string | undefined;
		for (const { target } of parts.filter((p) => p.item === it)) {
			// oxlint-disable-next-line no-await-in-loop -- one part at a time is the point: a measure must see no other delete
			const before = await target.measure();
			let held =
				before.key !== target.seen ? MESSAGES.cleanChanged() : target.root && !sudo ? MESSAGES.cleanSudo() : null;
			if (!held && target.pkcheck) {
				const pkcheck = ["pkcheck", "--action-id", target.pkcheck, "--process", String(ctx.pid)];
				// oxlint-disable-next-line no-await-in-loop -- as above
				if (bad(await ctx.run(pkcheck, { timeoutMs: 60_000 }))) held = MESSAGES.cleanPolkit();
			}
			if (held) {
				skip ??= held;
				continue;
			}
			// oxlint-disable-next-line no-await-in-loop -- as above
			const why = await target.remove();
			// oxlint-disable-next-line no-await-in-loop -- as above
			const after = await target.measure();
			o.freed += Math.max(0, before.bytes - after.bytes);
			if (why) fail ??= why;
			else done += 1;
		}
		o.status = fail ? "failed" : done === 0 ? "skipped" : "done";
		const detail = fail ?? skip;
		if (detail) o.detail = detail;
		ctx.log(`${it.id}: ${o.status}, freed ${o.freed} bytes${detail ? `: ${detail}` : ""}`);
		outcomes.push(o);
		onItem({ ...o });
	}
	return outcomes;
}
