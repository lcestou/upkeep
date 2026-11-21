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
} from "../shared/types";
import { MESSAGES } from "../shared/messages";
import type { Arch } from "./arch";
import { backupDir, listBackups, packOlder, prune, readMeta, restoreBackup, takeBackup, takePoint } from "./backup";
import { alsoOf, scan as scanFor, suggest as suggestFor, type DiscoverCtx } from "./discover";
import { readCopies } from "./extras/system";
import { managedSpecs } from "./managers";
import { type FetchLike, githubToken, type Rate } from "./github";
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
	canRestore,
	checkRelease,
	destOf,
	dlPath,
	installedFiles,
	installRelease,
	probeInstalled,
} from "./kinds/release";
import { type Ahead, canFetchEarly, createAhead } from "./ahead";
import { recoverTree, restoreBuilt } from "./kinds/built";
import { checkSource, installSource } from "./kinds/source";
import { cutTable, ensureManifest, loadCatalogue, loadManifest, relift, replaceManifest, tomlTable } from "./manifest";
import { dropTree, sweepTrash } from "./drop";
import { expandHome, type Paths } from "./paths";
import { killTree, type Run, type RunOpts } from "./run";
import { earliestStart, isRunning } from "./running";
import {
	appendHistory,
	type KnownRow,
	loadRows,
	saveRows,
	claimLock,
	clearInflight,
	loadState,
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
import { isNewer } from "./version";

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
	/** How often Restart now looks whether the app has quit. Default 200 ms. */
	pollMs?: number;
	/** Bytes free on a folder's disk, which early downloads keep room on. Default statfs; tests pass a number. */
	freeBytes?: (dir: string) => number;
};

export type Engine = {
	snapshot(): Snapshot;
	subscribe(listener: (e: EngineEvent) => void): () => void;
	check(keys?: string[]): Promise<void>;
	install(keys: string[]): Promise<{ started: boolean; reason?: string }>;
	stopAfterCurrent(): void;
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
	setSettings(patch: Partial<Settings>): Settings;
	history(limit: number): HistoryRow[];
	runLog(runId: string): LogLine[];
	readyKeys(autoOnly: boolean): string[];
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

/** Every kind not named here is checked against a GitHub release. Null when the app is not installed, which the kind has already logged as skipped. */
function checkOne(spec: AppSpec, ctx: KindCtx): Promise<Checked | null> {
	switch (spec.kind) {
		case "source":
			return checkSource(spec, ctx);
		case "claude-plugins":
			return Promise.resolve(checkClaudePlugins(ctx));
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

/** A finished install is "updated" in the run's results; failures keep their own word. */
const resultOf = (r: Outcome["result"]): RunResult["result"] => (r === "done" ? "updated" : r);

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

	function kindCtx(key: string, overrides: Partial<KindCtx> = {}): KindCtx {
		return {
			paths,
			run: deps.run,
			fetch: deps.fetch,
			token,
			settings: loadState(paths).settings,
			log: (text) => say(key, text),
			stage: (stage, pct) => {
				const a = apps.get(key);
				if (a && a.status === "working") {
					a.stage = stage;
					a.stagePct = pct;
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
			early: (onProgress) => ahead?.claim(key, onProgress) ?? Promise.resolve(null),
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

	function runningNow(spec: AppSpec): boolean {
		if (!spec.dest && !spec.process) return false;
		const dest = spec.dest ? expandHome(spec.dest, paths.home) : undefined;
		return isRunning({ kind: spec.kind, dest, process: spec.process }, deps.procRoot);
	}

	/** The row's resting status from its check result and the owner's skip and hold. */
	function resting(spec: AppSpec, c: Checked): Pick<AppState, "status" | "held" | "skipped"> {
		const state = loadState(paths);
		const held = state.hold[spec.key] === true;
		const skip = state.skip[spec.key];
		if (c.status !== "ready") return { status: c.status, held };
		if (held) return { status: "held", held, skipped: skip };
		if (skip !== undefined && skip === c.latest) return { status: "held", held, skipped: skip };
		return { status: spec.kind === "manual" ? "manual" : "ready", held };
	}

	// What else keeps each app up to date, worked out once per check from the system's Flatpak and Snap lists.
	let alsoNotes = new Map<string, string[]>();

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
			detail: c.detail,
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
		checked.set(spec.key, c);
		if (c.target) targets.set(spec.key, c.target);
		else targets.delete(spec.key);
		const app = buildApp(spec, c, history);
		apps.set(spec.key, app);
		emitApp(app);
	}

	async function doCheck(keys?: string[]): Promise<void> {
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
		token = await githubToken(deps.run);
		const history = readHistory(paths, 1000);
		const all = loadSpecs();
		// The notes are a nicety: a list that cannot be read leaves them out and never stops the check.
		const copies = await readCopies({ run: deps.run }).catch(() => ({ flatpaks: [], snaps: [] }));
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
		await Promise.all(
			list.map(async (spec) => {
				let c: Checked | null;
				try {
					c = await checkOne(spec, kindCtx(spec.key, { fetch: limitedFetch, run: limitedRun }));
				} catch (err) {
					c = {
						installed: null,
						latest: null,
						status: "problem",
						detail: err instanceof Error ? err.message : String(err),
					};
				}
				accept(spec, c, history);
				done();
			}),
		);
		checkedAt = deps.now().toISOString();
		rememberRows(list, checkedAt);
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
		app.restartToApply = o.result === "done" && o.restartToApply;
		app.stage = undefined;
		app.stagePct = undefined;
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
	function addToRun(keys: string[]): Requests["install"]["response"] {
		const queue = runQueue;
		if (!queue) return { started: false, reason: REASON_BUSY };
		if (run.stopping) return { started: false, reason: REASON_STOPPING };
		const inRun = new Set(queue.map((s) => s.key));
		const wanted = new Set(keys);
		const add = specs.filter((s) => wanted.has(s.key) && !inRun.has(s.key) && apps.get(s.key)?.status === "ready");
		if (add.length === 0) return { started: false, reason: REASON_NOTHING };
		queue.push(...add);
		for (const s of add) {
			const a = apps.get(s.key);
			if (a) {
				a.status = "queued";
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
	async function startInstall(this: Engine, keys: string[]): Promise<{ started: boolean; reason?: string }> {
		// A run would write its own marker over the one a failed recovery kept.
		if ((await this.recover()).some((r) => !r.ok)) return { started: false, reason: REASON_UNRECOVERED };
		// Retry from the summary: the failed apps go back to ready, which is what gets picked below.
		// What the first pass updated stays on screen and in the count, so the summary reads as one run.
		const retry = run.phase === "summary";
		const carried = retry ? run.results.filter((r) => r.result === "updated") : [];
		if (run.phase === "summary") resetFailed();
		const wanted = new Set(keys);
		const pick = specs.filter((s) => {
			const a = apps.get(s.key);
			return wanted.has(s.key) && a && (a.status === "ready" || a.versionless);
		});
		const queue = [...pick];
		if (queue.length === 0) return { started: false, reason: REASON_NOTHING };
		if (!claimLock(paths, process.pid, deps.procRoot)) return { started: false, reason: REASON_BUSY };
		runQueue = queue;
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
					a.restartToApply = false;
					emitApp(a);
				}
			}
			emitRun();
			if (!token) token = await githubToken(deps.run);
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
		const p = doRun(queue)
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
				run = { ...run, phase: "summary", currentKey: null, stopping: false };
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

	async function doRun(queue: AppSpec[]): Promise<void> {
		const history: HistoryRow[] = [];
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
			run = { ...run, index: i + 1, currentKey: spec.key };
			emitRun();
			emitApp(app);
			// The gate first: still open from the app before, it would let the plan start downloads beside this app's own.
			ahead?.gate(app.stage !== "download");
			planAhead();
			const started = Date.now();
			say(spec.key, `Updating ${spec.name}${from ? ` from ${from}` : ""}${app.latest ? ` to ${app.latest}` : ""}`);
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
				to: outcome.result === "done" ? outcome.installed : app.latest,
				result: resultOf(outcome.result),
				detail: outcome.detail,
				ms: Date.now() - started,
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
		appendHistory(paths, run.retry ? history.map((h) => ({ ...h, retry: true })) : history);
		say(null, `Run finished: ${run.results.filter((r) => r.result === "updated").length} updated`);
		log?.close();
		log = null;
		pruneLogs(paths, 50);
		run = { ...run, phase: "summary", currentKey: null, stopping: false };
		emitRun();
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
		check(keys) {
			if (run.phase === "installing" || run.phase === "checking" || starting) return busy;
			const p = doCheck(keys).catch((err: Error) => {
				say(null, `Check failed: ${err instanceof Error ? err.message : String(err)}`);
				run = { ...run, phase: "idle", currentKey: null };
				emitRun();
			});
			busy = p;
			return p;
		},
		async install(keys) {
			if (run.phase === "checking") return { started: false, reason: REASON_CHECKING };
			if (run.phase === "installing" && runQueue) return addToRun(keys);
			if (run.phase === "installing" || starting) return { started: false, reason: REASON_BUSY };
			// Between here and the run's own "installing", recover() may wait on disk: a check started in that gap
			// (pressed, or the schedule's) would run beside the install, so check() refuses while this is set.
			starting = true;
			try {
				return await startInstall.call(this, keys);
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
		dismissSummary() {
			if (run.phase !== "summary") return;
			for (const a of apps.values()) {
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
		},
		async restore(key, version) {
			if (run.phase === "installing" || run.phase === "checking") return { ok: false, detail: REASON_BUSY };
			const spec = specOf(key);
			if (!spec) return { ok: false, detail: MESSAGES.noApp(key) };
			// Only the app whose recovery failed may be restored; its restore replaces the kept marker.
			if ((await this.recover()).some((r) => !r.ok && r.key !== key)) return { ok: false, detail: REASON_UNRECOVERED };
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
					takePoint(paths, spec, current, { command, tag }, deps.now().toISOString());
				} else if (canRestore(spec) && current && current !== version && !isPackage(spec.kind)) {
					const files = installedFiles(spec, destOf(spec, { paths }), paths.home).filter((f) => existsSync(f));
					if (files.length > 0) takeBackup(paths, spec, current, files, deps.now().toISOString());
				}
				const r = await restoreBackup(paths, spec, version, deps.run);
				if (!r.ok) return r;
				prune(paths, key, loadState(paths).settings.keepBackups);
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
				else delete s.hold[key];
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
		setSettings(patch) {
			const s = updateState(paths, (st) => {
				st.settings = { ...st.settings, ...patch };
			});
			emitMeta();
			return s.settings;
		},
		history(limit) {
			return readHistory(paths, limit);
		},
		runLog(runId) {
			return readRunLog(paths, runId);
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
			loadSpecs();
			apps.delete(key);
			checked.delete(key);
			targets.delete(key);
			// What the owner chose for this app goes with it: an app added again under the same key starts from the defaults, never as auto.
			updateState(paths, (s) => {
				delete s.skip[key];
				delete s.hold[key];
				delete s.auto[key];
				delete s.restart[key];
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
		if (!token) token = await githubToken(deps.run);
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
		}
		return { ok: true };
	}

	/** Re-derives a resting row after a skip or hold change. */
	/** Rows a run could not update go back to where the last check left them. */
	function resetFailed(): void {
		for (const a of apps.values()) {
			if (a.status !== "failed" && a.status !== "rolled_back") continue;
			const spec = specOf(a.key);
			const c = checked.get(a.key);
			if (!spec || !c) continue;
			// The row goes back to where it can be tried again, and says why the last try ended. The next check clears it.
			const why = a.detail;
			Object.assign(a, resting(spec, { ...c, installed: a.installed }));
			a.detail = why ? MESSAGES.lastTryFailed(why) : c.detail;
			emitApp(a);
		}
	}

	function refresh(key: string): void {
		const spec = specOf(key);
		const a = apps.get(key);
		const c = checked.get(key);
		if (!spec || !a || !c) return;
		if (!["ready", "held", "manual", "fresh"].includes(a.status)) return;
		Object.assign(a, { skipped: undefined }, resting(spec, c));
		emitApp(a);
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
	checkedAt =
		Object.values(known)
			.map((r) => r.checkedAt)
			.toSorted()
			.at(-1) || null;

	return engine;
}
