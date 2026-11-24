import { expect, test } from "bun:test";
import type { Run } from "../engine/run";
import { DEFAULT_SETTINGS } from "../engine/store";
import { ok } from "../engine/testkit";
import type { Snapshot } from "../shared/types";
import { autoInstall, checkAtStart } from "./start-check";

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

/** An engine stand-in with these automatic apps ready and the wait switch as given. */
function autoEngine(keys: string[], waitUnmetered: boolean) {
	const installed: string[][] = [];
	const snapshot = (): Snapshot =>
		// SAFETY: autoInstall reads only settings from the snapshot.
		({ settings: { ...DEFAULT_SETTINGS, waitUnmetered } }) as Snapshot;
	return {
		installed,
		readyKeys: () => keys,
		install: async (k: string[]) => {
			installed.push(k);
			return { started: true };
		},
		snapshot,
	};
}

const meteredRun: Run = async (argv) => ok(argv.includes("Metered") ? "u 1" : "b false");

test("automatic apps install at a login start unless the wait is on and the connection is metered", async () => {
	const off = autoEngine(["a"], false);
	expect(await autoInstall(off, meteredRun)).toBeNull();
	expect(off.installed).toEqual([["a"]]);
	const on = autoEngine(["a"], true);
	expect(await autoInstall(on, meteredRun)).toBe("metered");
	expect(on.installed).toEqual([]);
	const noBus = autoEngine(["a"], true);
	expect(await autoInstall(noBus, undefined)).toBeNull();
	expect(noBus.installed).toEqual([["a"]]);
	const none = autoEngine([], true);
	expect(await autoInstall(none, meteredRun)).toBeNull();
	expect(none.installed).toEqual([]);
});
