import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
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

test("a lock left by a process that died is taken over, and released after", () => {
	mkdirSync(t.paths.state, { recursive: true });
	const lock = join(t.paths.state, "state.json.lock");
	writeFileSync(lock, "99999");
	const old = new Date(Date.now() - 60_000);
	utimesSync(lock, old, old);
	const started = Date.now();
	updateState(t.paths, (s) => {
		s.hold.zen = true;
	});
	expect(Date.now() - started).toBeLessThan(1000);
	expect(loadState(t.paths).hold).toEqual({ zen: true });
	expect(existsSync(lock)).toBe(false);
});
