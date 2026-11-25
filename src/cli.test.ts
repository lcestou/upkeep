import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkLine, main, pickSure, USAGE } from "./cli";
import type { EngineDeps } from "./engine/engine";
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
	expect(h[1]).toMatch(/ BorgBackup 1\.4\.1 to 1\.4\.2 Updated$/);
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
	expect(await main(["import", file], d, (l) => out.push(l))).toBe(1);
	expect(out[0]).toStartWith("could not write: ");
	expect(out[0]).toEndWith("Nothing was changed.");
	expect(readFileSync(join(t.paths.config, "apps.toml"), "utf8")).toBe(before);
	expect(existsSync(join(t.paths.state, "state.json"))).toBe(false);
	expect(existsSync(join(t.paths.state, "extras.json"))).toBe(false);
	rmSync(join(t.paths.state, `extras.json.${process.pid}.tmp`), { recursive: true });
	// Two imports at the same moment keep both starting points.
	const same: EngineDeps = { ...d, now: () => new Date("2026-11-12T10:00:00Z") };
	expect(await main(["import", file], same, () => {})).toBe(0);
	expect(await main(["import", file], same, () => {})).toBe(0);
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
		raise: (name: "SIGINT" | "SIGTERM") => {
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

test("SIGTERM is Stop now too, and a second signal quits at once with a warning", async () => {
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
	expect(out).toContain("Quit before BorgBackup was put back. Run upkeep recover.");
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
