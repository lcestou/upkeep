import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
	AppSpec,
	AppState,
	EngineEvent,
	HistoryRow,
	LogLine,
	RunResult,
	RunState,
	Settings,
	Snapshot,
} from "../shared/types";
import { listBackups, prune, restoreBackup, takeBackup } from "./backup";
import { type FetchLike, githubToken, type Rate } from "./github";
import { checkCommand, installCommand } from "./kinds/command";
import type { Checked, KindCtx, Outcome, Target } from "./kinds/context";
import {
	checkLegacy,
	installLegacy,
	legacyVerdict,
	CHECK_INCOMPLETE,
	type LegacyCtx,
	type LegacyRun,
	oldUpdaterRunning,
	sweepShims,
} from "./kinds/legacy";
import { canRestore, checkRelease, destOf, installedFiles, installRelease, probeInstalled } from "./kinds/release";
import { checkSource, installSource } from "./kinds/source";
import { ensureManifest, loadManifest } from "./manifest";
import { expandHome, type Paths } from "./paths";
import type { Run, RunOpts } from "./run";
import { isRunning } from "./running";
import {
	appendHistory,
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
import { isNewer } from "./version";

export type EngineDeps = {
	paths: Paths;
	seedManifest: string;
	fetch: FetchLike;
	run: Run;
	now: () => Date;
	oldScript: string;
	oldLock: string;
	oldLog: string;
	/** The app's version, shown in Settings. */
	version?: string;
	procRoot?: string;
	/** Tests point GitHub lookups at a local server. */
	api?: string;
	/** Test overrides for waits inside kinds. */
	stallMs?: number;
	retryMs?: number;
	lockWaitMs?: number;
	pollMs?: number;
};

export type Engine = {
	snapshot(): Snapshot;
	subscribe(listener: (e: EngineEvent) => void): () => void;
	check(keys?: string[]): Promise<void>;
	install(keys: string[]): Promise<{ started: boolean; reason?: string }>;
	stopAfterCurrent(): void;
	dismissSummary(): void;
	restore(key: string, version: string): Promise<{ ok: boolean; detail?: string }>;
	setSkip(key: string, version: string | null): void;
	setHold(key: string, held: boolean): void;
	setAuto(key: string, auto: boolean): void;
	setSettings(patch: Partial<Settings>): Settings;
	history(limit: number): HistoryRow[];
	runLog(runId: string): LogLine[];
	readyKeys(autoOnly: boolean): string[];
	/** Resolves when no check or run is in progress. */
	idle(): Promise<void>;
};

export const REASON_CHECKING = "A check is running.";
export const REASON_BUSY = "A run is already in progress.";
export const REASON_NOTHING = "Nothing to install.";
export const REASON_OLD = "The old updater is running. Finish or close its dialogs first.";

const NATIVE = new Set(["appimage", "archive", "file", "deb", "source", "command"]);

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

const pad = (n: number) => String(n).padStart(2, "0");

function stamp(d: Date): string {
	const rand = Math.random().toString(36).slice(2, 6);
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rand}`;
}

function checkOne(spec: AppSpec, ctx: KindCtx): Promise<Checked | null> {
	switch (spec.kind) {
		case "source":
			return checkSource(spec, ctx);
		case "command":
			return checkCommand(spec, ctx);
		default:
			return checkRelease(spec, ctx);
	}
}

const resultOf = (r: Outcome["result"]): RunResult["result"] => (r === "done" ? "updated" : r);

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
	let log: RunLog | null = null;
	let run: RunState = { id: null, phase: "idle", index: 0, total: 0, currentKey: null, stopping: false, results: [] };

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

	sweepShims(paths, deps.procRoot);

	// An install that never reached its verify: say so on that row once it is checked.
	const interrupted = new Map<string, string>();
	// Only when this process can claim run.lock: another process's install in progress is not a leftover.
	const leftover = readInflight(paths);
	if (leftover && claimLock(paths, process.pid, deps.procRoot)) {
		const name = specs.find((s) => s.key === leftover.key)?.name ?? leftover.key;
		interrupted.set(
			leftover.key,
			leftover.backupVersion
				? `An update was interrupted. Restore ${leftover.backupVersion} from this row.`
				: `An update was interrupted. Check that ${name} still starts.`,
		);
		rmSync(`${leftover.dest}.upkeep-new`, { force: true });
		clearInflight(paths);
		releaseLock(paths);
	}

	const specOf = (key: string) => specs.find((s) => s.key === key);

	function kindCtx(key: string, overrides: Partial<KindCtx> = {}): LegacyCtx {
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
			},
			onRate: (r) => {
				rate = r;
			},
			api: deps.api,
			procRoot: deps.procRoot,
			now: deps.now,
			stallMs: deps.stallMs,
			retryMs: deps.retryMs,
			oldScript: deps.oldScript,
			oldLock: deps.oldLock,
			oldLog: deps.oldLog,
			lockWaitMs: deps.lockWaitMs,
			pollMs: deps.pollMs,
			...overrides,
		};
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

	function buildApp(spec: AppSpec, c: Checked, history: HistoryRow[]): AppState {
		const state = loadState(paths);
		const restorable = canRestore(spec.kind);
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
			running: runningNow(spec),
			restartToApply: apps.get(spec.key)?.restartToApply ?? false,
			restorePoints: restorable ? listBackups(paths, spec.key) : [],
			canRestore: restorable,
			auto: state.auto[spec.key] ?? spec.auto ?? false,
			sudo: spec.sudo === true,
			versionless: spec.versionless === true,
			run: spec.run,
			note: spec.note,
			dest: spec.dest,
			stages: stageWeights(history, spec.key, spec.kind),
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

	/** A check that did not finish keeps the row's last known versions. */
	function keepVersions(key: string, c: Checked): Checked {
		if (c.detail !== CHECK_INCOMPLETE) return c;
		const prev = apps.get(key);
		return { ...c, installed: prev?.installed ?? null, latest: prev?.latest ?? null };
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
		const native = list.filter((s) => NATIVE.has(s.kind));
		const old = list.filter((s) => !NATIVE.has(s.kind));
		const nativeWork = native.map(async (spec) => {
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
		});
		const legacyWork =
			old.length === 0
				? Promise.resolve()
				: checkLegacy(old, kindCtx(""), (key, c) => {
						const spec = specOf(key);
						if (spec && c) {
							accept(spec, keepVersions(key, c), history);
							done();
						}
					}).then((all) => {
						for (const [key, c] of all) {
							const spec = specOf(key);
							if (spec && !c) {
								accept(spec, null, history);
								done();
							}
							// Read once the old script and its probes have ended, so they never count as the app.
							const a = apps.get(key);
							if (spec && a && c) {
								a.running = runningNow(spec);
								emitApp(a);
							}
						}
					});
		await Promise.all([...nativeWork, legacyWork]);
		checkedAt = deps.now().toISOString();
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
		app.restorePoints = app.canRestore ? listBackups(paths, app.key) : [];
		emitApp(app);
	}

	async function installOne(spec: AppSpec): Promise<Outcome> {
		const target = targets.get(spec.key);
		if (!target) throw new Error(`${spec.name} has no update to install. Check again.`);
		const ctx = kindCtx(spec.key);
		switch (spec.kind) {
			case "source":
				return installSource(spec, target, ctx);
			case "command":
				return installCommand(spec, target, ctx);
			case "legacy":
			case "manual":
				throw new Error(`${spec.name} cannot be installed here.`);
			default:
				return installRelease(spec, target, ctx);
		}
	}

	function backToReady(rest: AppSpec[]): void {
		for (const s of rest) {
			const a = apps.get(s.key);
			const c = checked.get(s.key);
			if (a && c) {
				Object.assign(a, resting(s, c));
				emitApp(a);
			}
		}
	}

	async function doRun(queue: AppSpec[]): Promise<void> {
		const history: HistoryRow[] = [];
		const legacyRuns = new Map<string, { run: LegacyRun; before: string | null; started: number; ended: number }>();
		for (const [i, spec] of queue.entries()) {
			if (run.stopping) {
				backToReady(queue.slice(i));
				break;
			}
			if (oldUpdaterRunning(kindCtx(spec.key))) {
				say(null, REASON_OLD);
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
			const started = Date.now();
			say(spec.key, `Updating ${spec.name}${from ? ` from ${from}` : ""}${app.latest ? ` to ${app.latest}` : ""}`);
			if (spec.kind === "legacy") {
				// oxlint-disable-next-line no-await-in-loop -- one app at a time is the point of the queue
				const lr = await installLegacy(spec, kindCtx(spec.key)).catch((err: unknown): LegacyRun => ({
					failed: err instanceof Error ? err.message : String(err),
					oldLines: [],
				}));
				if (lr.failed) {
					finishApp(app, { result: "failed", installed: from, detail: lr.failed, restartToApply: false });
					say(spec.key, `failed: ${lr.failed}`);
					const ms = Date.now() - started;
					const result: RunResult = {
						key: spec.key,
						name: spec.name,
						from,
						to: app.latest,
						result: "failed",
						detail: lr.failed,
						ms,
					};
					run.results.push(result);
					history.push({ ...result, runId: run.id ?? "", at: deps.now().toISOString(), stages: { install: ms } });
					emitRun();
				} else {
					// The script has ended: the row waits for the run's one verdict check.
					app.stage = "verify";
					app.stagePct = null;
					emitApp(app);
					legacyRuns.set(spec.key, { run: lr, before: from, started, ended: Date.now() });
				}
				continue;
			}
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
			finishApp(app, outcome);
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
		}
		if (legacyRuns.size > 0) {
			say(null, "Checking the old script's apps once more");
			run = { ...run, currentKey: null };
			emitRun();
			const checkStart = Date.now();
			const legacySpecs = specs.filter((s) => s.kind === "legacy" || s.kind === "manual");
			const after = await checkLegacy(legacySpecs, kindCtx("")).catch(() => new Map<string, Checked | null>());
			for (const [key, lr] of legacyRuns) {
				const spec = specOf(key);
				const app = apps.get(key);
				if (!spec || !app) continue;
				const v = legacyVerdict(spec, lr.before, after.get(key), lr.run);
				finishApp(app, v);
				if (v.result !== "done") say(key, `${v.result}: ${v.detail ?? ""}`);
				const c = after.get(key);
				if (c) checked.set(key, c);
				const result: RunResult = {
					key,
					name: spec.name,
					from: lr.before,
					to: v.result === "done" ? v.installed : app.latest,
					result: resultOf(v.result),
					detail: v.detail,
					ms: Date.now() - lr.started,
				};
				run.results.push(result);
				history.push({
					...result,
					runId: run.id ?? "",
					at: deps.now().toISOString(),
					stages: { install: lr.ended - lr.started, verify: Date.now() - checkStart },
				});
			}
		}
		appendHistory(paths, history);
		say(null, `Run finished: ${run.results.filter((r) => r.result === "updated").length} updated`);
		log?.close();
		log = null;
		pruneLogs(paths, 50);
		run = { ...run, phase: "summary", currentKey: null, stopping: false };
		emitRun();
	}

	const engine: Engine = {
		snapshot() {
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
			if (run.phase === "installing" || run.phase === "checking") return busy;
			const p = doCheck(keys).catch((err: unknown) => {
				say(null, `Check failed: ${err instanceof Error ? err.message : String(err)}`);
				run = { ...run, phase: "idle", currentKey: null };
				emitRun();
			});
			busy = p;
			return p;
		},
		async install(keys) {
			if (run.phase === "checking") return { started: false, reason: REASON_CHECKING };
			if (run.phase === "installing") return { started: false, reason: REASON_BUSY };
			// Retry from the summary: the failed apps go back to ready, which is what gets picked below.
			// What the first pass updated stays on screen and in the count, so the summary reads as one run.
			const carried = run.phase === "summary" ? run.results.filter((r) => r.result === "updated") : [];
			if (run.phase === "summary") resetFailed();
			const wanted = new Set(keys);
			const pick = specs.filter((s) => {
				const a = apps.get(s.key);
				return wanted.has(s.key) && a && (a.status === "ready" || (a.versionless && s.kind === "legacy"));
			});
			const queue = [...pick.filter((s) => s.kind !== "legacy"), ...pick.filter((s) => s.kind === "legacy")];
			if (queue.length === 0) return { started: false, reason: REASON_NOTHING };
			if (!claimLock(paths, process.pid, deps.procRoot)) return { started: false, reason: REASON_BUSY };
			if (oldUpdaterRunning(kindCtx(""))) {
				releaseLock(paths);
				return { started: false, reason: REASON_OLD };
			}
			try {
				rmSync(join(paths.cache, "dl"), { recursive: true, force: true });
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
				run = { ...run, phase: "idle", currentKey: null, stopping: false };
				emitRun();
				return { started: false, reason: err instanceof Error ? err.message : String(err) };
			}
			const p = doRun(queue)
				.catch((err: unknown) => {
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
								detail: `The run stopped: ${reason}`,
								restartToApply: false,
							});
					}
					run = { ...run, phase: "summary", currentKey: null, stopping: false };
					emitRun();
				})
				.finally(() => releaseLock(paths));
			busy = p;
			return { started: true };
		},
		stopAfterCurrent() {
			if (run.phase !== "installing") return;
			run = { ...run, stopping: true };
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
			run = { id: null, phase: "idle", index: 0, total: 0, currentKey: null, stopping: false, results: [] };
			emitRun();
		},
		async restore(key, version) {
			if (run.phase === "installing" || run.phase === "checking") return { ok: false, detail: REASON_BUSY };
			const spec = specOf(key);
			if (!spec) return { ok: false, detail: `No app ${key}.` };
			if (!claimLock(paths, process.pid, deps.procRoot)) return { ok: false, detail: REASON_BUSY };
			try {
				// A restore is a swap: what is installed now becomes a restore point first, so it can be undone.
				const current = apps.get(key)?.installed ?? null;
				if (canRestore(spec.kind) && current && current !== version) {
					const files = installedFiles(spec, destOf(spec, { paths })).filter((f) => existsSync(f));
					if (files.length > 0) takeBackup(paths, spec, current, files, deps.now().toISOString());
				}
				const r = await restoreBackup(paths, spec, version, deps.run);
				if (!r.ok) return r;
				prune(paths, key, loadState(paths).settings.keepBackups);
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
				return { ok: true };
			} finally {
				releaseLock(paths);
			}
		},
		setSkip(key, version) {
			updateState(paths, (s) => {
				if (version === null) delete s.skip[key];
				else s.skip[key] = version;
			});
			refresh(key);
		},
		setHold(key, held) {
			updateState(paths, (s) => {
				if (held) s.hold[key] = true;
				else delete s.hold[key];
			});
			refresh(key);
		},
		setAuto(key, auto) {
			updateState(paths, (s) => {
				s.auto[key] = auto;
			});
			const a = apps.get(key);
			if (a) {
				a.auto = auto;
				emitApp(a);
			}
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
				else if (autoOnly && a.versionless && a.auto && s.kind === "legacy") keys.push(s.key);
			}
			return keys;
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

	/** Re-derives a resting row after a skip or hold change. */
	/** Rows a run could not update go back to where the last check left them. */
	function resetFailed(): void {
		for (const a of apps.values()) {
			if (a.status !== "failed" && a.status !== "rolled_back") continue;
			const spec = specOf(a.key);
			const c = checked.get(a.key);
			if (!spec || !c) continue;
			Object.assign(a, resting(spec, { ...c, installed: a.installed }));
			a.detail = c.detail;
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

	return engine;
}
