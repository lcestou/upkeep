import { expect, test } from "bun:test";
import type { AppState, EngineEvent, RunState } from "../shared/types";
import { createCoalescer } from "./coalesce";

function app(key: string, stagePct: number): EngineEvent {
	return { type: "app", app: { key, stagePct } as AppState };
}
const run: EngineEvent = { type: "run", run: { phase: "summary" } as RunState };

function manualTimers() {
	let pending: (() => void) | null = null;
	return {
		timers: {
			set: (fn: () => void) => {
				pending = fn;
				return 1;
			},
			clear: () => {
				pending = null;
			},
		},
		fire: () => {
			const fn = pending;
			pending = null;
			fn?.();
		},
	};
}

test("many updates for one app inside a window become one, the latest", () => {
	const sent: EngineEvent[] = [];
	const t = manualTimers();
	const c = createCoalescer((e) => sent.push(e), 50, t.timers);
	c.push(app("fd", 10));
	c.push(app("fd", 40));
	c.push(app("fd", 90));
	expect(sent).toEqual([]);
	t.fire();
	expect(sent).toEqual([app("fd", 90)]);
});

test("each app keeps its own latest state", () => {
	const sent: EngineEvent[] = [];
	const t = manualTimers();
	const c = createCoalescer((e) => sent.push(e), 50, t.timers);
	c.push(app("fd", 10));
	c.push(app("zen", 5));
	c.push(app("fd", 20));
	t.fire();
	expect(sent).toEqual([app("fd", 20), app("zen", 5)]);
});

test("a run event flushes pending rows first, so the summary never overtakes the last row state", () => {
	const sent: EngineEvent[] = [];
	const t = manualTimers();
	const c = createCoalescer((e) => sent.push(e), 50, t.timers);
	c.push(app("fd", 100));
	c.push(run);
	expect(sent).toEqual([app("fd", 100), run]);
	t.fire();
	expect(sent).toHaveLength(2);
});

test("an extras event is never dropped and never overtakes the row updates sent before it", () => {
	const sent: EngineEvent[] = [];
	const { timers, fire } = manualTimers();
	const c = createCoalescer((e) => sent.push(e), 50, timers);
	const extras: EngineEvent = {
		type: "extras",
		extras: {
			settings: { system: "show" },
			system: { mode: "show", phase: "idle", rows: [], checkedAt: null, problem: null, glMissing: null },
		},
	};
	c.push(app("fd", 10));
	c.push(app("fd", 40));
	c.push(extras);
	c.push(app("fd", 90));
	fire();
	expect(sent).toEqual([app("fd", 40), extras, app("fd", 90)]);
});
