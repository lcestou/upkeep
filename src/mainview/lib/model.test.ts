import "./runes-plugin";
import { describe, expect, test } from "bun:test";
import type { AppState, Snapshot } from "../../shared/types";
import { createFixture } from "./fixture";

// Imported after the plugin is registered, so the runes compile.
const { Model, groupOf } = await import("./model.svelte");

const until = async (ok: () => boolean, ms = 8000) => {
	const end = Date.now() + ms;
	while (!ok()) {
		if (Date.now() > end) throw new Error("timed out");
		// oxlint-disable-next-line no-await-in-loop -- polling
		await new Promise((r) => setTimeout(r, 10));
	}
};

async function started(variant: "default" | "empty" | "checking" | "problems" | "many" = "default") {
	const model = new Model(createFixture({ variant, speed: 40 }));
	await model.start();
	return model;
}

describe("first load", () => {
	test("ticks the four ready apps", async () => {
		const m = await started();
		expect([...m.ticked].toSorted()).toEqual(["cursor", "fd", "wrangler", "zen"]);
		expect(m.tickedApps.length).toBe(4);
		expect(m.sentence).toBe("4 updates ready");
	});

	test("sums the sizes it knows", async () => {
		const m = await started();
		expect(m.tickedBytes).toBe(108_940_288 + 1_203_456);
		m.toggle("zen");
		expect(m.tickedBytes).toBe(1_203_456);
		m.toggle("fd");
		expect(m.tickedBytes).toBeNull();
	});

	test("groups in plan order with Ready to install first", async () => {
		const m = await started();
		expect(m.groups.map((g) => g.label)).toEqual(["Ready to install", "By hand", "Needs a look", "Fresh"]);
		expect(m.groups[0]?.apps.map((a) => a.key)).toEqual(["zen", "fd", "wrangler", "cursor"]);
		expect(m.apps.length).toBe(32);
	});

	test("versionless apps are fresh and never ticked", async () => {
		const m = await started();
		const plugins = m.apps.filter((a) => a.versionless);
		expect(plugins.length).toBe(2);
		for (const a of plugins) {
			expect(a.status).toBe("fresh");
			expect(m.ticked.has(a.key)).toBe(false);
		}
	});
});

const app = (m: InstanceType<typeof Model>, key: string): AppState => {
	const a = m.apps.find((x) => x.key === key);
	if (!a) throw new Error(key);
	return a;
};

describe("events", () => {
	test("a newly ready app is ticked, a still-ready one keeps the owner's choice", () => {
		const m = new Model();
		const snap: Snapshot = {
			apps: [
				{ ...baseApp("bat"), status: "fresh" },
				{ ...baseApp("fd"), status: "ready" },
			],
			run: { id: null, phase: "idle", index: 0, total: 0, currentKey: null, stopping: false, results: [] },
			settings: { keepBackups: 1, notify: true, checkAtLogin: false },
			rate: null,
			checkedAt: null,
			version: "0",
		};
		m.load(snap);
		m.toggle("fd");
		expect(m.ticked.has("fd")).toBe(false);
		m.apply({ type: "app", app: { ...app(m, "fd"), status: "ready" } });
		expect(m.ticked.has("fd")).toBe(false);
		m.apply({ type: "app", app: { ...app(m, "bat"), status: "ready" } });
		expect(m.ticked.has("bat")).toBe(true);
		m.apply({ type: "app", app: { ...app(m, "bat"), status: "queued" } });
		expect(m.ticked.has("bat")).toBe(false);
	});

	test("rows in a run stay in Ready to install", () => {
		for (const status of ["queued", "working", "done", "failed", "rolled_back"] as const) {
			expect(groupOf({ ...baseApp("x"), status })).toBe("ready");
		}
	});

	test("Select none and Select all", async () => {
		const m = await started();
		m.selectNone();
		expect(m.tickedApps.length).toBe(0);
		m.selectAll();
		expect(m.tickedApps.length).toBe(4);
	});
});

describe("a scripted run", () => {
	test("walks to 3 updated, 1 failed and retries only wrangler", async () => {
		const m = await started();
		const seen = new Set<string>();
		const off = setInterval(() => seen.add(m.sentence), 5);
		await m.install();
		await until(() => m.run.phase === "summary");
		clearInterval(off);
		expect(m.sentence).toBe("3 updated, 1 failed");
		expect([...seen].some((s) => s.startsWith("Installing Zen Browser, 1 of 4"))).toBe(true);
		expect(m.failedKeys).toEqual(["wrangler"]);
		expect(m.apps.find((a) => a.key === "zen")?.restartToApply).toBe(true);
		expect(m.apps.find((a) => a.key === "wrangler")?.detail).toBe("Still at 4.157.0 after the update command.");
		expect(m.log.length).toBeGreaterThan(4);
		await m.retry();
		await until(() => m.run.phase === "summary" && m.run.results.length === 1);
		expect(m.run.results.map((r) => r.key)).toEqual(["wrangler"]);
		expect(m.sentence).toBe("1 updated");
		await m.dismiss();
		await until(() => m.run.phase === "idle");
		expect(m.groups.find((g) => g.id === "ready")).toBeUndefined();
		// LRCGET is the one problem left in the default list.
		expect(m.sentence).toBe("1 need a look");
	});

	test("Stop after this one returns the rest to ready and ticks them again", async () => {
		const m = await started();
		await m.install();
		await until(() => m.run.phase === "installing");
		await m.stopAfterCurrent();
		await until(() => m.run.phase === "summary");
		expect(m.run.results.map((r) => r.key)).toEqual(["zen"]);
		expect([...m.ticked].toSorted()).toEqual(["cursor", "fd", "wrangler"]);
	});
});

describe("the inspector", () => {
	test("follows the run while open and lands on the failure", async () => {
		const m = await started();
		m.select("bat");
		await m.install();
		await until(() => m.run.phase === "installing" && m.run.currentKey === "zen");
		expect(m.openKey).toBe("zen");
		await until(() => m.run.phase === "summary");
		expect(m.openKey).toBe("wrangler");
	});

	test("opens on the failure even when it was closed, and a pick during the run pins it", async () => {
		const m = await started();
		await m.install();
		await until(() => m.run.currentKey === "fd");
		expect(m.openKey).toBeNull();
		m.select("llama");
		await until(() => m.run.currentKey === "wrangler");
		expect(m.openKey).toBe("llama");
		await until(() => m.run.phase === "summary");
		expect(m.openKey).toBe("wrangler");
		expect(m.pinned).toBe(false);
	});

	test("a clean run does not open it", async () => {
		const m = await started();
		m.selectNone();
		m.toggle("fd");
		await m.install();
		await until(() => m.run.phase === "summary");
		expect(m.openKey).toBeNull();
		expect(m.groups[0]?.label).toBe("This run");
	});
});

describe("variants", () => {
	test("empty is fresh", async () => {
		expect((await started("empty")).sentence).toBe("Everything is fresh");
	});
	test("checking holds twelve apps", async () => {
		const m = await started("checking");
		expect(m.sentence).toBe("Checking 20 of 32");
		expect(m.apps.filter((a) => a.status === "checking").length).toBe(12);
	});
	test("problems", async () => {
		expect((await started("problems")).sentence).toBe("3 need a look");
	});
	test("many renders 60 apps", async () => {
		expect((await started("many")).apps.length).toBe(60);
	});
});

function baseApp(key: string): AppState {
	return {
		key,
		name: key,
		kind: "archive",
		installed: "1.0.0",
		latest: "1.0.1",
		status: "fresh",
		running: false,
		restartToApply: false,
		restorePoints: [],
		canRestore: true,
		auto: false,
		sudo: false,
		versionless: false,
		stages: [],
		held: false,
	};
}
