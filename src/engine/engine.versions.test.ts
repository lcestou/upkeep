import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MESSAGES } from "../shared/messages";
import { createEngine, REASON_NOTHING } from "./engine";
import type { FetchLike } from "./github";
import { loadState } from "./store";
import { recordingRun, script, tempHome } from "./testkit";

const MANIFEST = `
[apps.tool]
name = "Tool"
kind = "file"
repo = "o/tool"
asset = 'tool-linux$'
dest = "~/.local/bin/tool"

[apps.cmd]
name = "Cmd"
kind = "command"
check = ["~/.local/bin/cmd", "--version"]
latest = "npm:cmd-pkg"
update = ["true"]
`;

/** The releases o/tool has, newest first as GitHub lists them: a candidate, the latest stable one and an older one. */
const RELEASES = [
	{ tag: "v1.2.0-rc.1", prerelease: true },
	{ tag: "v1.1.0", prerelease: false },
	{ tag: "v1.0.0", prerelease: false },
	{ tag: "v0.9.0", prerelease: false, draft: true },
];

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("engine-versions");
	mkdirSync(join(t.dir, "proc"));
});
afterEach(() => t.cleanup());

/** The program a release of tool ships: a script that prints the release's version. */
const program = (tag: string) => new TextEncoder().encode(`#!/bin/sh\necho "tool ${tag.slice(1)}"\n`);

/** A release body in GitHub's shape, its one file served from dl.test. */
function body(r: (typeof RELEASES)[number]) {
	return {
		tag_name: r.tag,
		prerelease: r.prerelease,
		draft: r.draft === true,
		html_url: `https://github.com/o/tool/releases/tag/${r.tag}`,
		published_at: "2026-11-09T00:00:00Z",
		body: "",
		assets: [
			{
				name: "tool-linux",
				browser_download_url: `https://dl.test/${r.tag}/tool-linux`,
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
	script(join(bin, "cmd"), 'echo "cmd 1.0.0"');
	const asked: { url: string; etag?: string }[] = [];
	const fetch: FetchLike = async (url, init) => {
		if (url.includes("registry.npmjs.org")) return Response.json({ version: "1.0.0" });
		const dl = /^https:\/\/dl\.test\/([^/]+)\/tool-linux$/.exec(url);
		if (dl) return new Response(program(dl[1] ?? ""));
		const etag = new Headers(init?.headers).get("If-None-Match") ?? undefined;
		asked.push({ url, etag });
		const api = "https://api.github.com/repos/o/tool/releases";
		if (url === `${api}/latest`) return Response.json(body(RELEASES[1] ?? RELEASES[0]!));
		if (url === `${api}?per_page=10`) {
			if (etag === '"list"') return new Response(null, { status: 304 });
			return Response.json(RELEASES.map(body), { headers: { etag: '"list"' } });
		}
		const tag = url.startsWith(`${api}/tags/`) ? decodeURIComponent(url.slice(api.length + 6)) : null;
		const r = RELEASES.find((x) => x.tag === tag);
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
	expect(row()).toMatchObject({ latest: "1.2.0-rc.1", status: "ready", prerelease: true });
	expect(loadState(t.paths).prerelease).toEqual({ tool: true });
	expect(asked.some((a) => a.url.endsWith("?per_page=10"))).toBe(true);

	engine.setPrerelease("tool", false);
	await engine.idle();
	expect(row()).toMatchObject({ latest: "1.1.0", status: "fresh", prerelease: false });
});

test("the release list is asked only when wanted, leaves drafts out and is revalidated with its etag", async () => {
	const { engine, asked } = await setup();
	expect(asked.some((a) => a.url.includes("per_page"))).toBe(false);
	const first = await engine.versions("tool");
	expect(first.versions).toEqual([
		{ tag: "v1.2.0-rc.1", version: "1.2.0-rc.1", publishedAt: "2026-11-09T00:00:00Z", prerelease: true },
		{ tag: "v1.1.0", version: "1.1.0", publishedAt: "2026-11-09T00:00:00Z", prerelease: false },
		{ tag: "v1.0.0", version: "1.0.0", publishedAt: "2026-11-09T00:00:00Z", prerelease: false },
	]);
	const again = await engine.versions("tool");
	expect(again.versions).toEqual(first.versions);
	expect(asked.findLast((a) => a.url.includes("per_page"))?.etag).toBe('"list"');
	expect(await engine.versions("cmd")).toEqual({ versions: [], problem: MESSAGES.noApp("cmd") });
});

test("installing an older version goes through a run and holds the app at it", async () => {
	const { engine, row } = await setup();
	expect(await engine.installVersion("tool", "v1.1.0")).toEqual({ started: false, reason: REASON_NOTHING });
	expect((await engine.installVersion("tool", "v0.0.1")).started).toBe(false);
	expect(row()?.status).toBe("fresh");

	expect(await engine.installVersion("tool", "v1.0.0")).toEqual({ started: true });
	await engine.idle();
	expect(row()).toMatchObject({ installed: "1.0.0", status: "done", held: true });
	expect(engine.snapshot().run.results[0]).toMatchObject({ from: "1.1.0", to: "1.0.0", result: "updated" });
	expect(loadState(t.paths).hold).toEqual({ tool: true });
	expect(row()?.restorePoints.map((p) => p.version)).toEqual(["1.1.0"]);

	engine.dismissSummary();
	expect(row()).toMatchObject({ installed: "1.0.0", latest: "1.1.0", status: "held", held: true });
	await engine.check();
	expect(row()).toMatchObject({ installed: "1.0.0", status: "held" });

	// Release hold offers the latest again.
	engine.setHold("tool", false);
	expect(row()).toMatchObject({ status: "ready", held: false });
});

test("installing a newer version than the latest does not hold the app", async () => {
	const { engine, row } = await setup();
	expect(await engine.installVersion("tool", "v1.2.0-rc.1")).toEqual({ started: true });
	await engine.idle();
	expect(row()).toMatchObject({ installed: "1.2.0-rc.1", status: "done", held: false });
	expect(loadState(t.paths).hold).toEqual({});
	engine.dismissSummary();
	expect(row()?.status).toBe("fresh");
});
