import type { SystemRow, SystemState } from "../../shared/types";
import type { Run, ProcessResult } from "../run";

export type SystemCtx = { run: Run };

export type SystemCheck = Pick<SystemState, "rows" | "problem" | "glMissing" | "packages">;

/** The read-only commands. None needs root; none changes anything. */
export const MINT_LIST = ["mintupdate-cli", "list"];
// The package lists tried in turn when Linux Mint's is not installed; each reads its own cache, none refreshes it.
export const APT_LIST = ["apt", "list", "--upgradable"];
export const DNF_LIST = ["dnf", "-q", "check-update"];
export const RPM_VERSIONS = ["rpm", "-qa", "--qf", "%{NAME}\t%{VERSION}-%{RELEASE}\n"];
// pacman-contrib's checkupdates reads a copy of the sync database; plain pacman -Qu is the fallback without it.
export const PACMAN_CHECK = ["checkupdates"];
export const PACMAN_LIST = ["pacman", "-Qu"];
export const SOURCE_VERSIONS = ["dpkg-query", "-W", "-f", "${source:Package}\t${Version}\n"];
export const FLATPAK_UPDATES = ["flatpak", "remote-ls", "--updates", "--columns=ref,name,version"];
export const FLATPAK_INSTALLED = ["flatpak", "list", "--columns=ref,name,version"];
export const FLATPAK_RUNNING = ["flatpak", "ps", "--columns=application"];
// db:Status-Abbrev, so "un" (never installed) and "rc" (removed) driver packages can be left out.
export const DRIVER_GL = ["dpkg-query", "-W", "-f", "${db:Status-Abbrev}\t${Version}\n", "libnvidia-gl-*"];
export const FLATPAK_RUNTIMES = ["flatpak", "list", "--runtime", "--columns=application"];

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
			// A runtime often has no version column: its branch is what changes.
			latest: version || branch,
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

/** A kernel or a GPU driver, by its package name on any of the four package systems; it needs a restart. */
function typeOf(name: string): SystemRow["type"] | null {
	if (/^(linux-(image|headers|modules|generic|signed)|kernel($|-)|linux(-lts|-zen|-hardened)?$)/.test(name))
		return "kernel";
	if (/nvidia/.test(name)) return "driver";
	return null;
}

/** A row for a package list other than Update Manager's; kernels and drivers get the restart note. */
function packageRow(
	source: "apt" | "dnf" | "pacman",
	name: string,
	installed: string | null,
	latest: string,
	security = false,
): SystemRow {
	const type = typeOf(name) ?? (security ? "security" : "package");
	const row: SystemRow = { id: `${source}:${name}`, source, name, type, installed, latest, running: false };
	if (type === "kernel" || type === "driver") row.note = "update-manager-only";
	return row;
}

/** apt list --upgradable: "name/suite,... version arch [upgradable from: old]"; a -security suite marks a security fix. */
export function parseAptList(stdout: string): SystemRow[] {
	const rows: SystemRow[] = [];
	for (const l of lines(stdout)) {
		const m = /^([^/\s]+)\/(\S+)\s+(\S+)\s+\S+(?:\s+\[upgradable from: ([^\]]+)\])?/.exec(l);
		if (m) rows.push(packageRow("apt", m[1] ?? "", m[4] ?? null, m[3] ?? "", (m[2] ?? "").includes("-security")));
	}
	return rows;
}

/**
 * dnf check-update: "name.arch  version  repo" per line, the arch cut off the name, until an "Obsoleting Packages"
 * section, which lists replacements, not updates. installed is name to version from rpm.
 */
export function parseDnfList(stdout: string, installed: Map<string, string>): SystemRow[] {
	const rows: SystemRow[] = [];
	for (const l of lines(stdout)) {
		if (/^Obsoleting/i.test(l)) break;
		const m = /^(\S+)\.[^.\s]+\s+(\S+)\s+\S+$/.exec(l);
		if (m) rows.push(packageRow("dnf", m[1] ?? "", installed.get(m[1] ?? "") ?? null, m[2] ?? ""));
	}
	return rows;
}

/** checkupdates and pacman -Qu: "name old -> new" per line. */
export function parsePacmanList(stdout: string): SystemRow[] {
	const rows: SystemRow[] = [];
	for (const l of lines(stdout)) {
		const m = /^(\S+)\s+(\S+)\s+->\s+(\S+)/.exec(l);
		if (m) rows.push(packageRow("pacman", m[1] ?? "", m[2] ?? null, m[3] ?? ""));
	}
	return rows;
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
 * The first package list this system has: Linux Mint's Update Manager, then apt, dnf and pacman (checkupdates, else
 * pacman -Qu). Each is tried only when the one before it is not installed. None of them needs root or refreshes a
 * cache, so the lists are as fresh as the system's own last refresh. Null when none is installed.
 */
async function packageList(ctx: SystemCtx): Promise<PackageAnswer | null> {
	const opts = { timeoutMs: 60_000 };
	const [list, sources] = await Promise.all([ctx.run(MINT_LIST, opts), ctx.run(SOURCE_VERSIONS, opts)]);
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
	const pac = check.missing ? await listWith(ctx, PACMAN_LIST, [0, 1]) : check;
	if (!pac.missing)
		return { packages: "pacman", rows: pac.problem ? [] : parsePacmanList(pac.stdout), problem: pac.problem };
	return null;
}

/**
 * Lists the pending system updates, read-only: the first package list this system has, and Flatpak, side by side.
 * A source that cannot answer leaves its rows out and names the problem; the other source still lists. With no
 * package list at all, the problem is Update Manager's missing command, which the view says quietly.
 */
export async function checkSystem(ctx: SystemCtx): Promise<SystemCheck> {
	const opts = { timeoutMs: 60_000 };
	const [pkg, [updates, installed, running, gl, runtimes]] = await Promise.all([
		packageList(ctx),
		Promise.all(
			[FLATPAK_UPDATES, FLATPAK_INSTALLED, FLATPAK_RUNNING, DRIVER_GL, FLATPAK_RUNTIMES].map((argv) =>
				ctx.run(argv, opts),
			),
		),
	]);
	const rows: SystemRow[] = [...(pkg?.rows ?? [])];
	const mintProblem: SystemCheck["problem"] = pkg ? pkg.problem : { code: "missing", command: MINT_LIST.join(" ") };
	const flatpakProblem = updates ? problemOf(FLATPAK_UPDATES, updates) : null;
	if (updates && !flatpakProblem)
		rows.push(
			...parseFlatpakUpdates(
				updates.stdout,
				ok(installed) ? (installed?.stdout ?? "") : "",
				ok(running) ? (running?.stdout ?? "") : "",
			),
		);
	return {
		rows,
		problem: mintProblem ?? flatpakProblem,
		glMissing: ok(gl) && ok(runtimes) ? glMissing(gl?.stdout ?? "", runtimes?.stdout ?? "") : null,
		packages: pkg?.packages ?? null,
	};
}
