import type { EngineEvent } from "../shared/types";

type TimerHandle = ReturnType<typeof setTimeout>;
type Timers = { set: (fn: () => void, ms: number) => TimerHandle; clear: (handle: TimerHandle) => void };

const realTimers: Timers = {
	set: (fn, ms) => setTimeout(fn, ms),
	clear: (handle) => clearTimeout(handle),
};

/**
 * Thins out per-row updates on their way to the view. A download reports progress many times a
 * second; the view needs the latest state per app, not every step. Anything that is not a row
 * update flushes the pending rows first, so a summary can never arrive before the final state of
 * the rows it summarises.
 */
export function createCoalescer(send: (event: EngineEvent) => void, windowMs = 50, timers: Timers = realTimers) {
	const pending = new Map<string, EngineEvent>();
	let handle: TimerHandle | null = null;

	function flush(): void {
		if (handle !== null) timers.clear(handle);
		handle = null;
		for (const event of pending.values()) send(event);
		pending.clear();
	}

	function push(event: EngineEvent): void {
		if (event.type !== "app") {
			flush();
			send(event);
			return;
		}
		pending.set(event.app.key, event);
		if (handle === null) handle = timers.set(flush, windowMs);
	}

	return { push, flush };
}
