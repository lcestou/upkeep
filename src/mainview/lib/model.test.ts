import "./runes-plugin";
import { describe, expect, jest, test } from "bun:test";
import type { AppState, Snapshot } from "../../shared/types";
import { createFixture } from "./fixture";

// Imported after the plugin is registered, so the runes compile.
const { Model, groupOf, runLabel } = await import("./model.svelte");

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

	test("a Shift-click ticks or unticks every ready app listed since the last one clicked", async () => {
		const m = await started();
		// Ready to install lists Cursor, fd, wrangler, Zen Browser.
		m.toggle("cursor");
		m.toggle("wrangler", true);
		expect([...m.ticked].toSorted()).toEqual(["zen"]);
		// Upward too: the clicked row's new tick spreads back to fd.
		m.toggle("fd");
		m.toggle("cursor", true);
		expect([...m.ticked].toSorted()).toEqual(["cursor", "fd", "zen"]);
	});

	test("groups in plan order with Ready to install first, each alphabetical by name whatever the list order", async () => {
		const m = await started();
		expect(m.groups.map((g) => g.label)).toEqual(["Ready to install", "By hand", "Needs a look", "Fresh"]);
		expect(m.groups[0]?.apps.map((a) => a.name)).toEqual(["Cursor", "fd", "wrangler", "Zen Browser"]);
		const fresh = m.groups.at(-1)?.apps.map((a) => a.name.toLowerCase()) ?? [];
		expect(fresh).toEqual(fresh.toSorted((a, b) => a.localeCompare(b)));
		expect(m.apps.length).toBe(32);
	});

	test("versionless apps are fresh and never ticked", async () => {
		const m = await started();
		const plugins = m.apps.filter((a) => a.versionless);
		expect(plugins.length).toBe(1);
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
			run: {
				id: null,
				phase: "idle",
				index: 0,
				total: 0,
				currentKey: null,
				stopping: false,
				results: [],
				retry: false,
			},
			settings: {
				keepBackups: 1,
				notify: true,
				checkAtLogin: false,
				checkEvery: "6h",
				frame: "own",
				buttons: "auto",
				corners: "rounded",
				language: "system",
				selfAuto: false,
				upkeepCommand: false,
			},
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

	test("rows in a run form their own group, and a re-checked row keeps its group", () => {
		expect(groupOf({ ...baseApp("x"), status: "checking" }, "ready")).toBe("ready");
		expect(groupOf({ ...baseApp("x"), status: "checking" })).toBe("checking");
		for (const status of ["queued", "working", "done", "failed", "rolled_back"] as const) {
			expect(groupOf({ ...baseApp("x"), status })).toBe("run");
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
		expect(m.apps.find((a) => a.key === "wrangler")?.detail).toBe("Still at 4.157.0 after the update.");
		expect(m.log.length).toBeGreaterThan(4);
		await m.retry();
		// A retry keeps the first pass: the summary now counts all four.
		await until(() => m.run.phase === "summary" && m.run.results.length === 4 && m.failedKeys.length === 0);
		expect(m.run.results.filter((r) => r.key === "wrangler").map((r) => r.result)).toEqual(["updated"]);
		expect(m.sentence).toBe("4 updated");
		await m.dismiss();
		await until(() => m.run.phase === "idle");
		expect(m.groups.find((g) => g.id === "ready")).toBeUndefined();
		// LRCGET is the one problem left in the default list.
		expect(m.sentence).toBe("1 needs a look");
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

describe("a re-check", () => {
	test("keeps the owner's ticks and each row's group", async () => {
		const m = await started();
		m.toggle("fd");
		let sawFdInReady = false;
		const off = setInterval(() => {
			if (m.apps.find((a) => a.key === "fd")?.status === "checking")
				sawFdInReady ||= m.groups.find((g) => g.id === "ready")?.apps.some((a) => a.key === "fd") ?? false;
		}, 2);
		await m.check();
		await until(() => m.run.phase === "checking");
		await until(() => m.run.phase === "idle");
		clearInterval(off);
		expect(sawFdInReady).toBe(true);
		expect([...m.ticked].toSorted()).toEqual(["cursor", "wrangler", "zen"]);
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

describe("a model with no bridge", () => {
	test("stays empty and every request resolves to nothing", async () => {
		const m = new Model();
		await m.start();
		expect(m.loaded).toBe(false);
		expect(await m.send("check", {})).toBeNull();
		await m.install(["fd"]);
		expect(m.starting).toBe(false);
		await m.check();
		await m.loadHistory();
		expect(m.history).toEqual([]);
	});

	test("stop is safe to call twice", async () => {
		const m = await started();
		m.stop();
		m.stop();
		expect(m.loaded).toBe(true);
	});
});

describe("the inspector and the add pane", () => {
	test("opening the add pane closes the inspector, and a drop asks the pane to find its text", async () => {
		const m = await started();
		m.select("fd");
		expect(m.openKey).toBe("fd");
		m.openAdd();
		expect(m.openKey).toBeNull();
		expect(m.adding).toBe(true);
		expect(m.findSeq).toBe(0);
		m.openAdd("sharkdp/fd");
		expect(m.addInput).toBe("sharkdp/fd");
		expect(m.findSeq).toBe(1);
		m.select("fd");
		expect(m.adding).toBe(false);
		m.close();
		expect(m.openKey).toBeNull();
	});

	test("a notice clears itself after five seconds and a second one restarts the clock", async () => {
		const m = await started();
		jest.useFakeTimers();
		try {
			m.flash("notice", "Removed fd.");
			jest.advanceTimersByTime(3000);
			m.flash("notice", "Removed bat.");
			jest.advanceTimersByTime(3000);
			expect(m.notice).toBe("Removed bat.");
			jest.advanceTimersByTime(2000);
			expect(m.notice).toBeNull();
			m.flash("added", "Added fd.", "fd");
			expect(m.addedNote).toEqual({ key: "fd", text: "Added fd." });
			jest.advanceTimersByTime(5000);
			expect(m.addedNote).toBeNull();
		} finally {
			jest.useRealTimers();
		}
	});
});

describe("engine events", () => {
	test("the log keeps the newest 2000 lines, each numbered once so a keyed list redraws only what changed", async () => {
		const m = await started("empty");
		for (let i = 0; i < 2005; i++) m.apply({ type: "log", line: { at: "t", key: null, text: String(i) } });
		expect(m.log.length).toBe(2000);
		expect(m.log[0]?.text).toBe("5");
		expect(new Set(m.log.map((l) => l.id)).size).toBe(2000);
		expect(m.log[0]?.id).toBe(6);
		expect(m.log.at(-1)?.id).toBe(2005);
	});

	test("chrome, extras and meta replace what the window shows", async () => {
		const m = await started("empty");
		m.apply({
			type: "chrome",
			chrome: { own: false, side: "right", order: ["minimize", "maximize", "close"], maximized: false, rounded: false },
		});
		expect(m.chrome?.own).toBe(false);
		m.apply({
			type: "meta",
			rate: { limit: 60, remaining: 7 },
			checkedAt: "2026-11-10T09:00:00Z",
			settings: { ...m.settings, notify: false },
		});
		expect(m.rate).toEqual({ limit: 60, remaining: 7 });
		expect(m.checkedAt).toBe("2026-11-10T09:00:00Z");
		expect(m.settings.notify).toBe(false);
	});

	test("a removed app leaves the list, the ticks and the inspector", async () => {
		const m = await started();
		m.select("fd");
		m.apply({ type: "removed", key: "fd" });
		expect(m.apps.some((a) => a.key === "fd")).toBe(false);
		expect(m.ticked.has("fd")).toBe(false);
		expect(m.openKey).toBeNull();
	});

	test("a fresh row cannot be ticked", async () => {
		const m = await started();
		const fresh = m.apps.find((a) => a.status === "fresh");
		m.toggle(fresh?.key ?? "");
		expect(m.ticked.has(fresh?.key ?? "")).toBe(false);
	});
});

describe("the filter", () => {
	test("matches name or repo, and Install still counts ticked apps it hides", async () => {
		const m = await started();
		m.filter = " ZEN ";
		expect(m.shown.map((a) => a.key)).toContain("zen");
		expect(m.shown.length).toBeLessThan(m.apps.length);
		expect(m.hiddenTicked).toBe(3);
		expect(m.tickedApps.length).toBe(4);
		m.selectNone();
		expect(m.ticked.has("fd")).toBe(true);
		expect(m.ticked.has("zen")).toBe(false);
	});

	test("labels the run group by phase", () => {
		expect(runLabel("installing")).toBe("Installing");
		expect(runLabel("summary")).toBe("This run");
	});
});

describe("the System group", () => {
	test("turning it on shows it checking, turning it off removes the rows", async () => {
		const m = new Model(createFixture({ speed: 40, system: "off" }));
		await m.start();
		expect(m.systemShown).toEqual([]);
		await m.setExtras({ system: "show" });
		expect(m.extras?.system.phase).toBe("checking");
		expect(m.extras?.system.mode).toBe("show");
		await m.setExtras({ system: "off" });
		expect(m.extras?.system.rows).toEqual([]);
		expect(m.extras?.system.phase).toBe("off");
	});

	test("the filter narrows the rows it shows by name", async () => {
		const m = new Model(createFixture({ speed: 40, system: "show" }));
		await m.start();
		const all = m.systemShown.length;
		expect(all).toBeGreaterThan(1);
		m.filter = m.systemShown[0]?.name.toLowerCase() ?? "";
		expect(m.systemShown.length).toBeGreaterThan(0);
		expect(m.systemShown.length).toBeLessThan(all);
	});

	test("a check also asks the system list while the group is on", async () => {
		const m = new Model(createFixture({ speed: 40, system: "show" }));
		await m.start();
		await m.check();
		await until(() => m.run.phase === "idle");
		expect(globalThis.upkeepSysOps?.length ?? 0).toBeGreaterThan(0);
	});
});

describe("requests the window sends", () => {
	test("History loads the rows, Stop and Dismiss reach the engine without throwing", async () => {
		const m = await started();
		await m.loadHistory();
		expect(m.history.length).toBeGreaterThan(0);
		await m.stopAfterCurrent();
		await m.dismiss();
	});

	test("a second Install is ignored until the first answers", async () => {
		const m = await started();
		const first = m.install(["fd"]);
		expect(m.starting).toBe(true);
		await m.install(["zen"]);
		await first;
		expect(m.starting).toBe(false);
	});

	test("a rejected request leaves what the window already shows", async () => {
		const m = new Model(createFixture({ speed: 40, fail: "history" }));
		await m.start();
		await m.loadHistory();
		expect(m.history).toEqual([]);
	});
});

describe("what the components read and write", () => {
	test("the view starts on updates and the header, add pane and list read the fields the window sets", async () => {
		const m = await started();
		expect(m.view).toBe("updates");
		expect(m.version).not.toBe("");
		m.view = "history";
		m.dropProblem = "Could not read that file.";
		m.reveal++;
		m.log = [{ at: "t", key: null, text: "x", id: 1 }];
		expect([m.view, m.dropProblem, m.reveal, m.log.length]).toEqual(["history", "Could not read that file.", 1, 1]);
		expect(m.allFresh).toBe(false);
		expect(m.restarts).toEqual([]);
		expect(m.refusal).toBeNull();
		expect(m.openApp).toBeNull();
		expect(m.queue).toEqual([]);
	});

	test("a re-check remembers where each row was until the answer arrives", async () => {
		const m = await started();
		const zen = m.apps.find((a) => a.key === "zen");
		if (!zen) throw new Error("fixture lost zen");
		m.apply({ type: "app", app: { ...zen, status: "checking" } });
		expect(m.prior.zen).toBe("ready");
		m.apply({ type: "app", app: zen });
		expect(m.prior.zen).toBeUndefined();
		m.prior = {};
		expect(m.prior).toEqual({});
	});

	test("Upkeep's own update arrives with the first answers and follows its events, and waits for a run", async () => {
		const m = new Model(createFixture({ speed: 40, self: "available" }));
		await m.start();
		expect(m.self).toEqual({ phase: "available", from: "0.1.0", version: "0.1.1" });
		expect(m.selfBusy).toBe(false);
		await m.send("selfUpdate", {});
		await until(() => m.self.phase === "ready");
		m.apply({ type: "self", self: { phase: "none" } });
		expect(m.self).toEqual({ phase: "none" });
		await m.install(["fd"]);
		await until(() => m.run.phase === "installing");
		expect(m.selfBusy).toBe(true);
		await until(() => m.run.phase === "summary");
		expect(m.selfBusy).toBe(false);
		m.stop();
		// A version that fails its start test ends failed, with the reason.
		const failing = new Model(createFixture({ speed: 40, self: "available", selfTestFails: true }));
		await failing.start();
		await failing.send("selfUpdate", {});
		await until(() => failing.self.phase === "failed");
		failing.stop();
		// With nothing asked for, the row has nothing to show.
		const plain = await started();
		expect(plain.self).toEqual({ phase: "none" });
	});

	test("the queue lists the run's apps, and Open shows the inspector app", async () => {
		const m = await started();
		m.select("fd");
		expect(m.openApp?.key).toBe("fd");
		await m.install(["fd", "zen"]);
		await until(() => m.run.phase === "installing");
		expect(m.queue.length).toBeGreaterThan(0);
		await until(() => m.run.phase === "summary");
	});
});

describe("System rows in the footer's Install", () => {
	/** A model on the fixture with System install on; the four ready apps start ticked. */
	async function withSystem(system: "install" | "refuse") {
		const m = new Model(createFixture({ speed: 40, system }));
		await m.start();
		await until(() => (m.extras?.system.installable?.length ?? 0) > 0);
		return m;
	}

	test("a Shift-click ranges over installable rows only, and Select none clears them", async () => {
		const m = await withSystem("install");
		const ids = m.systemShown.filter((r) => m.systemCan.has(r.id)).map((r) => r.id);
		m.tickSystem(ids[0] ?? "", true);
		m.tickSystem(ids[2] ?? "", true, true);
		expect(m.systemPicked).toEqual(ids.slice(0, 3));
		m.tickSystem(ids[1] ?? "", false);
		expect(m.systemPicked).toEqual([ids[0] ?? "", ids[2] ?? ""]);
		m.selectNone();
		expect(m.systemPicked).toEqual([]);
		expect(m.tickedApps).toEqual([]);
	});

	test("with System rows ticked, Install shows the plan and nothing runs until confirmed; then the apps follow", async () => {
		const m = await withSystem("install");
		m.tickSystem("apt:perl", true);
		await m.installTicked();
		expect(m.systemPlan?.ids).toEqual(["apt:perl"]);
		expect(m.run.phase).toBe("idle");
		expect(m.extras?.system.phase).toBe("idle");
		await m.confirmSystem();
		expect(m.systemPlan).toBeNull();
		expect(m.systemTicked.size).toBe(0);
		expect(m.extras?.system.phase).toBe("installing");
		expect(m.run.phase).toBe("idle");
		// The apps start only once the System install has ended.
		await until(() => m.run.phase === "installing" || m.run.phase === "summary");
		expect(m.extras?.system.phase).toBe("idle");
	});

	test("a refused System install shows its reason and the apps start at once", async () => {
		const m = await withSystem("refuse");
		m.tickSystem("apt:perl", true);
		await m.installTicked();
		await m.confirmSystem();
		await until(() => m.extras?.system.install?.refused !== null && m.extras?.system.phase === "idle");
		await until(() => m.run.phase === "installing" || m.run.phase === "summary");
	});

	test("with no System row ticked, Install starts the app run without a plan", async () => {
		const m = await withSystem("install");
		await m.installTicked();
		expect(m.systemPlan).toBeNull();
		await until(() => m.run.phase === "installing" || m.run.phase === "summary");
	});

	test("Confirm with no plan does nothing, and a row that became uninstallable drops from the pick", async () => {
		const m = await withSystem("install");
		await m.confirmSystem();
		expect(m.extras?.system.phase).toBe("idle");
		m.tickSystem("apt:perl", true);
		m.extras = m.extras && { ...m.extras, system: { ...m.extras.system, installable: [] } };
		expect(m.systemPicked).toEqual([]);
	});

	test("a plan request that fails runs nothing and keeps every tick", async () => {
		const m = new Model(createFixture({ speed: 40, system: "install", fail: "systemPlan" }));
		await m.start();
		await until(() => (m.extras?.system.installable?.length ?? 0) > 0);
		m.tickSystem("apt:perl", true);
		await m.installTicked();
		expect(m.systemPlan).toBeNull();
		expect(m.systemReason).toBeNull();
		await new Promise((r) => setTimeout(r, 50));
		expect(m.run.phase).toBe("idle");
		expect(m.systemPicked).toEqual(["apt:perl"]);
		expect(m.tickedApps.length).toBe(4);
	});

	test("a tick change closes the sheet, so what runs always matches the ticks", async () => {
		const m = await withSystem("install");
		m.tickSystem("apt:perl", true);
		m.tickSystem("flatpak:com.discordapp.Discord", true);
		await m.installTicked();
		expect(m.systemPlan?.ids.length).toBe(2);
		m.tickSystem("apt:perl", false);
		expect(m.systemPlan).toBeNull();
		await m.installTicked();
		m.selectNone();
		expect(m.systemPlan).toBeNull();
	});

	test("Confirm unticks only the rows in the plan; a row ticked meanwhile stays for the next press", async () => {
		const m = await withSystem("install");
		m.tickSystem("apt:perl", true);
		await m.installTicked();
		const plan = m.systemPlan;
		m.systemTicked = new Set([...m.systemTicked, "flatpak:com.discordapp.Discord"]);
		m.systemPlan = plan;
		await m.confirmSystem();
		expect(m.systemPicked).toEqual(["flatpak:com.discordapp.Discord"]);
	});

	test("the apps start even when the System install ends before its answer arrives", async () => {
		const fx = createFixture({ speed: 40, system: "install" });
		const answer = fx.request.bind(fx);
		// The answer to systemInstall lands well after the fake install (under 40 ms at this speed) has ended.
		fx.request = async (name, params) => {
			const res = await answer(name, params);
			if (name === "systemInstall") await new Promise((r) => setTimeout(r, 300));
			return res;
		};
		const m = new Model(fx);
		await m.start();
		await until(() => (m.extras?.system.installable?.length ?? 0) > 0);
		m.tickSystem("apt:perl", true);
		await m.installTicked();
		await m.confirmSystem();
		expect(m.extras?.system.phase).toBe("idle");
		await until(() => m.run.phase === "installing" || m.run.phase === "summary");
	});

	test("every Install press clears an earlier System refusal", async () => {
		const m = await withSystem("install");
		m.systemReason = "earlier";
		await m.installTicked();
		expect(m.systemReason).toBeNull();
	});
});
