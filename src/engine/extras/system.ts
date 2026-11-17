import type { SystemRow, SystemState } from "../../shared/types";
import { isRecord } from "../manifest";
import type { Run, ProcessResult } from "../run";
import { readOnlyUsr } from "../kinds/package";

export type SystemCtx = { run: Run };

export type SystemCheck = Pick<SystemState, "rows" | "problem" | "glMissing" | "packages">;

/** The read-only commands. None needs root; none changes anything. */
export const MINT_LIST = ["mintupdate-cli", "list"];
// The package lists tried in turn when Linux Mint's is not installed. None needs root; apt and pacman -Qu read the
// system's last refresh, while dnf and checkupdates may fetch fresh metadata into a cache of their own.
export const APT_LIST = ["apt", "list", "--upgradable"];
export const DNF_LIST = ["dnf", "-q", "check-update"];
export const RPM_VERSIONS = ["rpm", "-qa", "--qf", "%{NAME}.%{ARCH}\t%{VERSION}-%{RELEASE}\n"];
// pacman-contrib's checkupdates reads a copy of the sync database; plain pacman -Qu is the fallback without it.
export const PACMAN_CHECK = ["checkupdates"];
export const PACMAN_LIST = ["pacman", "-Qu"];
// openSUSE: -n never asks, --no-refresh leaves the repositories as the system last refreshed them.
export const ZYPPER_LIST = ["zypper", "-n", "-q", "--no-refresh", "list-updates"];
export const SOURCE_VERSIONS = ["dpkg-query", "-W", "-f", "${source:Package}\t${Version}\n"];
export const FLATPAK_UPDATES = ["flatpak", "remote-ls", "--updates", "--columns=ref,name,version"];
export const FLATPAK_INSTALLED = ["flatpak", "list", "--columns=ref,name,version"];
export const FLATPAK_RUNNING = ["flatpak", "ps", "--columns=application"];
// db:Status-Abbrev, so "un" (never installed) and "rc" (removed) driver packages can be left out.
export const DRIVER_GL = ["dpkg-query", "-W", "-f", "${db:Status-Abbrev}\t${Version}\n", "libnvidia-gl-*"];
export const FLATPAK_RUNTIMES = ["flatpak", "list", "--runtime", "--columns=application"];
// Cinnamon's own spice updater, which Update Manager reads too: it ships with Cinnamon, so any Cinnamon desktop has it.
// It reads the spices' index from the web into its own cache.
export const SPICE_TYPES = ["applet", "desklet", "extension", "theme"] as const;
/** The spice updater's list of pending updates for one spice type, as JSON. */
export const spiceList = (type: SpiceType) => ["cinnamon-spice-updater", "--list-json", type];
// Snap: the pending refreshes, and what is installed now for the old version.
export const SNAP_UPDATES = ["snap", "refresh", "--list"];
export const SNAP_INSTALLED = ["snap", "list"];

type SpiceType = (typeof SPICE_TYPES)[number];

/** Trailing whitespace is dropped, and so are lines left empty. */
const lines = (s: string) =>
	s
		.split("\n")
		.map((l) => l.trimEnd())
		.filter(Boolean);

/** Update Manager's own list: "%-15s %-45s %s" of type, source package and new version. */
export function parseMintList(stdout: string): { type: string; source: string; version: string }[] {
	const out: { type: string; source: string; version: string }[] = [];
	for (const l of lines(stdout)) {
		const m = /^(\S+)\s+(\S+)\s+(\S+)$/.exec(l);
		if (m) out.push({ type: m[1] ?? "", source: m[2] ?? "", version: m[3] ?? "" });
	}
	return out;
}

/** Installed version per source package. A source with several binaries keeps its first. */
export function parseSourceVersions(stdout: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const l of lines(stdout)) {
		const [source, version] = l.split("\t");
		if (source && version && !out.has(source)) out.set(source, version);
	}
	return out;
}

/**
 * What a person calls it: Flatpak's own name, without a trailing version for a runtime (the version cell
 * carries that), else the last segment of the id, never the whole id.
 */
function displayName(name: string, app: string, kind: "app" | "runtime"): string {
	const short = kind === "runtime" ? name.replace(/\s+(version\s+)?v?\d[\w.]*$/i, "").trim() : name.trim();
	return short || app.split(".").at(-1) || app;
}

/** One row per pending Flatpak ref, with the installed version and whether the app runs now. */
export function parseFlatpakUpdates(updates: string, installed: string, running: string): SystemRow[] {
	// Lines are "ref\tname\tversion"; a runtime has no version, so its line stops after the name.
	const have = new Map<string, { name: string; version: string }>();
	for (const l of lines(installed)) {
		const [ref, name = "", version = ""] = l.split("\t");
		if (ref) have.set(ref, { name, version });
	}
	const live = new Set(lines(running));
	const rows: SystemRow[] = [];
	for (const l of lines(updates)) {
		const [ref = "", listed = "", version = ""] = l.split("\t");
		const [kind, app = "", , branch = ""] = ref.split("/");
		if (kind !== "app" && kind !== "runtime") continue;
		const bare = ref.slice(kind.length + 1);
		const mine = have.get(bare);
		rows.push({
			id: `flatpak:${ref}`,
			source: "flatpak",
			name: displayName(listed || mine?.name || "", app, kind),
			type: kind,
			// A runtime's branch is its version: found by ref, it is installed at that branch.
			installed: mine ? mine.version || (kind === "runtime" ? branch : null) : null,
			// A runtime often has no version column: its branch is what changes. An app with none is a new build of
			// the version it has, never its branch name ("stable").
			latest: version || (kind === "app" && mine?.version) || branch,
			running: kind === "app" && live.has(app),
		});
	}
	return rows;
}

/** The installed NVIDIA driver version when its Flatpak GL runtime is missing, else null. */
export function glMissing(dpkgGl: string, flatpakRuntimes: string): string | null {
	const installed = lines(dpkgGl)
		.map((l) => l.split("\t"))
		.find(([status, version]) => status?.trim() === "ii" && version)?.[1];
	const driver = installed ? /^(\d+(?:\.\d+)+)/.exec(installed)?.[1] : undefined;
	if (!driver) return null;
	const runtime = `org.freedesktop.Platform.GL.nvidia-${driver.replaceAll(".", "-")}`;
	return lines(flatpakRuntimes).includes(runtime) ? null : driver;
}

/** Update Manager's rows, typed from its first column and the source name; kernels and drivers get the note. */
function aptRows(list: string, sources: Map<string, string>): SystemRow[] {
	return parseMintList(list).map((u) => {
		const type: SystemRow["type"] =
			u.type === "kernel"
				? "kernel"
				: u.source.startsWith("nvidia-graphics-drivers")
					? "driver"
					: u.type === "security"
						? "security"
						: "package";
		const row: SystemRow = {
			id: `apt:${u.source}`,
			source: "apt",
			name: u.source,
			type,
			installed: sources.get(u.source) ?? null,
			latest: u.version,
			running: false,
		};
		if (type === "kernel" || type === "driver") row.note = "update-manager-only";
		return row;
	});
}

/**
 * A kernel or a GPU driver, by its package name on any of the four package systems; it needs a restart. Only the
 * driver, its kernel module and its GL libraries count, never a tool beside them (nvidia-settings, the CUDA or
 * container toolkits), and linux-firmware is a package. A kernel flavour not named here reads as a package.
 */
function typeOf(name: string): SystemRow["type"] | null {
	// Debian's linux-image-*, Fedora's kernel-*, openSUSE's kernel-default and its flavours, Arch's linux and its
	// flavours, each with its headers.
	const kernel =
		/^(linux-(image|headers|modules|generic|signed)|kernel($|-(core|modules|modules-extra|devel|headers)$|-(default|preempt|longterm)(-devel)?$)|linux(-(lts|zen|hardened|rt|rt-lts|cachyos))?(-headers)?$)/;
	if (kernel.test(name)) return "kernel";
	// The driver, its kernel module and its GL libraries; never nvidia-settings, the CUDA or container toolkits.
	const driver =
		/^(nvidia(-(driver|dkms|open|lts|utils|kernel|graphics-drivers|firmware|gl|video)(-|$)|-?\d|-G\d|$)|lib32-nvidia-utils$|libnvidia-gl-\d|a?kmod-nvidia$|xorg-x11-drv-nvidia$)/;
	return driver.test(name) ? "driver" : null;
}

/** A row for a package list other than Update Manager's; kernels and drivers get the restart note. */
function packageRow(
	source: "apt" | "dnf" | "pacman" | "zypper",
	name: string,
	installed: string | null,
	latest: string,
	security = false,
	id = `${source}:${name}`,
): SystemRow {
	const type = typeOf(name) ?? (security ? "security" : "package");
	const row: SystemRow = { id, source, name, type, installed, latest, running: false };
	if (type === "kernel" || type === "driver") row.note = "update-manager-only";
	return row;
}

/**
 * apt list --upgradable: "name/suite,... version arch [upgradable from: old]"; a -security suite marks a security
 * fix, and the arch goes in the id.
 */
export function parseAptList(stdout: string): SystemRow[] {
	const rows: SystemRow[] = [];
	for (const l of lines(stdout)) {
		const m = /^([^/\s]+)\/(\S+)\s+(\S+)\s+(\S+)(?:\s+\[upgradable from: ([^\]]+)\])?/.exec(l);
		if (!m) continue;
		const [, name = "", suites = "", version = "", arch = "", from] = m;
		// A multiarch package is listed once per arch (libc6 for amd64 and i386), so the arch is in the id.
		rows.push(packageRow("apt", name, from ?? null, version, suites.includes("-security"), `apt:${name}.${arch}`));
	}
	return rows;
}

/**
 * dnf check-update: "name.arch  version  repo" per line, the arch cut off the name and kept in the id, since a
 * multilib package (glibc.x86_64 and glibc.i686) is listed once per arch. A name too long for its column is wrapped:
 * it stands alone, and its version and repo follow on the next, indented line. It stops at "Obsoleting Packages",
 * which lists replacements, not updates. installed is name.arch to version from rpm, so each arch shows its own.
 */
export function parseDnfList(stdout: string, installed: Map<string, string>): SystemRow[] {
	const rows: SystemRow[] = [];
	const all = lines(stdout);
	for (let i = 0; i < all.length; i++) {
		let l = all[i] ?? "";
		if (/^Obsoleting/i.test(l)) break;
		if (/^\S+\.[^.\s]+$/.test(l) && /^\s+\S+\s+\S+$/.test(all[i + 1] ?? "")) {
			i += 1;
			l = `${l} ${(all[i] ?? "").trim()}`;
		}
		const m = /^(\S+)\.([^.\s]+)\s+(\S+)\s+\S+$/.exec(l);
		if (!m) continue;
		const [, name = "", arch = "", version = ""] = m;
		rows.push(packageRow("dnf", name, installed.get(`${name}.${arch}`) ?? null, version, false, `dnf:${name}.${arch}`));
	}
	return rows;
}

/** checkupdates and pacman -Qu: "name old -> new" per line. A package pacman.conf ignores is not pending, so it is left out. */
export function parsePacmanList(stdout: string): SystemRow[] {
	const rows: SystemRow[] = [];
	for (const l of lines(stdout)) {
		if (l.endsWith("[ignored]")) continue;
		const m = /^(\S+)\s+(\S+)\s+->\s+(\S+)/.exec(l);
		if (m) rows.push(packageRow("pacman", m[1] ?? "", m[2] ?? null, m[3] ?? ""));
	}
	return rows;
}

/**
 * zypper list-updates: a table of "S | Repository | Name | Current Version | Available Version | Arch". Rows start
 * after the "---+---" rule, so a header zypper translated for the locale is never read as a package. The arch goes
 * in the id, as with apt.
 */
export function parseZypperList(stdout: string): SystemRow[] {
	const rows: SystemRow[] = [];
	let body = false;
	for (const l of lines(stdout)) {
		if (/^-+\+/.test(l)) {
			body = true;
			continue;
		}
		const cells = l.split("|").map((c) => c.trim());
		const [, , name = "", current = "", available = "", arch = ""] = cells;
		if (!body || cells.length < 6 || !name || !available) continue;
		rows.push(packageRow("zypper", name, current || null, available, false, `zypper:${name}.${arch}`));
	}
	return rows;
}

/**
 * cinnamon-spice-updater --list-json: an object of spices with an update, by uuid, each with name, old_version and
 * new_version. Null when the text is not that object: the updater prints "Cinnamon updates failed: …" and exits 0
 * when it cannot fetch the index, and that is a failed read, not an empty list.
 */
export function parseSpices(stdout: string, type: SpiceType): SystemRow[] | null {
	let data: unknown;
	try {
		data = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (!isRecord(data)) return null;
	return Object.entries(data).flatMap(([uuid, value]) => {
		if (!isRecord(value) || typeof value.new_version !== "string" || !value.new_version) return [];
		const name = typeof value.name === "string" && value.name ? value.name : uuid;
		const installed = typeof value.old_version === "string" && value.old_version ? value.old_version : null;
		const row: SystemRow = {
			id: `cinnamon:${type}:${uuid}`,
			source: "cinnamon",
			name,
			type,
			installed,
			latest: value.new_version,
			running: false,
		};
		return [row];
	});
}

/** A snap table's rows: its lines past the "Name ..." header. */
const snapBody = (s: string) => lines(s).filter((l, i) => !(i === 0 && l.startsWith("Name")));

/**
 * snap refresh --list, with snap list for the installed versions: both are tables whose first line is a header
 * starting "Name", with the name and the version in the first two columns. "All snaps up to date." goes to stderr.
 */
export function parseSnapList(updates: string, installed: string): SystemRow[] {
	const now = new Map(
		snapBody(installed)
			.map((l) => l.split(/\s+/))
			.map(([n = "", v = ""]) => [n, v]),
	);
	return snapBody(updates).flatMap((l) => {
		const [name = "", latest = ""] = l.split(/\s+/);
		// snapd writes "All snaps up to date." to stderr; a version that says so on stdout still lists nothing.
		if (!name || !latest || l.startsWith("All snaps")) return [];
		const row: SystemRow = {
			id: `snap:${name}`,
			source: "snap",
			name,
			type: "snap",
			installed: now.get(name) ?? null,
			latest,
			running: false,
		};
		return [row];
	});
}

/** A command that did not answer, timed out or exited non-zero is not ok. */
const ok = (r: ProcessResult | undefined) => r !== undefined && r.code === 0 && !r.timedOut;

/** Exit 127 is a missing command; any other failure or a timeout is failed, with stderr's first line. */
function problemOf(argv: string[], r: ProcessResult): SystemCheck["problem"] {
	const command = argv.join(" ");
	if (r.code === 127 && !r.timedOut) return { code: "missing", command };
	if (r.code !== 0 || r.timedOut)
		return { code: "failed", command, detail: (r.stderr || r.stdout).trim().split("\n")[0] ?? "" };
	return null;
}

/** One package system's answer: its rows and the problem reading it, or nothing when it is not installed. */
type PackageAnswer = {
	packages: NonNullable<SystemState["packages"]>;
	rows: SystemRow[];
	problem: SystemCheck["problem"];
};

/** A command's run with its expected exit codes counted as ok; any other code is a failure, 127 a missing tool. */
async function listWith(
	ctx: SystemCtx,
	argv: string[],
	okCodes: number[],
): Promise<{ missing: true } | { missing: false; stdout: string; problem: SystemCheck["problem"] }> {
	const r = await ctx.run(argv, { timeoutMs: 60_000 });
	if (r.code === 127 && !r.timedOut) return { missing: true };
	const fine = okCodes.includes(r.code) && !r.timedOut;
	return { missing: false, stdout: r.stdout, problem: fine ? null : problemOf(argv, { ...r, code: r.code || 1 }) };
}

/**
 * The first package list this system has: Linux Mint's Update Manager, then apt, dnf, pacman (checkupdates, else
 * pacman -Qu) and zypper. Each is tried only when the one before it is not installed. None needs root. Null when none
 * is installed. A checkupdates that fails (it needs fakeroot, which pacman-contrib does not pull in) falls back to
 * pacman -Qu, so a working pacman still lists. On an image-based system (read-only /usr) none is read: their updates
 * come as a whole image, and dnf there lists packages it cannot install. Flatpak, the usual way to add apps there,
 * still lists.
 */
async function packageList(ctx: SystemCtx): Promise<PackageAnswer | null | "image"> {
	const opts = { timeoutMs: 60_000 };
	const [image, list, sources] = await Promise.all([
		readOnlyUsr(ctx.run),
		ctx.run(MINT_LIST, opts),
		ctx.run(SOURCE_VERSIONS, opts),
	]);
	if (image) return "image";
	if (!(list.code === 127 && !list.timedOut)) {
		const problem = problemOf(MINT_LIST, list);
		const versions = ok(sources) ? parseSourceVersions(sources.stdout) : new Map<string, string>();
		return { packages: "mint", rows: problem ? [] : aptRows(list.stdout, versions), problem };
	}
	const apt = await listWith(ctx, APT_LIST, [0]);
	if (!apt.missing) return { packages: "apt", rows: apt.problem ? [] : parseAptList(apt.stdout), problem: apt.problem };
	// dnf check-update exits 100 when there are updates and 0 when there are none.
	const dnf = await listWith(ctx, DNF_LIST, [0, 100]);
	if (!dnf.missing) {
		const rpm = await ctx.run(RPM_VERSIONS, opts);
		const versions = ok(rpm) ? parseSourceVersions(rpm.stdout) : new Map<string, string>();
		return { packages: "dnf", rows: dnf.problem ? [] : parseDnfList(dnf.stdout, versions), problem: dnf.problem };
	}
	// checkupdates exits 2 when there is nothing to update; pacman -Qu exits 1 then.
	const check = await listWith(ctx, PACMAN_CHECK, [0, 2]);
	const pac = check.missing || check.problem ? await listWith(ctx, PACMAN_LIST, [0, 1]) : check;
	if (!pac.missing)
		return { packages: "pacman", rows: pac.problem ? [] : parsePacmanList(pac.stdout), problem: pac.problem };
	// 106: some repositories could not be read, and the rest still listed.
	const zypper = await listWith(ctx, ZYPPER_LIST, [0, 106]);
	if (!zypper.missing)
		return {
			packages: "zypper",
			rows: zypper.problem ? [] : parseZypperList(zypper.stdout),
			problem: zypper.problem,
		};
	return null;
}

/**
 * Lists the pending system updates, read-only: the first package list this system has, and Flatpak, side by side.
 * A source that cannot answer leaves its rows out and names the problem; the other source still lists. With no
 * package list at all, the problem is Update Manager's missing command, which the view says quietly.
 */
export async function checkSystem(ctx: SystemCtx): Promise<SystemCheck> {
	const opts = { timeoutMs: 60_000 };
	const [pkg, [updates, installed, running, gl, runtimes], spices, [snapUpdates, snapInstalled]] = await Promise.all([
		packageList(ctx),
		Promise.all(
			[FLATPAK_UPDATES, FLATPAK_INSTALLED, FLATPAK_RUNNING, DRIVER_GL, FLATPAK_RUNTIMES].map((argv) =>
				ctx.run(argv, opts),
			),
		),
		Promise.all(SPICE_TYPES.map(async (type) => ({ type, r: await ctx.run(spiceList(type), opts) }))),
		Promise.all([SNAP_UPDATES, SNAP_INSTALLED].map((argv) => ctx.run(argv, opts))),
	]);
	const list = pkg === "image" ? null : pkg;
	const rows: SystemRow[] = [...(list?.rows ?? [])];
	const mintProblem: SystemCheck["problem"] =
		pkg === "image" ? null : list ? list.problem : { code: "missing", command: MINT_LIST.join(" ") };
	const flatpakProblem = updates ? problemOf(FLATPAK_UPDATES, updates) : null;
	if (updates && !flatpakProblem)
		rows.push(
			...parseFlatpakUpdates(
				updates.stdout,
				ok(installed) ? (installed?.stdout ?? "") : "",
				ok(running) ? (running?.stdout ?? "") : "",
			),
		);
	// Spices and snaps are listed when their tool answers; a desktop without Cinnamon or a system without snapd says nothing.
	let spiceProblem: SystemCheck["problem"] = null;
	for (const { type, r } of spices) {
		if (!ok(r)) continue;
		const found = parseSpices(r.stdout, type);
		if (found) rows.push(...found);
		else
			spiceProblem ??= {
				code: "failed",
				command: spiceList(type).join(" "),
				// The window says it could not read the Cinnamon list, so the updater's own lead-in is dropped.
				detail: (r.stdout.trim().split("\n")[0] ?? "").replace(/^Cinnamon updates failed:\s*/, ""),
			};
	}
	if (ok(snapUpdates))
		rows.push(...parseSnapList(snapUpdates?.stdout ?? "", ok(snapInstalled) ? (snapInstalled?.stdout ?? "") : ""));
	return {
		rows,
		// A tool this system lacks is said quietly in the window, so a real failure elsewhere goes first.
		problem:
			[mintProblem, flatpakProblem, spiceProblem].find((p) => p?.code === "failed") ?? mintProblem ?? flatpakProblem,
		glMissing: ok(gl) && ok(runtimes) ? glMissing(gl?.stdout ?? "", runtimes?.stdout ?? "") : null,
		packages: list?.packages ?? null,
	};
}

/** The installed Flatpak apps by id and name, and the Snaps by name: the system's other copies an app may have. */
export type SystemCopies = { flatpaks: { id: string; name: string }[]; snaps: string[] };

/** Reads the Flatpak and Snap lists once, read-only. A tool that is missing or fails gives an empty list. */
export async function readCopies(ctx: SystemCtx): Promise<SystemCopies> {
	const opts = { timeoutMs: 20_000 };
	const [fp, sn] = await Promise.all([
		ctx.run(["flatpak", "list", "--app", "--columns=application,name"], opts),
		ctx.run(SNAP_INSTALLED, opts),
	]);
	const flatpaks =
		fp.code === 0
			? lines(fp.stdout).flatMap((l) => {
					const [id = "", name = ""] = l.split("\t");
					return id ? [{ id, name }] : [];
				})
			: [];
	// snap list's first line is its header: Name Version Rev Tracking Publisher Notes.
	const snaps =
		sn.code === 0
			? lines(sn.stdout)
					.slice(1)
					.map((l) => l.split(/\s+/)[0] ?? "")
					.filter(Boolean)
			: [];
	return { flatpaks, snaps };
}

/** Lowercase with spaces, dashes, dots and underscores gone, so "Zen Browser", "zen-browser" and zen_browser meet. */
const squash = (s: string) => s.toLowerCase().replace(/[\s._-]+/g, "");

/**
 * The other copies of an app, by its key and its name: a Flatpak whose name or last id segment matches, and a Snap of
 * the same name. A match on a name this short (two letters) would be a guess, so it is left out.
 */
export function copiesOf(
	key: string,
	name: string,
	copies: SystemCopies,
): { flatpak: string | null; snap: string | null } {
	const want = new Set([squash(key), squash(name)].filter((w) => w.length > 2));
	const flatpak = copies.flatpaks.find(
		(f) => want.has(squash(f.name)) || want.has(squash(f.id.split(".").at(-1) ?? "")),
	);
	const snap = copies.snaps.find((s) => want.has(squash(s)));
	return { flatpak: flatpak?.id ?? null, snap: snap ?? null };
}

/**
 * True when apt knows pkg from a repository as well as from what is installed: "apt-cache policy" lists a source
 * other than dpkg's status file. Then the system's own updates install it too. Missing apt, or an unknown package, is false.
 */
export async function aptRepoHas(ctx: SystemCtx, pkg: string): Promise<boolean> {
	const r = await ctx.run(["apt-cache", "policy", pkg], { timeoutMs: 20_000 });
	if (r.code !== 0) return false;
	return lines(r.stdout).some((l) => /^\s+\d+\s+(https?|file|cdrom|mirror):/.test(l));
}
