import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkLine, main, pickSure, USAGE } from "./cli";
import type { EngineDeps } from "./engine/engine";
import { claimLock, loadState, readInflight, releaseLock, updateState, writeInflight } from "./engine/store";
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
	const { run } = recordingRun(t.paths, (argv) =>
		argv[0] === "gh" ? { code: 1, stdout: "", stderr: "", timedOut: false } : undefined,
	);
	mkdirSync(join(t.dir, "proc"), { recursive: true });
	return {
		paths: t.paths,
		seedManifest: seed,
		fetch: fakeFetch,
		run,
		now: () => new Date(),
		oldLock: { file: join(t.dir, "lock"), name: "lutechi-updater" },
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
});

test("install exits 1 when nothing could be installed, and a bad command line is a usage error", async () => {
	const out: string[] = [];
	expect(await main(["install", "bat"], deps(), (l) => out.push(l))).toBe(1);
	expect(out.at(-1)).toBe("Nothing to install.");
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
	expect(existsSync(join(t.paths.config, "apps.toml.bak"))).toBe(true);
	expect(existsSync(join(t.paths.state, "state.json.bak"))).toBe(true);
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
	const listed: string[] = [];
	await main(["list"], withCatalogue, (l) => listed.push(l));
	expect(listed.at(-1)).toBe("fd  fd  file  sharkdp/fd");
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
