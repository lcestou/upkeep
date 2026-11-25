import { expect, test } from "bun:test";
import { REASON_BUSY, REASON_CHECKING, REASON_NOTHING } from "../engine/engine";
import { checkAndRetry, checkAtStart } from "./start-check";

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

/** An engine stand-in for the retry: each installAuto answers the next wait in turn. */
function retryEngine(offline: boolean, waits: ("metered" | "battery" | undefined)[]) {
	const calls: string[] = [];
	return {
		calls,
		check: async () => {
			calls.push("check");
		},
		offline: () => offline,
		installAuto: async () => {
			calls.push("installAuto");
			const wait = waits.shift();
			return wait ? { started: false, wait } : { started: true };
		},
	};
}

test("a busy or checking refusal keeps the apps waiting; a start or nothing ready ends the wait", async () => {
	const answer = (r: { started: boolean; reason?: string }) => ({
		check: async () => undefined,
		offline: () => false,
		installAuto: async () => r,
	});
	expect(await checkAndRetry(answer({ started: false, reason: REASON_BUSY }), "metered")).toBe("metered");
	expect(await checkAndRetry(answer({ started: false, reason: REASON_CHECKING }), "battery")).toBe("battery");
	expect(await checkAndRetry(answer({ started: false, reason: REASON_NOTHING }), "metered")).toBeUndefined();
	expect(await checkAndRetry(answer({ started: true }), "metered")).toBeUndefined();
});

test("a scheduled check retries automatic apps only while they wait, and keeps the wait when offline", async () => {
	const none = retryEngine(false, []);
	expect(await checkAndRetry(none, undefined)).toBeUndefined();
	expect(none.calls).toEqual(["check"]);
	const still = retryEngine(false, ["battery"]);
	expect(await checkAndRetry(still, "metered")).toBe("battery");
	expect(still.calls).toEqual(["check", "installAuto"]);
	const goes = retryEngine(false, [undefined]);
	expect(await checkAndRetry(goes, "metered")).toBeUndefined();
	const offline = retryEngine(true, []);
	expect(await checkAndRetry(offline, "metered")).toBe("metered");
	expect(offline.calls).toEqual(["check"]);
});
