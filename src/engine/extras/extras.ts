import { MESSAGES } from "../../shared/messages";
import type {
	EngineEvent,
	ExtrasSettings,
	ExtrasSnapshot,
	HistoryRow,
	Requests,
	SystemOutcome,
	SystemState,
} from "../../shared/types";
import { stamp } from "../engine";
import type { Paths } from "../paths";
import { killGroup, type Run } from "../run";
import { appendHistory, claimLock, openRunLog, releaseLock, type RunLog } from "../store";
import { installable, outcomesAfter, planSteps, preflight, runSteps } from "./install";
import { loadExtras, updateExtras } from "./state";
import { checkSystem } from "./system";

export type ExtrasDeps = { paths: Paths; run: Run; now: () => Date; procRoot?: string };

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
	/** True while a System install runs: the window's close and the tray's Quit wait for it. */
	installing(): boolean;
	/** Ends the process group of the command a System install is running; for a quit that cannot wait. */
	stopSystem(): void;
	/** Resolves when no check or install is running. */
	idle(): Promise<void>;
};

/** The lock's owner name for a System install: the engine holds the same run lock under the same pid with none. */
const LOCK_OWNER = "system";

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

	/** installable is worked out here, never stored, so it always follows the rows and the switch. */
	const snapshot = (): ExtrasSnapshot => {
		const shown =
			settings.systemInstall && system.mode === "show"
				? { ...system, installable: system.rows.filter((r) => installable(r, system.packages)).map((r) => r.id) }
				: system;
		return structuredClone({ settings, system: shown });
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
		running = checkSystem({ run: deps.run })
			.then((found) => {
				if (!current()) return;
				system = { ...system, ...found, phase: "idle", checkedAt: deps.now().toISOString() };
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

	/**
	 * The install itself, once the lock is held: the read-only pre-checks, the steps, the list read again, then one
	 * history row per ticked row. The lock is given back in finally and only under this owner, so it never frees a lock
	 * the engine holds.
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
			// A row whose step has run stays working until the list read afterwards says how it ended.
			const failed = await runSteps(steps, ctx, (step) => {
				const outcomes = system.install?.outcomes ?? [];
				for (const o of outcomes) if (step.ids.includes(o.id)) o.status = "working";
				set(outcomes);
			});
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
			appendHistory(deps.paths, rows);
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
			settings = updateExtras(deps.paths, patch);
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
			if (system.phase === "installing") return { started: false, reason: MESSAGES.reasonBusy() };
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
		installing: () => installingNow,
		stopSystem() {
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
