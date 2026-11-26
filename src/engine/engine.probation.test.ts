import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEngine } from "./engine";
import type { FetchLike } from "./github";
import { loadState, updateState } from "./store";
import { ok, recordingRun, script, tempHome } from "./testkit";

// A self-updating tool with a restore argv, a user service and a health address: everything probation reads.
const MANIFEST = `
[apps.tool]
name = "Tool"
kind = "command"
check = ["~/.local/bin/tool", "--version"]
latest = "npm:tool"
update = ["~/.local/bin/tool-up"]
restore = ["~/.local/bin/tool-set", "{version}"]
dest = "~/.local/bin/tool"
restart = ["systemctl", "--user", "restart", "tool.service"]
health = "http://127.0.0.1:9/health"
`;

const HOUR = 3_600_000;

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("engine-probation");
	mkdirSync(join(t.dir, "proc"));
});
afterEach(() => t.cleanup());

/**
 * The engine over a temp home with Tool at 1.0.0 and 1.1.0 on offer. The journal, the unit and the health address
 * answer from the returned machine, which a test changes; reads names every probation read made, in order.
 */
async function setup() {
	writeFileSync(join(t.dir, "seed.toml"), MANIFEST);
	const bin = join(t.paths.home, ".local/bin");
	const version = join(t.dir, "tool-version");
	writeFileSync(version, "1.0.0");
	script(join(bin, "tool"), `read -r v < "${version}"; echo "tool $v"`);
	script(join(bin, "tool-set"), `echo "$1" > "${version}"`);
	const m = {
		latest: "1.1.0",
		clock: Date.parse("2026-11-20T12:00:00Z"),
		crashes: [] as number[],
		active: "active",
		restarts: 2,
		healthy: true,
		reads: [] as string[],
	};
	// The update writes the version the last check was offered.
	const offered = join(t.dir, "tool-offered");
	script(join(bin, "tool-up"), `cp "${offered}" "${version}"`);
	const dest = join(bin, "tool");
	const fetch: FetchLike = async (url) => {
		if (url.includes("registry.npmjs.org")) {
			writeFileSync(offered, m.latest);
			return Response.json({ version: m.latest });
		}
		if (url === "http://127.0.0.1:9/health") {
			m.reads.push("health");
			return new Response("", { status: m.healthy ? 200 : 503 });
		}
		return new Response("missing", { status: 404 });
	};
	const { run } = recordingRun(t.paths, (argv) => {
		if (argv[0] === "journalctl") {
			m.reads.push("journal");
			return ok(
				m.crashes
					.map((at) => JSON.stringify({ COREDUMP_EXE: dest, __REALTIME_TIMESTAMP: String(at * 1000) }))
					.join("\n"),
			);
		}
		if (argv[0] === "systemctl") {
			m.reads.push(argv.join(" "));
			return ok(`ActiveState=${m.active}\nNRestarts=${m.restarts}\n`);
		}
		if (argv[0] === "gh") return { code: 1, stdout: "", stderr: "", timedOut: false };
		if (["flatpak", "snap", "apt-cache"].includes(argv[0] ?? ""))
			return { code: 127, stdout: "", stderr: "", timedOut: false };
		return undefined;
	});
	const engine = createEngine({
		paths: t.paths,
		seedManifest: join(t.dir, "seed.toml"),
		fetch,
		run,
		now: () => new Date(m.clock),
		procRoot: join(t.dir, "proc"),
		retryMs: 1,
		version: "9.9.9",
		freeBytes: () => 1e12,
	});
	const logs: string[] = [];
	engine.subscribe((e) => {
		if (e.type === "log") logs.push(e.line.text);
	});
	await engine.check();
	return { engine, m, logs, run, fetch };
}

/** Installs Tool's offered version and waits for the run to end. */
async function update(engine: Awaited<ReturnType<typeof setup>>["engine"]) {
	expect(await engine.install(["tool"])).toEqual({ started: true });
	await engine.idle();
	engine.dismissSummary();
}

const row = (engine: Awaited<ReturnType<typeof setup>>["engine"]) =>
	engine.snapshot().apps.find((a) => a.key === "tool");

test("nothing is read while no app is on probation", async () => {
	const { engine, m } = await setup();
	expect(m.reads).toEqual([]);
	await engine.check();
	expect(m.reads).toEqual([]);
});

test("an update starts a probation with the unit's restart count, and a crash after it puts up a sign", async () => {
	const { engine, m, logs, run, fetch } = await setup();
	await update(engine);
	const rec = loadState(t.paths).probation.tool;
	expect(rec).toMatchObject({ from: "1.0.0", to: "1.1.0", restarts: { "user:tool.service": 2 }, misses: 0 });
	expect(rec?.at).toBe(new Date(m.clock).toISOString());
	m.reads = [];
	m.clock += HOUR;
	await engine.check();
	// One journal read, the unit, the health address; no sign yet.
	expect(m.reads).toEqual(["journal", "systemctl --user show -p ActiveState -p NRestarts tool.service", "health"]);
	expect(row(engine)?.watch).toBeUndefined();
	m.crashes = [m.clock - 1000];
	m.clock += HOUR;
	await engine.check();
	expect(row(engine)?.watch).toEqual({ sign: "crash", from: "1.0.0", to: "1.1.0", at: rec?.at ?? "", crashes: 1 });
	expect(logs).toContain("Watching Tool: crash sign since 1.1.0");
	// The sign is kept in state, so a new engine (the next start) shows it from its first check.
	const again = createEngine({
		paths: t.paths,
		seedManifest: join(t.dir, "seed.toml"),
		fetch,
		run,
		procRoot: join(t.dir, "proc"),
		now: () => new Date(m.clock),
		version: "9.9.9",
	});
	await again.check();
	expect(row(again)?.watch?.sign).toBe("crash");
});

test("a service that fails or keeps restarting puts up a sign", async () => {
	const { engine, m } = await setup();
	await update(engine);
	m.restarts = 4;
	m.clock += HOUR;
	await engine.check();
	expect(row(engine)?.watch).toBeUndefined();
	m.restarts = 5;
	await engine.check();
	expect(row(engine)?.watch?.sign).toBe("service");
});

test("the health address needs two misses in a row", async () => {
	const { engine, m } = await setup();
	await update(engine);
	m.healthy = false;
	await engine.check();
	expect(row(engine)?.watch).toBeUndefined();
	await engine.check();
	expect(row(engine)?.watch?.sign).toBe("health");
});

test("It's fine ends the probation and takes the sign down", async () => {
	const { engine, m } = await setup();
	await update(engine);
	m.active = "failed";
	await engine.check();
	expect(row(engine)?.watch?.sign).toBe("service");
	expect(engine.endWatch("nope")).toBe(false);
	expect(engine.endWatch("tool")).toBe(true);
	expect(row(engine)?.watch).toBeUndefined();
	expect(loadState(t.paths).probation).toEqual({});
	m.reads = [];
	await engine.check();
	expect(m.reads).toEqual([]);
});

test("going back to the version before ends the probation", async () => {
	const { engine, m } = await setup();
	await update(engine);
	m.active = "failed";
	await engine.check();
	expect(row(engine)?.restorePoints.map((p) => p.version)).toContain("1.0.0");
	expect(await engine.restore("tool", "1.0.0")).toEqual({ ok: true });
	expect(readFileSync(join(t.dir, "tool-version"), "utf8").trim()).toBe("1.0.0");
	expect(loadState(t.paths).probation.tool).toBeUndefined();
	expect(row(engine)?.watch).toBeUndefined();
});

test("a new update replaces the probation, sign and all", async () => {
	const { engine, m } = await setup();
	await update(engine);
	m.active = "failed";
	await engine.check();
	expect(row(engine)?.watch?.sign).toBe("service");
	m.active = "active";
	m.restarts = 9;
	m.latest = "1.2.0";
	m.clock += HOUR;
	await engine.check();
	await update(engine);
	expect(row(engine)?.watch).toBeUndefined();
	expect(loadState(t.paths).probation.tool).toMatchObject({
		from: "1.1.0",
		to: "1.2.0",
		at: new Date(m.clock).toISOString(),
		restarts: { "user:tool.service": 9 },
	});
});

test("a probation with no sign ends after 3 days; one with a sign stays but is not read again", async () => {
	const { engine, m } = await setup();
	await update(engine);
	m.clock += 73 * HOUR;
	m.reads = [];
	await engine.check();
	expect(m.reads).toEqual([]);
	expect(loadState(t.paths).probation).toEqual({});
	updateState(t.paths, (s) => {
		s.probation.tool = {
			at: new Date(m.clock - 80 * HOUR).toISOString(),
			from: "1.0.0",
			to: "1.1.0",
			restarts: {},
			misses: 0,
			sign: "health",
		};
	});
	await engine.check();
	expect(m.reads).toEqual([]);
	expect(row(engine)?.watch?.sign).toBe("health");
});

test("with Watch updated apps off, an update keeps no probation and a check reads nothing", async () => {
	const { engine, m } = await setup();
	engine.setSettings({ watchUpdates: false });
	await update(engine);
	expect(loadState(t.paths).probation).toEqual({});
	expect(m.reads.filter((r) => r.startsWith("systemctl"))).toEqual([]);
	// A probation kept from before the switch went off is not read either, and its sign is not shown.
	updateState(t.paths, (s) => {
		s.probation.tool = {
			at: new Date(m.clock).toISOString(),
			from: "1.0.0",
			to: "1.1.0",
			restarts: {},
			misses: 0,
			sign: "crash",
		};
	});
	m.reads = [];
	await engine.check();
	expect(m.reads).toEqual([]);
	expect(row(engine)?.watch).toBeUndefined();
});

test("removing an app drops its probation", async () => {
	const { engine } = await setup();
	await update(engine);
	expect(loadState(t.paths).probation.tool).toBeDefined();
	expect((await engine.removeApp("tool")).ok).toBe(true);
	expect(loadState(t.paths).probation).toEqual({});
});
