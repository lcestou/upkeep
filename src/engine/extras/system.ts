import type { SystemRow, SystemState } from "../../shared/types";
import type { Run, RunResult } from "../run";

export type SystemCtx = { run: Run };

export type SystemCheck = Pick<SystemState, "rows" | "problem" | "glMissing">;

/** The seven read-only commands. None needs root; none changes anything. */
export const MINT_LIST = ["mintupdate-cli", "list"];
export const SOURCE_VERSIONS = ["dpkg-query", "-W", "-f", "${source:Package}\t${Version}\n"];
export const FLATPAK_UPDATES = ["flatpak", "remote-ls", "--updates", "--columns=ref,version"];
export const FLATPAK_INSTALLED = ["flatpak", "list", "--columns=ref,version"];
export const FLATPAK_RUNNING = ["flatpak", "ps", "--columns=application"];
// db:Status-Abbrev, so "un" (never installed) and "rc" (removed) driver packages can be left out.
export const DRIVER_GL = ["dpkg-query", "-W", "-f", "${db:Status-Abbrev}\t${Version}\n", "libnvidia-gl-*"];
export const FLATPAK_RUNTIMES = ["flatpak", "list", "--runtime", "--columns=application"];

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

/** One row per pending Flatpak ref, with the installed version and whether the app runs now. */
export function parseFlatpakUpdates(updates: string, installed: string, running: string): SystemRow[] {
	const have = new Map<string, string>();
	for (const l of lines(installed)) {
		const [ref, version] = l.split("\t");
		if (ref) have.set(ref, version ?? "");
	}
	const live = new Set(lines(running));
	const rows: SystemRow[] = [];
	for (const l of lines(updates)) {
		const [ref = "", version = ""] = l.split("\t");
		const [kind, app = "", , branch = ""] = ref.split("/");
		if (kind !== "app" && kind !== "runtime") continue;
		const bare = ref.slice(kind.length + 1);
		rows.push({
			id: `flatpak:${ref}`,
			source: "flatpak",
			name: app,
			type: kind,
			installed: have.get(bare) || null,
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

const ok = (r: RunResult | undefined) => r !== undefined && r.code === 0 && !r.timedOut;

function problemOf(argv: string[], r: RunResult): SystemCheck["problem"] {
	const command = argv.join(" ");
	if (r.code === 127 && !r.timedOut) return { code: "missing", command };
	if (r.code !== 0 || r.timedOut)
		return { code: "failed", command, detail: (r.stderr || r.stdout).trim().split("\n")[0] ?? "" };
	return null;
}

/**
 * Lists the pending system updates, read-only. The seven commands are independent and start together.
 * A source that cannot answer leaves its rows out and names the problem; the other source still lists.
 */
export async function checkSystem(ctx: SystemCtx): Promise<SystemCheck> {
	const opts = { timeoutMs: 60_000 };
	const [list, sources, updates, installed, running, gl, runtimes] = (await Promise.all(
		[MINT_LIST, SOURCE_VERSIONS, FLATPAK_UPDATES, FLATPAK_INSTALLED, FLATPAK_RUNNING, DRIVER_GL, FLATPAK_RUNTIMES].map(
			(argv) => ctx.run(argv, opts),
		),
	)) as RunResult[];
	const rows: SystemRow[] = [];
	const mintProblem = list ? problemOf(MINT_LIST, list) : null;
	if (list && !mintProblem)
		rows.push(...aptRows(list.stdout, ok(sources) ? parseSourceVersions(sources?.stdout ?? "") : new Map()));
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
	};
}
