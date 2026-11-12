import { expect, test } from "bun:test";
import { CHECK_EVERY_MS, checkDue, startSchedule } from "./schedule";

const H = 3600_000;

test("a check is due once either clock passes the interval, never with Only when I ask", () => {
	const last = { wall: 0, mono: 0 };
	expect(checkDue({ wall: 5 * H, mono: 5 * H }, last, 6 * H)).toBe(false);
	expect(checkDue({ wall: 6 * H, mono: 6 * H }, last, 6 * H)).toBe(true);
	// The wall clock set back an hour after boot: the monotonic clock still brings the check.
	expect(checkDue({ wall: 5 * H, mono: 6 * H }, last, 6 * H)).toBe(true);
	// Asleep for a day: the monotonic clock stood still, the wall clock brings one check on waking.
	expect(checkDue({ wall: 24 * H, mono: 1 * H }, last, 6 * H)).toBe(true);
	expect(checkDue({ wall: 99 * H, mono: 99 * H }, last, CHECK_EVERY_MS.ask)).toBe(false);
	expect(checkDue({ wall: 0, mono: 0 }, null, 6 * H)).toBe(true);
});

test("the schedule checks when due and idle, once, and a check pressed by hand resets it", async () => {
	let now = { wall: 0, mono: 0 };
	let idle = false;
	let checks = 0;
	const s = startSchedule({ every: () => "6h", idle: () => idle, check: () => checks++, clocks: () => now, tickMs: 5 });
	const tick = () => Bun.sleep(15);
	now = { wall: 7 * H, mono: 7 * H };
	await tick();
	expect(checks).toBe(0);
	idle = true;
	await tick();
	expect(checks).toBe(1);
	await tick();
	expect(checks).toBe(1);
	now = { wall: 12 * H, mono: 12 * H };
	s.checked();
	now = { wall: 14 * H, mono: 14 * H };
	await tick();
	expect(checks).toBe(1);
	s.stop();
});

test("on the real clocks Only when I ask never checks, and a fresh start is not due", async () => {
	let checks = 0;
	const s = startSchedule({ every: () => "ask", idle: () => true, check: () => checks++, tickMs: 5 });
	await Bun.sleep(20);
	s.checked();
	const daily = startSchedule({ every: () => "daily", idle: () => true, check: () => checks++, tickMs: 5 });
	await Bun.sleep(20);
	expect(checks).toBe(0);
	s.stop();
	daily.stop();
});
