import type { Settings } from "../shared/types";

/** How long each "Check for updates" choice waits between checks; "ask" never checks on its own. */
export const CHECK_EVERY_MS = {
	"6h": 6 * 3600_000,
	daily: 24 * 3600_000,
	ask: null,
} satisfies Record<Settings["checkEvery"], number | null>;

/** One moment on both clocks: wall is Date.now(), mono only ever counts forward (and stops while the machine sleeps). */
export type Clocks = { wall: number; mono: number };

/**
 * Whether a scheduled check is due. Due when either clock says the interval has passed since the last check: the
 * monotonic one so a wall-clock jump backwards (a hardware clock an hour fast, then corrected) never freezes the
 * schedule, the wall one so a machine that slept through the interval checks once on waking. A wall jump forwards can
 * bring one check early, never a burst: every check resets both.
 */
export function checkDue(now: Clocks, last: Clocks | null, every: number | null): boolean {
	if (every === null) return false;
	if (last === null) return true;
	return now.mono - last.mono >= every || now.wall - last.wall >= every;
}

/**
 * Checks on the owner's schedule while Upkeep runs, window or tray. Looks once a minute; a check runs only when the
 * engine is idle, so never during an install or another check. Any check, scheduled or pressed, resets the clocks:
 * the caller reports each finished check through checked(). Returns stop().
 */
export function startSchedule(o: {
	every: () => Settings["checkEvery"];
	idle: () => boolean;
	check: () => void;
	clocks?: () => Clocks;
	tickMs?: number;
}) {
	const clocks = o.clocks ?? (() => ({ wall: Date.now(), mono: performance.now() }));
	let last: Clocks | null = clocks();
	const tick = () => {
		if (!o.idle()) return;
		if (!checkDue(clocks(), last, CHECK_EVERY_MS[o.every()])) return;
		last = clocks();
		o.check();
	};
	const id = setInterval(tick, o.tickMs ?? 60_000);
	return {
		checked: () => {
			last = clocks();
		},
		stop: () => clearInterval(id),
	};
}
