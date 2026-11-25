import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppState, EngineEvent } from "../shared/types";
import { createEngine } from "./engine";
import type { FetchLike } from "./github";
import type { Arch } from "./arch";
import type { Run } from "./run";
import { loadRows } from "./store";
import { ok, realRun, recordingRun, script, tempHome } from "./testkit";

// A command app that takes 0.3 s to update runs first; the archive app fd waits behind it.
const MANIFEST = `
[apps.slow]
name = "Slow"
kind = "command"
check = ["~/.local/bin/slow", "--version"]
latest = "npm:slow-pkg"
update = ["~/.local/bin/slow-up"]

[apps.fd]
name = "fd"
kind = "archive"
repo = "sharkdp/fd"
asset = 'x86_64-unknown-linux-gnu\\.tar\\.gz$'
dest = "~/.local/bin/fd"
bins = ["fd"]
`;
const ASSET = "fd-v10.5.2-x86_64-unknown-linux-gnu.tar.gz";

/** Waits until cond holds, every 5 ms for up to 2 s. */
const until = async (cond: () => boolean, left = 400): Promise<void> => {
	if (cond() || left === 0) return;
	await Bun.sleep(5);
	return until(cond, left - 1);
};

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("engine-power");
	mkdirSync(join(t.dir, "proc"));
});
afterEach(() => t.cleanup());

/** A fake power runner: answers the lock probe and the bus questions, and records each lock started and stopped. */
function fakePower(o: { inhibit?: boolean; metered?: boolean; startThrows?: boolean; spawnFails?: boolean }) {
	const asked: string[] = [];
	const locks: { argv: string[]; stopped: number }[] = [];
	const run: Run = Object.assign(
		async (argv: string[]) => {
			asked.push(argv.join(" "));
			if (argv[0] === "systemd-inhibit") return o.inhibit ? ok("systemd 255") : { ...ok(), code: 127 };
			if (argv.includes("Metered")) return ok(o.metered ? "u 1\n" : "u 4\n");
			return ok("b false\n");
		},
		{
			start: (argv: string[]) => {
				if (o.startThrows) throw new Error("EACCES: permission denied, open 'start-1.out'");
				const lock = { argv, stopped: 0 };
				locks.push(lock);
				return {
					failed: o.spawnFails === true,
					output: () => "",
					stop: async () => {
						lock.stopped += 1;
					},
				};
			},
		},
	);
	return { run, asked, locks };
}

/**
 * The engine over a temp home with both apps ready, unless the first check (quiet when asked) finds no network: offline
 * makes every fetch a network error, githubDown only GitHub's.
 */
async function setup(power?: Run, net = { offline: false, githubDown: false }, quiet = false, arch: Arch = "x86_64") {
	writeFileSync(join(t.dir, "seed.toml"), MANIFEST);
	const bin = join(t.paths.home, ".local/bin");
	const version = join(t.dir, "slow-version");
	writeFileSync(version, "1.0.0");
	script(join(bin, "slow"), `read -r v < "${version}"; echo "slow $v"`);
	script(join(bin, "slow-up"), `sleep 0.3; echo 1.1.0 > "${version}"`);
	script(join(bin, "fd"), 'echo "fd 10.5.1"');
	script(join(t.dir, "tar-fd", "fd"), 'echo "fd 10.5.2"');
	const tarball = join(t.dir, "fd.tar.gz");
	await realRun(t.paths)(["tar", "czf", tarball, "-C", join(t.dir, "tar-fd"), "."]);
	const tar = new Uint8Array(readFileSync(tarball));
	const fetched: boolean[] = [];
	let slowWorking = false;
	const fetch: FetchLike = async (url) => {
		if (net.offline || (net.githubDown && url.includes("github")))
			throw new TypeError("Unable to connect. Is the computer able to access the url?");
		if (url.includes("registry.npmjs.org")) return Response.json({ version: "1.1.0" });
		if (url.endsWith("/releases/latest"))
			return Response.json({
				tag_name: "v10.5.2",
				html_url: "https://github.com/sharkdp/fd/releases/tag/v10.5.2",
				published_at: "2026-11-09T00:00:00Z",
				body: "",
				assets: [{ name: ASSET, browser_download_url: `https://dl.test/${ASSET}`, size: tar.length, digest: null }],
			});
		if (url !== `https://dl.test/${ASSET}`) return new Response("missing", { status: 404 });
		fetched.push(slowWorking);
		return new Response(tar);
	};
	const { run } = recordingRun(t.paths, (argv) =>
		argv[0] === "gh"
			? { code: 1, stdout: "", stderr: "", timedOut: false }
			: ["flatpak", "snap", "apt-cache"].includes(argv[0] ?? "")
				? { code: 127, stdout: "", stderr: "", timedOut: false }
				: undefined,
	);
	const engine = createEngine({
		paths: t.paths,
		seedManifest: join(t.dir, "seed.toml"),
		fetch,
		run,
		power,
		arch,
		now: () => new Date(),
		procRoot: join(t.dir, "proc"),
		retryMs: 1,
		pollMs: 10,
		version: "9.9.9",
		freeBytes: () => 1e12,
	});
	const logs: string[] = [];
	const fd: AppState[] = [];
	engine.subscribe((e: EngineEvent) => {
		if (e.type === "log") logs.push(e.line.text);
		if (e.type !== "app") return;
		if (e.app.key === "slow") slowWorking = e.app.status === "working";
		if (e.app.key === "fd") fd.push(e.app);
	});
	await engine.check(undefined, { quietOffline: quiet });
	return { engine, fetched, logs, fd };
}

test("a run holds sleep for as long as it lasts, lets go once, and asks about systemd-inhibit only once", async () => {
	const power = fakePower({ inhibit: true });
	const { engine, logs } = await setup(power.run);
	expect(await engine.install(["slow"])).toEqual({ started: true });
	await engine.idle();
	expect(power.locks).toHaveLength(1);
	expect(power.locks[0]?.argv.slice(0, 4)).toEqual(["systemd-inhibit", "--what=sleep", "--mode=block", "--who=Upkeep"]);
	// The lock ends with this process: a crash never leaves it held.
	expect(power.locks[0]?.argv).toContain(`--pid=${process.pid}`);
	expect(power.locks[0]?.stopped).toBe(1);
	expect(logs).toContain("Asked logind to hold sleep until the run ends");
	engine.dismissSummary();
	await engine.install(["fd"]);
	await engine.idle();
	expect(power.locks.map((l) => l.stopped)).toEqual([1, 1]);
	expect(power.asked.filter((a) => a.startsWith("systemd-inhibit"))).toHaveLength(1);
});

test("a run stopped after the current app lets the lock go too", async () => {
	const power = fakePower({ inhibit: true });
	const { engine } = await setup(power.run);
	await engine.install(["slow", "fd"]);
	await until(() => engine.snapshot().run.currentKey === "slow");
	engine.stopAfterCurrent();
	await engine.idle();
	expect(engine.snapshot().run.results.map((r) => r.result)).toEqual(["updated"]);
	expect(power.locks.map((l) => l.stopped)).toEqual([1]);
});

test("Stop now and ending the step let the lock go, and never end the lock itself early", async () => {
	const power = fakePower({ inhibit: true });
	const { engine } = await setup(power.run);
	await engine.install(["slow", "fd"]);
	await until(() => engine.snapshot().run.currentKey === "slow");
	engine.stopNow();
	// The lock is not the step: ending the step leaves it held until the run is over.
	await engine.endStep();
	expect(power.locks.map((l) => l.stopped)).toEqual([0]);
	await engine.idle();
	expect(engine.snapshot().run.phase).toBe("summary");
	expect(power.locks.map((l) => l.stopped)).toEqual([1]);
});

test("a lock that cannot start is skipped with a line, and the run goes on", async () => {
	const power = fakePower({ inhibit: true, startThrows: true });
	const { engine, logs } = await setup(power.run);
	await engine.install(["slow"]);
	await engine.idle();
	expect(engine.snapshot().run.results.map((r) => r.result)).toEqual(["updated"]);
	expect(logs).toContain(
		"The sleep lock could not start (EACCES: permission denied, open 'start-1.out'): sleep is not held during this run",
	);
	expect(logs).not.toContain("Asked logind to hold sleep until the run ends");
});

test("a lock whose process never started is not called held", async () => {
	const power = fakePower({ inhibit: true, spawnFails: true });
	const { engine, logs } = await setup(power.run);
	await engine.install(["slow"]);
	await engine.idle();
	expect(engine.snapshot().run.results.map((r) => r.result)).toEqual(["updated"]);
	expect(logs).toContain(
		"The sleep lock could not start (its process did not start): sleep is not held during this run",
	);
	expect(logs).not.toContain("Asked logind to hold sleep until the run ends");
});

test("without systemd-inhibit every run goes on as before, and says so once", async () => {
	const power = fakePower({ inhibit: false });
	const { engine, logs } = await setup(power.run);
	await engine.install(["slow"]);
	await engine.idle();
	engine.dismissSummary();
	await engine.install(["fd"]);
	await engine.idle();
	expect(engine.snapshot().run.results.map((r) => r.result)).toEqual(["updated"]);
	expect(power.locks).toHaveLength(0);
	expect(logs.filter((l) => l.startsWith("No systemd-inhibit here"))).toHaveLength(1);
});

test("automatic installs wait on a metered connection only with the switch on, and a pressed Install never waits", async () => {
	const power = fakePower({ inhibit: true, metered: true });
	const { engine, fetched, logs } = await setup(power.run);
	expect(await engine.installAuto()).toEqual({ started: false, reason: "Nothing to install." });
	engine.setAuto("slow", true);
	engine.setAuto("fd", true);
	engine.setSettings({ waitUnmetered: true });
	expect(await engine.installAuto()).toEqual({ started: false, wait: "metered" });
	expect(logs).toContain("Automatic updates wait: metered connection");
	expect(engine.snapshot().run.phase).toBe("idle");
	// A pressed Install runs, early downloads included.
	expect(await engine.install(["slow", "fd"])).toEqual({ started: true });
	await engine.idle();
	expect(fetched).toEqual([true]);
	engine.dismissSummary();
	await engine.check();
	expect(engine.readyKeys(true)).toEqual([]);
});

test("with the switch off, automatic installs start and the connection is not even asked about", async () => {
	const power = fakePower({ inhibit: true, metered: true });
	const { engine } = await setup(power.run);
	engine.setAuto("slow", true);
	expect(await engine.installAuto()).toEqual({ started: true });
	await engine.idle();
	expect(engine.snapshot().run.results.map((r) => r.result)).toEqual(["updated"]);
	expect(power.asked.some((a) => a.includes("Metered"))).toBe(false);
});

test("a quiet check with no network keeps the rows and the check time, and a loud one shows the failure", async () => {
	const net = { offline: false, githubDown: false };
	const { engine } = await setup(undefined, net);
	const at = engine.snapshot().checkedAt;
	expect(engine.offline()).toBe(false);
	net.offline = true;
	await engine.check(undefined, { quietOffline: true });
	expect(engine.offline()).toBe(true);
	const fd = () => engine.snapshot().apps.find((a) => a.key === "fd");
	expect(fd()?.status).toBe("ready");
	// A command app whose version source could not be reached keeps its row too.
	expect(engine.snapshot().apps.find((a) => a.key === "slow")?.status).toBe("ready");
	expect(engine.snapshot().checkedAt).toBe(at);
	await engine.check();
	expect(engine.offline()).toBe(true);
	expect(fd()?.status).toBe("problem");
	net.offline = false;
	await engine.check(undefined, { quietOffline: true });
	expect(engine.offline()).toBe(false);
	expect(fd()?.status).toBe("ready");
});

test("a command app that got its answer means the network is up, even with GitHub down", async () => {
	const net = { offline: false, githubDown: true };
	const { engine } = await setup(undefined, net);
	expect(engine.offline()).toBe(false);
	expect(engine.snapshot().apps.find((a) => a.key === "fd")?.status).toBe("problem");
	expect(engine.snapshot().apps.find((a) => a.key === "slow")?.status).toBe("ready");
});

test("a quiet offline check stamps a row that answered with now, and leaves a kept row's stamp", async () => {
	// On aarch64 fd's table has no pattern, so its row is a problem found before any lookup: it answers offline too.
	const net = { offline: false, githubDown: false };
	const { engine } = await setup(undefined, net, false, "aarch64");
	const first = loadRows(t.paths);
	await Bun.sleep(5);
	net.offline = true;
	await engine.check(undefined, { quietOffline: true });
	expect(engine.offline()).toBe(true);
	const rows = loadRows(t.paths);
	expect(rows.slow?.checkedAt).toBe(first.slow?.checkedAt);
	expect((rows.fd?.checkedAt ?? "") > (first.fd?.checkedAt ?? "")).toBe(true);
});

test("a first quiet check with no network shows no row at all rather than a failure", async () => {
	const { engine } = await setup(undefined, { offline: true, githubDown: false }, true);
	expect(engine.offline()).toBe(true);
	expect(engine.snapshot().apps).toEqual([]);
});
