import { MESSAGES } from "../../shared/messages";
import type {
	CleanupOutcome,
	CleanupPick,
	CleanupState,
	EngineEvent,
	ExtrasSettings,
	ExtrasSnapshot,
	HistoryRow,
	Requests,
	SystemOutcome,
	SystemState,
} from "../../shared/types";
import { stamp } from "../engine";
import { isAbsolute } from "node:path";
import { expandHome, type Paths } from "../paths";
import { killGroup, type Run } from "../run";
import { appendHistory, claimLock, openRunLog, readInflight, releaseLock, type RunLog } from "../store";
import { clean, measureCandidates, type Measured, needsTyping, review, TYPE_WORD } from "./cleanup";
import { installable, outcomesAfter, planSteps, preflight, runSteps } from "./install";
import { detectSnapshot, finishSnapshot, SNAPSHOT_KEY, type SnapshotResult, takeSnapshot, TOOL_NAME } from "./snapshot";
import { loadExtras, updateExtras } from "./state";
import { checkSystem } from "./system";

export type ExtrasDeps = {
	paths: Paths;
	run: Run;
	now: () => Date;
	procRoot?: string;
	/** The folders apps are installed into, where Cleanup looks for Upkeep's leftovers. */
	leftoverDirs?: () => string[];
};

export type Extras = {
	snapshot(): ExtrasSnapshot;
	subscribe(listener: (e: EngineEvent) => void): () => void;
	setSettings(patch: Partial<ExtrasSettings>): ExtrasSettings;
	/** Starts a read-only check unless one runs, an install runs, or the area is off. */
	checkSystem(): { started: boolean };
	/** The commands installing these rows would run now; nothing runs. */
	planSystem(ids: string[]): Requests["systemPlan"]["response"];
	/** Installs the rows when commands is still what planSystem answers; the rest of the run reports through events. */
	installSystem(ids: string[], commands: string[][]): Requests["systemInstall"]["response"];
	/** The person's answer after a failed snapshot: go installs without one. Not ok when nothing is asking. */
	answerSnapshot(go: boolean): { ok: boolean };
	/** Measures Cleanup's candidates again unless Cleanup is off, measuring or cleaning. Sizes come as events. */
	measureCleanup(): { started: boolean };
	/** What deleting the picks frees and the commands it runs; nothing runs. */
	reviewCleanup(picks: CleanupPick[]): Requests["cleanupReview"]["response"];
	/** Deletes the picks when commands is still what reviewCleanup answers; the rest reports through events. */
	runCleanup(picks: CleanupPick[], commands: string[][], typed?: string): Requests["cleanupRun"]["response"];
	/** True while a System install or a cleanup runs: the window's close and the tray's Quit wait for it. */
	installing(): boolean;
	/** Ends the process group of the command a System install or a cleanup is running; for a quit that cannot wait. */
	stopSystem(): void;
	/** Resolves when no check or install is running. */
	idle(): Promise<void>;
};

/** The lock's owner name for a System install: the engine holds the same run lock under the same pid with none. */
const LOCK_OWNER = "system";
/** The lock's owner name for a cleanup, so it never runs beside an install and never frees another's lock. */
const CLEANUP_OWNER = "cleanup";

/** How long a failed snapshot's ask waits for an answer before it counts as Stop, so a hidden window never holds the lock. */
const ASK_MS = 30 * 60_000;

/** A measure writes no run log: it changes nothing, and runs each time the tab is looked at. */
const quiet = () => undefined;

/** Cleanup's state while its tab is hidden, or before its first measure. */
const cleanupOff = (on: boolean): CleanupState => ({
	phase: on ? "idle" : "off",
	items: [],
	measuredAt: null,
	last: null,
});

/** A fresh object each call: callers spread it and must not share rows with an earlier state. */
const offState = (): SystemState => ({
	mode: "off",
	phase: "off",
	rows: [],
	checkedAt: null,
	problem: null,
	glMissing: null,
	packages: null,
});

/** History's row for the snapshot: taken, skipped because a fresh one exists, or failed and gone on without. */
function snapshotRow(snap: SnapshotResult, ms: number, runId: string, at: string): HistoryRow {
	const base = {
		key: SNAPSHOT_KEY,
		name: TOOL_NAME[snap.tool],
		from: null,
		to: null,
		ms,
		runId,
		at,
		stages: {},
	};
	if (snap.status === "taken")
		return {
			...base,
			result: "updated",
			detail: snap.name ? MESSAGES.snapshotTaken(snap.name) : MESSAGES.snapshotTakenNoName(),
		};
	if (snap.status === "skipped") return { ...base, result: "skipped", detail: MESSAGES.snapshotSkipped(snap.name) };
	return { ...base, result: "failed", detail: snap.reason };
}

/**
 * The system updates list beside the app list. It shares nothing with the engine's check and is never awaited
 * by it, so it cannot delay the app rows. It checks once at start when shown, and again when asked; there is no
 * timer, because Update Manager refreshes the apt cache itself and Upkeep never does. An install holds the engine's
 * own run lock, so an app install and a System install never run together, and only ever starts from the person's
 * press: nothing here runs it on a schedule.
 */
export function createExtras(deps: ExtrasDeps): Extras {
	const listeners = new Set<(e: EngineEvent) => void>();
	let settings = loadExtras(deps.paths);
	let system: SystemState = settings.system === "show" ? { ...offState(), mode: "show", phase: "idle" } : offState();
	let running: Promise<void> = Promise.resolve();
	// Bumped by each check and by turning the group off: only the newest check's answer may land.
	let generation = 0;
	// The pid of the command a System install is running, for a quit that has to end it.
	let child: number | null = null;
	/** True from the start of a System install to the end of its finally, whatever the settings say meanwhile. */
	let installingNow = false;
	// The answer to a failed snapshot's ask, while one waits; a quit that cannot wait answers Stop.
	let answer: ((go: boolean) => void) | null = null;
	let cleanup = cleanupOff(settings.cleanup === true);
	// What the last measure found, with how each part is deleted; the view only ever sees its items.
	let measured: Measured | null = null;
	let measureGeneration = 0;

	/** installable is worked out here, never stored, so it always follows the rows and the switch. */
	const snapshot = (): ExtrasSnapshot => {
		const shown =
			settings.systemInstall && system.mode === "show"
				? { ...system, installable: system.rows.filter((r) => installable(r, system.packages)).map((r) => r.id) }
				: system;
		return structuredClone({ settings, system: shown, cleanup });
	};
	const emit = () => {
		const extras = snapshot();
		for (const l of listeners) {
			try {
				l({ type: "extras", extras });
			} catch {
				// a listener's failure is not ours
			}
		}
	};

	/**
	 * Not started when the area is off, a check already runs or an install does (it checks again itself when it ends).
	 * The check reports through emit, never by throwing. A check overtaken by a newer one, or by the group being turned
	 * off (and maybe on again), drops its answer.
	 */
	function check() {
		if (system.mode !== "show" || system.phase !== "idle") return { started: false };
		system = { ...system, phase: "checking" };
		emit();
		generation += 1;
		const mine = generation;
		const current = () => mine === generation && system.mode === "show";
		running = Promise.all([checkSystem({ run: deps.run }), detectSnapshot(deps.run).catch(() => null)])
			.then(([found, snapshotSetup]) => {
				if (!current()) return;
				system = { ...system, ...found, snapshotSetup, phase: "idle", checkedAt: deps.now().toISOString() };
			})
			.catch((err: Error) => {
				if (!current()) return;
				const detail = err instanceof Error ? err.message : String(err);
				system = { ...system, phase: "idle", problem: { code: "failed", command: "", detail } };
			})
			.finally(emit);
		return { started: true };
	}

	/** Records a refusal where the window shows it, and answers the request with it. Nothing ran. */
	function refuse(commands: string[][], reason: string) {
		system = { ...system, install: { at: deps.now().toISOString(), commands, outcomes: [], refused: reason } };
		emit();
		return { started: false, reason };
	}

	/** Shows where the snapshot before the steps is, or clears it. */
	function snapshotPhase(phase: NonNullable<SystemState["install"]>["snapshot"]) {
		if (!system.install) return;
		const { snapshot: _old, ...rest } = system.install;
		system = { ...system, install: phase ? { ...rest, snapshot: phase } : rest };
		emit();
	}

	/** Waits for the person's answer to a failed snapshot, or ASK_MS, after which it counts as Stop. */
	function ask(): Promise<boolean> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => answer?.(false), ASK_MS);
			answer = (go) => {
				clearTimeout(timer);
				answer = null;
				resolve(go);
			};
		});
	}

	/**
	 * The snapshot before the steps, when its setting is on and a tool is set up; null when none is due. A failed one
	 * asks the person; stop is true when they chose Stop (or did not answer), after which nothing of the System
	 * install runs.
	 */
	async function snapshotFirst(log: (line: string) => void): Promise<{ snap: SnapshotResult | null; stop: boolean }> {
		const setup = system.snapshotSetup;
		if (!settings.snapshotBeforeSystem || !setup) return { snap: null, stop: false };
		snapshotPhase({ phase: "taking" });
		const snap = await takeSnapshot(setup, {
			run: deps.run,
			now: deps.now,
			log,
			onStart: (pid) => {
				child = pid;
			},
		});
		child = null;
		if (snap.status !== "failed") {
			snapshotPhase(undefined);
			return { snap, stop: false };
		}
		log(snap.reason);
		snapshotPhase({ phase: "asking", reason: snap.reason });
		const go = await ask();
		snapshotPhase(undefined);
		log(go ? "Going on without a snapshot, as asked" : "Stopped before the system updates, as asked");
		return { snap, stop: !go };
	}

	/**
	 * The install itself, once the lock is held: the read-only pre-checks, the snapshot when it is on, the steps, the
	 * list read again, then one history row per ticked row and one for the snapshot. Snapper's post snapshot follows
	 * the steps even when they fail. The lock is given back in finally and only under this owner, so it never frees a
	 * lock the engine holds.
	 */
	async function install(ids: string[], commands: string[][], log: RunLog, runId: string) {
		installingNow = true;
		try {
			const steps = planSteps(system.rows, ids, system.packages);
			const picked = system.rows.filter((r) => steps.some((s) => s.ids.includes(r.id)));
			const started = Date.now();
			const say = (text: string) => log.write({ at: deps.now().toISOString(), key: "system", text });
			const set = (outcomes: SystemOutcome[]) => {
				if (system.install) system = { ...system, install: { ...system.install, outcomes } };
				emit();
			};
			const ctx = {
				run: deps.run,
				pid: process.pid,
				log: say,
				onStart: (pid: number) => {
					child = pid;
				},
			};
			say(`System install: ${picked.map((r) => r.name).join(", ")}`);
			const refused = await preflight(steps, system.rows, ctx);
			if (refused) {
				say(refused);
				system = { ...system, phase: "idle" };
				refuse(commands, refused);
				return;
			}
			const { snap, stop } = await snapshotFirst(say);
			if (snap && stop) {
				appendHistory(deps.paths, [snapshotRow(snap, Date.now() - started, runId, deps.now().toISOString())]);
				system = { ...system, phase: "idle" };
				refuse(commands, MESSAGES.snapshotStopped());
				return;
			}
			// A row whose step has run stays working until the list read afterwards says how it ended.
			let failed: Map<string, string>;
			try {
				failed = await runSteps(steps, ctx, (step) => {
					const outcomes = system.install?.outcomes ?? [];
					for (const o of outcomes) if (step.ids.includes(o.id)) o.status = "working";
					set(outcomes);
				});
			} finally {
				await finishSnapshot(snap, { run: deps.run, now: deps.now, log: say, onStart: ctx.onStart });
			}
			child = null;
			const after = await checkSystem({ run: deps.run });
			const outcomes = outcomesAfter(picked, failed, after);
			const at = deps.now().toISOString();
			const ms = Date.now() - started;
			const rows: HistoryRow[] = outcomes.map((o) => ({
				key: `system:${o.id}`,
				name: o.name,
				from: o.from,
				to: o.to,
				result: o.status === "done" ? "updated" : "failed",
				detail: o.detail,
				ms,
				runId,
				at,
				stages: {},
			}));
			appendHistory(deps.paths, snap ? [snapshotRow(snap, ms, runId, at), ...rows] : rows);
			for (const o of outcomes) say(`${o.name}: ${o.status}${o.detail ? `: ${o.detail}` : ""}`);
			generation += 1;
			// Turned off during the run: the history is written, and the group stays off.
			if (system.mode === "show") system = { ...system, ...after, phase: "idle", checkedAt: at };
			set(outcomes);
		} finally {
			child = null;
			log.close();
			releaseLock(deps.paths, process.pid, LOCK_OWNER);
			installingNow = false;
			if (system.phase === "installing") system = { ...system, phase: "idle" };
			emit();
		}
	}

	/** The context Cleanup's measure and delete run with. */
	const cleanupCtx = (log: (line: string) => void) => ({
		run: deps.run,
		paths: deps.paths,
		pid: process.pid,
		procRoot: deps.procRoot ?? "/proc",
		devCaches: settings.devCaches === true,
		// A table's dest may start with ~; anything that is still not absolute is not looked in.
		leftoverDirs: (deps.leftoverDirs?.() ?? []).map((d) => expandHome(d, deps.paths.home)).filter((d) => isAbsolute(d)),
		log,
		onStart: (pid: number) => {
			child = pid;
		},
	});

	/**
	 * Measures every candidate, read-only, and lands each item as it is measured. A measure overtaken by a newer one or
	 * by Cleanup being switched off drops its answer. Not started while Cleanup is off or already measuring or cleaning.
	 */
	function measureNow() {
		if (cleanup.phase !== "idle") return { started: false };
		measureGeneration += 1;
		const mine = measureGeneration;
		const current = () => mine === measureGeneration && cleanup.phase === "measuring";
		cleanup = { ...cleanup, phase: "measuring", items: [] };
		emit();
		const done = measureCandidates(cleanupCtx(quiet), (items) => {
			if (!current()) return;
			cleanup = { ...cleanup, items };
			emit();
		})
			.then((m) => {
				if (!current()) return;
				measured = m;
				cleanup = { ...cleanup, phase: "idle", items: m.items, measuredAt: deps.now().toISOString() };
			})
			.catch(() => {
				if (current()) cleanup = { ...cleanup, phase: "idle", measuredAt: deps.now().toISOString() };
			})
			.finally(emit);
		running = Promise.all([running, done]).then(() => undefined);
		return { started: true };
	}

	/** Records a refused cleanup where the window shows it, and answers the request with it. Nothing ran. */
	function refuseCleanup(reason: string) {
		cleanup = { ...cleanup, last: { at: deps.now().toISOString(), outcomes: [], refused: reason } };
		emit();
		return { started: false, reason };
	}

	/**
	 * The cleanup itself, once the lock is held: each picked item's parts deleted in turn, one history row per item, the
	 * lock given back under this owner only, then a fresh measure so the sizes show what is left. A measure or command
	 * that throws ends the run: every item not finished by then is marked failed with the error's text, and still gets
	 * its history row, so the tab never stays on Cleaning and the run never rejects.
	 */
	async function cleanRun(picks: CleanupPick[], m: Measured, log: RunLog, runId: string) {
		const started = Date.now();
		const say = (text: string) => log.write({ at: deps.now().toISOString(), key: "cleanup", text });
		try {
			let outcomes: CleanupOutcome[];
			try {
				outcomes = await clean(picks, m, cleanupCtx(say), (o) => {
					const last = cleanup.last;
					if (!last) return;
					cleanup = { ...cleanup, last: { ...last, outcomes: last.outcomes.map((x) => (x.id === o.id ? o : x)) } };
					emit();
				});
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				say(`Cleanup stopped: ${detail}`);
				outcomes = structuredClone(cleanup.last?.outcomes ?? []);
				for (const o of outcomes)
					if (o.status === "queued" || o.status === "working") {
						o.status = "failed";
						o.detail = detail;
					}
				if (cleanup.last) cleanup = { ...cleanup, last: { ...cleanup.last, outcomes } };
			}
			const at = deps.now().toISOString();
			const ms = Date.now() - started;
			const rows: HistoryRow[] = outcomes.map((o) => ({
				key: `cleanup:${o.id}`,
				name: o.id,
				from: null,
				to: null,
				result: o.status === "done" ? "cleaned" : o.status === "skipped" ? "skipped" : "failed",
				detail: o.detail,
				ms,
				runId,
				at,
				stages: {},
				freed: o.freed,
			}));
			appendHistory(deps.paths, rows);
		} catch (err) {
			say(`Cleanup history not written: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			child = null;
			log.close();
			releaseLock(deps.paths, process.pid, CLEANUP_OWNER);
			measured = null;
			cleanup = { ...cleanup, phase: settings.cleanup ? "idle" : "off" };
			emit();
			if (settings.cleanup) measureNow();
		}
	}

	const extras: Extras = {
		snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		setSettings(patch) {
			// The group and its install switch stay on while an install runs: off would hide it and let the app quit mid-apt.
			if (installingNow && (patch.system === "off" || patch.systemInstall === false)) return settings;
			const was = settings.systemInstall === true;
			const before = settings;
			settings = updateExtras(deps.paths, patch);
			const cleanupOn = settings.cleanup === true;
			if (!cleanupOn && before.cleanup && cleanup.phase !== "cleaning") {
				measureGeneration += 1;
				measured = null;
				cleanup = cleanupOff(false);
				emit();
			} else if (cleanupOn && cleanup.phase === "off") {
				cleanup = cleanupOff(true);
				measureNow();
			} else if (cleanupOn && before.devCaches !== settings.devCaches && cleanup.phase !== "cleaning") {
				// The list gains or loses the developer caches: measure again, dropping a measure under way.
				measureGeneration += 1;
				cleanup = { ...cleanup, phase: "idle" };
				measureNow();
			}
			if (settings.system === "off") {
				generation += 1;
				system = offState();
				emit();
			} else if (system.mode === "off") {
				system = { ...offState(), mode: "show", phase: "idle" };
				emit();
				check();
			} else if (was !== (settings.systemInstall === true)) emit();
			return settings;
		},
		checkSystem: check,
		planSystem(ids) {
			const commands = planSteps(system.rows, ids, system.packages).map((s) => s.argv);
			if (!settings.systemInstall || system.mode !== "show") return { commands: [], reason: MESSAGES.systemNothing() };
			return commands.length > 0 ? { commands } : { commands, reason: MESSAGES.systemNothing() };
		},
		installSystem(ids, commands) {
			if (!settings.systemInstall || system.mode !== "show")
				return { started: false, reason: MESSAGES.systemNothing() };
			if (system.phase === "installing" || cleanup.phase === "cleaning")
				return { started: false, reason: MESSAGES.reasonBusy() };
			if (system.phase === "checking") return refuse(commands, MESSAGES.reasonChecking());
			const steps = planSteps(system.rows, ids, system.packages);
			if (steps.length === 0) return refuse(commands, MESSAGES.systemNothing());
			// What runs is exactly what the person was shown, or nothing.
			if (JSON.stringify(steps.map((s) => s.argv)) !== JSON.stringify(commands))
				return refuse(commands, MESSAGES.systemListChanged());
			if (!claimLock(deps.paths, process.pid, deps.procRoot, LOCK_OWNER))
				return refuse(commands, MESSAGES.reasonBusy());
			const now = deps.now();
			const runId = `${stamp(now)}-system`;
			let log: RunLog;
			try {
				log = openRunLog(deps.paths, runId);
			} catch (err) {
				releaseLock(deps.paths, process.pid, LOCK_OWNER);
				return refuse(commands, err instanceof Error ? err.message : String(err));
			}
			const queued = system.rows
				.filter((r) => steps.some((s) => s.ids.includes(r.id)))
				.map((r): SystemOutcome => ({ id: r.id, name: r.name, from: r.installed, to: r.latest, status: "queued" }));
			system = {
				...system,
				phase: "installing",
				install: { at: now.toISOString(), commands, outcomes: queued, refused: null },
			};
			emit();
			running = install(ids, commands, log, runId).catch((err: Error) => {
				const reason = err instanceof Error ? err.message : String(err);
				refuse(commands, reason);
			});
			return { started: true };
		},
		measureCleanup: measureNow,
		reviewCleanup(picks) {
			if (!settings.cleanup || !measured || cleanup.phase !== "idle")
				return { bytes: 0, commands: [], reason: MESSAGES.cleanNothing() };
			const r = review(picks, measured);
			return r.parts === 0 ? { ...r, reason: MESSAGES.cleanNothing() } : { bytes: r.bytes, commands: r.commands };
		},
		runCleanup(picks, commands, typed) {
			if (!settings.cleanup) return { started: false, reason: MESSAGES.cleanNothing() };
			if (cleanup.phase === "cleaning" || installingNow) return { started: false, reason: MESSAGES.reasonBusy() };
			if (cleanup.phase === "measuring" || !measured) return refuseCleanup(MESSAGES.cleanListChanged());
			const m = measured;
			const r = review(picks, m);
			if (r.parts === 0) return refuseCleanup(MESSAGES.cleanNothing());
			// What runs is exactly what the person reviewed, or nothing.
			if (JSON.stringify(r.commands) !== JSON.stringify(commands)) return refuseCleanup(MESSAGES.cleanListChanged());
			if (needsTyping(picks, m) && typed?.trim() !== TYPE_WORD)
				return refuseCleanup(MESSAGES.cleanTypeFirst(TYPE_WORD));
			if (!claimLock(deps.paths, process.pid, deps.procRoot, CLEANUP_OWNER))
				return refuseCleanup(MESSAGES.reasonBusy());
			// With the lock held no install runs, so a marker left is an interrupted one: its restore point and temp
			// copies are what recovery puts back, and none of them may go before it is finished.
			if (readInflight(deps.paths)) {
				releaseLock(deps.paths, process.pid, CLEANUP_OWNER);
				return refuseCleanup(MESSAGES.reasonUnrecovered());
			}
			const now = deps.now();
			const runId = `${stamp(now)}-cleanup`;
			let log: RunLog;
			try {
				log = openRunLog(deps.paths, runId);
			} catch (err) {
				releaseLock(deps.paths, process.pid, CLEANUP_OWNER);
				return refuseCleanup(err instanceof Error ? err.message : String(err));
			}
			const queued = r.items.map((id): CleanupOutcome => ({ id, status: "queued", freed: 0 }));
			cleanup = { ...cleanup, phase: "cleaning", last: { at: now.toISOString(), outcomes: queued, refused: null } };
			emit();
			running = Promise.all([running, cleanRun(picks, m, log, runId)]).then(() => undefined);
			return { started: true };
		},
		answerSnapshot(go) {
			if (!answer) return { ok: false };
			answer(go);
			return { ok: true };
		},
		installing: () => installingNow || cleanup.phase === "cleaning",
		stopSystem() {
			// A quit that cannot wait takes Stop as the answer to a failed snapshot's ask.
			answer?.(false);
			if (child !== null) killGroup(child);
		},
		async idle() {
			for (;;) {
				const p = running;
				// oxlint-disable-next-line no-await-in-loop -- a new check may start while we wait
				await p;
				if (p === running) return;
			}
		},
	};
	if (settings.system === "show") check();
	return extras;
}
