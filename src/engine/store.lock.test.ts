import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadState, updateState } from "./store";
import { tempHome } from "./testkit";

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("state-lock");
});
afterEach(() => t.cleanup());

test("two processes changing state.json at once both keep every change", async () => {
	// Each writer marks 40 keys of its own; without the lock, one's read-change-write erases the other's.
	const writer = (name: string) =>
		Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { updateState } from ${JSON.stringify(join(import.meta.dir, "store.ts"))};
const paths = JSON.parse(process.env.UPKEEP_PATHS);
for (let i = 0; i < 40; i++) updateState(paths, (s) => { s.hold["${name}-" + i] = true; });`,
			],
			{ env: { ...process.env, UPKEEP_PATHS: JSON.stringify(t.paths) }, stdout: "ignore", stderr: "inherit" },
		);
	const a = writer("a");
	const b = writer("b");
	expect([await a.exited, await b.exited]).toEqual([0, 0]);
	expect(Object.keys(loadState(t.paths).hold).length).toBe(80);
	expect(existsSync(join(t.paths.state, "state.json.lock"))).toBe(false);
});

test("a lock left by a process that died is taken over at once, and released after", () => {
	mkdirSync(t.paths.state, { recursive: true });
	const lock = join(t.paths.state, "state.json.lock");
	// A pid far above any live one: its holder is gone, however fresh the file.
	writeFileSync(lock, "999999999");
	const started = Date.now();
	updateState(t.paths, (s) => {
		s.hold.zen = true;
	});
	expect(Date.now() - started).toBeLessThan(1000);
	expect(loadState(t.paths).hold).toEqual({ zen: true });
	expect(existsSync(lock)).toBe(false);
});

test("a live holder's lock is waited for, never taken; a pidless old one is; and no lock at all still writes", () => {
	mkdirSync(t.paths.state, { recursive: true });
	const lock = join(t.paths.state, "state.json.lock");
	// This test process is alive: its lock is waited out (2 s), not removed, and the change still goes through.
	writeFileSync(lock, String(process.pid));
	const started = Date.now();
	updateState(t.paths, (s) => {
		s.hold.a = true;
	});
	expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
	expect(existsSync(lock)).toBe(true);
	expect(loadState(t.paths).hold.a).toBe(true);
	// An old lock counts as left behind even when its pid is alive again (reused after a crash), and so does a pidless one.
	const old = new Date(Date.now() - 60_000);
	utimesSync(lock, old, old);
	updateState(t.paths, (s) => {
		s.hold.reused = true;
	});
	expect(existsSync(lock)).toBe(false);
	writeFileSync(lock, "");
	utimesSync(lock, old, old);
	updateState(t.paths, (s) => {
		s.hold.b = true;
	});
	expect(existsSync(lock)).toBe(false);
	// A folder where no lock can be made: the change is attempted without one, and fails as a write there would.
	const ro = tempHome("state-ro");
	mkdirSync(ro.paths.state, { recursive: true });
	chmodSync(ro.paths.state, 0o555);
	expect(() =>
		updateState(ro.paths, (s) => {
			s.hold.c = true;
		}),
	).toThrow();
	chmodSync(ro.paths.state, 0o755);
	ro.cleanup();
});

test("a lock that cannot be removed is gone around, and the change still goes through", () => {
	mkdirSync(join(t.paths.state, "state.json.lock"), { recursive: true });
	const old = new Date(Date.now() - 60_000);
	utimesSync(join(t.paths.state, "state.json.lock"), old, old);
	updateState(t.paths, (s) => {
		s.hold.dir = true;
	});
	expect(loadState(t.paths).hold.dir).toBe(true);
});
