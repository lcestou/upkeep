import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkLine, main, USAGE } from "./cli";
import type { EngineDeps } from "./engine/engine";
import type { FetchLike } from "./engine/github";
import { realRun, recordingRun, script, tempHome } from "./engine/testkit";
import type { AppState } from "./shared/types";

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
		oldScript: join(t.dir, "no-old-script"),
		oldLock: join(t.dir, "lock"),
		oldLog: join(t.dir, "old.log"),
		procRoot: join(t.dir, "proc"),
	};
}

test("check prints the old script's line shapes", async () => {
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

test("check exits 1 when the old updater's check did not finish, and 0 otherwise", async () => {
	const d = deps();
	writeFileSync(
		join(t.dir, "seed.toml"),
		`${MANIFEST}
[apps.cursor]
name = "Cursor"
kind = "legacy"
legacy_key = "cursor"
legacy_name = "Cursor"
`,
	);
	d.oldScript = script(join(t.dir, "lutechi-updater"), "exit 2");
	const out: string[] = [];
	expect(await main(["check"], d, (l) => out.push(l))).toBe(1);
	expect(out).toContain("  SKIP:   Cursor The old updater's check did not finish.");
	script(d.oldScript, 'echo "  OK:     Cursor 2.1.0"');
	expect(await main(["check"], d, () => {})).toBe(0);
});
