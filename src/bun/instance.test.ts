import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimInstance } from "./instance";

const dirs: string[] = [];
function socketPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "upkeep-instance-"));
	dirs.push(dir);
	return join(dir, "upkeep.sock");
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("the first claim is primary, the second asks it to show and steps aside", async () => {
	const path = socketPath();
	let shown = 0;
	expect(await claimInstance(path, () => shown++)).toBe("primary");
	expect(await claimInstance(path, () => {})).toBe("secondary");
	await Bun.sleep(50);
	expect(shown).toBe(1);
});

test("a socket file left by a crash does not block the next start", async () => {
	const path = socketPath();
	writeFileSync(path, "");
	expect(await claimInstance(path, () => {})).toBe("primary");
});

test("two starts at the same moment over a stale socket: exactly one becomes primary", async () => {
	const path = socketPath();
	writeFileSync(path, "");
	let shown = 0;
	const roles = await Promise.all([claimInstance(path, () => shown++), claimInstance(path, () => shown++)]);
	expect(roles.toSorted()).toEqual(["primary", "secondary"]);
	await Bun.sleep(50);
	expect(shown).toBe(1);
});
