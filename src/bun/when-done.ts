import { canPower, COUNTDOWN_MS, type PowerAction, powerBlocker, powerNow } from "../engine/power";
import type { Run } from "../engine/run";
import type { RunState, SystemState, WhenDone, WhenDoneState } from "../shared/types";

/** Every when-done choice, in the order the window and the tray list them. */
export const WHEN_DONE: readonly WhenDone[] = ["nothing", "quit", "suspend", "poweroff"];

/** What the when-done choice needs from the main process; tests pass fakes, so nothing real ever powers off. */
export type WhenDonePorts = {
	run: Run;
	now: () => number;
	/** Calls fn after ms; the function returned stops it. */
	later: (ms: number, fn: () => void) => () => void;
	/** Shows the window and raises it above the others. */
	raise: () => void;
	/** Ends Upkeep the way the tray's Quit does. */
	quit: () => void;
	/** Every change of state, for the window and the tray. */
	tell: (state: WhenDoneState) => void;
	/** One English line for the run log's console. */
	log: (line: string) => void;
};

/** The when-done choice for one run, held in the main process so the window and the tray show the same one. */
export type WhenDoneControl = ReturnType<typeof createWhenDone>;

/**
 * One source of truth for what happens when a run ends. The choice lives for one run: a new run starts at Nothing,
 * and the end of a run consumes it. Suspend and power-off act only when every app updated, after a countdown that
 * Cancel stops; any failure cancels them and raises the window with the reason. Quit is left to the caller, which
 * already waits for the run's notice to go out first.
 */
export function createWhenDone(ports: WhenDonePorts) {
	let state: WhenDoneState = {
		choice: "nothing",
		can: { suspend: false, poweroff: false },
		countdown: null,
		cancelled: null,
	};
	let stopTimer: (() => void) | null = null;
	// A System install that failed since the last run ended: its apps run right after it, as one press.
	let systemFailed = false;
	let systemWas: SystemState["phase"] | null = null;

	/** Replaces the state and tells the window and the tray. */
	const set = (next: Partial<WhenDoneState>) => {
		state = { ...state, ...next };
		ports.tell(state);
	};

	/** Stops a running countdown's timer without touching the state. */
	const stopClock = () => {
		stopTimer?.();
		stopTimer = null;
	};

	/** The countdown reached zero: asks logind, then quits after a power-off it took, or shows its refusal and stays up. */
	const act = async (action: PowerAction) => {
		stopTimer = null;
		set({ countdown: null });
		// shortcut: a System install started while logind's own password ask is open still goes ahead; logind's call cannot be taken back.
		if (systemWas === "installing") {
			ports.log(`When done: ${action} cancelled, a System install is running`);
			set({ choice: "nothing" });
			return;
		}
		ports.log(`When done: asking logind to ${action}`);
		const refused = await powerNow(ports.run, action);
		if (refused === null) {
			if (action === "poweroff") ports.quit();
			return;
		}
		ports.log(`When done: logind refused to ${action}: ${refused}`);
		set({ cancelled: { action, why: "refused", detail: refused } });
		ports.raise();
	};

	/** Asks logind which power actions it allows, so the choice offers only those. Never throws. */
	const probe = async (): Promise<void> => {
		const [suspend, poweroff] = await Promise.all([canPower(ports.run, "suspend"), canPower(ports.run, "poweroff")]);
		// A choice logind stopped allowing goes back to Nothing rather than fail at the end.
		const lost = (state.choice === "suspend" && !suspend) || (state.choice === "poweroff" && !poweroff);
		if (lost) set({ can: { suspend, poweroff }, choice: "nothing" });
		else set({ can: { suspend, poweroff } });
	};

	return {
		snapshot: (): WhenDoneState => state,

		probe,

		/** Picks the choice for this run. False for an unknown word, or a power action logind does not allow here. */
		choose(choice: WhenDone): boolean {
			// The view's word is checked here: only a known choice is kept.
			if (!WHEN_DONE.includes(choice)) return false;
			if ((choice === "suspend" || choice === "poweroff") && !state.can[choice]) return false;
			if (choice !== state.choice) set({ choice });
			return true;
		},

		/**
		 * Cancels a countdown, which leaves Upkeep as it is; with none, takes away the note on why one did not happen.
		 * False when there was neither.
		 */
		cancel(): boolean {
			if (state.countdown) {
				stopClock();
				ports.log(`When done: ${state.countdown.action} cancelled`);
				set({ countdown: null, choice: "nothing", cancelled: null });
				return true;
			}
			if (!state.cancelled) return false;
			set({ cancelled: null });
			return true;
		},

		/** A run started: the choice starts at Nothing, an old note goes, and logind is asked again what it allows. */
		runStarted(): void {
			stopClock();
			set({ choice: "nothing", countdown: null, cancelled: null });
			void probe();
		},

		/**
		 * Follows the System install: one that ended with a failed step cancels a power action on the run after it, and one
		 * that starts during a countdown stops the countdown.
		 */
		system(sys: SystemState): void {
			if (sys.phase === "installing" && systemWas !== "installing") {
				systemFailed = false;
				// Never power off under a System install started during the countdown: someone is at the PC.
				if (state.countdown) {
					stopClock();
					ports.log(`When done: ${state.countdown.action} cancelled, a System install started`);
					set({ countdown: null, choice: "nothing", cancelled: null });
				}
			}
			if (systemWas === "installing" && sys.phase !== "installing")
				systemFailed = sys.install?.outcomes.some((o) => o.status === "failed") === true;
			systemWas = sys.phase;
		},

		/**
		 * A run ended. Returns "quit" when the caller should quit as the tray's Quit after this run does; a suspend or
		 * power-off starts its countdown, or is cancelled with the reason. Either way the window is raised, and the
		 * choice is used up.
		 */
		runEnded(run: RunState): "quit" | null {
			const choice = state.choice;
			const failedSystem = systemFailed;
			systemFailed = false;
			if (choice === "nothing") return null;
			set({ choice: "nothing" });
			if (choice === "quit") return "quit";
			const why = powerBlocker(run, failedSystem);
			if (why) {
				ports.log(`When done: ${choice} cancelled, the run did not finish cleanly (${why})`);
				set({ cancelled: { action: choice, why } });
				ports.raise();
				return null;
			}
			ports.log(`When done: ${choice} in ${COUNTDOWN_MS / 1000} s unless cancelled`);
			set({ countdown: { action: choice, at: ports.now() + COUNTDOWN_MS } });
			stopTimer = ports.later(COUNTDOWN_MS, () => void act(choice));
			ports.raise();
			return null;
		},
	};
}
