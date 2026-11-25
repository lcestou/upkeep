import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
	AppSpec,
	AppState,
	EngineEvent,
	HistoryRow,
	LogLine,
	Requests,
	RunResult,
	RunState,
	Settings,
	Snapshot,
	Stage,
	Suggestion,
	TokenState,
} from "../shared/types";
import { MESSAGES } from "../shared/messages";
import type { Arch } from "./arch";
import {
	backupDir,
	configPath,
	listBackups,
	packOlder,
	prune,
	readMeta,
	restoreBackup,
	takeBackup,
	takePoint,
} from "./backup";
import { alsoOf, scan as scanFor, suggest as suggestFor, type DiscoverCtx } from "./discover";
import { readCopies } from "./extras/system";
import { managedSpecs } from "./managers";
import { type FetchLike, GITHUB_API, githubToken, isFailure, type Rate } from "./github";
import { checkClaudePlugins, installClaudePlugins } from "./kinds/plugins";
import { checkCommand, installCommand, tagOf } from "./kinds/command";
import { isPackage } from "./kinds/package";
import { fill } from "./kinds/tree";
import {
	type Checked,
	type KindCtx,
	type Outcome,
	REASON_UNRECOVERED,
	readInstalled,
	type Target,
} from "./kinds/context";
import {
	canList,
	canRestore,
	checkRelease,
	destOf,
	dlPath,
	installedFiles,
	installRelease,
	listReleases,
	probeInstalled,
	versionTarget,
} from "./kinds/release";
import { type Ahead, canFetchEarly, createAhead } from "./ahead";
import { recoverTree, restoreBuilt } from "./kinds/built";
import { guardRepo } from "./repoid";
import { checkSource, installSource } from "./kinds/source";
import { cutTable, ensureManifest, loadCatalogue, loadManifest, relift, replaceManifest, tomlTable } from "./manifest";
import { dropTree, sweepTrash } from "./drop";
import { entryOwners, foreignEntry, removeMenu, writeMenu } from "./menu";
import { expandHome, type Paths } from "./paths";
import { canHoldSleep, holdSleep, LOCK_LINES, waitReason } from "./power";
import { endGroup, killTree, type Run, type RunOpts, runsAsRoot, stepName } from "./run";
import { earliestStart, isRunning } from "./running";
import {
	appendHistory,
	type KnownRow,
	loadRows,
	saveRows,
	claimLock,
	clearInflight,
	loadState,
	isTokenText,
	readToken,
	writeToken,
	openRunLog,
	pruneLogs,
	readHistory,
	readInflight,
	readRunLog,
	releaseLock,
	type RunLog,
	stageWeights,
	updateState,
} from "./store";
import { launchDetached, restartApp, terminate } from "./restart";
import { isNewer, isPrerelease } from "./version";

export type EngineDeps = {
	/** Ends a process tree during recovery. Default killTree; tests pass a recorder so no real pid is signalled. */
	kill?: (pid: number, procRoot: string) => void;
	/** The pause after that kill. Default 2 s. */
	recoverWaitMs?: number;
	/** Asks a process to quit for Restart now. Default SIGTERM; tests pass a recorder. */
	signal?: (pid: number) => void;
	/** Starts an app again for Restart now, detached; null once started, else why not. Tests pass a recorder so nothing real starts. */
	launch?: (argv: string[]) => Promise<string | null>;
	paths: Paths;
	seedManifest: string;
	/** The folder of tested tables Add app looks in first, one file per app. Without it Add app only guesses. */
	catalogueDir?: string;
	/** Where Add app asks for a catalogue table the shipped copy lacks: <url>/<key>.toml. Without it, the shipped copy only. */
	catalogueUrl?: string;
	fetch: FetchLike;
	run: Run;
	/**
	 * Runs the sleep lock during an install and the metered and battery questions. Without it no lock is taken and
	 * nothing waits; realDeps passes the real runner, and tests a fake so no real lock is ever held.
	 */
	power?: Run;
	/** How long a started sleep lock must stay up before it counts as held. Default 300 ms; tests pass less. */
	lockConfirmMs?: number;
	now: () => Date;
	/** The app's version, shown in Settings. */
	version?: string;
	procRoot?: string;
	/** Tests point GitHub lookups at a local server. */
	api?: string;
	/** The machine's architecture, which decides each release file. Default x86_64; realDeps reads the real one. */
	arch?: Arch;
	/** Test overrides for waits inside kinds. */
	stallMs?: number;
	retryMs?: number;
	/** How long a pasted token's check at GitHub may take before it counts as no answer. Default 10 s. */
	tokenWaitMs?: number;
	/** How often Restart now looks whether the app has quit. Default 200 ms. */
	pollMs?: number;
	/** Bytes free on a folder's disk, which early downloads keep room on. Default statfs; tests pass a number. */
	freeBytes?: (dir: string) => number;
};

export type Engine = {
	snapshot(): Snapshot;
	subscribe(listener: (e: EngineEvent) => void): () => void;
	/** quietOffline: an app whose check found no network keeps the row it had, so a start before the network is up shows nothing failed. */
	check(keys?: string[], opts?: { quietOffline?: boolean }): Promise<void>;
	/** Whether the last check found the network down: some app could not reach its forge and none that asks one got an answer. */
	offline(): boolean;
	/** now: a row held only because its release is still settling goes too, as Install now anyway asks. */
	install(keys: string[], now?: boolean): Promise<{ started: boolean; reason?: string }>;
	stopAfterCurrent(): void;
	/**
	 * Ends the run now: a cuttable step of the current app is cut and the app put back; a step that is never cut (a
	 * root package install, an undo) is waited out first, and the row says what it waits for. The rest stay ready.
	 */
	stopNow(): void;
	/**
	 * For quitting at once (a second Ctrl-C): ends the step in progress, TERM to its process group and KILL after 5 s,
	 * and resolves once it is gone. A step that runs as root cannot be ended from here and is left running; the answer
	 * names it then. Null when no step runs.
	 */
	endStep(): Promise<{ step: string; root: boolean } | null>;
	dismissSummary(): void;
	restore(key: string, version: string): Promise<{ ok: boolean; detail?: string }>;
	/** Restarts an app whose table says how, and drops its waiting restart once that worked. Refused during a run. */
	restartApp(key: string): Promise<{ ok: boolean; detail?: string }>;
	/** False, and nothing written, for a key not in the list. */
	setSkip(key: string, version: string | null): boolean;
	/** False, and nothing written, for a key not in the list. */
	setHold(key: string, held: boolean): boolean;
	/** False, and nothing written, for a key not in the list. */
	setAuto(key: string, auto: boolean): boolean;
	/** Writes the person's pre-release switch, then checks the app again when nothing else runs. False for an app whose releases cannot be listed. */
	setPrerelease(key: string, prerelease: boolean): boolean;
	/** The newest releases of an app whose releases can be listed, asked of its forge only now. */
	versions(key: string): Promise<Requests["versions"]["response"]>;
	/** Installs one release by its tag through the usual run; one older than the latest skips the latest once it is in. */
	installVersion(key: string, tag: string): Promise<{ started: boolean; reason?: string }>;
	/**
	 * Writes or deletes an AppImage's menu entry. Refused for another kind, during a run, and when another tool already
	 * has an entry for the same file; detail says why when there is a sentence for it.
	 */
	setMenu(key: string, menu: boolean): Promise<{ ok: boolean; detail?: string }>;
	setSettings(patch: Partial<Settings>): Settings;
	/** The pasted token's last four characters, and what the last check did when GitHub refused it (see TokenState). */
	tokenState(): TokenState;
	/**
	 * Keeps or forgets the pasted token. "shape": not a token's characters; "refused": GitHub answered it 401 when asked
	 * once now. Either way nothing is written. A network fault on that ask keeps the token. The next request uses it.
	 */
	setToken(token: string | null): Promise<"ok" | "shape" | "refused">;
	history(limit: number): HistoryRow[];
	runLog(runId: string): LogLine[];
	readyKeys(autoOnly: boolean): string[];
	/**
	 * Installs the ready apps marked automatic. With "wait for an unmetered connection" on, nothing starts while the
	 * connection is metered or the machine is on battery, and wait says which; a pressed Install never comes here.
	 */
	installAuto(): Promise<{ started: boolean; reason?: string; wait?: "metered" | "battery" }>;
	/** Resolves when no check or run is in progress. */
	idle(): Promise<void>;
	suggest(input: string, asset?: string): Promise<{ suggestions: Suggestion[]; problem?: string }>;
	scan(): Promise<{ suggestions: Suggestion[] }>;
	addApps(specs: AppSpec[]): Promise<{ added: string[]; problems: { key: string; detail: string }[] }>;
	removeApp(key: string): Promise<{ ok: boolean; detail?: string }>;
	/** Finishes or undoes a built update that was interrupted. Install and restore call it first; check never does. */
	recover(): Promise<{ key: string; name: string; version: string | null; ok: boolean }[]>;
};

/** The kinds an owner can add from the window. */
const ADDABLE = new Set(["appimage", "archive", "file", "deb", "rpm"]);

export const REASON_CHECKING = MESSAGES.reasonChecking();
export const REASON_BUSY = MESSAGES.reasonBusy();
export const REASON_NOTHING = MESSAGES.reasonNothing();
export const REASON_STOPPING = MESSAGES.reasonStopping();

/**
 * Whether a copy still running after an update is worth a restart prompt. A desktop app, a package or a service is;
 * an app whose table can do nothing about it is not: an archive, a single file or a command app (a tool run by its
 * own update command) with no restart command and no relaunch. Its running copy keeps the old version until it exits,
 * every new run already uses the new one, and there is nothing to press. A command app's note still says so in its
 * pane.
 */
function restartWanted(spec: AppSpec): boolean {
	return (
		!(spec.kind === "archive" || spec.kind === "file" || spec.kind === "command") ||
		(spec.restart?.length ?? 0) > 0 ||
		spec.relaunch === true
	);
}

/** The kinds whose check answers from the disk alone, so a good answer says nothing about the network. */
const LOCAL_CHECKS = new Set(["claude-plugins"]);

/**
 * Whether a check's results say the network is down: some app failed before its source answered, and no app whose
 * check fetches got an answer. Command and manual apps fetch their latest version too, so their answer counts. A
 * partial outage (one host down, another up) is not offline.
 */
function offlineIn(list: AppSpec[], found: Map<string, Checked | null>): boolean {
	const rows = list.flatMap((s) => {
		const c = found.get(s.key);
		return c ? [{ c, local: LOCAL_CHECKS.has(s.kind) }] : [];
	});
	return rows.some((r) => r.c.offline) && !rows.some((r) => !r.local && r.c.status !== "problem");
}

/** Runs fn with at most n in flight at once. */
function limiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
	let active = 0;
	const waiting: (() => void)[] = [];
	return async (fn) => {
		if (active >= n) await new Promise<void>((r) => waiting.push(r));
		active++;
		try {
			return await fn();
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
}

/** Two digits, so a stamp sorts by time as plain text. */
const pad = (n: number) => String(n).padStart(2, "0");

/** A run id in local time with four random characters, so two runs in one second still get distinct logs. */
export function stamp(d: Date): string {
	const rand = Math.random().toString(36).slice(2, 6);
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rand}`;
}

/** The table as a check reads it: the person's pre-release switch (switches, read once per check) over the table's own field. */
function effective(spec: AppSpec, switches: Record<string, boolean>): AppSpec {
	const pre = switches[spec.key];
	return pre === undefined ? spec : { ...spec, prerelease: pre };
}

/** Every kind not named here is checked against a GitHub release. Null when the app is not installed, which the kind has already logged as skipped. */
function checkOne(spec: AppSpec, ctx: KindCtx): Promise<Checked | null> {
	switch (spec.kind) {
		case "source":
			return checkSource(spec, ctx);
		case "claude-plugins":
			return checkClaudePlugins(ctx);
		case "command":
		case "manual":
			return checkCommand(spec, ctx);
		default:
			return checkRelease(spec, ctx);
	}
}

/** A built app's stages until its first update's timings exist: the build is most of the wait. */
const BUILT_WEIGHTS: [Stage, number][] = [
	["download", 5],
	["backup", 5],
	["build", 60],
	["install", 15],
	["verify", 15],
];
/** A .deb, .rpm or a command app that keeps a restore point shows a backup stage its default stem has no room for. */
const POINT_WEIGHTS = {
	deb: [
		["download", 45],
		["backup", 10],
		["install", 35],
		["verify", 10],
	],
	rpm: [
		["download", 45],
		["backup", 10],
		["install", 35],
		["verify", 10],
	],
	command: [
		["backup", 10],
		["install", 75],
		["verify", 15],
	],
} satisfies Record<"deb" | "rpm" | "command", [Stage, number][]>;

/** A step a kind runs now: its argv, whether Stop now may cut it, and its pid once it started. */
type InStep = { argv: string[]; cuttable: boolean; pid?: number; waitedOn?: boolean };

/** A finished install is "updated" in the run's results; failures keep their own word. */
const resultOf = (r: Outcome["result"]): RunResult["result"] => (r === "done" ? "updated" : r);

const DAY_MS = 86_400_000;

/**
 * When a release published at publishedAt is offered under a wait of days, as an ISO time, or undefined when it is
 * offered now: no wait, an old enough release, or no date to count from (a links, json or command source), which
 * counts as published long ago. An unreadable date counts as none.
 */
export function settlesAt(publishedAt: string | undefined, days: number, now: Date): string | undefined {
	const at = Date.parse(publishedAt ?? "");
	if (days <= 0 || Number.isNaN(at)) return undefined;
	const until = at + days * DAY_MS;
	return until > now.getTime() ? new Date(until).toISOString() : undefined;
}

/** Whether a row goes into a run: Ready, or with now (Install now anyway) still settling. A held or skipped row never. */
function takesRow(a: AppState | undefined, now: boolean): boolean {
	return a?.status === "ready" || (now && a?.settles !== undefined);
}

/** Every file the engine writes comes from deps.paths and every process it starts goes through deps.run, so a test can run it in a temp home. */
export function createEngine(deps: EngineDeps): Engine {
	const { paths } = deps;
	const listeners = new Set<(e: EngineEvent) => void>();
	const apps = new Map<string, AppState>();
	const checked = new Map<string, Checked>();
	const targets = new Map<string, Target>();
	let specs: AppSpec[] = [];
	let rate: Rate | null = null;
	let checkedAt: string | null = null;
	let token: string | null = null;
	let busy: Promise<void> = Promise.resolve();
	let starting = false;
	/** The run's Stop now; a fresh one for each run, since an aborted signal stays aborted. */
	let stopNow = new AbortController();
	/** The step a kind waits on now, so Stop now can say what it waits for when the step is one it never cuts. */
	let inStep: InStep | null = null;
	let log: RunLog | null = null;
	let run: RunState = {
		id: null,
		phase: "idle",
		index: 0,
		total: 0,
		currentKey: null,
		stopping: false,
		results: [],
		retry: false,
	};

	const emit = (e: EngineEvent) => {
		for (const l of listeners) {
			try {
				l(e);
			} catch {
				// a listener's failure is not the engine's
			}
		}
	};
	const emitApp = (a: AppState) =>
		emit({ type: "app", app: { ...a, restorePoints: [...a.restorePoints], stages: [...a.stages] } });
	const emitRun = () => emit({ type: "run", run: { ...run, results: [...run.results] } });
	const emitMeta = () => emit({ type: "meta", rate, checkedAt, settings: loadState(paths).settings });
	const say = (key: string | null, text: string) => {
		const line: LogLine = { at: deps.now().toISOString(), key, text };
		// No event of its own: the window reads the line's time from the log event itself.
		const a = key ? apps.get(key) : undefined;
		if (a?.status === "working") a.activeAt = line.at;
		try {
			log?.write(line);
		} catch {
			// A full disk or a read-only log must not stop the run: the line still goes out as an event.
		}
		emit({ type: "log", line });
	};

	function loadSpecs(): AppSpec[] {
		const file = ensureManifest(paths, deps.seedManifest);
		const { apps: list, errors } = loadManifest(file);
		for (const e of errors) say(null, `apps.toml: ${e}`);
		specs = list;
		return list;
	}
	loadSpecs();
	// Read once: the catalogue ships with the app and does not change while it runs.
	const catalogue = deps.catalogueDir ? loadCatalogue(deps.catalogueDir) : { apps: [], errors: [] };
	for (const e of catalogue.errors) say(null, e);

	sweepTrash(paths);

	// An install that never reached its verify: say so on that row once it is checked.
	const interrupted = new Map<string, string>();
	// Only when this process can claim run.lock: another process's install in progress is not a leftover.
	const leftover = readInflight(paths);
	// A built update's marker is only reported here, so check and history stay read-only; recover() acts on it.
	if (leftover?.tree) interrupted.set(leftover.key, MESSAGES.interruptedRestoreFromRow(leftover.backupVersion ?? ""));
	else if (leftover && claimLock(paths, process.pid, deps.procRoot)) {
		const name = specs.find((s) => s.key === leftover.key)?.name ?? leftover.key;
		interrupted.set(
			leftover.key,
			leftover.backupVersion
				? MESSAGES.interruptedRestoreFromRow(leftover.backupVersion)
				: MESSAGES.interruptedCheckStarts(name),
		);
		// One temp per installed file: an archive with several programs writes one beside each. The marker names them,
		// so this holds after the app left the list; an older marker without them falls back to the table.
		const spec = specs.find((s) => s.key === leftover.key);
		// Only files beside dest: the marker is a file on disk, and recovery touches nothing anywhere else.
		const beside = leftover.files?.filter((f) => dirname(resolve(f)) === dirname(resolve(leftover.dest)));
		const files = beside?.length ? beside : spec ? installedFiles(spec, leftover.dest, paths.home) : [leftover.dest];
		for (const f of new Set([leftover.dest, ...files]))
			try {
				// A folder app's is a directory.
				rmSync(`${f}.upkeep-new`, { recursive: true, force: true });
			} catch {
				// A root-owned leftover (a sudo install) is not ours to delete; it stays, and the start goes on.
			}
		clearInflight(paths);
		releaseLock(paths);
	}

	const specOf = (key: string) => specs.find((s) => s.key === key);
	// Apps whose target is a version the person picked, until that install is in or the summary is dismissed.
	const chosen = new Set<string>();
	// Apps whose pre-release switch changed while a check or run was under way: checked again once it is over.
	const stale = new Set<string>();
	// Apps a picked version went into, until the summary is dismissed: only they rest by the latest again, skipping it or not.
	const picked = new Set<string>();

	/** Checks the apps whose switch changed during a check or run, once nothing is under way; a later change waits again. */
	function checkStale(): void {
		if (stale.size === 0 || run.phase !== "idle" || starting) return;
		const keys = [...stale];
		stale.clear();
		void engine.check(keys);
	}

	function kindCtx(key: string, overrides: Partial<KindCtx> = {}): KindCtx {
		const cancel = stopNow.signal;
		const start = deps.run.start;
		const cancellable: Run = async (argv, opts) => {
			const mine: InStep = { argv, cuttable: opts?.cuttable === true };
			inStep = mine;
			const a = apps.get(key);
			const working = a?.status === "working" ? a : undefined;
			if (working) {
				working.step = { at: deps.now().toISOString(), limitMs: opts?.timeoutMs ?? null };
				emitApp(working);
			}
			try {
				return await deps.run(argv, {
					cancel,
					...opts,
					onStart: (pid) => {
						mine.pid = pid;
						opts?.onStart?.(pid);
					},
				});
			} finally {
				if (inStep === mine) inStep = null;
				if (working?.status === "working" && working.step) {
					working.step = undefined;
					// The step Stop now waited on has ended: the put-back that follows is not that wait.
					if (mine.waitedOn) working.waiting = undefined;
					emitApp(working);
				}
			}
		};
		return {
			paths,
			run: start ? Object.assign(cancellable, { start }) : cancellable,
			cancel,
			fetch: deps.fetch,
			token,
			settings: loadState(paths).settings,
			log: (text) => say(key, text),
			stage: (stage, pct) => {
				const a = apps.get(key);
				if (a && a.status === "working") {
					a.stage = stage;
					a.stagePct = pct;
					a.activeAt = deps.now().toISOString();
					emitApp(a);
				}
				// The current app's own download has the line to itself; early downloads start once it moves on.
				if (key === run.currentKey) ahead?.gate(stage !== "download");
			},
			onRate: (r) => {
				rate = r;
			},
			api: deps.api,
			arch: deps.arch,
			procRoot: deps.procRoot,
			now: deps.now,
			stallMs: deps.stallMs,
			retryMs: deps.retryMs,
			early: (onProgress) => ahead?.claim(key, onProgress, cancel) ?? Promise.resolve(null),
			...overrides,
		};
	}

	/** Kinds whose running process is watched for a restart; a command only gives advice. */
	const WATCHED = new Set(["appimage", "archive", "file", "deb", "rpm", "source"]);
	/** Apps whose Restart now is under way. */
	const restarting = new Set<string>();
	/** The run under way's queue, which addToRun appends to; null outside a run. */
	let runQueue: AppSpec[] | null = null;
	/** The run under way's early downloads; null outside a run. */
	let ahead: Ahead | null = null;
	/** A retry's first-pass order, which the order on screen keeps. */
	let runBase: string[] = [];
	/** The order the view shows: a retry's first pass as it was, then what this pass adds, in the order it runs. */
	const shownOrder = (queue: AppSpec[]) => [...runBase, ...queue.map((s) => s.key).filter((k) => !runBase.includes(k))];

	/**
	 * Whether the app still runs a process from before its install. The entry goes once none does:
	 * the owner closed or restarted it.
	 */
	function restartNeeded(spec: AppSpec): boolean {
		const at = loadState(paths).restart[spec.key];
		if (!at) return false;
		const dest = spec.dest ? expandHome(spec.dest, paths.home) : undefined;
		const started = earliestStart({ kind: spec.kind, dest, process: spec.process }, deps.procRoot);
		if (started !== null && started < Date.parse(at)) return true;
		updateState(paths, (s) => {
			delete s.restart[spec.key];
		});
		return false;
	}

	/** The row's restart flag at load: a running old copy, for an app whose restart is worth a prompt. */
	function restartFlag(spec: AppSpec): boolean {
		if (!restartWanted(spec)) {
			// A reminder saved before command-line tools stopped getting one: it is dropped, not shown.
			if (loadState(paths).restart[spec.key])
				updateState(paths, (s) => {
					delete s.restart[spec.key];
				});
			return false;
		}
		if (WATCHED.has(spec.kind)) return restartNeeded(spec);
		return apps.get(spec.key)?.restartToApply ?? false;
	}

	/** Whether restoring this point would put settings back: it saved some that the table still names. */
	function pointPutsSettingsBack(spec: AppSpec, version: string): boolean {
		const named = new Set((spec.keep_with_restore ?? []).map((c) => configPath(c, paths.home)));
		return (readMeta(join(backupDir(paths, spec.key), version))?.config ?? []).some((c) => named.has(c.path));
	}

	/** Whether the app has a live process, by dest or process name; false for an app with neither. */
	function runningNow(spec: AppSpec): boolean {
		if (!spec.dest && !spec.process) return false;
		const dest = spec.dest ? expandHome(spec.dest, paths.home) : undefined;
		return isRunning({ kind: spec.kind, dest, process: spec.process }, deps.procRoot);
	}

	/**
	 * The row's resting status and detail from its check result, the owner's skip and hold, and the wait in Settings. An
	 * offered release whose file changed since it was first seen, or whose repo's name now answers with another
	 * repository, is held too, with the reason as its detail, and releasing the hold lets it through. A hold or a skip wins over the wait; a manual app never waits. settles is always present,
	 * undefined when not settling, so Object.assign clears it.
	 */
	function resting(spec: AppSpec, c: Checked): Pick<AppState, "status" | "held" | "skipped" | "detail" | "settles"> {
		const state = loadState(paths);
		const tag = c.target?.tag;
		const changed = tag !== undefined && state.changed[spec.key] === tag;
		const swapped = state.swapped[spec.key];
		const held = state.hold[spec.key] === true || (c.status === "ready" && (changed || swapped !== undefined));
		const skip = state.skip[spec.key];
		const detail =
			c.status !== "ready"
				? c.detail
				: swapped !== undefined
					? MESSAGES.repoReplaced(`github.com/${swapped}`)
					: changed
						? MESSAGES.releaseChanged(tag)
						: c.detail;
		if (c.status !== "ready") return { status: c.status, held, detail, settles: undefined };
		if (held) return { status: "held", held, skipped: skip, detail, settles: undefined };
		if (skip !== undefined && skip === c.latest)
			return { status: "held", held, skipped: skip, detail, settles: undefined };
		// A manual app is run by the person, so it never waits: Install now anyway could not run it.
		if (spec.kind === "manual") return { status: "manual", held, detail, settles: undefined };
		const settles = settlesAt(c.publishedAt, state.settings.waitDays, deps.now());
		if (settles) return { status: "held", held, detail, settles };
		return { status: "ready", held, detail, settles: undefined };
	}

	/**
	 * Remembers the release file a check offered and marks the app changed when the same tag and file name now carry
	 * another hash of the same kind. A file added to the release later, a tag that moved on, a hash read another way
	 * (a digest after a sha512 sum) or a release the forge locks never fires. Only a row on offer is marked: an
	 * installed release has nothing left to hold.
	 */
	function noteRelease(key: string, c: Checked): void {
		const t = c.target;
		const a = t?.asset;
		const hash = a?.digest ?? (a?.sum ? `${a.sum.algo}:${a.sum.hex}` : null);
		if (!t || !a || !hash || t.locked) return;
		const was = loadState(paths).seen[key];
		if (was?.tag === t.tag && was.file === a.name && was.hash === hash) return;
		const sameKind = was?.hash.split(":")[0] === hash.split(":")[0];
		updateState(paths, (s) => {
			if (s.changed[key] !== undefined && s.changed[key] !== t.tag) delete s.changed[key];
			if (c.status === "ready" && was?.tag === t.tag && was.file === a.name && sameKind) s.changed[key] = t.tag;
			s.seen[key] = { tag: t.tag, file: a.name, hash };
		});
	}

	// What else keeps each app up to date, worked out once per check from the system's Flatpak and Snap lists.
	let alsoNotes = new Map<string, string[]>();
	// Other tools' menu entries by the program they start, read once per check rather than once per row.
	let owners = new Map<string, string>();

	function buildApp(spec: AppSpec, c: Checked, history: HistoryRow[]): AppState {
		const state = loadState(paths);
		const restorable = canRestore(spec);
		const app: AppState = {
			key: spec.key,
			name: spec.name,
			kind: spec.kind,
			repo: spec.repo,
			installed: c.installed,
			latest: c.latest,
			...resting(spec, c),
			size: c.size,
			notes: c.notes,
			releaseUrl: c.releaseUrl,
			publishedAt: c.publishedAt,
			commits: c.commits,
			ahead: c.ahead,
			running: runningNow(spec),
			restartToApply: restartFlag(spec),
			restorePoints: restorable ? listBackups(paths, spec.key) : [],
			canRestore: restorable,
			canRestart: Boolean(spec.restart?.length || spec.relaunch),
			closes: !spec.restart?.length && spec.relaunch === true,
			auto: state.auto[spec.key] ?? spec.auto ?? false,
			prerelease: canList(spec) ? (state.prerelease[spec.key] ?? spec.prerelease ?? false) : undefined,
			...menuOf(spec, state.menu),
			sudo: spec.sudo === true,
			versionless: spec.versionless === true,
			run: spec.run,
			note: spec.note,
			dest: spec.dest,
			also: alsoNotes.get(spec.key),
			stages: stageWeights(
				history,
				spec.key,
				spec.kind,
				restorable && spec.kind === "source"
					? BUILT_WEIGHTS
					: restorable && (isPackage(spec.kind) || spec.kind === "command")
						? POINT_WEIGHTS[spec.kind]
						: undefined,
			),
		};
		const note = interrupted.get(spec.key);
		if (note) {
			app.status = "problem";
			app.detail = note;
			interrupted.delete(spec.key);
		}
		return app;
	}

	/** An AppImage row's menu switch; nothing for another kind. Reads the applications folder on every call. */
	function menuOf(spec: AppSpec, menu: Record<string, string[]>): Pick<AppState, "menu" | "menuDetail"> {
		if (spec.kind !== "appimage") return {};
		if (menu[spec.key]) return { menu: "on" };
		const other = foreignEntry(owners, destOf(spec, { paths }));
		return other ? { menu: "elsewhere", menuDetail: MESSAGES.menuElsewhere(other) } : { menu: "off" };
	}

	/**
	 * Writes the app's entry again from the AppImage now at dest, after an update or a restore, since a new version may
	 * change its name or icon. Files the new write did not produce again (an icon of another size) are deleted. A failed
	 * write keeps the old entry and only logs: the update itself went through. An AppImage no longer at dest has its
	 * entry removed, since it would start nothing.
	 */
	async function refreshMenu(spec: AppSpec): Promise<void> {
		const had = loadState(paths).menu[spec.key];
		if (!had || spec.kind !== "appimage") return;
		const ctx = { paths, run: deps.run };
		const dest = destOf(spec, { paths });
		// An entry that would start a file no longer there is worse than none.
		if (!existsSync(dest)) {
			await removeMenu(had, ctx);
			updateState(paths, (s) => {
				delete s.menu[spec.key];
			});
			say(spec.key, `Removed the menu entry: ${dest} is not there any more.`);
			return;
		}
		const r = await writeMenu(spec.key, dest, ctx);
		if ("problem" in r) {
			say(spec.key, r.problem);
			return;
		}
		await removeMenu(
			had.filter((f) => !r.files.includes(f)),
			ctx,
		);
		updateState(paths, (s) => {
			s.menu[spec.key] = r.files;
		});
	}

	function accept(spec: AppSpec, c: Checked | null, history: HistoryRow[]): void {
		if (!c) {
			apps.delete(spec.key);
			checked.delete(spec.key);
			targets.delete(spec.key);
			return;
		}
		// A skip clears itself once a version newer than the skipped one appears.
		const skip = loadState(paths).skip[spec.key];
		if (skip !== undefined && c.latest && isNewer(skip, c.latest))
			updateState(paths, (s) => {
				delete s.skip[spec.key];
			});
		noteRelease(spec.key, c);
		checked.set(spec.key, c);
		chosen.delete(spec.key);
		if (c.target) targets.set(spec.key, c.target);
		else targets.delete(spec.key);
		const app = buildApp(spec, c, history);
		apps.set(spec.key, app);
		emitApp(app);
		armSettle();
	}

	/** Whether the last check found the network down; see offline(). */
	let lastOffline = false;

	/** quietOffline keeps a row that found no network as it was before, and leaves it and the check time unsaved. */
	async function doCheck(keys?: string[], quietOffline = false): Promise<void> {
		const list = loadSpecs().filter((s) => !keys || keys.includes(s.key));
		run = {
			...run,
			id: `${stamp(deps.now())}-check`,
			phase: "checking",
			index: 0,
			total: list.length,
			currentKey: null,
			retry: false,
		};
		log = openRunLog(paths, run.id ?? "check");
		emitRun();
		for (const s of list) {
			const a = apps.get(s.key);
			if (a) {
				a.status = "checking";
				emitApp(a);
			}
		}
		token = await freshToken(true);
		const history = readHistory(paths, 1000);
		const all = loadSpecs();
		// The notes are a nicety: a list that cannot be read leaves them out and never stops the check.
		const copies = await readCopies({ run: deps.run }).catch(() => ({ flatpaks: [], snaps: [] }));
		owners = entryOwners(paths);
		alsoNotes = new Map(
			all.map((s) => [s.key, alsoOf(s, all, copies, paths.home)] as const).filter(([, a]) => a.length > 0),
		);
		const fetchSlot = limiter(8);
		const probeSlot = limiter(4);
		const limitedFetch: FetchLike = (url, init) => fetchSlot(() => deps.fetch(url, init));
		const limitedRun: Run = Object.assign((argv: string[], opts?: RunOpts) => probeSlot(() => deps.run(argv, opts)), {
			start: deps.run.start,
		});
		const done = () => {
			run.index += 1;
			emitRun();
		};
		const switches = loadState(paths).prerelease;
		const found = new Map<string, Checked | null>();
		const kept = new Set<string>();
		await Promise.all(
			list.map(async (spec) => {
				const before = checked.get(spec.key);
				let c: Checked | null;
				try {
					const ctx = kindCtx(spec.key, { fetch: limitedFetch, run: limitedRun });
					c = await checkOne(effective(spec, switches), ctx);
					if (c && !c.offline)
						await guardRepo(
							spec,
							c.status === "ready",
							paths,
							{
								cacheDir: join(paths.cache, "github"),
								token: ctx.token,
								fetch: ctx.fetch,
								onRate: ctx.onRate,
								api: ctx.api,
							},
							ctx.log,
						);
				} catch (err) {
					c = {
						installed: null,
						latest: null,
						status: "problem",
						detail: err instanceof Error ? err.message : String(err),
					};
				}
				found.set(spec.key, c);
				// A row with nothing before it (a first start, an app just added) stays out of the list until a check gets through.
				if (quietOffline && c?.offline) {
					kept.add(spec.key);
					if (before) accept(spec, before, history);
				} else accept(spec, c, history);
				done();
			}),
		);
		lastOffline = offlineIn(list, found);
		if (quietOffline && lastOffline) say(null, "No network yet: the rows keep what the last check found");
		else checkedAt = deps.now().toISOString();
		// A row that answered is stamped now even when the check found no network; a kept row keeps its own stamp.
		rememberRows(
			list.filter((s) => !kept.has(s.key)),
			deps.now().toISOString(),
		);
		log?.close();
		log = null;
		run = { ...run, id: null, phase: "idle", index: run.total, currentKey: null };
		emitRun();
		emitMeta();
	}

	function finishApp(app: AppState, o: Omit<Outcome, "stages">): void {
		app.status = o.result;
		app.installed = o.installed;
		app.detail = o.detail;
		app.checked = o.checked;
		app.restartToApply = o.result === "done" && o.restartToApply;
		app.stage = undefined;
		app.stagePct = undefined;
		app.activeAt = undefined;
		app.step = undefined;
		app.waiting = undefined;
		app.downloaded = undefined;
		app.restorePoints = app.canRestore ? listBackups(paths, app.key) : [];
		emitApp(app);
	}

	async function installOne(spec: AppSpec): Promise<Outcome> {
		const target = targets.get(spec.key);
		if (!target) throw new Error(MESSAGES.noUpdateToInstall(spec.name));
		const ctx = kindCtx(spec.key);
		switch (spec.kind) {
			case "source":
				return installSource(spec, target, ctx);
			case "command":
				return installCommand(spec, target, ctx);
			case "claude-plugins":
				return installClaudePlugins(ctx);
			case "manual":
				throw new Error(MESSAGES.cannotInstallHere(spec.name));
			default:
				return installRelease(spec, target, ctx);
		}
	}

	function backToReady(rest: AppSpec[]): void {
		for (const s of rest) {
			const a = apps.get(s.key);
			const c = checked.get(s.key);
			if (a && c) {
				Object.assign(a, resting(s, c), { downloaded: undefined });
				emitApp(a);
			}
		}
	}

	/** Hands the apps still waiting behind the current one, in run order, to the early downloads. */
	function planAhead(): void {
		const queue = runQueue;
		if (!ahead || !queue) return;
		const at = queue.findIndex((s) => s.key === run.currentKey);
		ahead.plan(
			queue.slice(at + 1).flatMap((s) => {
				const asset = targets.get(s.key)?.asset;
				return canFetchEarly(s, asset) ? [{ key: s.key, asset, file: dlPath(paths, s.key, asset.name) }] : [];
			}),
		);
	}

	/** Marks a waiting row whose file came down ahead of its turn. A row no longer waiting (Stop) shows nothing. */
	function fetchedAhead(key: string): void {
		const a = apps.get(key);
		if (a?.status !== "queued" || run.stopping) return;
		a.downloaded = true;
		say(key, "Downloaded ahead of its turn");
		emitApp(a);
	}

	/**
	 * Adds ready apps to the run under way, as a download manager does: each goes after the apps already waiting. An
	 * app already in the run is left where it is. Refused once Stop after current is pending, since the run is about
	 * to end.
	 */
	function addToRun(keys: string[], now = false): Requests["install"]["response"] {
		const queue = runQueue;
		if (!queue) return { started: false, reason: REASON_BUSY };
		if (run.stopping) return { started: false, reason: REASON_STOPPING };
		const inRun = new Set(queue.map((s) => s.key));
		const wanted = new Set(keys);
		const add = specs.filter((s) => wanted.has(s.key) && !inRun.has(s.key) && takesRow(apps.get(s.key), now));
		if (add.length === 0) return { started: false, reason: REASON_NOTHING };
		queue.push(...add);
		for (const s of add) {
			const a = apps.get(s.key);
			if (a) {
				a.status = "queued";
				a.settles = undefined;
				// A note from the check or a last try is about the row at rest; an app that never starts must not keep it.
				a.detail = undefined;
				a.restartToApply = false;
				emitApp(a);
			}
		}
		say(null, `Added ${add.map((s) => s.name).join(", ")} to the run`);
		run = { ...run, total: queue.length, queue: shownOrder(queue) };
		emitRun();
		planAhead();
		return { started: true };
	}

	/** The body of install() once its phase checks passed; install() holds `starting` around it. */
	async function startInstall(
		this: Engine,
		keys: string[],
		now: boolean,
	): Promise<{ started: boolean; reason?: string }> {
		// A run would write its own marker over the one a failed recovery kept.
		if ((await this.recover()).some((r) => !r.ok)) return { started: false, reason: REASON_UNRECOVERED };
		// Retry from the summary: the failed apps go back to ready, which is what gets picked below.
		// What the first pass updated stays on screen and in the count, so the summary reads as one run.
		const retry = run.phase === "summary";
		const carried = retry ? run.results.filter((r) => r.result === "updated") : [];
		// A failed row goes back through the release wait; its retry still takes it, as Install now anyway did.
		const failed = new Set(
			[...apps.values()]
				.filter((a) => a.status === "failed" || a.status === "rolled_back" || a.status === "stopped")
				.map((a) => a.key),
		);
		if (run.phase === "summary") resetFailed();
		const wanted = new Set(keys);
		const pick = specs.filter((s) => {
			const a = apps.get(s.key);
			return wanted.has(s.key) && a && (takesRow(a, now || (retry && failed.has(s.key))) || a.versionless);
		});
		const queue = [...pick];
		if (queue.length === 0) return { started: false, reason: REASON_NOTHING };
		if (!claimLock(paths, process.pid, deps.procRoot)) return { started: false, reason: REASON_BUSY };
		runQueue = queue;
		stopNow = new AbortController();
		// A retry keeps the first pass's order on screen, so the rows it shows do not move.
		runBase = retry ? (run.queue ?? []) : [];
		try {
			dropTree(join(paths.cache, "dl"), paths);
			const id = stamp(deps.now());
			log = openRunLog(paths, id);
			run = {
				id,
				phase: "installing",
				index: 0,
				total: queue.length,
				currentKey: null,
				stopping: false,
				results: carried,
				retry,
				queue: shownOrder(queue),
			};
			for (const s of queue) {
				const a = apps.get(s.key);
				if (a) {
					a.status = "queued";
					a.settles = undefined;
					// A note from the check or a last try is about the row at rest; an app that never starts must not keep it.
					a.detail = undefined;
					a.restartToApply = false;
					emitApp(a);
				}
			}
			emitRun();
			token = await freshToken();
		} catch (err) {
			// Nothing ran yet: put the rows back and give the lock up.
			log?.close();
			log = null;
			backToReady(queue);
			releaseLock(paths);
			runQueue = null;
			run = { ...run, phase: "idle", currentKey: null, stopping: false };
			emitRun();
			return { started: false, reason: err instanceof Error ? err.message : String(err) };
		}
		const early = createAhead({
			dir: join(paths.cache, "dl"),
			fetch: deps.fetch,
			token,
			stallMs: deps.stallMs,
			retryMs: deps.retryMs,
			freeBytes: deps.freeBytes,
			onReady: fetchedAhead,
			log: say,
		});
		ahead = early;
		// The lock is taken inside the run, so busy covers it, and let go however the run ends: done, stopped or thrown.
		const p = (async () => {
			const release = await sleepHeld();
			try {
				await doRun(queue);
			} finally {
				await release?.().catch(() => undefined);
			}
		})()
			.catch((err: Error) => {
				const reason = err instanceof Error ? err.message : String(err);
				say(null, `Run failed: ${reason}`);
				try {
					log?.close();
				} catch {
					// the log is already broken
				}
				log = null;
				for (const s of queue) {
					const a = apps.get(s.key);
					if (a && (a.status === "queued" || a.status === "working"))
						finishApp(a, {
							result: "failed",
							installed: a.installed,
							detail: MESSAGES.runStopped(reason),
							restartToApply: false,
						});
				}
				run = { ...run, phase: "summary", currentKey: null, stopping: false, stoppingNow: false };
				emitRun();
			})
			.finally(async () => {
				// What came down ahead and was never used goes before the lock does; the lock goes even if that fails.
				try {
					await early.cancel();
				} finally {
					if (ahead === early) ahead = null;
					runQueue = null;
					releaseLock(paths);
				}
			});
		busy = p;
		return { started: true };
	}

	/** Whether the lock tool answered, asked once per engine; null until the first run asks. */
	let lockable: Promise<boolean> | null = null;
	/** Said once per engine: a machine without the lock tool runs every install without the lock. */
	let noLockSaid = false;

	/**
	 * Takes the sleep lock for a run; null, and one log line the first time, where there is none to take. A lock that
	 * cannot be started (its output file cannot be written) is skipped with a line: the run goes on without it.
	 */
	async function sleepHeld(): Promise<(() => Promise<void>) | null> {
		const power = deps.power;
		if (!power) return null;
		lockable ??= canHoldSleep(power).catch(() => false);
		if (!(await lockable)) {
			if (!noLockSaid) say(null, LOCK_LINES.missing);
			noLockSaid = true;
			return null;
		}
		try {
			const release = await holdSleep(power, process.pid, "Installing updates", deps.lockConfirmMs);
			if (release) say(null, LOCK_LINES.held);
			return release;
		} catch (err) {
			say(null, LOCK_LINES.failed(err instanceof Error ? err.message : String(err)));
			return null;
		}
	}

	/**
	 * Runs the queue, then ends the run: the history of every app that finished is appended in a finally, so a stopped
	 * run or one that throws still records them; the log closes and the run moves to summary with stopping and
	 * stoppingNow cleared. A throw skips the summary here; startInstall's catch fails the open rows instead.
	 */
	async function doRun(queue: AppSpec[]): Promise<void> {
		const history: HistoryRow[] = [];
		// In a finally: a run that throws or is stopped still records the apps it finished.
		try {
			await eachApp(queue, history);
		} finally {
			appendHistory(paths, run.retry ? history.map((h) => ({ ...h, retry: true })) : history);
		}
		say(null, `Run finished: ${run.results.filter((r) => r.result === "updated").length} updated`);
		log?.close();
		log = null;
		pruneLogs(paths, 50);
		run = { ...run, phase: "summary", currentKey: null, stopping: false, stoppingNow: false };
		emitRun();
	}

	/** The run's loop, one app at a time; each finished app's row goes into history as it ends. */
	async function eachApp(queue: AppSpec[], history: HistoryRow[]): Promise<void> {
		for (const [i, spec] of queue.entries()) {
			if (run.stopping) {
				backToReady(queue.slice(i));
				break;
			}
			const app = apps.get(spec.key);
			if (!app) continue;
			const from = app.installed;
			app.status = "working";
			app.stage = app.stages[0]?.id;
			app.stagePct = 0;
			app.activeAt = deps.now().toISOString();
			run = { ...run, index: i + 1, currentKey: spec.key };
			emitRun();
			emitApp(app);
			// The gate first: still open from the app before, it would let the plan start downloads beside this app's own.
			ahead?.gate(app.stage !== "download");
			planAhead();
			const started = Date.now();
			const to = targets.get(spec.key)?.version ?? app.latest;
			say(spec.key, `Updating ${spec.name}${from ? ` from ${from}` : ""}${to ? ` to ${to}` : ""}`);
			let outcome: Outcome;
			try {
				// oxlint-disable-next-line no-await-in-loop -- one app at a time is the point of the queue
				outcome = await installOne(spec);
			} catch (err) {
				outcome = {
					result: "failed",
					installed: from,
					detail: err instanceof Error ? err.message : String(err),
					restartToApply: false,
					stages: {},
				};
			}
			// A command-line tool's running copy needs no restart: the row is updated, and when a running copy was seen
			// (a watched kind) it says the old copy runs on. A self-updating tool's note already says so in its pane.
			if (outcome.result === "done" && outcome.restartToApply && !restartWanted(spec))
				outcome = {
					...outcome,
					restartToApply: false,
					detail: outcome.detail ?? (WATCHED.has(spec.kind) ? MESSAGES.oldCopyRuns(spec.name) : undefined),
				};
			finishApp(app, outcome);
			if (outcome.result === "done" && chosen.delete(spec.key)) {
				picked.add(spec.key);
				skipIfBehind(spec, app, from);
			}
			// After Stop now nothing more is started, the entry's refresh included: the old entry still starts dest.
			// oxlint-disable-next-line no-await-in-loop -- the entry follows its own app's install, before the next starts
			if (outcome.result === "done" && !run.stoppingNow) await refreshMenu(spec);
			if (outcome.result === "done" && outcome.restartToApply && WATCHED.has(spec.kind)) {
				const at = deps.now().toISOString();
				updateState(paths, (s) => {
					s.restart[spec.key] = at;
				});
			}
			say(spec.key, outcome.detail ? `${outcome.result}: ${outcome.detail}` : outcome.result);
			const result: RunResult = {
				key: spec.key,
				name: spec.name,
				from,
				to: outcome.result === "done" ? outcome.installed : to,
				result: resultOf(outcome.result),
				detail: outcome.detail,
				ms: Date.now() - started,
				checked: outcome.checked,
			};
			run.results.push(result);
			history.push({ ...result, runId: run.id ?? "", at: deps.now().toISOString(), stages: outcome.stages });
			emitRun();
			// A marker this app kept is the only record of a tree that could not be put back; the next app would erase it.
			const left = readInflight(paths);
			if (left?.tree && left.key === spec.key) {
				if (i + 1 < queue.length) say(null, REASON_UNRECOVERED);
				backToReady(queue.slice(i + 1));
				break;
			}
		}
		// The loop is over: an app added from here on would never run, so the run takes no more.
		runQueue = null;
	}

	const engine: Engine = {
		snapshot() {
			const waiting = loadState(paths).restart;
			for (const a of apps.values()) {
				const spec = specOf(a.key);
				if (spec && WATCHED.has(spec.kind) && (waiting[a.key] || a.restartToApply))
					a.restartToApply = restartWanted(spec) && restartNeeded(spec);
			}
			const order = new Map(specs.map((s, i) => [s.key, i]));
			const list = [...apps.values()].toSorted((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
			return {
				apps: structuredClone(list),
				run: { ...run, results: [...run.results] },
				settings: loadState(paths).settings,
				rate,
				checkedAt,
				version: deps.version ?? "0.1.0",
			};
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		check(keys, opts) {
			if (run.phase === "installing" || run.phase === "checking" || starting) return busy;
			const p = doCheck(keys, opts?.quietOffline)
				.catch((err: Error) => {
					say(null, `Check failed: ${err instanceof Error ? err.message : String(err)}`);
					run = { ...run, phase: "idle", currentKey: null };
					emitRun();
				})
				.then(checkStale);
			busy = p;
			return p;
		},
		async install(keys, now = false) {
			if (run.phase === "checking") return { started: false, reason: REASON_CHECKING };
			if (run.phase === "installing" && runQueue) return addToRun(keys, now);
			if (run.phase === "installing" || starting) return { started: false, reason: REASON_BUSY };
			// Between here and the run's own "installing", recover() may wait on disk: a check started in that gap
			// (pressed, or the schedule's) would run beside the install, so check() refuses while this is set.
			starting = true;
			try {
				return await startInstall.call(this, keys, now);
			} finally {
				starting = false;
			}
		},

		stopAfterCurrent() {
			if (run.phase !== "installing") return;
			run = { ...run, stopping: true };
			// The apps behind the current one will not run: their early downloads stop and their files go.
			void ahead?.cancel();
			for (const a of apps.values())
				if (a.downloaded) {
					a.downloaded = undefined;
					emitApp(a);
				}
			emitRun();
		},
		offline: () => lastOffline,
		async endStep() {
			const step = inStep;
			if (!step) return null;
			const root = runsAsRoot(step.argv);
			if (!root && step.pid) await endGroup(step.pid);
			return { step: stepName(step.argv), root };
		},
		stopNow() {
			if (run.phase !== "installing" || run.stoppingNow) return;
			engine.stopAfterCurrent();
			run = { ...run, stopping: true, stoppingNow: true };
			stopNow.abort();
			const key = run.currentKey;
			const step = inStep;
			const app = key ? apps.get(key) : undefined;
			const spec = key ? specOf(key) : undefined;
			if (app && spec && step && !step.cuttable) {
				const back = canRestore(spec) ? app.installed : null;
				const line = back
					? MESSAGES.waitingThenPutBack(stepName(step.argv), back)
					: MESSAGES.waitingFor(stepName(step.argv));
				say(app.key, line);
				step.waitedOn = true;
				app.waiting = line;
				emitApp(app);
			}
			emitRun();
		},
		dismissSummary() {
			if (run.phase !== "summary") return;
			for (const a of apps.values()) {
				// Only a picked version: an update whose probe reads 1.2 for the tag's 1.2.0 still rests fresh.
				if (a.status === "done" && picked.delete(a.key) && behindLatest(a)) continue;
				if (a.status === "done") {
					a.status = "fresh";
					a.detail = undefined;
					const c = checked.get(a.key);
					if (c) checked.set(a.key, { ...c, installed: a.installed, status: "fresh", target: undefined });
					targets.delete(a.key);
					emitApp(a);
				}
			}
			resetFailed();
			// A picked version that did not go in: the row's target is the latest again, so Install all never installs it.
			for (const key of chosen) {
				const t = checked.get(key)?.target;
				if (t) targets.set(key, t);
				else targets.delete(key);
			}
			chosen.clear();
			run = {
				id: null,
				phase: "idle",
				index: 0,
				total: 0,
				currentKey: null,
				stopping: false,
				results: [],
				retry: false,
			};
			emitRun();
			checkStale();
		},
		async restore(key, version) {
			if (run.phase === "installing" || run.phase === "checking") return { ok: false, detail: REASON_BUSY };
			const spec = specOf(key);
			if (!spec) return { ok: false, detail: MESSAGES.noApp(key) };
			// Only the app whose recovery failed may be restored; its restore replaces the kept marker.
			if ((await this.recover()).some((r) => !r.ok && r.key !== key)) return { ok: false, detail: REASON_UNRECOVERED };
			// Settings swapped under a running app are written over when it saves on quit. A served app is stopped first.
			if (!spec.serve?.length && pointPutsSettingsBack(spec, version) && runningNow(spec))
				return { ok: false, detail: MESSAGES.closeBeforeSettingsRestore(spec.name) };
			if (!claimLock(paths, process.pid, deps.procRoot)) return { ok: false, detail: REASON_BUSY };
			try {
				if (canRestore(spec) && spec.kind === "source") return await restoreBuiltApp(spec, version);
				// A restore is a swap: what is installed now becomes a restore point first, so it can be undone.
				// What is installed is read from disk: a row can be from the last start's cache, or from before an install.
				let current = apps.get(key)?.installed ?? null;
				if (canRestore(spec)) {
					const now = await probeInstalled(spec, kindCtx(key));
					current = "version" in now ? now.version : null;
				}
				// A .deb's undo would need its package downloaded again, so its restore keeps no point of what it replaces.
				if (canRestore(spec) && current && current !== version && spec.kind === "command" && spec.restore) {
					// The tag's form comes from this session's check, else from the point being put back, which kept its own tag.
					const back = readMeta(join(backupDir(paths, key), version));
					const tag = tagOf(
						checked.get(key)?.target ?? (back?.tag ? { tag: back.tag, version: back.version } : undefined),
						current,
					);
					const command = spec.restore.map((a) => fill(a, { version: current ?? "", tag }));
					takePoint(paths, spec, current, { command, tag }, deps.now().toISOString(), kindCtx(key).log);
				} else if (canRestore(spec) && current && current !== version && !isPackage(spec.kind)) {
					const files = installedFiles(spec, destOf(spec, { paths }), paths.home).filter((f) => existsSync(f));
					if (files.length > 0) takeBackup(paths, spec, current, files, deps.now().toISOString(), kindCtx(key).log);
				}
				const r = await restoreBackup(paths, spec, version, deps.run, spec.keep_with_restore);
				if (!r.ok) return r;
				prune(paths, key, loadState(paths).settings.keepBackups);
				await refreshMenu(spec);
				await packOlder(paths, key, deps.run, kindCtx(key).log);
				const probe = await probeInstalled(spec, kindCtx(key));
				const installed = "version" in probe ? probe.version : null;
				const app = apps.get(key);
				const c = checked.get(key);
				const at = deps.now();
				appendHistory(paths, [
					{
						key,
						name: spec.name,
						from: current,
						to: installed,
						result: "restored",
						ms: 0,
						runId: `restore-${stamp(at)}`,
						at: at.toISOString(),
						stages: {},
					},
				]);
				// He stepped back from the latest on purpose: it is skipped until a newer one comes out, not offered again.
				if (c?.latest && isNewer(installed, c.latest))
					updateState(paths, (st) => {
						st.skip[key] = c.latest ?? "";
					});
				if (app && c) {
					const status = isNewer(installed, c.latest) ? "ready" : "fresh";
					const next: Checked = {
						...c,
						installed,
						status,
						target: c.target ? { ...c.target, from: installed } : undefined,
					};
					checked.set(key, next);
					if (next.target) targets.set(key, next.target);
					Object.assign(app, resting(spec, next), { installed, detail: undefined, restartToApply: false });
					app.restorePoints = listBackups(paths, key);
					emitApp(app);
				}
				// The restored copy is not the one a running process missed.
				updateState(paths, (st) => {
					delete st.restart[key];
				});
				return { ok: true };
			} finally {
				releaseLock(paths);
			}
		},
		setSkip(key, version) {
			if (!specOf(key)) return false;
			updateState(paths, (s) => {
				if (version === null) delete s.skip[key];
				else s.skip[key] = version;
			});
			refresh(key);
			return true;
		},
		async restartApp(key) {
			if (run.phase === "installing") return { ok: false, detail: REASON_BUSY };
			const spec = specOf(key);
			if (!spec) return { ok: false, detail: MESSAGES.noApp(key) };
			// The pane and the group can both ask; a second relaunch would start the app twice.
			if (restarting.has(key)) return { ok: false, detail: MESSAGES.alreadyRestarting(spec.name) };
			restarting.add(key);
			say(key, `Restarting ${spec.name}`);
			const r = await restartApp(spec, destOf(spec, { paths }), {
				run: deps.run,
				procRoot: deps.procRoot,
				signal: deps.signal ?? terminate,
				launch: deps.launch ?? launchDetached,
				pollMs: deps.pollMs ?? 200,
			}).finally(() => restarting.delete(key));
			say(key, r.ok ? `Restarted ${spec.name}` : (r.detail ?? ""));
			if (!r.ok) return r;
			updateState(paths, (s) => {
				delete s.restart[key];
			});
			const a = apps.get(key);
			if (a) {
				a.restartToApply = false;
				emitApp(a);
			}
			return r;
		},
		setHold(key, held) {
			if (!specOf(key)) return false;
			updateState(paths, (s) => {
				if (held) s.hold[key] = true;
				else {
					delete s.hold[key];
					// Releasing a hold Upkeep put on a changed release lets that release through.
					delete s.changed[key];
					// Releasing a swapped repo's hold takes the repository now under the name as the one to follow.
					if (s.swapped[key] !== undefined) {
						delete s.swapped[key];
						delete s.origin[key];
					}
				}
			});
			refresh(key);
			return true;
		},
		setAuto(key, auto) {
			if (!specOf(key)) return false;
			updateState(paths, (s) => {
				s.auto[key] = auto;
			});
			const a = apps.get(key);
			if (a) {
				a.auto = auto;
				emitApp(a);
			}
			return true;
		},
		setPrerelease(key, prerelease) {
			const spec = specOf(key);
			if (!spec || !canList(spec)) return false;
			updateState(paths, (s) => {
				s.prerelease[key] = prerelease;
				// A skipped pre-release can never be offered once the switch is off, and would hide nothing but itself.
				const skip = s.skip[key];
				if (!prerelease && skip !== undefined && isPrerelease(skip)) delete s.skip[key];
			});
			const a = apps.get(key);
			if (a) {
				a.prerelease = prerelease;
				emitApp(a);
			}
			// What counts as the latest changed: the row asks its forge again, now or once the check or run is over.
			stale.add(key);
			checkStale();
			return true;
		},
		async versions(key) {
			const spec = specOf(key);
			if (!spec || !canList(spec)) return { versions: [], problem: MESSAGES.noApp(key) };
			token = await freshToken();
			const list = await listReleases(spec, kindCtx(key));
			if (isFailure(list)) return { versions: [], problem: list.detail };
			return {
				versions: list.flatMap((r) =>
					r.version
						? [{ tag: r.tag, version: r.version, publishedAt: r.publishedAt, prerelease: r.prerelease === true }]
						: [],
				),
			};
		},
		async installVersion(key, tag) {
			// A check under way is waited for, as one the summary's dismissal starts is below; one started meanwhile refuses.
			if (run.phase === "checking") await busy;
			if (run.phase === "checking") return { started: false, reason: REASON_CHECKING };
			if (run.phase === "installing" || starting) return { started: false, reason: REASON_BUSY };
			const spec = specOf(key);
			const first = apps.get(key);
			if (!spec || !first || !checked.has(key) || !canList(spec))
				return { started: false, reason: MESSAGES.noApp(key) };
			token = await freshToken();
			const t = await versionTarget(spec, kindCtx(key), tag, first.installed);
			if (isFailure(t)) return { started: false, reason: t.detail };
			if (t.version === first.installed) return { started: false, reason: REASON_NOTHING };
			// A release whose file changed since it was first seen stays held here too, until the person releases the hold.
			if (loadState(paths).changed[key] === t.tag) return { started: false, reason: MESSAGES.releaseChanged(t.tag) };
			const swapped = loadState(paths).swapped[key];
			if (swapped !== undefined) return { started: false, reason: MESSAGES.repoReplaced(`github.com/${swapped}`) };
			// A new run, not a retry of the one on the summary. Dismissing may start the check a switch changed in the run
			// was waiting for; the pick waits for it instead of being refused, then reads the row it left.
			if (run.phase === "summary") {
				engine.dismissSummary();
				// The run that left the summary is over, so busy is that check when one started, else already settled.
				await busy;
			}
			const a = apps.get(key);
			const c = checked.get(key);
			if (!a || !c) return { started: false, reason: MESSAGES.noApp(key) };
			chosen.add(key);
			targets.set(key, t);
			a.status = "ready";
			const r = await engine.install([key]);
			if (!r.started) {
				chosen.delete(key);
				if (c.target) targets.set(key, c.target);
				else targets.delete(key);
				Object.assign(a, resting(spec, c));
				emitApp(a);
			}
			return r;
		},
		async setMenu(key, menu) {
			const spec = specOf(key);
			if (spec?.kind !== "appimage") return { ok: false };
			if (run.phase === "installing") return { ok: false, detail: REASON_BUSY };
			const ctx = { paths, run: deps.run };
			const had = loadState(paths).menu[key] ?? [];
			let files: string[] | null = null;
			if (menu) {
				const dest = destOf(spec, { paths });
				owners = entryOwners(paths);
				const other = foreignEntry(owners, dest);
				if (other) return { ok: false, detail: MESSAGES.menuElsewhere(other) };
				const r = await writeMenu(key, dest, ctx);
				if ("problem" in r) return { ok: false, detail: r.problem };
				files = r.files;
			}
			await removeMenu(
				had.filter((f) => !files?.includes(f)),
				ctx,
			);
			updateState(paths, (s) => {
				if (files) s.menu[key] = files;
				else delete s.menu[key];
			});
			const a = apps.get(key);
			if (a) {
				Object.assign(a, { menuDetail: undefined }, menuOf(spec, loadState(paths).menu));
				emitApp(a);
			}
			return { ok: true };
		},
		setSettings(patch) {
			const s = updateState(paths, (st) => {
				st.settings = { ...st.settings, ...patch };
			});
			// A new wait moves rows between Ready and settling at once, without a check.
			if (patch.waitDays !== undefined) for (const key of apps.keys()) refresh(key);
			emitMeta();
			return s.settings;
		},
		tokenState() {
			const hint = readToken(paths)?.slice(-4) ?? null;
			return { hint, refused: hint ? tokenFallback : null };
		},
		async setToken(t) {
			const trimmed = t?.trim() ?? null;
			if (trimmed !== null && !isTokenText(trimmed)) return "shape";
			if (trimmed !== null && (await tokenStatus(trimmed)) === 401) return "refused";
			if (!writeToken(paths, trimmed)) return "shape";
			// The next check or search reads the file again; a token from before must not linger.
			token = null;
			tokenFallback = null;
			return "ok";
		},
		history(limit) {
			return readHistory(paths, limit);
		},
		runLog(runId) {
			return readRunLog(paths, runId);
		},
		async installAuto() {
			const keys = engine.readyKeys(true);
			if (keys.length === 0) return { started: false, reason: REASON_NOTHING };
			const wait = deps.power && loadState(paths).settings.waitUnmetered ? await waitReason(deps.power) : null;
			if (!wait) return engine.install(keys);
			say(null, `Automatic updates wait: ${wait === "metered" ? "metered connection" : "on battery"}`);
			return { started: false, wait };
		},
		readyKeys(autoOnly) {
			const keys: string[] = [];
			for (const s of specs) {
				const a = apps.get(s.key);
				if (!a) continue;
				if (a.status === "ready" && (!autoOnly || a.auto)) keys.push(s.key);
				else if (autoOnly && a.versionless && a.auto) keys.push(s.key);
			}
			return keys;
		},
		async suggest(input, asset) {
			return suggestFor(input, await discoverCtx(), asset);
		},
		async scan() {
			return scanFor(await discoverCtx());
		},
		async addApps(list) {
			const file = ensureManifest(paths, deps.seedManifest);
			const added: string[] = [];
			const problems: { key: string; detail: string }[] = [];
			// A command table that is not the catalogue's is checked against the tool managers' own records, read again here.
			const managed = list.some((s) => s.kind === "command" && !catalogue.apps.some((c) => c.key === s.key))
				? await managedSpecs(deps.run, paths.home)
				: [];
			for (const s of list) {
				const detail = writeApp(file, s, managed);
				if (detail) problems.push({ key: s.key, detail });
				else added.push(s.key);
			}
			if (added.length > 0) {
				loadSpecs();
				void this.check(added);
			}
			return { added, problems };
		},
		async removeApp(key) {
			if (run.phase === "installing") return { ok: false, detail: REASON_BUSY };
			// Its table is what recovery reads to put the interrupted update back; without it Install stays blocked.
			const left = readInflight(paths);
			if (left?.tree && left.key === key) return { ok: false, detail: REASON_UNRECOVERED };
			const file = ensureManifest(paths, deps.seedManifest);
			const text = readFileSync(file, "utf8");
			const cut = cutTable(text, key);
			if (cut === null) return { ok: false, detail: MESSAGES.noAppInList(key) };
			replaceManifest(file, cut);
			// The menu entry Upkeep wrote goes with the app; the AppImage itself stays, as removing from the list always left it.
			const menu = loadState(paths).menu[key];
			if (menu) await removeMenu(menu, { paths, run: deps.run });
			loadSpecs();
			apps.delete(key);
			checked.delete(key);
			targets.delete(key);
			// What the owner chose for this app goes with it: an app added again under the same key starts from the defaults, never as auto.
			updateState(paths, (s) => {
				delete s.skip[key];
				delete s.hold[key];
				delete s.auto[key];
				delete s.prerelease[key];
				delete s.restart[key];
				delete s.menu[key];
				delete s.seen[key];
				delete s.changed[key];
				delete s.origin[key];
				delete s.swapped[key];
			});
			emit({ type: "removed", key });
			return { ok: true };
		},
		async recover() {
			const m = readInflight(paths);
			if (!m?.tree) return [];
			// Another process's run in progress is not ours to undo.
			if (!claimLock(paths, process.pid, deps.procRoot)) return [];
			try {
				const point = m.backupVersion ? readMeta(join(backupDir(paths, m.key), m.backupVersion)) : null;
				// The table as it was at the run, so a later edit of apps.toml never changes what is put back.
				const spec = point?.tree?.spec ?? specOf(m.key);
				if (!spec) return [{ key: m.key, name: m.key, version: m.backupVersion, ok: false }];
				const ok = await recoverTree(m, spec, {
					...kindCtx(m.key),
					kill: deps.kill ?? killTree,
					waitMs: deps.recoverWaitMs,
				});
				const version = m.backupVersion ?? "";
				const sentence = ok
					? MESSAGES.interruptedPutBack(spec.name, version)
					: MESSAGES.interruptedRestoreFromRow(version);
				interrupted.set(m.key, sentence);
				const app = apps.get(m.key);
				if (app) {
					app.status = "problem";
					app.detail = sentence;
					emitApp(app);
				}
				return [{ key: m.key, name: spec.name, version: m.backupVersion, ok }];
			} finally {
				releaseLock(paths);
			}
		},
		async idle() {
			for (;;) {
				const p = busy;
				// oxlint-disable-next-line no-await-in-loop -- a new check may start while we wait
				await p;
				if (p === busy) return;
			}
		},
	};

	async function discoverCtx(): Promise<DiscoverCtx> {
		token = await freshToken();
		return {
			paths,
			run: deps.run,
			fetch: deps.fetch,
			token,
			specs,
			catalogue: catalogue.apps,
			catalogueUrl: deps.catalogueUrl,
			log: (text) => say(null, text),
			api: deps.api,
			arch: deps.arch,
		};
	}

	/** Appends one app's table to apps.toml, or says why not. The written table must read back as the same spec. */
	function writeApp(file: string, s: AppSpec, managed: AppSpec[] = []): string | null {
		// A kind the window cannot work out (a command, a source build) is written only as the catalogue tested it, or as
		// a tool manager's records make it: the card may rename it, move its dest or mark it install_if_missing (a clone
		// build not installed yet), but its steps, check and update are the catalogue's or the manager's, never a caller's.
		const same = (e: AppSpec | undefined) => {
			if (e === undefined) return false;
			const want: AppSpec = { ...e, name: s.name, dest: s.dest };
			if (s.install_if_missing) want.install_if_missing = true;
			return Bun.deepEquals(want, s);
		};
		const tested = same(catalogue.apps.find((c) => c.key === s.key)) || same(managed.find((m) => m.key === s.key));
		if (!ADDABLE.has(s.kind) && !tested) return MESSAGES.kindNotAddable(s.key);
		const { key } = s;
		const relifted = relift(s);
		if ("problem" in relifted) return relifted.problem;
		const lifted = relifted.spec;
		if (specs.some((x) => x.key === key)) return MESSAGES.alreadyInList(key);
		const dest = expandHome(lifted.dest ?? "", paths.home);
		const owner = specs.find((x) => x.dest && expandHome(x.dest, paths.home) === dest);
		if (owner) return MESSAGES.destBelongsTo(String(lifted.dest), owner.name);
		const before = readFileSync(file, "utf8");
		const failed = MESSAGES.couldNotWriteAppsToml(lifted.name);
		try {
			replaceManifest(file, `${before.replace(/\n*$/, "\n")}\n${tomlTable(lifted)}`);
		} catch {
			return failed;
		}
		const back = loadManifest(file).apps.find((x) => x.key === key);
		if (JSON.stringify(back) !== JSON.stringify(lifted)) {
			copyFileSync(`${file}.bak`, file);
			return failed;
		}
		specs = loadManifest(file).apps;
		return null;
	}

	/**
	 * Restore of a built app: no point of the current version is taken first, so it cannot itself be undone.
	 * The history row and the row's state follow the same rules as a file restore.
	 */
	async function restoreBuiltApp(spec: AppSpec, version: string): Promise<{ ok: boolean; detail?: string }> {
		const current = apps.get(spec.key)?.installed ?? null;
		const r = await restoreBuilt(spec, version, kindCtx(spec.key));
		if (!r.ok) return r;
		const installed = (await readInstalled(spec, kindCtx(spec.key)))?.installed ?? null;
		const at = deps.now();
		appendHistory(paths, [
			{
				key: spec.key,
				name: spec.name,
				from: current,
				to: installed,
				result: "restored",
				ms: 0,
				runId: `restore-${stamp(at)}`,
				at: at.toISOString(),
				stages: {},
			},
		]);
		const app = apps.get(spec.key);
		const c = checked.get(spec.key);
		if (app && c) {
			const next: Checked = { ...c, installed, status: isNewer(installed, c.latest) ? "ready" : "fresh" };
			checked.set(spec.key, next);
			Object.assign(app, resting(spec, next), { installed, detail: undefined, restartToApply: false });
			app.restorePoints = listBackups(paths, spec.key);
			emitApp(app);
			armSettle();
		}
		return { ok: true };
	}

	/**
	 * A picked version older than the latest and than what was installed before it (from) went in: the latest is
	 * skipped, as a restore point's going back skips it, so the next check does not offer it straight back and a newer
	 * release is offered when it comes out. A pick between from and the latest skips nothing.
	 */
	function skipIfBehind(spec: AppSpec, app: AppState, from: string | null): void {
		const latest = checked.get(spec.key)?.latest ?? null;
		// Only a step back from what was installed: a pick between it and the latest (1.0.5 over 1.0.0) hides nothing.
		if (latest === null || !isNewer(app.installed, latest) || !isNewer(app.installed, from)) return;
		updateState(paths, (s) => {
			s.skip[spec.key] = latest;
		});
		say(spec.key, `Skipping ${latest} for ${spec.name}`);
	}

	/**
	 * Settles a done row that is behind the latest (a picked version) when the summary is dismissed: it rests with the
	 * latest as its target again, held as skipping it after a step back (Stop skipping offers it), ready after a step up.
	 * False for a row at or past the latest.
	 */
	function behindLatest(a: AppState): boolean {
		const spec = specOf(a.key);
		const c = checked.get(a.key);
		if (!spec || !c?.target || !isNewer(a.installed, c.latest)) return false;
		const next: Checked = { ...c, installed: a.installed, status: "ready", target: { ...c.target, from: a.installed } };
		checked.set(a.key, next);
		targets.set(a.key, next.target ?? c.target);
		Object.assign(a, resting(spec, next), { detail: undefined });
		emitApp(a);
		return true;
	}

	/**
	 * Rows a run could not update, or the person stopped, go back to where the last check left them, so each can be
	 * ticked again. A stopped row keeps its own sentence ("Stopped. 1.0.0 is back in place."): it did not fail.
	 */
	function resetFailed(): void {
		for (const a of apps.values()) {
			if (a.status !== "failed" && a.status !== "rolled_back" && a.status !== "stopped") continue;
			const spec = specOf(a.key);
			const c = checked.get(a.key);
			if (!spec || !c) continue;
			// The row goes back to where it can be tried again, and says why the last try ended. The next check clears it.
			const why = a.detail;
			const stopped = a.status === "stopped";
			Object.assign(a, resting(spec, { ...c, installed: a.installed }));
			a.detail = why ? (stopped ? why : MESSAGES.lastTryFailed(why)) : c.detail;
			emitApp(a);
		}
		armSettle();
	}

	/** Re-derives a resting row after a skip or hold change. */
	function refresh(key: string): void {
		const spec = specOf(key);
		const a = apps.get(key);
		const c = checked.get(key);
		if (!spec || !a || !c) return;
		if (!["ready", "held", "manual", "fresh"].includes(a.status)) return;
		Object.assign(a, { skipped: undefined }, resting(spec, c));
		emitApp(a);
		armSettle();
	}

	/** Set by the last check when GitHub refused the pasted token: whether gh's sign-in stood in. Null otherwise. */
	let tokenFallback: TokenState["refused"] = null;

	/**
	 * GitHub's answer status for a token at /rate_limit, which costs none of the hour's budget; null on a network fault
	 * or no answer within tokenWaitMs (10 s), so Save answers and a check never sits in checking. Asked only of the real
	 * GitHub API: the token never goes to a test server or another host.
	 */
	async function tokenStatus(t: string): Promise<number | null> {
		if ((deps.api ?? GITHUB_API) !== GITHUB_API) return null;
		const ms = deps.tokenWaitMs ?? 10_000;
		let timer: ReturnType<typeof setTimeout> | undefined;
		// The race ends the wait even for a fetch that ignores its signal.
		const late = new Promise<null>((done) => {
			timer = setTimeout(() => done(null), ms);
		});
		try {
			const res = await Promise.race([
				deps.fetch(`${GITHUB_API}/rate_limit`, {
					headers: { Authorization: `Bearer ${t}`, Accept: "application/vnd.github+json" },
					signal: AbortSignal.timeout(ms),
				}),
				late,
			]);
			return res?.status ?? null;
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
		}
	}

	/** The last answer GitHub gave about the pasted token, and when, so requests close together ask it once. */
	let probed: { token: string; at: number; refused: boolean } | null = null;

	/**
	 * Whether GitHub refuses the pasted token now. An accepted token's answer is reused for 60 s, so Other versions and
	 * Add app do not each ask; a refusal is never reused, so a token put right is seen at once. force (a check) always asks.
	 */
	async function tokenRefused(pasted: string, force: boolean): Promise<boolean> {
		const now = deps.now().getTime();
		if (!force && probed?.token === pasted && !probed.refused && now - probed.at < 60_000) return false;
		const refused = (await tokenStatus(pasted)) === 401;
		probed = { token: pasted, at: now, refused };
		return refused;
	}

	/**
	 * The token for one check or search: the pasted one, unless GitHub now answers it 401 (an expired or revoked token),
	 * then gh's sign-in for this check, so a token gone stale is never worse than none. A network fault keeps the pasted one.
	 */
	async function freshToken(force = false): Promise<string | null> {
		const pasted = readToken(paths);
		const refused = pasted !== null && (await tokenRefused(pasted, force));
		const t = await githubToken(deps.run, refused ? null : pasted);
		tokenFallback = refused ? (t ? "gh" : "none") : null;
		return t;
	}

	let settleTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Keeps one timer set to the earliest moment a settling row is offered, so the row turns Ready then without a check
	 * (with "Only when I ask" there may be none for days). It re-derives the settling rows and sets itself again. Called
	 * after anything that can change a wait: a check's rows, a refresh, failed rows put back. The timer never keeps a
	 * process alive, so the command line still exits.
	 */
	function armSettle(): void {
		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = null;
		// Only resting waiting rows: refresh leaves a checking or problem row alone, so its old date would fire forever.
		const next = Math.min(
			...[...apps.values()].map((a) => (a.status === "held" && a.settles ? Date.parse(a.settles) : Infinity)),
		);
		if (!Number.isFinite(next)) return;
		// setTimeout holds at most 2^31-1 ms (about 24 days); a later moment is reached by setting it again.
		const ms = Math.min(Math.max(0, next - deps.now().getTime()) + 50, 2 ** 31 - 1);
		settleTimer = setTimeout(() => {
			settleTimer = null;
			for (const a of apps.values()) if (a.status === "held" && a.settles) refresh(a.key);
			armSettle();
		}, ms);
		settleTimer.unref();
	}

	/** Writes what this check learned, on top of what earlier checks knew about the other apps. */
	function rememberRows(list: AppSpec[], at: string): void {
		const rows = loadRows(paths);
		const listed = new Set(specs.map((s) => s.key));
		for (const key of Object.keys(rows)) if (!listed.has(key)) delete rows[key];
		for (const s of list) {
			const c = checked.get(s.key);
			if (!c) {
				delete rows[s.key];
				continue;
			}
			const { target: _target, ...known } = c;
			rows[s.key] = { ...known, checkedAt: at };
		}
		try {
			saveRows(paths, rows);
		} catch {
			// A cache that cannot be written only costs the next start its head start.
		}
	}

	// The last check's rows, so the list is there before the first check ends. No target: an install waits for a check.
	const known = loadRows(paths);
	for (const spec of specs) {
		const row: KnownRow | undefined = known[spec.key];
		if (!row) continue;
		const { checkedAt: _at, ...c } = row;
		checked.set(spec.key, c);
		apps.set(spec.key, buildApp(spec, c, []));
	}
	armSettle();
	checkedAt =
		Object.values(known)
			.map((r) => r.checkedAt)
			.toSorted()
			.at(-1) || null;

	return engine;
}
