import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AppSpec } from "../../shared/types";
import type { Paths } from "../paths";
import curlShim from "../shim/curl.sh" with { type: "text" };
import notifyShim from "../shim/notify-send.sh" with { type: "text" };
import zenityShim from "../shim/zenity.sh" with { type: "text" };
import { isRunning } from "../running";
import type { Checked, KindCtx, Outcome } from "./context";

export type LegacyCtx = KindCtx & {
	/** The old lutechi-updater script. */
	oldScript: string;
	/** Its lock file, /tmp/lutechi-updater.lock. */
	oldLock: string;
	/** Its log, ~/.local/share/lutechi-updater.log. */
	oldLog: string;
	/** How long to wait for the old script's own run to end. Default 60 s. */
	lockWaitMs?: number;
	/** How often the events file is read. Default 200 ms. */
	pollMs?: number;
};

export const NO_SCRIPT = "The old updater script is not installed.";
export const OLD_RUNNING = "The old updater is already running.";
export const NOT_FINISHED = "The old script did not finish this update. See the log.";

const LINE = /^\s+(OK|UPDATE|SKIP|BROKEN):\s+(.+)$/;

/** A run that was killed leaves its shim directory, and maybe a token file, behind: remove the ones whose process is gone. */
export function sweepShims(paths: Paths, procRoot = "/proc"): void {
	const root = join(paths.cache, "shim");
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return;
	}
	for (const e of entries) {
		const pid = /^run-(\d+)-/.exec(e)?.[1];
		if (pid && !existsSync(join(procRoot, pid))) rmSync(join(root, e), { recursive: true, force: true });
	}
}

/**
 * Writes the shims and, with a token, the curl header file into a directory of this run's own.
 * It is deleted after: an app the old script relaunches inherits this PATH and must find the real
 * zenity once the run is over, and two processes never share the events or token file.
 */
function prepareShims(ctx: LegacyCtx): { dir: string; events: string; env: Record<string, string>; cleanup(): void } {
	const root = join(ctx.paths.cache, "shim");
	mkdirSync(root, { recursive: true });
	const dir = mkdtempSync(join(root, `run-${process.pid}-`));
	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	try {
		return writeShims(dir, ctx.token, cleanup);
	} catch (err) {
		cleanup();
		throw err;
	}
}

function writeShims(
	dir: string,
	token: string | null,
	cleanup: () => void,
): { dir: string; events: string; env: Record<string, string>; cleanup(): void } {
	for (const [name, text] of [
		["zenity", zenityShim],
		["notify-send", notifyShim],
		["curl", curlShim],
	] as const) {
		writeFileSync(join(dir, name), text);
		chmodSync(join(dir, name), 0o755);
	}
	const events = join(dir, "events.ndjson");
	writeFileSync(events, "");
	const env: Record<string, string> = { UPKEEP_SHIM_EVENTS: events };
	const auth = join(dir, "curl-auth");
	if (token) {
		writeFileSync(auth, `Authorization: Bearer ${token}\n`, { mode: 0o600 });
		chmodSync(auth, 0o600);
		env.UPKEEP_CURL_AUTH = auth;
	}
	return { dir, events, env, cleanup };
}

/** Which spec a --check line belongs to: the longest legacy_name followed by a space that starts the text. */
export function matchLine(specs: AppSpec[], line: string): { spec: AppSpec; tag: string; rest: string } | null {
	const m = LINE.exec(line);
	if (!m) return null;
	const tag = m[1] ?? "";
	const text = m[2] ?? "";
	let best: AppSpec | null = null;
	for (const s of specs) {
		const name = s.legacy_name;
		if (name && text.startsWith(`${name} `) && (!best || name.length > (best.legacy_name ?? "").length)) best = s;
	}
	if (!best) return null;
	return { spec: best, tag, rest: text.slice((best.legacy_name ?? "").length + 1).trim() };
}

export function readLine(tag: string, rest: string): Checked {
	const tokens = rest.split(/\s+/).filter(Boolean);
	if (tag === "OK") return { installed: tokens.at(-1) ?? null, latest: tokens.at(-1) ?? null, status: "fresh" };
	if (tag === "UPDATE") {
		const installed = tokens[0] ?? null;
		const latest = tokens[1] === "->" ? (tokens[2] ?? null) : null;
		const target = latest ? { from: installed, version: latest, tag: latest } : undefined;
		// A manual app's update is the owner's to run; Checked has no manual status, the engine maps it.
		return { installed, latest, status: "ready", target };
	}
	return { installed: null, latest: null, status: "problem", detail: rest };
}

/**
 * Runs the old script's --check once and maps its lines onto the legacy and manual specs.
 * onApp fires as each line arrives. A spec with no line is left out (null), except versionless ones.
 */
export async function checkLegacy(
	specs: AppSpec[],
	ctx: LegacyCtx,
	onApp?: (key: string, checked: Checked | null) => void,
): Promise<Map<string, Checked | null>> {
	const out = new Map<string, Checked | null>();
	const set = (key: string, c: Checked | null) => {
		out.set(key, c);
		onApp?.(key, c);
	};
	if (!existsSync(ctx.oldScript)) {
		for (const s of specs) set(s.key, { installed: null, latest: null, status: "problem", detail: NO_SCRIPT });
		return out;
	}
	for (const s of specs) if (s.versionless) set(s.key, { installed: null, latest: null, status: "fresh" });
	const shims = prepareShims(ctx);
	try {
		await ctx.run([ctx.oldScript, "--check"], {
			pathPrefix: shims.dir,
			env: shims.env,
			timeoutMs: 5 * 60_000,
			killTree: true,
			onLine: (line) => {
				const hit = matchLine(specs, line);
				if (hit && !hit.spec.versionless) set(hit.spec.key, readLine(hit.tag, hit.rest));
			},
		});
	} finally {
		shims.cleanup();
	}
	for (const s of specs) if (!out.has(s.key)) out.set(s.key, null);
	return out;
}

function liveLock(file: string, procRoot: string): boolean {
	try {
		const pid = readFileSync(file, "utf8").trim();
		return /^\d+$/.test(pid) && existsSync(join(procRoot, pid));
	} catch {
		return false;
	}
}

/** True while the old script's lock names a live process. */
export function oldUpdaterRunning(ctx: Pick<LegacyCtx, "oldLock" | "procRoot">): boolean {
	return liveLock(ctx.oldLock, ctx.procRoot ?? "/proc");
}

function sizeOf(file: string): number {
	try {
		return statSync(file).size;
	} catch {
		return 0;
	}
}

type ShimEvent = { pct?: number | null; text?: string; dialog?: string; title?: string; answer?: boolean };

export type LegacyRun = { failed?: string; oldLines: string[]; code?: number };

// Old-log lines that mean a versionless app was not updated (old lines 1687, 1696, 1723, 1728).
const OLD_FAILURE = /update failed|FAILED|lookup failed|refresh failed/;

/**
 * Runs `lutechi-updater <legacy_key>` with the shims first in PATH, so no dialog waits.
 * Whether the app updated is decided afterwards by one --check (legacyVerdict), and for a versionless app by its exit code and the old log.
 */
export async function installLegacy(spec: AppSpec, ctx: LegacyCtx): Promise<LegacyRun> {
	const procRoot = ctx.procRoot ?? "/proc";
	const deadline = Date.now() + (ctx.lockWaitMs ?? 60_000);
	while (liveLock(ctx.oldLock, procRoot)) {
		if (Date.now() >= deadline) return { failed: OLD_RUNNING, oldLines: [] };
		// oxlint-disable-next-line no-await-in-loop -- waiting for the old script's own run to end
		await Bun.sleep(Math.min(1000, ctx.lockWaitMs ?? 1000));
	}
	const shims = prepareShims(ctx);
	const relaunch = isRunning(spec, procRoot);
	const logStart = sizeOf(ctx.oldLog);
	let offset = 0;
	const poll = () => {
		let text = "";
		try {
			text = readFileSync(shims.events, "utf8");
		} catch {
			return;
		}
		const end = text.lastIndexOf("\n") + 1;
		for (const raw of text.slice(offset, end).split("\n")) {
			if (!raw) continue;
			let e: ShimEvent;
			try {
				e = JSON.parse(raw) as ShimEvent;
			} catch {
				ctx.log(`shim: ${raw}`);
				continue;
			}
			if ("pct" in e) ctx.stage("install", typeof e.pct === "number" ? Math.min(100, e.pct) : null);
			else if (typeof e.text === "string" && !e.dialog) ctx.log(e.text);
			else if (e.dialog) {
				const answer = e.dialog === "question" ? (e.answer ? " answered yes" : " answered no") : "";
				ctx.log(`dialog ${e.dialog}: ${e.title ?? ""}${e.text ? ` ${e.text}` : ""}${answer}`);
			}
		}
		offset = end;
	};
	const timer = setInterval(poll, ctx.pollMs ?? 200);
	ctx.stage("install", 0);
	ctx.log(`$ ${ctx.oldScript} ${spec.legacy_key ?? ""}`);
	let timedOut = false;
	let code = 0;
	try {
		const r = await ctx.run([ctx.oldScript, spec.legacy_key ?? ""], {
			pathPrefix: shims.dir,
			env: { ...shims.env, UPKEEP_SHIM_RELAUNCH: relaunch ? "1" : "0" },
			timeoutMs: 35 * 60_000,
			killTree: true,
			onLine: (l) => ctx.log(l),
		});
		timedOut = r.timedOut;
		code = r.code;
		ctx.log(`The old script exited ${r.code}.`);
	} finally {
		clearInterval(timer);
		poll();
		shims.cleanup();
	}
	// The old script writes its reasons to its own log, not to stdout (line 198).
	const oldLines: string[] = [];
	try {
		const buf = readFileSync(ctx.oldLog);
		// A log that shrank was truncated or rotated during the run: everything in it is new.
		for (const line of buf
			.subarray(buf.length < logStart ? 0 : logStart)
			.toString("utf8")
			.split("\n")) {
			if (!line) continue;
			oldLines.push(line);
			ctx.log(`old: ${line}`);
		}
	} catch {
		// no log
	}
	return timedOut
		? { failed: "The old script ran past 35 minutes and was stopped.", oldLines, code }
		: { oldLines, code };
}

/** After the run's one --check: done only when the version moved, or for a versionless app when the old log shows no failure. */
export function legacyVerdict(
	spec: AppSpec,
	before: string | null,
	after: Checked | null | undefined,
	run: LegacyRun,
): Omit<Outcome, "stages"> {
	const failed = (detail: string) => ({ result: "failed" as const, installed: before, detail, restartToApply: false });
	if (run.failed) return failed(run.failed);
	if (spec.versionless) {
		// No new old-log line means nothing ran: the old script lost its own lock (line 86), or claude/omp is missing.
		const bad = (run.code ?? 0) !== 0 || run.oldLines.length === 0 || run.oldLines.some((l) => OLD_FAILURE.test(l));
		return bad ? failed(NOT_FINISHED) : { result: "done", installed: null, restartToApply: false };
	}
	if (after?.status === "fresh" && after.installed && after.installed !== before)
		return { result: "done", installed: after.installed, restartToApply: false };
	return failed(NOT_FINISHED);
}
