import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppState, EngineEvent } from "../shared/types";
import { createEngine } from "./engine";
import type { FetchLike } from "./github";
import type { Run } from "./run";
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

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("engine-power");
	mkdirSync(join(t.dir, "proc"));
});
afterEach(() => t.cleanup());

/** A fake power runner: answers the lock probe and the bus questions, and records each lock started and stopped. */
function fakePower(o: { inhibit?: boolean; metered?: boolean }) {
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
				const lock = { argv, stopped: 0 };
				locks.push(lock);
				return {
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

/** The engine over a temp home with both apps ready. offline makes every GitHub answer a network error. */
async function setup(power?: Run, net = { offline: false }) {
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
		if (net.offline) throw new TypeError("Unable to connect. Is the computer able to access the url?");
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
	await engine.check();
	return { engine, fetched, logs, fd };
}

test("a run holds sleep and shutdown for as long as it lasts, then lets go once", async () => {
	const power = fakePower({ inhibit: true });
	const { engine, logs } = await setup(power.run);
	expect(await engine.install(["slow", "fd"])).toEqual({ started: true });
	expect(power.locks).toHaveLength(1);
	expect(power.locks[0]?.argv.slice(0, 4)).toEqual([
		"systemd-inhibit",
		"--what=sleep:shutdown",
		"--mode=block",
		"--who=Upkeep",
	]);
	// The lock ends with this process: a crash never leaves it held.
	expect(power.locks[0]?.argv).toContain(`--pid=${process.pid}`);
	await engine.idle();
	expect(engine.snapshot().run.results.map((r) => r.result)).toEqual(["updated", "updated"]);
	expect(power.locks[0]?.stopped).toBe(1);
	expect(logs).toContain("Sleep and shutdown held until the run ends");
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

test("with the wait switched on, a metered connection keeps downloads back until each app's own turn", async () => {
	const power = fakePower({ inhibit: true, metered: true });
	const { engine, fetched, logs, fd } = await setup(power.run);
	engine.setSettings({ waitUnmetered: true });
	expect(await engine.install(["slow", "fd"])).toEqual({ started: true });
	await engine.idle();
	// A pressed Install still runs; fd's file came down only once slow was done.
	expect(engine.snapshot().run.results.map((r) => r.result)).toEqual(["updated", "updated"]);
	expect(fetched).toEqual([false]);
	expect(fd.some((a) => a.downloaded)).toBe(false);
	expect(logs).toContain("Downloads ahead wait: metered connection");
});

test("with the wait switched off, a metered connection is not even asked about", async () => {
	const power = fakePower({ inhibit: true, metered: true });
	const { engine, fetched } = await setup(power.run);
	await engine.install(["slow", "fd"]);
	await engine.idle();
	expect(fetched).toEqual([true]);
	expect(power.asked.some((a) => a.includes("Metered"))).toBe(false);
});

test("a quiet check with no network keeps the rows and the check time, and a loud one shows the failure", async () => {
	const net = { offline: false };
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
