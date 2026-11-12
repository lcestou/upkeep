import type { EngineEvent, ExtrasSettings, ExtrasSnapshot, SystemState } from "../../shared/types";
import type { Paths } from "../paths";
import type { Run } from "../run";
import { loadExtras, updateExtras } from "./state";
import { checkSystem } from "./system";

export type ExtrasDeps = { paths: Paths; run: Run; now: () => Date };

export type Extras = {
	snapshot(): ExtrasSnapshot;
	subscribe(listener: (e: EngineEvent) => void): () => void;
	setSettings(patch: Partial<ExtrasSettings>): ExtrasSettings;
	/** Starts a read-only check unless one runs or the area is off. */
	checkSystem(): { started: boolean };
	/** Resolves when no check is running. */
	idle(): Promise<void>;
};

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
 * timer, because Update Manager refreshes the apt cache itself and Upkeep never does.
 */
export function createExtras(deps: ExtrasDeps): Extras {
	const listeners = new Set<(e: EngineEvent) => void>();
	let settings = loadExtras(deps.paths);
	let system: SystemState = settings.system === "show" ? { ...offState(), mode: "show", phase: "idle" } : offState();
	let running: Promise<void> = Promise.resolve();

	const snapshot = (): ExtrasSnapshot => structuredClone({ settings, system });
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

	/** Not started when the area is off or a check already runs. The check reports through emit, never by throwing. */
	function check() {
		if (system.mode !== "show" || system.phase === "checking") return { started: false };
		system = { ...system, phase: "checking" };
		emit();
		running = checkSystem({ run: deps.run })
			.then((found) => {
				// Turned off while it ran: drop what it found.
				if (system.mode !== "show") return;
				system = { ...system, ...found, phase: "idle", checkedAt: deps.now().toISOString() };
			})
			.catch((err: Error) => {
				if (system.mode !== "show") return;
				const detail = err instanceof Error ? err.message : String(err);
				system = { ...system, phase: "idle", problem: { code: "failed", command: "", detail } };
			})
			.finally(emit);
		return { started: true };
	}

	const extras: Extras = {
		snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		setSettings(patch) {
			settings = updateExtras(deps.paths, patch);
			if (settings.system === "off") {
				system = offState();
				emit();
			} else if (system.mode === "off") {
				system = { ...offState(), mode: "show", phase: "idle" };
				emit();
				check();
			}
			return settings;
		},
		checkSystem: check,
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
