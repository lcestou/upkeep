import { expect, test } from "bun:test";
import { checkAtStart } from "./start-check";

/** An engine stand-in whose checks find the network down for the first `down` tries. */
function fakeEngine(down: number) {
	const checks: (boolean | undefined)[] = [];
	return {
		checks,
		check: async (_keys?: string[], opts?: { quietOffline?: boolean }) => {
			checks.push(opts?.quietOffline);
		},
		offline: () => checks.length <= down,
	};
}

test("a start with the network up checks once", async () => {
	const engine = fakeEngine(0);
	const waits: number[] = [];
	await checkAtStart(
		engine,
		async (ms) => {
			waits.push(ms);
		},
		[10, 20, 30],
	);
	expect(engine.checks).toEqual([true]);
	expect(waits).toEqual([]);
});

test("a start before the network is up waits and checks again quietly until one gets through", async () => {
	const engine = fakeEngine(2);
	const waits: number[] = [];
	await checkAtStart(
		engine,
		async (ms) => {
			waits.push(ms);
		},
		[10, 20, 30],
	);
	expect(engine.checks).toEqual([true, true, true]);
	expect(waits).toEqual([10, 20]);
});

test("when the network never comes, only the last try may show the failure", async () => {
	const engine = fakeEngine(99);
	const waits: number[] = [];
	await checkAtStart(
		engine,
		async (ms) => {
			waits.push(ms);
		},
		[10, 20, 30],
	);
	expect(engine.checks).toEqual([true, true, true, false]);
	expect(waits).toEqual([10, 20, 30]);
	// With no waits at all the one check is the last.
	const once = fakeEngine(99);
	await checkAtStart(once, async () => undefined, []);
	expect(once.checks).toEqual([false]);
});
