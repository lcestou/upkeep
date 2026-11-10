import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppState, RunState, Snapshot } from "../shared/types";
import { isDevBuild } from "./dev-script";
import { claimInstance, releaseInstance } from "./instance";
import { trayIcon } from "./tray-model";

const dirs: string[] = [];
function socketPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "upkeep-r3-"));
	dirs.push(dir);
	return join(dir, "upkeep.sock");
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("a connection that does not say show leaves the window alone", async () => {
	const path = socketPath();
	let shown = 0;
	expect(await claimInstance(path, () => shown++)).toBe("primary");
	await Bun.connect({ unix: path, socket: { open: (s) => void s.end("ping\n"), data() {} } });
	await Bun.sleep(50);
	expect(shown).toBe(0);
});

test("a claim file left by a start that died is taken over after five seconds", async () => {
	const path = socketPath();
	writeFileSync(path, "");
	writeFileSync(`${path}.claim`, "");
	const old = (Date.now() - 6000) / 1000;
	utimesSync(`${path}.claim`, old, old);
	expect(await claimInstance(path, () => {})).toBe("primary");
	// Primary through the socket, not through the one-second give-up: a second start must find it.
	expect(await claimInstance(path, () => {})).toBe("secondary");
	expect(existsSync(`${path}.claim`)).toBe(false);
});

test("a run that ends with a rollback shows the failed icon", () => {
	const run: RunState = {
		id: "r",
		phase: "summary",
		index: 1,
		total: 1,
		currentKey: null,
		stopping: false,
		results: [{ key: "a", name: "A", from: "1", to: "1", result: "rolled_back" }] as RunState["results"],
	};
	const snapshot = { apps: [{ key: "a", name: "A", status: "rolled_back" } as AppState], run } as Snapshot;
	expect(trayIcon(snapshot)).toBe("failed");
});

test("a path that only contains a dev bundle further up is not a dev build", () => {
	expect(isDevBuild("/home/x/Upkeep-dev/Resources/app/bun/../../../../elsewhere")).toBe(false);
	expect(isDevBuild("/home/x/Upkeep-dev/Resources/app/bun/extra")).toBe(false);
});

test("releasing the instance stops answering and removes the socket, so a start during shutdown is primary", async () => {
	const path = socketPath();
	expect(await claimInstance(path, () => {})).toBe("primary");
	releaseInstance(path);
	expect(existsSync(path)).toBe(false);
	expect(await claimInstance(path, () => {})).toBe("primary");
});
