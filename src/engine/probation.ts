import { realpathSync } from "node:fs";
import { basename } from "node:path";
import type { AppSpec, Watch, WatchSign } from "../shared/types";
import type { FetchLike } from "./github";
import { installedFiles } from "./kinds/release";
import { isRecord } from "./manifest";
import { expandHome, type Paths } from "./paths";
import type { Run } from "./run";

/** How long an app stays on probation after Upkeep updated it. */
export const PROBATION_MS = 3 * 86_400_000;

/** How long the health address may take to answer one GET. */
export const HEALTH_TIMEOUT_MS = 5000;

/** How much NRestarts must grow since the update before a looping service counts as a sign. */
const RESTART_GROWTH = 3;

/** systemd-coredump's message id: one journal entry per core dump, with the crashed program's path and command line. */
const COREDUMP_MESSAGE = "MESSAGE_ID=fc2e22bc6ee647b6b90729ab34a250b1";

/**
 * One app's probation, kept in state.json from the update that finished until the person answers or it runs out.
 * restarts is each unit's NRestarts read right after the update; misses counts health checks failed in a row; sign
 * is set once and stays until the person answers, a restore or a new update; crashes is the last count seen since
 * the update.
 */
export type Probation = {
	at: string;
	from: string | null;
	to: string | null;
	restarts: Record<string, number>;
	misses: number;
	sign?: WatchSign;
	crashes?: number;
};

/** A unit an app's table drives with systemctl, and whether it is the person's own (--user) or the system's. */
export type Unit = { name: string; user: boolean };

/**
 * The units an app's table drives with systemctl: its restart argv and each serve entry's active argv, read as
 * `[sudo [-n]] systemctl [flags] <verb> [flags] <unit>`. The unit is the last word that is not a flag. A table that
 * restarts its service some other way (a script, a container tool) names none, and its service is not watched.
 */
export function unitsOf(spec: AppSpec): Unit[] {
	const out = new Map<string, Unit>();
	for (const argv of [spec.restart, ...(spec.serve ?? []).map((s) => s.active)]) {
		const words = (argv ?? []).filter((w) => w !== "sudo" && w !== "-n");
		if (basename(words[0] ?? "") !== "systemctl") continue;
		const name = words.slice(1).findLast((w) => !w.startsWith("-"));
		const verb = words.slice(1).find((w) => !w.startsWith("-"));
		if (!name || name === verb) continue;
		const user = words.includes("--user");
		out.set(`${user ? "user" : "system"}:${name}`, { name, user });
	}
	return [...out.values()];
}

/** The key a unit's baseline is kept under in a Probation: "user:<unit>" or "system:<unit>". */
export const unitKey = (u: Unit) => `${u.user ? "user" : "system"}:${u.name}`;

/**
 * A unit's ActiveState and NRestarts as `systemctl show` reports them, or null when it cannot be read: systemctl
 * missing, no such bus, a unit systemd does not know (it still answers, with NRestarts empty, which reads as null).
 */
export async function readUnit(run: Run, u: Unit): Promise<{ active: string; restarts: number } | null> {
	try {
		const r = await run(
			["systemctl", ...(u.user ? ["--user"] : []), "show", "-p", "ActiveState", "-p", "NRestarts", u.name],
			{ timeoutMs: 5000 },
		);
		if (r.code !== 0) return null;
		const field = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(r.stdout)?.[1]?.trim() ?? "";
		const restarts = field("NRestarts");
		if (!/^\d+$/.test(restarts)) return null;
		return { active: field("ActiveState"), restarts: Number(restarts) };
	} catch {
		return null;
	}
}

/** Every unit's NRestarts now, for the baseline an update starts probation with. A unit that cannot be read is left out. */
export async function restartBaseline(run: Run, spec: AppSpec): Promise<Record<string, number>> {
	const units = unitsOf(spec);
	const read = await Promise.all(units.map((u) => readUnit(run, u)));
	const out: Record<string, number> = {};
	for (const [i, u] of units.entries()) {
		const r = read[i];
		if (r) out[unitKey(u)] = r.restarts;
	}
	return out;
}

/** One core dump: the crashed program's path and when it was logged, in ms. */
export type Crash = { exe: string; at: number };

/**
 * The core dumps systemd-coredump logged since sinceMs, read from the journal. A Chromium or Electron child process
 * (its command line holds --type=, a GPU or renderer helper) is left out, so a helper's crash never blames an update.
 * Anything the journal cannot give (journalctl missing, no access to the system journal, nothing logged) is no
 * crashes, never an error. A field the journal stores as bytes (not UTF-8) is skipped with its entry.
 */
export async function readCrashes(run: Run, sinceMs: number): Promise<Crash[]> {
	let stdout = "";
	try {
		const r = await run(
			[
				"journalctl",
				"--no-pager",
				"-q",
				"-o",
				"json",
				"--output-fields=COREDUMP_EXE,COREDUMP_CMDLINE",
				COREDUMP_MESSAGE,
				"--since",
				`@${Math.floor(sinceMs / 1000)}`,
			],
			{ timeoutMs: 10_000 },
		);
		if (r.code !== 0) return [];
		stdout = r.stdout;
	} catch {
		return [];
	}
	const out: Crash[] = [];
	for (const line of stdout.split("\n")) {
		let e: unknown;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(e)) continue;
		const { COREDUMP_EXE: exe, COREDUMP_CMDLINE: cmdline, __REALTIME_TIMESTAMP: at } = e;
		if (typeof exe !== "string" || typeof at !== "string" || !/^\d+$/.test(at)) continue;
		if (typeof cmdline === "string" && /(^|\s)--type=/.test(cmdline)) continue;
		out.push({ exe, at: Math.floor(Number(at) / 1000) });
	}
	return out;
}

/**
 * The paths an app's crashes are matched against: every file an install writes (installedFiles), each also by its
 * real path, since the kernel names the resolved program. A folder app's folder matches anything under it.
 * shortcut: an AppImage runs from its own mount under /tmp, so its crashes never match dest; matching the mount needs
 * the dump's environment, which is large to read on every check.
 */
export function crashPaths(spec: AppSpec, paths: Pick<Paths, "home">): string[] {
	if (!spec.dest) return [];
	const dest = expandHome(spec.dest, paths.home);
	const out = new Set<string>();
	for (const f of installedFiles(spec, dest, paths.home)) {
		out.add(f);
		try {
			out.add(realpathSync(f));
		} catch {
			// gone or unreadable: its written path is all there is
		}
	}
	return [...out];
}

/** Whether a crashed program is one of these paths or sits under one of them. */
export const isOwn = (exe: string, own: string[]) => own.some((p) => exe === p || exe.startsWith(`${p}/`));

/**
 * Whether the app crashed more since the update than in the same length of time before it: 0 before and 1 after is
 * a sign, 2 and 2 is not. Returns the count since the update too.
 */
export function crashSign(
	crashes: Crash[],
	own: string[],
	updatedAt: number,
	now: number,
): { after: number; sign: boolean } {
	const span = now - updatedAt;
	let before = 0;
	let after = 0;
	for (const c of crashes) {
		if (!isOwn(c.exe, own)) continue;
		if (c.at >= updatedAt && c.at <= now) after += 1;
		else if (c.at >= updatedAt - span && c.at < updatedAt) before += 1;
	}
	return { after, sign: after > before };
}

/** A service is a sign when it is failed, or when it restarted RESTART_GROWTH times or more since the update. */
export function serviceSign(now: { active: string; restarts: number }, baseline: number | undefined): boolean {
	return now.active === "failed" || (baseline !== undefined && now.restarts - baseline >= RESTART_GROWTH);
}

/** Whether the health address answers a GET with a 2xx status within HEALTH_TIMEOUT_MS. Any fault is a miss. */
export async function healthAnswers(fetch: FetchLike, url: string, timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
	try {
		const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
		return res.ok;
	} catch {
		return false;
	}
}

/** Whether a probation has run its three days at now. */
export const expired = (p: Pick<Probation, "at">, now: Date) => now.getTime() - Date.parse(p.at) > PROBATION_MS;

export type LookDeps = { run: Run; fetch: FetchLike; paths: Pick<Paths, "home">; now: Date; healthTimeoutMs?: number };

/**
 * One look at an app on probation, during a check: its crashes (from crashes, read once for every app), each unit it
 * drives, and its health address, each read only. Returns the record as it stands after: a sign once set stays, the
 * crash count is refreshed, and a health miss counts toward two in a row (an answer resets it). The first sign found
 * is the one kept; crashes are looked at first.
 */
export async function look(spec: AppSpec, p: Probation, crashes: Crash[], deps: LookDeps): Promise<Probation> {
	const next: Probation = { ...p, restarts: { ...p.restarts } };
	const at = Date.parse(p.at);
	const c = crashSign(crashes, crashPaths(spec, deps.paths), at, deps.now.getTime());
	if (c.after > 0) next.crashes = c.after;
	if (c.sign) next.sign ??= "crash";
	const units = unitsOf(spec);
	const read = await Promise.all(units.map((u) => readUnit(deps.run, u)));
	for (const [i, u] of units.entries()) {
		const r = read[i];
		if (r && serviceSign(r, p.restarts[unitKey(u)])) next.sign ??= "service";
	}
	if (spec.health) {
		const ok = await healthAnswers(deps.fetch, spec.health, deps.healthTimeoutMs);
		next.misses = ok ? 0 : p.misses + 1;
		if (next.misses >= 2) next.sign ??= "health";
	}
	return next;
}

/** The sign a row shows for a probation record, only while one is up; versions and times as the record keeps them. */
export function watchOf(p: Probation | undefined): Watch | undefined {
	if (!p?.sign) return undefined;
	const w: Watch = { sign: p.sign, from: p.from, to: p.to, at: p.at };
	if (p.sign === "crash" && p.crashes) w.crashes = p.crashes;
	return w;
}
