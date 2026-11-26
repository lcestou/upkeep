import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkLine, main, pickSure, stopOnSignal, USAGE } from "./cli";
import { createEngine, type EngineDeps } from "./engine/engine";
import {
	appendHistory,
	claimLock,
	loadState,
	readInflight,
	releaseLock,
	updateState,
	writeInflight,
} from "./engine/store";
import type { FetchLike } from "./engine/github";
import { realRun, recordingRun, script, tempHome } from "./engine/testkit";
import type { AppState, Suggestion } from "./shared/types";

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("cli");
});
afterEach(() => t.cleanup());

const MANIFEST = `
[apps.borg]
name = "BorgBackup"
kind = "file"
repo = "borgbackup/borg"
asset = 'borg-linux$'
dest = "~/.local/bin/borg"

[apps.bat]
name = "bat"
kind = "file"
repo = "sharkdp/bat"
asset = 'bat-linux$'
dest = "~/.local/bin/bat"
`;

const NEW_BORG = new TextEncoder().encode('#!/bin/bash\necho "borg 1.4.2"\n');

const fakeFetch: FetchLike = async (url) => {
	if (url.endsWith("borgbackup/borg/releases/latest"))
		return Response.json({
			tag_name: "1.4.2",
			assets: [
				{ name: "borg-linux", browser_download_url: "https://dl.test/borg", size: NEW_BORG.length, digest: null },
			],
		});
	if (url.endsWith("sharkdp/bat/releases/latest"))
		return Response.json({ tag_name: "v0.26.1", assets: [{ name: "bat-linux" }] });
	if (url === "https://dl.test/borg") return new Response(NEW_BORG);
	return new Response("", { status: 404 });
};

function deps(): EngineDeps {
	const seed = join(t.dir, "seed.toml");
	writeFileSync(seed, MANIFEST);
	script(join(t.paths.home, ".local/bin/borg"), 'echo "borg 1.4.1"');
	script(join(t.paths.home, ".local/bin/bat"), 'echo "bat 0.26.1"');
	// gh, and the system's own lists (Flatpak, Snap, apt), read as not there: no test reads the machine it runs on.
	const { run } = recordingRun(t.paths, (argv) =>
		["gh", "flatpak", "snap", "apt-cache"].includes(argv[0] ?? "")
			? { code: argv[0] === "gh" ? 1 : 127, stdout: "", stderr: "", timedOut: false }
			: undefined,
	);
	mkdirSync(join(t.dir, "proc"), { recursive: true });
	return {
		paths: t.paths,
		seedManifest: seed,
		fetch: fakeFetch,
		run,
		now: () => new Date(),
		procRoot: join(t.dir, "proc"),
	};
}

test("check prints one line per app in the OK, UPDATE, BROKEN and SKIP shapes", async () => {
	const out: string[] = [];
	expect(await main(["check"], deps(), (l) => out.push(l))).toBe(0);
	expect(out.toSorted()).toEqual(["  OK:     bat 0.26.1", "  UPDATE: BorgBackup 1.4.1 -> 1.4.2"]);
});

test("check --json prints one AppState per line", async () => {
	const out: string[] = [];
	await main(["check", "--json"], deps(), (l) => out.push(l));
	const rows = out.map((l) => JSON.parse(l) as AppState);
	expect(rows.map((r) => r.key).toSorted()).toEqual(["bat", "borg"]);
});

test("a release inside the wait: check says HELD, --all passes it by, and naming the app installs it", async () => {
	const d = deps();
	const fresh = new Date(Date.now() - 3_600_000).toISOString();
	d.fetch = async (url, init) => {
		const res = await fakeFetch(url, init);
		if (!url.endsWith("borgbackup/borg/releases/latest")) return res;
		return Response.json({ ...(await res.json()), published_at: fresh });
	};
	updateState(t.paths, (s) => {
		s.settings.waitDays = 3;
	});
	const out: string[] = [];
	expect(await main(["check"], d, (l) => out.push(l))).toBe(0);
	expect(out).toContain(
		`  HELD:   BorgBackup 1.4.1 -> 1.4.2 (offered from ${new Date(Date.parse(fresh) + 3 * 86_400_000).toLocaleDateString("sv-SE")})`,
	);
	const all: string[] = [];
	expect(await main(["install", "--all"], d, (l) => all.push(l))).toBe(1);
	expect(all).toContain("Nothing to install.");
	const named: string[] = [];
	expect(await main(["install", "borg"], d, (l) => named.push(l))).toBe(0);
	expect(named).toContain("[borg] done 1.4.2");
});

test("install updates, exits 0, then restore and history work", async () => {
	const d = deps();
	const out: string[] = [];
	expect(await main(["install", "borg"], d, (l) => out.push(l))).toBe(0);
	expect(out).toContain("[borg] done 1.4.2");
	expect((await realRun(t.paths)([join(t.paths.home, ".local/bin/borg")])).stdout).toBe("borg 1.4.2\n");
	const r: string[] = [];
	expect(await main(["restore", "borg"], d, (l) => r.push(l))).toBe(0);
	expect(r).toEqual(["Restored 1.4.1."]);
	const h: string[] = [];
	expect(await main(["history"], d, (l) => h.push(l))).toBe(0);
	expect(h[0]).toMatch(/ BorgBackup 1\.4\.2 to 1\.4\.1 Restored$/);
	// The update says how its download was checked.
	expect(h[1]).toMatch(/ BorgBackup 1\.4\.1 to 1\.4\.2 Updated \(size checked only\)$/);
	// A Cleanup row has no versions: it says what it freed.
	appendHistory(t.paths, [
		{
			runId: "c",
			at: "2026-11-14T00:00:00.000Z",
			key: "cleanup:trash",
			name: "trash",
			from: null,
			to: null,
			result: "cleaned",
			ms: 0,
			stages: {},
			freed: 2048,
		},
	]);
	const c: string[] = [];
	expect(await main(["history"], d, (l) => c.push(l))).toBe(0);
	expect(c[0]).toBe("2026-11-14T00:00:00.000Z trash freed 2048 bytes Cleaned");
	appendHistory(t.paths, [
		{
			runId: "d",
			at: "2026-11-15T00:00:00.000Z",
			key: "cleanup:autoremove",
			name: "autoremove",
			from: null,
			to: null,
			result: "cleaned",
			ms: 0,
			stages: {},
			freed: 0,
		},
	]);
	const e: string[] = [];
	expect(await main(["history"], d, (l) => e.push(l))).toBe(0);
	expect(e[0]).toBe("2026-11-15T00:00:00.000Z autoremove Cleaned");
});

test("install exits 1 when nothing could be installed, and a bad command line is a usage error", async () => {
	const out: string[] = [];
	expect(await main(["install", "bat"], deps(), (l) => out.push(l))).toBe(1);
	expect(out.at(-1)).toBe("Nothing to install.");
	const json: string[] = [];
	expect(await main(["install", "bat", "--json"], deps(), (l) => json.push(l))).toBe(1);
	expect(JSON.parse(json.at(-1) ?? "{}")).toEqual({ started: false, reason: "Nothing to install." });
	const d = deps();
	const usage = await Promise.all(
		[[], ["frobnicate"], ["install"], ["restore"], ["check", "extra"]].map(async (argv) => {
			const u: string[] = [];
			return { code: await main(argv, d, (l) => u.push(l)), u };
		}),
	);
	for (const { code, u } of usage) {
		expect(code).toBe(2);
		expect(u).toEqual([USAGE]);
	}
	expect(await main(["restore", "bat"], deps(), () => {})).toBe(1);
});

test("checkLine maps problems to SKIP and BROKEN", () => {
	const base = { key: "x", name: "tmux", installed: null, latest: null } as AppState;
	expect(checkLine({ ...base, status: "problem", detail: "tmux will not start (/usr/local/bin/tmux)." })).toBe(
		"  BROKEN: tmux will not start (/usr/local/bin/tmux).",
	);
	expect(checkLine({ ...base, status: "problem", detail: "GitHub answered 404 for a/b." })).toBe(
		"  SKIP:   tmux GitHub answered 404 for a/b.",
	);
	expect(checkLine({ ...base, status: "fresh", versionless: true })).toBe("  OK:     tmux");
	expect(
		checkLine({ ...base, status: "ready", versionless: true, detail: "New versions in their marketplaces: a." }),
	).toBe("  UPDATE: tmux New versions in their marketplaces: a.");
	expect(checkLine({ ...base, status: "ready", versionless: true })).toBe("  UPDATE: tmux");
	// A held or skipped update is not one install --all would run.
	expect(checkLine({ ...base, status: "held", installed: "9.0.0", latest: "10.5.2", skipped: "10.5.2" })).toBe(
		"  HELD:   tmux 9.0.0 -> 10.5.2 (skipping 10.5.2)",
	);
	expect(
		checkLine({ ...base, status: "held", installed: "9.0.0", latest: "10.5.2", settles: "2026-11-27T08:00:00.000Z" }),
	).toBe("  HELD:   tmux 9.0.0 -> 10.5.2 (offered from 2026-11-27)");
	expect(
		checkLine({ ...base, status: "held", installed: "9.0.0", latest: "10.5.2", paused: "2026-12-09T08:00:00.000Z" }),
	).toBe("  HELD:   tmux 9.0.0 -> 10.5.2 (paused until 2026-12-09)");
	// A hold Upkeep put on a changed release says why.
	expect(checkLine({ ...base, status: "held", installed: "9.0.0", latest: "10.5.2", detail: "Why." })).toBe(
		"  HELD:   tmux 9.0.0 -> 10.5.2 Why.",
	);
});

test("hold on and off set and release an app's hold; an unknown key or a missing on/off is refused", async () => {
	const d = deps();
	const out: string[] = [];
	expect(await main(["hold", "bat", "on"], d, (l) => out.push(l))).toBe(0);
	expect(JSON.parse(readFileSync(join(t.paths.state, "state.json"), "utf8")).hold).toEqual({ bat: true });
	expect(await main(["hold", "bat", "off"], d, (l) => out.push(l))).toBe(0);
	expect(JSON.parse(readFileSync(join(t.paths.state, "state.json"), "utf8")).hold).toEqual({});
	expect(out).toEqual(["Holding bat.", "Released the hold on bat."]);
	const json: string[] = [];
	expect(await main(["hold", "nope", "off", "--json"], d, (l) => json.push(l))).toBe(1);
	expect(JSON.parse(json[0] ?? "{}")).toEqual({ key: "nope", held: false, ok: false });
	expect(await main(["hold", "nope", "off"], d, (l) => json.push(l))).toBe(1);
	expect(json[1]).toBe("No app nope in the list.");
	expect(await main(["hold", "bat"], d, () => undefined)).toBe(2);
});

test("pause sets an app's pause for days and off ends it; an unknown key or a bad count is refused", async () => {
	const d = deps();
	const out: string[] = [];
	expect(await main(["pause", "bat", "14"], d, (l) => out.push(l))).toBe(0);
	const until = loadState(t.paths).pause.bat ?? "";
	expect(Date.parse(until) - Date.now()).toBeGreaterThan(13.9 * 86_400_000);
	expect(out).toEqual([`Paused bat until ${new Date(until).toLocaleDateString("sv-SE")}.`]);
	expect(await main(["pause", "bat", "off"], d, (l) => out.push(l))).toBe(0);
	expect(out[1]).toBe("Resumed bat.");
	expect(loadState(t.paths).pause).toEqual({});
	const json: string[] = [];
	expect(await main(["pause", "bat", "7", "--json"], d, (l) => json.push(l))).toBe(0);
	expect(JSON.parse(json[0] ?? "{}")).toMatchObject({ key: "bat", ok: true });
	expect(await main(["pause", "nope", "7"], d, (l) => json.push(l))).toBe(1);
	expect(json[1]).toBe("No app nope in the list.");
	const counts = ["0", "366", "1.5", "soon", "0x7", "1e1", " 7 ", "+7", ""];
	const bad = await Promise.all(counts.map((n) => main(["pause", "bat", n], d, () => undefined)));
	expect(bad).toEqual(counts.map(() => 2));
	// A hold wins over a pause: pausing a held app is refused and says why.
	const held: string[] = [];
	expect(await main(["hold", "bat", "on"], d, (l) => held.push(l))).toBe(0);
	expect(await main(["pause", "bat", "7"], d, (l) => held.push(l))).toBe(1);
	expect(held[1]).toBe("bat is held. Release the hold first, then pause it.");
	expect(loadState(t.paths).pause).toEqual({});
	expect(await main(["pause", "bat"], d, () => undefined)).toBe(2);
});

test("install --auto with the wait on and a metered connection installs nothing, says why and exits 0", async () => {
	const d = deps();
	const power: EngineDeps["run"] = async (argv) => ({
		code: 0,
		stdout: argv.includes("Metered") ? "u 1" : "b false",
		stderr: "",
		timedOut: false,
	});
	mkdirSync(t.paths.state, { recursive: true });
	writeFileSync(
		join(t.paths.state, "state.json"),
		JSON.stringify({ settings: { waitUnmetered: true }, auto: { borg: true } }),
	);
	const out: string[] = [];
	expect(await main(["install", "--auto"], { ...d, power }, (l) => out.push(l))).toBe(0);
	expect(out.at(-1)).toBe("Automatic updates wait: the connection is metered.");
	const json: string[] = [];
	expect(await main(["install", "--auto", "--json"], { ...d, power }, (l) => json.push(l))).toBe(0);
	expect(JSON.parse(json.at(-1) ?? "{}")).toMatchObject({ started: false, wait: "metered" });
});

test("recover with another Upkeep's run holding the lock says so and exits 1, leaving the marker", async () => {
	const d = deps();
	const marker = {
		key: "borg",
		dest: "/x",
		backupVersion: null,
		tree: { step: "pause" as const, build: null, active: [], paused: [] },
	};
	writeInflight(d.paths, marker);
	mkdirSync(d.paths.state, { recursive: true });
	// The lock's holder is alive: its pid has a stat entry with the same start time.
	const proc = join(d.procRoot ?? "", "4242");
	mkdirSync(proc, { recursive: true });
	writeFileSync(join(proc, "stat"), "4242 (bun) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 777 0 0");
	writeFileSync(join(d.paths.state, "run.lock"), "4242 777");
	const out: string[] = [];
	expect(await main(["recover"], d, (l) => out.push(l))).toBe(1);
	expect(out).toEqual(["Another Upkeep run is in progress. Try again when it ends."]);
	expect(readInflight(d.paths)).toEqual(marker);
});

test("recover prints one line per app and exits 1 when one could not be put back", async () => {
	const out: string[] = [];
	expect(await main(["recover"], deps(), (l) => out.push(l))).toBe(0);
	expect(out).toEqual(["Nothing to recover."]);
	const d = deps();
	writeInflight(d.paths, {
		key: "borg",
		dest: "/x",
		backupVersion: "1.4.1",
		tree: { step: "pause", build: null, active: [], paused: [] },
	});
	const ok: string[] = [];
	expect(await main(["recover"], d, (l) => ok.push(l))).toBe(0);
	expect(ok).toEqual(["BorgBackup: put back 1.4.1"]);
	writeInflight(d.paths, {
		key: "borg",
		dest: "/x",
		backupVersion: "9.9",
		tree: { step: "build", build: null, active: [], paused: [] },
	});
	const bad: string[] = [];
	expect(await main(["recover"], d, (l) => bad.push(l))).toBe(1);
	expect(bad).toEqual(["BorgBackup: could not be put back. See the log."]);
	expect(readInflight(d.paths)?.backupVersion).toBe("9.9");
});

test("list reads apps.toml without a check; --json gives each app's table", async () => {
	const d = deps();
	const out: string[] = [];
	expect(await main(["list"], d, (l) => out.push(l))).toBe(0);
	expect(out).toEqual(["borg  BorgBackup  file  borgbackup/borg", "bat  bat  file  sharkdp/bat"]);
	const json: string[] = [];
	expect(await main(["list", "--json"], d, (l) => json.push(l))).toBe(0);
	expect(json.map((l) => JSON.parse(l).key)).toEqual(["borg", "bat"]);
	writeFileSync(join(t.paths.config, "apps.toml"), "[apps.x]\nkind = 3\n");
	const bad: string[] = [];
	expect(await main(["list"], d, (l) => bad.push(l))).toBe(1);
	expect(bad[0]).toStartWith("apps.toml: ");
});

test("remove takes an app off the list and keeps the app; an unknown key is refused", async () => {
	const d = deps();
	const out: string[] = [];
	expect(await main(["remove", "bat"], d, (l) => out.push(l))).toBe(0);
	expect(out).toEqual(["Removed bat."]);
	expect(readFileSync(join(t.paths.home, ".local/bin/bat"), "utf8")).toContain("bat 0.26.1");
	const json: string[] = [];
	expect(await main(["remove", "nope", "--json"], d, (l) => json.push(l))).toBe(1);
	expect(JSON.parse(json[0] ?? "{}")).toMatchObject({ key: "nope", ok: false });
	const left: string[] = [];
	await main(["list"], d, (l) => left.push(l));
	expect(left).toEqual(["borg  BorgBackup  file  borgbackup/borg"]);
});

test("add adds only a single sure match; nothing found, or an app already listed, adds nothing", async () => {
	const d = deps();
	const none: string[] = [];
	expect(await main(["add", "no-such-app-anywhere"], d, (l) => none.push(l))).toBe(1);
	expect(none[0]).toBeTruthy();
	const dup: string[] = [];
	expect(await main(["add", "sharkdp/bat", "--json"], d, (l) => dup.push(l))).toBe(1);
	const answer = JSON.parse(dup[0] ?? "{}");
	expect(answer.added).toEqual([]);
	const listed: string[] = [];
	await main(["list"], d, (l) => listed.push(l));
	expect(listed).toHaveLength(2);
});

test("import of a file that takes the release wait off says so and needs --yes", async () => {
	const d = deps();
	await main(["list"], d, () => {});
	updateState(t.paths, (s) => {
		s.settings.waitDays = 7;
	});
	const file = join(t.dir, "upkeep.json");
	await main(["export", file], d, () => {});
	const doc = JSON.parse(readFileSync(file, "utf8"));
	writeFileSync(file, JSON.stringify({ ...doc, settings: { ...doc.settings, waitDays: 1 } }));
	const said: string[] = [];
	expect(await main(["import", file], d, (l) => said.push(l))).toBe(1);
	expect(said).toContain(`${file} shortens this setting on this computer:`);
	expect(said).toContain("  Wait before offering a new release: 7 days -> 1 day");
	expect(loadState(t.paths).settings.waitDays).toBe(7);
	writeFileSync(file, JSON.stringify({ ...doc, settings: { ...doc.settings, waitDays: 0 } }));
	const off: string[] = [];
	expect(await main(["import", file], d, (l) => off.push(l))).toBe(1);
	expect(off).toContain(`${file} shortens this setting on this computer:`);
	expect(off).toContain("  Wait before offering a new release: 7 days -> Off");
	expect(await main(["import", file, "--yes"], d, () => {})).toBe(0);
	expect(loadState(t.paths).settings.waitDays).toBe(0);
});

test("import drops what a check remembered of a release for an app it drops or changes", async () => {
	const d = deps();
	await main(["list"], d, () => {});
	const seen = (tag: string) => ({ tag, file: "f", hash: "sha256:ab" });
	const remember = () =>
		updateState(t.paths, (s) => {
			s.seen = { borg: seen("v1"), bat: seen("v2") };
			s.changed = { borg: "v1", bat: "v2" };
		});
	remember();
	const file = join(t.dir, "upkeep.json");
	expect(await main(["export", file], d, () => {})).toBe(0);
	const exported = JSON.parse(readFileSync(file, "utf8"));
	// bat dropped, borg the same table: only borg's memory stays.
	writeFileSync(file, JSON.stringify({ ...exported, apps: exported.apps.replace(/\[apps\.bat\][\s\S]*$/, "") }));
	expect(await main(["import", file], d, () => {})).toBe(0);
	const first = loadState(t.paths);
	expect([first.seen, first.changed]).toEqual([{ borg: seen("v1") }, { borg: "v1" }]);
	// borg's table changed, and bat comes back as an app this machine no longer lists: neither keeps its memory.
	remember();
	writeFileSync(file, JSON.stringify({ ...exported, apps: exported.apps.replace("borg-linux$", "borg-linux64$") }));
	expect(await main(["import", file], d, () => {})).toBe(0);
	const after = loadState(t.paths);
	expect([after.seen, after.changed]).toEqual([{}, {}]);
});

test("export and import carry the list, settings, skips, holds and auto picks, and keep the old files", async () => {
	const d = deps();
	await main(["list"], d, () => {});
	updateState(t.paths, (s) => {
		s.skip = { borg: "1.4.2" };
		s.hold = { bat: true };
		s.auto = { borg: true };
		s.settings.keepBackups = 3;
	});
	const file = join(t.dir, "upkeep.json");
	const said: string[] = [];
	expect(await main(["export", file], d, (l) => said.push(l))).toBe(0);
	expect(said).toEqual([`Exported to ${file}.`]);
	const exported = JSON.parse(readFileSync(file, "utf8"));
	expect(exported).toMatchObject({ upkeep: 1, skip: { borg: "1.4.2" }, hold: { bat: true }, auto: { borg: true } });
	expect(exported.apps).toContain("[apps.borg]");
	// On stdout, the same document.
	const stdout: string[] = [];
	expect(await main(["export"], d, (l) => stdout.push(l))).toBe(0);
	expect(JSON.parse(stdout.join("\n")).apps).toBe(exported.apps);
	const line: string[] = [];
	expect(await main(["export", "--json"], d, (l) => line.push(l))).toBe(0);
	expect(line).toHaveLength(1);
	expect(JSON.parse(line[0] ?? "{}").upkeep).toBe(1);
	const answer: string[] = [];
	expect(await main(["export", file, "--json"], d, (l) => answer.push(l))).toBe(0);
	expect(JSON.parse(answer[0] ?? "{}")).toEqual({ ok: true, file });

	// A different machine's setup: only borg, and a skip for an app it does not list.
	updateState(t.paths, (s) => {
		s.skip = {};
		s.settings.keepBackups = 1;
	});
	exported.apps = exported.apps.replace(/\[apps\.bat\][\s\S]*$/, "");
	exported.skip = { borg: "1.4.2", gone: "9" };
	writeFileSync(file, JSON.stringify(exported));
	const done: string[] = [];
	expect(await main(["import", file], d, (l) => done.push(l))).toBe(0);
	expect(done[0]).toStartWith("Imported 1 apps.");
	const state = loadState(t.paths);
	expect(state.skip).toEqual({ borg: "1.4.2" });
	expect(state.hold).toEqual({});
	expect(state.settings.keepBackups).toBe(3);
	expect(readdirSync(t.paths.config).filter((f) => f.startsWith("apps.toml.pre-import-"))).toHaveLength(1);
	expect(readdirSync(t.paths.state).filter((f) => f.startsWith("state.json.pre-import-"))).toHaveLength(1);
});

test("import that would turn the wait for an unmetered connection off says so and needs --yes", async () => {
	const d = deps();
	await main(["list"], d, () => {});
	const file = join(t.dir, "nowait.json");
	expect(await main(["export", file], d, () => {})).toBe(0);
	updateState(t.paths, (s) => {
		s.settings.waitUnmetered = true;
	});
	const said: string[] = [];
	expect(await main(["import", file], d, (l) => said.push(l))).toBe(1);
	expect(said.slice(0, 2)).toEqual([
		`${file} turns off these settings on this computer:`,
		"  Wait for an unmetered connection and mains power for automatic app updates",
	]);
	expect(loadState(t.paths).settings.waitUnmetered).toBe(true);
});

test("import of a list whose apps run commands prints them and needs --yes; new or changed apps come in with auto off", async () => {
	const d = deps();
	await main(["list"], d, () => {});
	// borg is set to install automatically on this machine.
	updateState(t.paths, (s) => {
		s.auto = { borg: true };
	});
	const file = join(t.dir, "shared.json");
	expect(await main(["export", file], d, () => {})).toBe(0);
	const doc = JSON.parse(readFileSync(file, "utf8"));
	// bat now comes from another repo, and fake is new: both release apps, neither runs a command.
	doc.apps = doc.apps.replace('repo = "sharkdp/bat"', 'repo = "evil/bat"');
	doc.apps +=
		'\n[apps.glow]\nname = "Glow"\nkind = "command"\ncheck = ["glow", "--version"]\nlatest = "npm:glow"\nupdate = ["glow", "up"]\n' +
		'\n[apps.fake]\nname = "git"\nkind = "file"\nrepo = "evil/git"\nasset = "git$"\ndest = "~/.local/bin/git"\nauto = true\ninstall_if_missing = true\n';
	doc.auto = { glow: true, borg: true, bat: true };
	writeFileSync(file, JSON.stringify(doc));
	const before = readFileSync(join(t.paths.config, "apps.toml"), "utf8");
	const ask = [
		`${file} has apps that run these commands on this computer:`,
		"  Glow (glow)",
		"    source: npm:glow",
		"    check: glow --version",
		"    update: glow up",
		"and 3 apps that only install their release files, without root.",
	];
	const said: string[] = [];
	expect(await main(["import", file], d, (l) => said.push(l))).toBe(1);
	expect(said).toEqual([
		...ask,
		"Nothing was changed. Read the list, then run it again with --yes to import.",
		"Automatic installs come in off for every app that is new here or differs from this computer's table.",
	]);
	const json: string[] = [];
	expect(await main(["import", file, "--json"], d, (l) => json.push(l))).toBe(1);
	expect(JSON.parse(json[0] ?? "{}")).toEqual({
		ok: false,
		ask: {
			apps: [{ key: "glow", name: "Glow", commands: ["source: npm:glow", "check: glow --version", "update: glow up"] }],
			plain: 3,
			turnsOn: [],
			turnsOff: [],
		},
	});
	expect(readFileSync(join(t.paths.config, "apps.toml"), "utf8")).toBe(before);
	// --yes prints the same list before the result, so a log records what came in.
	const yes: string[] = [];
	expect(await main(["import", "--yes", file], d, (l) => yes.push(l))).toBe(0);
	expect(yes).toEqual([
		...ask,
		"Imported 4 apps. The files it replaced are kept beside them as .pre-import-<time>.",
		"Automatic installs came in off for bat, glow, fake: new here or changed from this computer's table.",
	]);
	// borg matches this machine's table and keeps its pick; the changed and the new ones do not, whatever the file said.
	expect(loadState(t.paths).auto).toEqual({ borg: true, bat: false, glow: false, fake: false });
	// The same file a second time: every table now matches, and each keeps this machine's pick (off), not the file's.
	const again: string[] = [];
	expect(await main(["import", file, "--yes", "--yes", "--json"], d, (l) => again.push(l))).toBe(0);
	// Nothing is new or changed now, so nothing "came in off": the picks here simply stay.
	expect(JSON.parse(again[0] ?? "{}").autoOff).toEqual([]);
	expect(loadState(t.paths).auto).toEqual({ borg: true, bat: false, glow: false, fake: false });
	// A pick made here survives a re-import of a file that says otherwise.
	updateState(t.paths, (s) => {
		s.auto.glow = true;
		s.auto.borg = false;
	});
	expect(await main(["import", file, "--yes"], d, () => {})).toBe(0);
	expect(loadState(t.paths).auto).toEqual({ borg: false, bat: false, glow: true, fake: false });
});

test("import of a list of release apps only asks nothing and says which came in with auto off", async () => {
	const d = deps();
	await main(["list"], d, () => {});
	const file = join(t.dir, "plain.json");
	expect(await main(["export", file], d, () => {})).toBe(0);
	const doc = JSON.parse(readFileSync(file, "utf8"));
	doc.apps = doc.apps.replace(/\[apps\.bat\][\s\S]*$/, "");
	doc.apps += '\n[apps.fd]\nname = "fd"\nkind = "file"\nrepo = "sharkdp/fd"\nasset = "fd$"\ndest = "~/.local/bin/fd"\n';
	doc.auto = { fd: true };
	writeFileSync(file, JSON.stringify(doc));
	const said: string[] = [];
	expect(await main(["import", file], d, (l) => said.push(l))).toBe(0);
	expect(said).toEqual([
		"Imported 2 apps. The files it replaced are kept beside them as .pre-import-<time>.",
		"Automatic installs came in off for fd: new here or changed from this computer's table.",
	]);
	expect(loadState(t.paths).auto).toEqual({ borg: false, fd: false });
	// One app that installs only its releases is said in the singular.
	writeFileSync(
		file,
		JSON.stringify({
			...doc,
			apps:
				'[apps.glow]\nname = "Glow"\nkind = "command"\ncheck = ["glow", "-V"]\nlatest = "npm:glow"\nupdate = ["glow", "up"]\n' +
				doc.apps.replace(/\[apps\.fd\][\s\S]*$/, ""),
		}),
	);
	const one: string[] = [];
	expect(await main(["import", file], d, (l) => one.push(l))).toBe(1);
	expect(one).toContain("and 1 app that only installs its release files, without root.");
});

test("import never takes a pre-release switch from the file, and a table that turns prerelease on comes in with auto off", async () => {
	const d = deps();
	await main(["list"], d, () => {});
	const file = join(t.dir, "pre.json");
	const fd = '\n[apps.fd]\nname = "fd"\nkind = "file"\nrepo = "sharkdp/fd"\nasset = "fd$"\ndest = "~/.local/bin/fd"\n';
	expect(await main(["export", file], d, () => {})).toBe(0);
	const doc = JSON.parse(readFileSync(file, "utf8"));
	doc.apps = doc.apps.replace(/\[apps\.bat\][\s\S]*$/, "") + fd;
	writeFileSync(file, JSON.stringify(doc));
	expect(await main(["import", file], d, () => {})).toBe(0);
	// The table now matches; a switch the file carries never decides, and this machine's own is kept.
	writeFileSync(file, JSON.stringify({ ...doc, auto: { fd: true }, prerelease: { fd: true } }));
	expect(await main(["import", file], d, () => {})).toBe(0);
	expect(loadState(t.paths).prerelease).toEqual({});
	updateState(t.paths, (s) => {
		s.prerelease.fd = false;
		s.auto.fd = true;
	});
	expect(await main(["import", file], d, () => {})).toBe(0);
	expect(loadState(t.paths)).toMatchObject({ prerelease: { fd: false }, auto: { fd: true } });
	// prerelease = true in the table changes what installs: the app differs, its auto comes in off, the switch goes.
	writeFileSync(file, JSON.stringify({ ...doc, apps: `${doc.apps}prerelease = true\n`, auto: { fd: true } }));
	const said: string[] = [];
	expect(await main(["import", file], d, (l) => said.push(l))).toBe(0);
	expect(said).toContain("Automatic installs came in off for fd: new here or changed from this computer's table.");
	expect(loadState(t.paths)).toMatchObject({ prerelease: {}, auto: { fd: false } });
});

test("import of a file that turns on a setting or extra that is off here asks first; turning things off does not", async () => {
	const d = deps();
	await main(["list"], d, () => {});
	const file = join(t.dir, "switches.json");
	expect(await main(["export", file], d, () => {})).toBe(0);
	const doc = JSON.parse(readFileSync(file, "utf8"));
	doc.settings.selfAuto = true;
	doc.settings.upkeepCommand = true;
	doc.settings.language = "de";
	// systemInstall without the list shown is clamped away, so only the list counts.
	doc.extras = { system: "show", systemInstall: true, cleanup: true, devCaches: true };
	writeFileSync(file, JSON.stringify(doc));
	const said: string[] = [];
	expect(await main(["import", file], d, (l) => said.push(l))).toBe(1);
	expect(said).toEqual([
		`${file} turns on these settings on this computer:`,
		"  Update Upkeep automatically",
		"  Add the upkeep command",
		"  Show system updates",
		"  Install system updates from Upkeep",
		"  Show Cleanup",
		"  Include developer caches",
		"Nothing was changed. Read the list, then run it again with --yes to import.",
		"Automatic installs come in off for every app that is new here or differs from this computer's table.",
	]);
	expect(loadState(t.paths).settings.selfAuto).toBe(false);
	expect(await main(["import", file, "--yes"], d, () => {})).toBe(0);
	expect(loadState(t.paths).settings).toMatchObject({ selfAuto: true, upkeepCommand: true, language: "de" });
	// Now on here: the same file asks nothing, and a file turning them off asks nothing either.
	expect(await main(["import", file], d, () => {})).toBe(0);
	doc.settings.selfAuto = false;
	doc.settings.checkEvery = "daily";
	doc.extras = { system: "off" };
	writeFileSync(file, JSON.stringify(doc));
	expect(await main(["import", file], d, () => {})).toBe(0);
	expect(loadState(t.paths).settings.selfAuto).toBe(false);
});

test("import refuses a file that is not an export, or whose list does not load, and changes nothing", async () => {
	const d = deps();
	await main(["list"], d, () => {});
	const before = readFileSync(join(t.paths.config, "apps.toml"), "utf8");
	const file = join(t.dir, "bad.json");
	const cases: [string, string][] = [
		["{", "not JSON"],
		["[]", "not an Upkeep export"],
		['{"upkeep": 2, "apps": ""}', "not an Upkeep export this version reads"],
		['{"upkeep": 1}', 'the export has no "apps" text'],
		['{"upkeep": 1, "apps": "[apps.x]\\nkind = 3\\n"}', "x:"],
	];
	for (const [text, problem] of cases) {
		writeFileSync(file, text);
		const out: string[] = [];
		// oxlint-disable-next-line no-await-in-loop -- each case rewrites the same file, so they run in order
		expect(await main(["import", file, "--json"], d, (l) => out.push(l))).toBe(1);
		expect((JSON.parse(out[0] ?? "{}").problems ?? []).join("\n")).toContain(problem);
	}
	const missing: string[] = [];
	expect(await main(["import", join(t.dir, "absent.json")], d, (l) => missing.push(l))).toBe(1);
	expect(missing[0]).toStartWith("Could not read ");
	const missingJson: string[] = [];
	expect(await main(["import", join(t.dir, "absent.json"), "--json"], d, (l) => missingJson.push(l))).toBe(1);
	expect(JSON.parse(missingJson[0] ?? "{}")).toMatchObject({ ok: false });
	expect(readFileSync(join(t.paths.config, "apps.toml"), "utf8")).toBe(before);
});

test("import waits for no run: with another Upkeep's run holding the lock it refuses", async () => {
	const d = deps();
	await main(["list"], d, () => {});
	const file = join(t.dir, "upkeep.json");
	await main(["export", file], d, () => {});
	expect(claimLock(t.paths, process.ppid)).toBe(true);
	const out: string[] = [];
	expect(await main(["import", file], d, (l) => out.push(l))).toBe(1);
	expect(out).toEqual(["An Upkeep run is in progress. Try again when it ends."]);
	const json: string[] = [];
	expect(await main(["import", file, "--json"], d, (l) => json.push(l))).toBe(1);
	expect(JSON.parse(json[0] ?? "{}")).toEqual({
		ok: false,
		problems: ["An Upkeep run is in progress. Try again when it ends."],
	});
	releaseLock(t.paths, process.ppid);
});

test("history, restore and recover answer in JSON with --json", async () => {
	const d = deps();
	expect(await main(["install", "borg"], d, () => {})).toBe(0);
	const h: string[] = [];
	expect(await main(["history", "--json"], d, (l) => h.push(l))).toBe(0);
	expect(JSON.parse(h[0] ?? "{}")).toMatchObject({ key: "borg", result: "updated" });
	const r: string[] = [];
	expect(await main(["restore", "borg", "--json"], d, (l) => r.push(l))).toBe(0);
	expect(JSON.parse(r[0] ?? "{}")).toMatchObject({ key: "borg", version: "1.4.1", ok: true });
	const none: string[] = [];
	expect(await main(["restore", "bat", "--json"], d, (l) => none.push(l))).toBe(1);
	expect(JSON.parse(none[0] ?? "{}")).toMatchObject({ key: "bat", ok: false });
	const c: string[] = [];
	expect(await main(["recover", "--json"], d, (l) => c.push(l))).toBe(0);
	expect(JSON.parse(c[0] ?? "{}")).toEqual({ busy: false, apps: [] });
});

test("add takes a catalogue app by its name, and says each problem of an import in text", async () => {
	const d = deps();
	const catalogue = join(t.dir, "catalogue");
	mkdirSync(catalogue, { recursive: true });
	writeFileSync(
		join(catalogue, "fd.toml"),
		`[apps.fd]\nname = "fd"\nkind = "file"\nrepo = "sharkdp/fd"\nasset = 'fd-linux$'\ndest = "~/.local/bin/fd"\n`,
	);
	const withCatalogue: EngineDeps = {
		...d,
		catalogueDir: catalogue,
		fetch: async (url, init) =>
			url.endsWith("sharkdp/fd/releases/latest")
				? Response.json({ tag_name: "v10.5.2", assets: [{ name: "fd-linux", size: 10, digest: null }] })
				: fakeFetch(url, init),
	};
	const out: string[] = [];
	expect(await main(["add", "fd"], withCatalogue, (l) => out.push(l))).toBe(0);
	expect(out).toEqual(["Added fd."]);
	// A Snap of the same app is said after, as the window's card says it; the add itself goes ahead. A name of two
	// letters (fd) is too short to call a match.
	writeFileSync(
		join(catalogue, "glowtool.toml"),
		'[apps.glowtool]\nname = "Glow Tool"\nkind = "command"\ncheck = ["glowtool", "--version"]\nlatest = "npm:glowtool"\nupdate = ["glowtool", "up"]\n',
	);
	const snapped: EngineDeps = {
		...withCatalogue,
		run: async (argv, opts) =>
			argv[0] === "snap"
				? {
						code: 0,
						stdout:
							"Name  Version  Rev  Tracking  Publisher  Notes\nfd  1  1  latest/stable  x  -\nglowtool  1  1  latest/stable  x  -\n",
						stderr: "",
						timedOut: false,
					}
				: withCatalogue.run(argv, opts),
	};
	const noted: string[] = [];
	expect(await main(["add", "glowtool"], snapped, (l) => noted.push(l))).toBe(0);
	expect(noted).toEqual([
		"Added glowtool.",
		"Note: Glow Tool is also installed as a Snap (glowtool), which updates on its own.",
	]);
	const listed: string[] = [];
	await main(["list"], withCatalogue, (l) => listed.push(l));
	expect(listed).toContain("fd  fd  file  sharkdp/fd");
	const file = join(t.dir, "bad.json");
	writeFileSync(file, "[]");
	const said: string[] = [];
	expect(await main(["import", file], d, (l) => said.push(l))).toBe(1);
	expect(said).toEqual(["not an Upkeep export: the file is not an object"]);
});

test("add writes only a sure suggestion or a catalogue table, never a guessed repo", () => {
	const of = (confidence: Suggestion["confidence"], source: Suggestion["source"]): Suggestion => ({
		spec: { key: "bottom", name: "bottom", kind: "file", repo: "ClementTsang/bottom" },
		installed: null,
		latest: "0.10.2",
		asset: null,
		alternatives: [],
		source,
		confidence,
		why: "",
	});
	expect(pickSure([of("sure", "repo")])?.source).toBe("repo");
	expect(pickSure([of("guess", "catalogue")])?.source).toBe("catalogue");
	expect(pickSure([of("guess", "file")])).toBeNull();
	expect(pickSure([])).toBeNull();
});

test("an import that cannot finish puts every file back and removes the ones it created", async () => {
	const d = deps();
	await main(["list"], d, () => {});
	const before = readFileSync(join(t.paths.config, "apps.toml"), "utf8");
	const file = join(t.dir, "upkeep.json");
	await main(["export", file], d, () => {});
	const exported = JSON.parse(readFileSync(file, "utf8"));
	exported.apps = exported.apps.replace(/\[apps\.bat\][\s\S]*$/, "");
	exported.hold = { borg: true };
	exported.extras = { system: "show" };
	writeFileSync(file, JSON.stringify(exported));
	// A fresh machine: no state.json or extras.json yet. A folder where extras.json's temp copy goes makes the last
	// write fail after apps.toml and state.json were written.
	rmSync(join(t.paths.state, "state.json"), { force: true });
	mkdirSync(join(t.paths.state, `extras.json.${process.pid}.tmp`), { recursive: true });
	const out: string[] = [];
	expect(await main(["import", file, "--yes"], d, (l) => out.push(l))).toBe(1);
	// --yes prints the list first (the extra this file turns on), then the reason.
	expect(out.slice(0, 2)).toEqual([`${file} turns on these settings on this computer:`, "  Show system updates"]);
	expect(out[2]).toStartWith("could not write: ");
	expect(out[2]).toEndWith("Nothing was changed.");
	expect(readFileSync(join(t.paths.config, "apps.toml"), "utf8")).toBe(before);
	expect(existsSync(join(t.paths.state, "state.json"))).toBe(false);
	expect(existsSync(join(t.paths.state, "extras.json"))).toBe(false);
	rmSync(join(t.paths.state, `extras.json.${process.pid}.tmp`), { recursive: true });
	// Two imports at the same moment keep both starting points.
	const same: EngineDeps = { ...d, now: () => new Date("2026-11-12T10:00:00Z") };
	expect(await main(["import", file, "--yes"], same, () => {})).toBe(0);
	expect(await main(["import", file, "--yes"], same, () => {})).toBe(0);
	const copies = readdirSync(t.paths.config).filter((f) =>
		f.startsWith("apps.toml.pre-import-2026-11-12T10-00-00-000Z"),
	);
	expect(copies.toSorted()).toEqual([
		"apps.toml.pre-import-2026-11-12T10-00-00-000Z",
		"apps.toml.pre-import-2026-11-12T10-00-00-000Z-2",
	]);
	const failed: string[] = [];
	expect(await main(["export", join(t.dir, "no", "such", "dir", "x.json")], d, (l) => failed.push(l))).toBe(1);
	expect(failed[0]).toStartWith("Could not write ");
	const failedJson: string[] = [];
	expect(await main(["export", join(t.dir, "no", "x.json"), "--json"], d, (l) => failedJson.push(l))).toBe(1);
	expect(JSON.parse(failedJson[0] ?? "{}").ok).toBe(false);
});

test("add refuses a catalogue app whose install path holds a script, as the window does", async () => {
	const d = deps();
	const catalogue = join(t.dir, "catalogue");
	mkdirSync(catalogue, { recursive: true });
	writeFileSync(
		join(catalogue, "httpx.toml"),
		`[apps.httpx]\nname = "httpx"\nkind = "file"\nrepo = "o/httpx"\nasset = 'httpx-linux$'\ndest = "~/.local/bin/httpx"\n`,
	);
	// Another tool of the same name, a Python script.
	script(join(t.paths.home, ".local/bin/httpx"), "echo httpx 0.28.1");
	const withCatalogue: EngineDeps = {
		...d,
		catalogueDir: catalogue,
		fetch: async (url, init) =>
			url.endsWith("o/httpx/releases/latest")
				? Response.json({ tag_name: "v1.6.0", assets: [{ name: "httpx-linux", size: 10, digest: null }] })
				: fakeFetch(url, init),
	};
	const out: string[] = [];
	expect(await main(["add", "httpx"], withCatalogue, (l) => out.push(l))).toBe(1);
	expect(out).toEqual([
		"~/.local/bin/httpx is already there and is not this app's program (a script, or another tool with the same name). Adding would replace it; remove or rename it first.",
	]);
	const listed: string[] = [];
	await main(["list"], d, (l) => listed.push(l));
	expect(listed.some((l) => l.startsWith("httpx "))).toBe(false);
});

/** Stands in for process: raise() delivers a signal to what install listens with, and exit is recorded, not taken. */
function fakeSignals() {
	const listeners = new Map<string, Set<() => void>>();
	const exits: number[] = [];
	return {
		exits,
		raise: (name: "SIGINT" | "SIGTERM" | "SIGHUP") => {
			for (const fn of listeners.get(name) ?? []) fn();
		},
		listening: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
		on(name: string, fn: () => void) {
			listeners.set(name, (listeners.get(name) ?? new Set()).add(fn));
		},
		off(name: string, fn: () => void) {
			listeners.get(name)?.delete(fn);
		},
		exit(code: number) {
			exits.push(code);
		},
	};
}

/** deps() whose borg download sends a little and then stalls until it is aborted. */
function stalledDeps(): EngineDeps {
	const d = deps();
	d.fetch = async (url, init) => {
		if (url !== "https://dl.test/borg") return fakeFetch(url, init);
		return new Response(
			new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(new Uint8Array([1]));
					init?.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
				},
			}),
			{ headers: { "content-length": "100" } },
		);
	};
	return d;
}

test("the first Ctrl-C during an install is Stop now: it says so, puts the app back and exits 1", async () => {
	const sig = fakeSignals();
	const out: string[] = [];
	const code = await main(
		["install", "borg"],
		stalledDeps(),
		(l) => {
			out.push(l);
			if (l.includes("Downloading borg-linux")) sig.raise("SIGINT");
		},
		sig,
	);
	expect(code).toBe(1);
	expect(out).toContain(
		"Stopping: putting BorgBackup back. Press Ctrl-C again to quit at once, which can leave BorgBackup half-installed.",
	);
	expect(out).toContain("[borg] stopped Stopped. 1.4.1 is back in place.");
	expect(sig.exits).toEqual([]);
	expect(sig.listening()).toBe(0);
	expect((await realRun(t.paths)([join(t.paths.home, ".local/bin/borg")])).stdout).toBe("borg 1.4.1\n");
});

test("SIGTERM is Stop now too, and a second signal with no step left to end quits without claiming the put-back failed", async () => {
	const sig = fakeSignals();
	const out: string[] = [];
	await main(
		["install", "borg"],
		stalledDeps(),
		(l) => {
			out.push(l);
			if (l.includes("Downloading borg-linux")) {
				sig.raise("SIGTERM");
				sig.raise("SIGINT");
			}
		},
		sig,
	);
	expect(out.filter((l) => l.startsWith("Stopping: putting BorgBackup back."))).toHaveLength(1);
	expect(out).toContain(
		"Quit while BorgBackup was being stopped. Run upkeep recover to make sure it is back in place.",
	);
	expect(sig.exits).toEqual([130]);
});

test("Ctrl-C during the check before an install quits at once: nothing is being changed yet", async () => {
	const sig = fakeSignals();
	const d = deps();
	d.fetch = async (url, init) => {
		if (url.endsWith("borgbackup/borg/releases/latest")) sig.raise("SIGINT");
		return fakeFetch(url, init);
	};
	await main(["install", "borg"], d, () => {}, sig);
	expect(sig.exits[0]).toBe(130);
});

test("a second Ctrl-C during a root step quits and says the step runs on as root", async () => {
	const d = deps();
	const seed = join(t.dir, "seed.toml");
	writeFileSync(
		seed,
		readFileSync(seed, "utf8").replace('dest = "~/.local/bin/borg"', 'dest = "~/.local/bin/borg"\nsudo = true'),
	);
	const marker = join(t.dir, "sudo-started");
	// A stand-in sudo in the temp home: it says it started, waits a moment, then runs the command as the person.
	script(join(t.paths.home, ".local/bin/sudo"), `touch "${marker}"; sleep 1; [ "$1" = -n ] && shift; exec "$@"`);
	const sig = fakeSignals();
	const out: string[] = [];
	const poll = setInterval(() => {
		if (!existsSync(marker)) return;
		clearInterval(poll);
		sig.raise("SIGINT");
		sig.raise("SIGINT");
	}, 20);
	await main(["install", "borg"], d, (l) => out.push(l), sig);
	clearInterval(poll);
	expect(out).toContain(
		"Quit before BorgBackup was put back. install runs as root and is still running; run upkeep recover once it ends.",
	);
	expect(sig.exits).toEqual([130]);
});

test("closing the terminal (SIGHUP) during an install is Stop now too", async () => {
	const sig = fakeSignals();
	const out: string[] = [];
	const code = await main(
		["install", "borg"],
		stalledDeps(),
		(l) => {
			out.push(l);
			if (l.includes("Downloading borg-linux")) sig.raise("SIGHUP");
		},
		sig,
	);
	expect(code).toBe(1);
	expect(out).toContain("[borg] stopped Stopped. 1.4.1 is back in place.");
	expect(sig.exits).toEqual([]);
	expect(sig.listening()).toBe(0);
});

test("Ctrl-C while the install starts waits for the recovery of an earlier update; a second one quits", () => {
	const sig = fakeSignals();
	const out: string[] = [];
	const engine = {
		snapshot: () => createEngine(deps()).snapshot(),
		stopNow: () => out.push("stopNow"),
		endStep: async () => null,
	};
	const gate = { starting: true, pending: false };
	const unlisten = stopOnSignal(engine, sig, (l) => out.push(l), gate);
	sig.raise("SIGINT");
	expect(gate.pending).toBe(true);
	expect(sig.exits).toEqual([]);
	expect(out).toEqual(["Stopping: no app will be installed. Press Ctrl-C again to quit at once."]);
	sig.raise("SIGINT");
	expect(out.at(-1)).toBe("Quit while an earlier interrupted update was being finished or undone. Run upkeep recover.");
	expect(sig.exits).toEqual([130]);
	unlisten();
	expect(sig.listening()).toBe(0);
});

/** A fetch that fails the test if anything reaches the network. */
const noNetwork: FetchLike = async (url) => {
	throw new Error(`status reached the network: ${url}`);
};

test("status before any check says so and exits 1, without the network", async () => {
	const out: string[] = [];
	expect(await main(["status"], { ...deps(), fetch: noNetwork, version: "9.9.9" }, (l) => out.push(l))).toBe(1);
	expect(out).toEqual(["Upkeep 9.9.9", "No check has run yet."]);
	const metrics: string[] = [];
	expect(await main(["status", "--metrics"], { ...deps(), fetch: noNetwork }, (l) => metrics.push(l))).toBe(0);
	expect(metrics[0]).toContain("upkeep_last_check_timestamp_seconds 0\n");
});

test("status reads what the last check saved, as text, JSON and metrics, without the network", async () => {
	const d = deps();
	await main(["check"], d, () => {});
	const quiet = { ...d, fetch: noNetwork, version: "9.9.9" };
	const out: string[] = [];
	expect(await main(["status"], quiet, (l) => out.push(l))).toBe(0);
	expect(out[0]).toBe("Upkeep 9.9.9");
	expect(out[1]).toMatch(/^Last check: \d{4}-\d\d-\d\dT/);
	expect(out.slice(2)).toEqual([
		"2 apps: 1 up to date, 1 ready, 0 held, 0 failing",
		"  UPDATE: BorgBackup 1.4.1 -> 1.4.2",
	]);

	const json: string[] = [];
	await main(["status", "--json"], quiet, (l) => json.push(l));
	const s = JSON.parse(json[0] ?? "");
	expect(s.running).toBe(false);
	expect(s.counts).toEqual({ apps: 2, upToDate: 1, ready: 1, held: 0, failing: 0 });
	expect(s.ready).toEqual([{ key: "borg", name: "BorgBackup", installed: "1.4.1", latest: "1.4.2" }]);

	const metrics: string[] = [];
	await main(["status", "--metrics"], quiet, (l) => metrics.push(l));
	expect(metrics[0]).toContain('upkeep_info{version="9.9.9"} 1');
	expect(metrics[0]).toContain('upkeep_update_ready{app="borg",installed="1.4.1",latest="1.4.2"} 1');
});

test("status says a run is in progress while another process holds the run lock, and a held app counts as held", async () => {
	const d = deps();
	await main(["check"], d, () => {});
	updateState(t.paths, (s) => {
		s.hold.borg = true;
	});
	// A live process: this test's own pid, with its real start time.
	expect(claimLock(t.paths)).toBe(true);
	const out: string[] = [];
	try {
		await main(["status"], { ...d, fetch: noNetwork, version: "9.9.9" }, (l) => out.push(l));
	} finally {
		releaseLock(t.paths);
	}
	expect(out[0]).toBe("Upkeep 9.9.9, a run is in progress");
	expect(out).toContain("2 apps: 1 up to date, 0 ready, 1 held, 0 failing");
	expect(out).toContain("  HELD:   BorgBackup 1.4.1 -> 1.4.2");
});

test("after an install the saved rows carry the new version, so status shows the app up to date before any check", async () => {
	const d = deps();
	expect(await main(["install", "borg"], d, () => {})).toBe(0);
	const out: string[] = [];
	await main(["status"], { ...d, fetch: noNetwork }, (l) => out.push(l));
	expect(out).toContain("2 apps: 2 up to date, 0 ready, 0 held, 0 failing");
});

test("status with an unknown argument prints the usage", async () => {
	const out: string[] = [];
	expect(await main(["status", "now"], deps(), (l) => out.push(l))).toBe(2);
	expect(out).toEqual([USAGE]);
});

test("status counts a paused app as held and prints its HELD line as check does, with the pause's end", async () => {
	const d = deps();
	await main(["check"], d, () => {});
	expect(await main(["pause", "borg", "14"], d, () => {})).toBe(0);
	const quiet = { ...d, fetch: noNetwork };
	const out: string[] = [];
	await main(["status"], quiet, (l) => out.push(l));
	expect(out).toContain("2 apps: 1 up to date, 0 ready, 1 held, 0 failing");
	const line = out.find((l) => l.startsWith("  HELD:"));
	expect(line).toMatch(/^ {2}HELD: {3}BorgBackup 1\.4\.1 -> 1\.4\.2 \(paused until \d{4}-\d\d-\d\d\)$/);
	const checked: string[] = [];
	await main(["check"], d, (l) => checked.push(l));
	expect(checked).toContain(line ?? "no HELD line");
	const json: string[] = [];
	await main(["status", "--json"], quiet, (l) => json.push(l));
	expect(JSON.parse(json[0] ?? "").held[0].paused).toMatch(/^\d{4}-/);
});
