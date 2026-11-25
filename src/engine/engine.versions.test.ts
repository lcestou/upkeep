import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MESSAGES } from "../shared/messages";
import { backupDir } from "./backup";
import { createEngine, REASON_NOTHING } from "./engine";
import type { FetchLike } from "./github";
import { claimLock, loadState, releaseLock } from "./store";
import { recordingRun, script, tempHome } from "./testkit";

const MANIFEST = `
[apps.tool]
name = "Tool"
kind = "file"
repo = "o/tool"
asset = 'tool-linux$'
dest = "~/.local/bin/tool"
keep_with_restore = ["~/.config/tool"]

[apps.cmd]
name = "Cmd"
kind = "command"
check = ["~/.local/bin/cmd", "--version"]
latest = "npm:cmd-pkg"
update = ["true"]
`;

type Rel = { tag: string; prerelease?: boolean; draft?: boolean; file?: string; broken?: boolean };

/**
 * The releases o/tool has, newest first as GitHub lists them: another product of the repo (its own file, a higher
 * version), a candidate, the latest stable one, older ones (one whose file is missing, one from before a rename) and
 * a draft. Each test starts from this list.
 */
const START: Rel[] = [
	{ tag: "v2.0.0", file: "cli-linux" },
	{ tag: "v1.2.0-rc.1", prerelease: true },
	{ tag: "v1.1.0" },
	{ tag: "v1.0.0" },
	{ tag: "v0.9.5", broken: true },
	{ tag: "v0.8.0", file: "Tool-x86_64" },
	{ tag: "v0.7.0", draft: true },
];
let releases: Rel[] = [];
/** While set, a release file sends one byte and then waits until its fetch is aborted, as a slow download does. */
let stall = false;
/** The tag releases/latest answers. */
let latestTag = "v1.1.0";

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("engine-versions");
	mkdirSync(join(t.dir, "proc"));
});
afterEach(() => t.cleanup());

/** The program a release of tool ships: a script that prints the release's version. */
const program = (tag: string) => new TextEncoder().encode(`#!/bin/sh\necho "tool ${tag.slice(1)}"\n`);

/** A release body in GitHub's shape, its one file served from dl.test. */
function body(r: Rel) {
	const file = r.file ?? "tool-linux";
	return {
		tag_name: r.tag,
		prerelease: r.prerelease === true,
		draft: r.draft === true,
		html_url: `https://github.com/o/tool/releases/tag/${r.tag}`,
		published_at: "2026-11-09T00:00:00Z",
		body: "",
		assets: [
			{
				name: file,
				browser_download_url: `https://dl.test/${r.tag}/${file}`,
				size: program(r.tag).length,
				digest: null,
			},
		],
	};
}

/** The engine over a temp home with tool 1.1.0 installed. asked lists the GitHub addresses fetched, with their etag. */
async function setup() {
	writeFileSync(join(t.dir, "seed.toml"), MANIFEST);
	const bin = join(t.paths.home, ".local/bin");
	script(join(bin, "tool"), 'echo "tool 1.1.0"');
	mkdirSync(join(t.paths.home, ".config/tool"), { recursive: true });
	writeFileSync(join(t.paths.home, ".config/tool/settings"), "as 1.1.0 left it");
	script(join(bin, "cmd"), 'echo "cmd 1.0.0"');
	const asked: { url: string; etag?: string }[] = [];
	releases = [...START];
	stall = false;
	latestTag = "v1.1.0";
	const fetch: FetchLike = async (url, init) => {
		if (url.includes("registry.npmjs.org")) return Response.json({ version: "1.0.0" });
		const dl = /^https:\/\/dl\.test\/([^/]+)\/[^/]+$/.exec(url);
		if (dl && stall)
			return new Response(
				new ReadableStream<Uint8Array>({
					start(c) {
						c.enqueue(new Uint8Array([1]));
						init?.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
					},
				}),
				{ headers: { "content-length": "100" } },
			);
		if (dl) {
			const r = releases.find((x) => x.tag === dl[1]);
			return r && !r.broken ? new Response(program(r.tag)) : new Response("missing", { status: 404 });
		}
		const etag = new Headers(init?.headers).get("If-None-Match") ?? undefined;
		asked.push({ url, etag });
		const api = "https://api.github.com/repos/o/tool/releases";
		const tag =
			url === `${api}/latest`
				? latestTag
				: url.startsWith(`${api}/tags/`)
					? decodeURIComponent(url.slice(api.length + 6))
					: null;
		if (url === `${api}?per_page=10`) {
			const etagNow = `"${releases.length}"`;
			if (etag === etagNow) return new Response(null, { status: 304 });
			return Response.json(releases.map(body), { headers: { etag: etagNow } });
		}
		const r = releases.find((x) => x.tag === tag);
		return r ? Response.json(body(r)) : new Response("{}", { status: 404 });
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
		now: () => new Date(),
		procRoot: join(t.dir, "proc"),
		retryMs: 1,
		pollMs: 10,
		version: "9.9.9",
		freeBytes: () => 1e12,
	});
	await engine.check();
	const row = (key = "tool") => engine.snapshot().apps.find((a) => a.key === key);
	return { engine, asked, row };
}

test("a listable app follows stable releases until the person switches pre-releases on", async () => {
	const { engine, asked, row } = await setup();
	expect(row()).toMatchObject({ latest: "1.1.0", status: "fresh", prerelease: false });
	// A command app has no release list, so it has no switch.
	expect(row("cmd")?.prerelease).toBeUndefined();
	expect(engine.setPrerelease("cmd", true)).toBe(false);
	expect(engine.setPrerelease("nope", true)).toBe(false);

	expect(engine.setPrerelease("tool", true)).toBe(true);
	await engine.idle();
	// The repo's other product, 2.0.0, has no file this table installs, so the candidate is the newest.
	expect(row()).toMatchObject({ latest: "1.2.0-rc.1", status: "ready", prerelease: true });
	expect(loadState(t.paths).prerelease).toEqual({ tool: true });
	expect(asked.some((a) => a.url.endsWith("?per_page=10"))).toBe(true);

	engine.setPrerelease("tool", false);
	await engine.idle();
	expect(row()).toMatchObject({ latest: "1.1.0", status: "fresh", prerelease: false });
});

test("a switch changed during a check is checked again once the check is over", async () => {
	const { engine, row } = await setup();
	const p = engine.check();
	engine.setPrerelease("tool", true);
	await p;
	await engine.idle();
	expect(row()).toMatchObject({ latest: "1.2.0-rc.1", prerelease: true });
});

test("the release list is asked only when wanted, keeps what this table installs and is revalidated with its etag", async () => {
	const { engine, asked } = await setup();
	expect(asked.some((a) => a.url.includes("per_page"))).toBe(false);
	const first = await engine.versions("tool");
	// No other product's release, no release from before the file was renamed, no draft.
	expect(first.versions.map((v) => [v.tag, v.prerelease])).toEqual([
		["v1.2.0-rc.1", true],
		["v1.1.0", false],
		["v1.0.0", false],
		["v0.9.5", false],
	]);
	expect(first.versions[0]).toEqual({
		tag: "v1.2.0-rc.1",
		version: "1.2.0-rc.1",
		publishedAt: "2026-11-09T00:00:00Z",
		prerelease: true,
	});
	const again = await engine.versions("tool");
	expect(again.versions).toEqual(first.versions);
	expect(asked.findLast((a) => a.url.includes("per_page"))?.etag).toBe(`"${START.length}"`);
	expect(await engine.versions("cmd")).toEqual({ versions: [], problem: MESSAGES.noApp("cmd") });
});

test("going back to an older version skips the latest, and a newer release is offered when it comes out", async () => {
	const { engine, row } = await setup();
	expect(await engine.installVersion("tool", "v1.1.0")).toEqual({ started: false, reason: REASON_NOTHING });
	expect(row()?.status).toBe("fresh");

	expect(await engine.installVersion("tool", "v1.0.0")).toEqual({ started: true });
	await engine.idle();
	expect(row()).toMatchObject({ installed: "1.0.0", status: "done", held: false });
	expect(engine.snapshot().run.results[0]).toMatchObject({ from: "1.1.0", to: "1.0.0", result: "updated" });
	expect(loadState(t.paths)).toMatchObject({ skip: { tool: "1.1.0" }, hold: {} });
	expect(row()?.restorePoints.map((p) => p.version)).toEqual(["1.1.0"]);
	// The point keeps the app's settings, as an update's does.
	expect(readFileSync(join(backupDir(t.paths, "tool"), "1.1.0", "upkeep-config", "0", "settings"), "utf8")).toBe(
		"as 1.1.0 left it",
	);

	engine.dismissSummary();
	expect(row()).toMatchObject({ installed: "1.0.0", latest: "1.1.0", status: "held", skipped: "1.1.0", held: false });
	await engine.check();
	expect(row()).toMatchObject({ installed: "1.0.0", status: "held", skipped: "1.1.0" });

	// A newer release clears the skip and is offered.
	releases = [{ tag: "v1.3.0" }, ...releases];
	latestTag = "v1.3.0";
	await engine.check();
	expect(row()).toMatchObject({ latest: "1.3.0", status: "ready" });
	expect(row()?.skipped).toBeUndefined();
	expect(loadState(t.paths).skip).toEqual({});
});

test("going back and then forward to the latest leaves nothing that hides the next release", async () => {
	const { engine, row } = await setup();
	await engine.installVersion("tool", "v1.0.0");
	await engine.idle();
	engine.dismissSummary();
	expect(await engine.installVersion("tool", "v1.1.0")).toEqual({ started: true });
	await engine.idle();
	engine.dismissSummary();
	expect(row()).toMatchObject({ installed: "1.1.0", status: "fresh", held: false });
	releases = [{ tag: "v1.3.0" }, ...releases];
	latestTag = "v1.3.0";
	await engine.check();
	expect(row()).toMatchObject({ latest: "1.3.0", status: "ready" });
});

test("installing a newer version than the latest skips nothing", async () => {
	const { engine, row } = await setup();
	expect(await engine.installVersion("tool", "v1.2.0-rc.1")).toEqual({ started: true });
	await engine.idle();
	expect(row()).toMatchObject({ installed: "1.2.0-rc.1", status: "done", held: false });
	expect(loadState(t.paths)).toMatchObject({ skip: {}, hold: {} });
	engine.dismissSummary();
	expect(row()?.status).toBe("fresh");
});

test("a release this table cannot install is refused before anything runs", async () => {
	const { engine, row } = await setup();
	expect(await engine.installVersion("tool", "v0.8.0")).toEqual({
		started: false,
		reason: MESSAGES.noAssetMatches("tool-linux$"),
	});
	expect((await engine.installVersion("tool", "v0.0.1")).started).toBe(false);
	expect(row()?.status).toBe("fresh");
	expect(engine.snapshot().run.phase).toBe("idle");
});

test("a picked install refused by the run lock puts the row and its target back", async () => {
	const { engine, row } = await setup();
	releases = [{ tag: "v1.3.0" }, ...releases];
	latestTag = "v1.3.0";
	await engine.check();
	expect(row()?.status).toBe("ready");
	const proc = join(t.dir, "proc");
	mkdirSync(join(proc, "4242"));
	writeFileSync(join(proc, "4242/stat"), "4242 (bun) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5555 0 0");
	expect(claimLock(t.paths, 4242, proc)).toBe(true);
	const refused = await engine.installVersion("tool", "v1.0.0");
	expect(refused.started).toBe(false);
	expect(row()).toMatchObject({ status: "ready", installed: "1.1.0", latest: "1.3.0" });
	// The lock goes; Install now takes the latest, not the version the refused press picked.
	releaseLock(t.paths, 4242);
	expect(await engine.install(["tool"])).toEqual({ started: true });
	await engine.idle();
	expect(row()).toMatchObject({ installed: "1.3.0", status: "done" });
});

test("a picked version that fails leaves the latest as the target once the summary is dismissed", async () => {
	const { engine, row } = await setup();
	releases = [{ tag: "v1.3.0" }, ...releases];
	latestTag = "v1.3.0";
	await engine.check();
	expect(await engine.installVersion("tool", "v0.9.5")).toEqual({ started: true });
	await engine.idle();
	expect(row()).toMatchObject({ status: "failed", installed: "1.1.0" });
	expect(loadState(t.paths).skip).toEqual({});
	engine.dismissSummary();
	expect(row()?.status).toBe("ready");
	expect(await engine.install(["tool"])).toEqual({ started: true });
	await engine.idle();
	expect(row()).toMatchObject({ installed: "1.3.0", status: "done" });
});

test("Stop now ends a picked install like any other: nothing is skipped and the latest is the target again", async () => {
	const { engine, row } = await setup();
	stall = true;
	engine.subscribe((e) => {
		if (e.type === "app" && e.app.key === "tool" && e.app.status === "working") engine.stopNow();
	});
	expect(await engine.installVersion("tool", "v1.0.0")).toEqual({ started: true });
	await engine.idle();
	expect(row()).toMatchObject({ status: "stopped", installed: "1.1.0" });
	expect(engine.snapshot().run.results.map((r) => [r.result, r.to])).toEqual([["stopped", "1.0.0"]]);
	expect(loadState(t.paths).skip).toEqual({});
	stall = false;
	engine.dismissSummary();
	expect(row()?.status).toBe("fresh");
	expect(await engine.install(["tool"])).toMatchObject({ started: false });
}, 15_000);
