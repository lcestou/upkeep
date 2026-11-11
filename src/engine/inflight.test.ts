import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readInflight, writeInflight } from "./store";
import { tempHome } from "./testkit";

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("inflight");
	mkdirSync(t.paths.state, { recursive: true });
});
afterEach(() => t.cleanup());

const raw = (v: unknown) => writeFileSync(join(t.paths.state, "inflight.json"), JSON.stringify(v));
const base = { key: "llama", dest: "/x/llama-server", backupVersion: "f2918cabb" };

test("a marker keeps a well-formed tree", () => {
	const tree = {
		step: "placing" as const,
		build: { pid: 4242, started: 9001 },
		active: ["llama-server"],
		paused: ["sd-api.service"],
	};
	writeInflight(t.paths, { ...base, tree });
	expect(readInflight(t.paths)).toEqual({ ...base, tree });
	raw({ ...base, tree: { ...tree, build: null } });
	expect(readInflight(t.paths)?.tree?.build).toBeNull();
});

test("a malformed tree is dropped and the rest of the marker kept", () => {
	const good = { step: "build", build: null, active: [], paused: [] };
	for (const tree of [
		{ ...good, active: "llama-server" },
		{ ...good, paused: [1] },
		{ ...good, step: "dancing" },
		{ ...good, build: { pid: "1", started: 2 } },
		"tree",
	]) {
		raw({ ...base, tree });
		expect(readInflight(t.paths)).toEqual(base);
	}
	raw(base);
	expect(readInflight(t.paths)).toEqual(base);
});
