import { expect, test } from "bun:test";
import type { AppState, EngineEvent, RunState } from "../shared/types";
import { createCoalescer } from "./coalesce";

function app(key: string, stagePct: number): EngineEvent {
	return { type: "app", app: { key, stagePct } as AppState };
}
const run: EngineEvent = { type: "run", run: { phase: "summary" } as RunState };

function manualTimers() {
	let pending: (() => void) | null = null;
	// A spent real handle: the fake never starts a timer but must return the handle type the coalescer holds.
	const spent = setTimeout(() => {}, 0);
	clearTimeout(spent);
	return {
		timers: {
			set: (fn: () => void) => {
				pending = fn;
				return spent;
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
			system: {
				mode: "show",
				phase: "idle",
				rows: [],
				checkedAt: null,
				problem: null,
				glMissing: null,
				packages: null,
			},
			cleanup: { phase: "off", items: [], measuredAt: null, last: null },
		},
	};
	c.push(app("fd", 10));
	c.push(app("fd", 40));
	c.push(extras);
	c.push(app("fd", 90));
	fire();
	expect(sent).toEqual([app("fd", 40), extras, app("fd", 90)]);
});

test("with the real timers, a burst of updates for one app reaches the view as the latest one", async () => {
	const sent: EngineEvent[] = [];
	const c = createCoalescer((e) => sent.push(e), 5);
	c.push(app("fd", 10));
	c.push(app("fd", 70));
	expect(sent).toEqual([]);
	await Bun.sleep(40);
	expect(sent).toEqual([app("fd", 70)]);
});

test("a flush cancels the waiting timer, so nothing is sent twice", async () => {
	const sent: EngineEvent[] = [];
	const c = createCoalescer((e) => sent.push(e), 5);
	c.push(app("fd", 10));
	c.flush();
	await Bun.sleep(30);
	expect(sent).toEqual([app("fd", 10)]);
});
