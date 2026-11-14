import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

/** The names Upkeep keeps beside its app folder, in the channel root, which an update never replaces. */
export const SELF_FILES = {
	/** The start script the menu entry and the login entry run. */
	shim: "upkeep-start.sh",
	/** One update attempt, from just before the swap until the next Upkeep that starts settles it. */
	attempt: ".upkeep-update.json",
	/** A full copy of the version being replaced. */
	keep: "app.keep",
	/** The person's files as the old version last wrote them, with a list of where each belongs. */
	configKeep: ".upkeep-config-keep",
	/** The new tree after a rollback, for a bug report. */
	failed: "app.failed",
	/** The hash the start script rolled back, for the next Upkeep to report. */
	rolledBack: ".upkeep-rolled-back",
} as const;

/** The marker a running Upkeep writes once it is up: the start script reads it as "this version has started". */
export const okMarker = (hash: string) => `.upkeep-ok-${hash}`;

/**
 * One update attempt. The keys are flat and each value sits on its own line, because the start script reads the two
 * hashes with sed and never parses JSON.
 */
export type Attempt = {
	fromVersion: string;
	fromHash: string;
	toVersion: string;
	toHash: string;
	/** Whether the window was open, so the version that comes up shows it again or stays in the tray. */
	window: boolean;
	startedAt: string;
};

/**
 * The start script. It never waits, never ends a process and never deletes: it renames, copies and starts.
 *
 * 1. The app folder has no launcher and an attempt is recorded: an update was cut off between its two renames. The
 *    old tree is put back from app.previous (the framework's name for it), else from the kept copy.
 * 2. An attempt is recorded, the app folder is the new version, that version never wrote its marker, the kept copy is
 *    the old version, and nothing runs from the app folder: the new version did not come up. The old one is put back,
 *    with the person's files as it last wrote them. A new version that is still starting is running, so it is left.
 * 3. The launcher is started. Every path reaches this step.
 *
 * What it gets wrong: a machine switched off in the first seconds after a swap has a healthy new version put back
 * once, since "never confirmed and not running" is all it can see.
 */
export const START_SH = `#!/bin/sh
# Starts Upkeep. Before that, repairs an install that an interrupted update left without its app folder, and puts
# the previous version back when a new one never confirmed that it came up. Written by Upkeep at every start.
root=$1
case "$root" in
/*) ;;
*)
	echo "upkeep-start: the install folder must be an absolute path" >&2
	exit 64
	;;
esac
app="$root/app"
attempt="$root/${SELF_FILES.attempt}"
keep="$root/${SELF_FILES.keep}"
failed="$root/${SELF_FILES.failed}"
config="$root/${SELF_FILES.configKeep}"

# value FILE KEY: what a "KEY":"..." pair in FILE holds, or nothing.
value() {
	[ -f "$1" ] || return 0
	sed -n 's/.*"'"$2"'"[ ]*:[ ]*"\\([a-z0-9]*\\)".*/\\1/p' "$1" | sed -n 1p
}

# running: true while some process runs a program from the app folder.
running() {
	for exe in /proc/[0-9]*/exe; do
		target=$(readlink "$exe" 2>/dev/null) || continue
		case "$target" in
		"$app"/*) return 0 ;;
		esac
	done
	return 1
}

# aside PATH: moves PATH out of the way under a name of its own, so nothing here ever deletes.
aside() {
	[ -e "$1" ] || return 0
	mv "$1" "$1.$$"
}

# restore_config: puts back each file the old version last wrote, to where the list says it belongs.
restore_config() {
	[ -f "$config/where" ] || return 0
	while IFS='	' read -r name dest; do
		[ -n "$name" ] && [ -f "$config/$name" ] && cp -p "$config/$name" "$dest"
	done <"$config/where"
	return 0
}

if [ -f "$attempt" ] && [ ! -x "$app/bin/launcher" ]; then
	source=
	if [ -x "$root/app.previous/bin/launcher" ]; then
		source="$root/app.previous"
	elif [ -x "$keep/bin/launcher" ]; then
		source="$keep"
	fi
	if [ -n "$source" ]; then
		aside "$failed"
		if [ -e "$app" ]; then mv "$app" "$failed"; fi
		if [ ! -e "$app" ]; then mv "$source" "$app"; fi
	fi
elif [ -f "$attempt" ]; then
	to=$(value "$attempt" toHash)
	from=$(value "$attempt" fromHash)
	now=$(value "$app/Resources/version.json" hash)
	kept=$(value "$keep/Resources/version.json" hash)
	if [ -n "$to" ] && [ -n "$from" ] && [ "$now" = "$to" ] && [ "$kept" = "$from" ] &&
		[ ! -e "$root/.upkeep-ok-$to" ] && ! running; then
		aside "$failed"
		if mv "$app" "$failed"; then
			if mv "$keep" "$app"; then
				restore_config
				printf '%s\\n' "$to" >"$root/${SELF_FILES.rolledBack}"
			else
				mv "$failed" "$app"
			fi
		fi
	fi
fi

if [ ! -x "$app/bin/launcher" ]; then
	echo "upkeep-start: no Upkeep to start in $root; run the installer again" >&2
	exit 69
fi
shift
exec "$app/bin/launcher" "$@" </dev/null >/dev/null 2>&1
`;

/**
 * Writes the start script into the channel root, by rename, so a shell that is running the old copy keeps reading
 * the file it opened. Skipped when the bytes already match, so a healthy install is never rewritten.
 */
export function installShim(root: string): void {
	const file = join(root, SELF_FILES.shim);
	try {
		if (readFileSync(file, "utf8") === START_SH) return;
	} catch {
		// Not there yet, or unreadable: write it.
	}
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, START_SH, { mode: 0o700 });
	chmodSync(tmp, 0o700);
	renameSync(tmp, file);
}

/** A root made only of these characters needs no quoting in a shell or a desktop entry. */
const PLAIN_PATH = /^\/[A-Za-z0-9._/+@-]+$/;

/**
 * What a menu or login entry runs, as an argument list: the start script when it is there, the launcher itself when
 * it is not, so a deleted script never leaves a dead entry. A plain root (the usual ~/.local/share/...) is written into
 * the script as is, so the Exec line holds no escaped quote or $: dex, which i3 and other minimal sessions use for
 * autostart, refuses those. Any other root travels as the script's $0, which keeps spaces or quotes whole.
 */
export function entryArgv(root: string): string[] {
	const shim = SELF_FILES.shim;
	const script = PLAIN_PATH.test(root)
		? `[ -f ${root}/${shim} ] && exec sh ${root}/${shim} ${root}; exec ${root}/app/bin/launcher`
		: `[ -f "$0/${shim}" ] && exec sh "$0/${shim}" "$0"; exec "$0/app/bin/launcher"`;
	return ["sh", "-c", script, root];
}

/** Every file and link under dir as "relative path -> what it is": a size for a file, a target for a link. */
function listTree(dir: string, under = ""): Map<string, string> {
	const out = new Map<string, string>();
	for (const name of readdirSync(join(dir, under))) {
		const rel = under ? `${under}/${name}` : name;
		const stat = lstatSync(join(dir, rel));
		if (stat.isSymbolicLink()) out.set(rel, `link ${readlinkSync(join(dir, rel))}`);
		else if (stat.isDirectory()) for (const [k, v] of listTree(dir, rel)) out.set(k, v);
		else out.set(rel, `file ${stat.size} ${stat.mode & 0o111 ? "x" : "-"}`);
	}
	return out;
}

/** The bytes of every file under dir, links not followed; 0 for a folder that is not there. */
export function treeBytes(dir: string): number {
	let total = 0;
	try {
		for (const name of readdirSync(dir)) {
			const stat = lstatSync(join(dir, name));
			total += stat.isDirectory() ? treeBytes(join(dir, name)) : stat.size;
		}
	} catch {
		// gone or unreadable: counts as nothing
	}
	return total;
}

/**
 * Copies the app folder to the kept copy and checks it: every file with its size and whether it runs, every link
 * with its target. A copy that differs is removed and reported, since a kept copy that cannot start is worse than
 * none. A full copy, not hard links: the framework's staging may change a file in place, and a link would change
 * with it. `copy` is the copier, so a test can hand in one that fails.
 */
export function keepCopy(
	from: string,
	to: string,
	copy: (from: string, to: string) => void = (a, b) => cpSync(a, b, { recursive: true, verbatimSymlinks: true }),
): void {
	rmSync(to, { recursive: true, force: true });
	copy(from, to);
	const want = listTree(from);
	const got = listTree(to);
	const same = want.size === got.size && [...want].every(([k, v]) => got.get(k) === v);
	if (!same) {
		rmSync(to, { recursive: true, force: true });
		throw new Error(`the kept copy of ${from} does not match it`);
	}
}

/**
 * Copies the person's files into the channel root with a list of where each belongs, one "name<TAB>path" per line,
 * which the start script reads on a rollback. A file that does not exist yet is left out. A path holding a tab or a
 * line break cannot be listed and is left out too.
 */
export function keepConfig(root: string, files: string[]): void {
	const dir = join(root, SELF_FILES.configKeep);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const where: string[] = [];
	for (const [i, file] of files.entries()) {
		if (!isAbsolute(file) || /[\t\n]/.test(file) || !existsSync(file)) continue;
		const name = `file${i}`;
		copyFileSync(file, join(dir, name));
		where.push(`${name}\t${file}`);
	}
	writeFileSync(join(dir, "where"), where.map((l) => `${l}\n`).join(""));
}

/**
 * Removes what an attempt left once it is settled: the kept copy and the kept files, and with failedToo every tree
 * set aside. After a rollback the tree that would not start is left for a bug report, until the next attempt.
 */
export function clearKept(root: string, failedToo: boolean): void {
	if (!isAbsolute(root)) return;
	rmSync(join(root, SELF_FILES.keep), { recursive: true, force: true });
	rmSync(join(root, SELF_FILES.configKeep), { recursive: true, force: true });
	if (!failedToo) return;
	for (const name of readdirSync(root))
		if (name === SELF_FILES.failed || name.startsWith(`${SELF_FILES.failed}.`))
			rmSync(join(root, name), { recursive: true, force: true });
}

/** Writes the attempt with one key per line, the shape the start script reads. */
export function writeAttempt(root: string, attempt: Attempt): void {
	const file = join(root, SELF_FILES.attempt);
	writeFileSync(`${file}.tmp`, `${JSON.stringify(attempt, null, "\t")}\n`);
	renameSync(`${file}.tmp`, file);
}

/**
 * The recorded attempt, or null when there is none or a field is missing. Read field by field, the way the start
 * script reads it, so what one accepts the other does too.
 */
export function readAttempt(root: string): Attempt | null {
	let text = "";
	try {
		text = readFileSync(join(root, SELF_FILES.attempt), "utf8");
	} catch {
		return null;
	}
	/** The quoted value of one key, or undefined. */
	const field = (key: string) => new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*)"`).exec(text)?.[1];
	const window = /"window"\s*:\s*(true|false)/.exec(text)?.[1];
	const [fromVersion, fromHash, toVersion, toHash, startedAt] = [
		field("fromVersion"),
		field("fromHash"),
		field("toVersion"),
		field("toHash"),
		field("startedAt"),
	];
	if (!fromVersion || !fromHash || !toVersion || !toHash || !startedAt || !window) return null;
	return { fromVersion, fromHash, toVersion, toHash, window: window === "true", startedAt };
}
