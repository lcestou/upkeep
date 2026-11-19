import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppState, EngineEvent } from "../shared/types";
import { createEngine } from "./engine";
import type { FetchLike } from "./github";
import { dlPath } from "./kinds/release";
import { realRun, recordingRun, script, tempHome } from "./testkit";

/** Waits until cond holds, every 5 ms for up to 2 s: under load the run reaches its first fetch later than a fixed sleep. */
const until = async (cond: () => boolean, left = 400): Promise<void> => {
	if (cond() || left === 0) return;
	await Bun.sleep(5);
	return until(cond, left - 1);
};

// A command app that takes 0.6 s to update runs first; the archive app fd waits behind it.
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
	t = tempHome("engine-ahead");
	mkdirSync(join(t.dir, "proc"));
});
afterEach(() => t.cleanup());

/** The engine over a temp home. fd's file is served at once, or held until its fetch is aborted when hold is set. */
async function setup(hold = false) {
	writeFileSync(join(t.dir, "seed.toml"), MANIFEST);
	const bin = join(t.paths.home, ".local/bin");
	const version = join(t.dir, "slow-version");
	writeFileSync(version, "1.0.0");
	script(join(bin, "slow"), `read -r v < "${version}"; echo "slow $v"`);
	script(join(bin, "slow-up"), `sleep 0.6; echo 1.1.0 > "${version}"`);
	script(join(bin, "fd"), 'echo "fd 10.5.1"');
	script(join(t.dir, "tar-fd", "fd"), 'echo "fd 10.5.2"');
	const tarball = join(t.dir, "fd.tar.gz");
	await realRun(t.paths)(["tar", "czf", tarball, "-C", join(t.dir, "tar-fd"), "."]);
	const tar = new Uint8Array(readFileSync(tarball));
	const fetched: { slowWorking: boolean }[] = [];
	let slowWorking = false;
	const fetch: FetchLike = async (url, init) => {
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
		fetched.push({ slowWorking });
		if (!hold) return new Response(tar);
		return new Promise<Response>((_, reject) =>
			init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
		);
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
	const fd: AppState[] = [];
	engine.subscribe((e: EngineEvent) => {
		if (e.type !== "app") return;
		if (e.app.key === "slow") slowWorking = e.app.status === "working";
		if (e.app.key === "fd") fd.push(e.app);
	});
	await engine.check();
	return { engine, fetched, fd, file: dlPath(t.paths, "fd", ASSET) };
}

test("a release app behind a slow one downloads while it works, waits marked, and skips its download at its turn", async () => {
	const { engine, fetched, fd } = await setup();
	expect(await engine.install(["slow", "fd"])).toEqual({ started: true });
	await engine.idle();
	expect(fetched).toEqual([{ slowWorking: true }]);
	expect(fd.some((a) => a.status === "queued" && a.downloaded)).toBe(true);
	// At its turn the download stage goes from its start straight to full.
	const pcts = fd.filter((a) => a.status === "working" && a.stage === "download").map((a) => a.stagePct);
	expect(pcts.at(-1)).toBe(100);
	expect(pcts.filter((p) => p !== 0 && p !== 100)).toEqual([]);
	expect(engine.snapshot().run.results.map((r) => [r.key, r.result])).toEqual([
		["slow", "updated"],
		["fd", "updated"],
	]);
	expect(engine.snapshot().apps.find((a) => a.key === "fd")?.downloaded).toBeUndefined();
});

test("Stop while the first app works stops the early download, deletes its file, and the row is ready", async () => {
	const { engine, fetched, file } = await setup(true);
	let stopped = false;
	engine.subscribe((e) => {
		if (!stopped && e.type === "log" && e.line.text.includes("ahead of its turn")) {
			stopped = true;
			engine.stopAfterCurrent();
		}
	});
	await engine.install(["slow", "fd"]);
	await engine.idle();
	expect(stopped).toBe(true);
	expect(fetched).toHaveLength(1);
	expect(existsSync(file)).toBe(false);
	expect(engine.snapshot().run.results.map((r) => r.key)).toEqual(["slow"]);
	const fd = engine.snapshot().apps.find((a) => a.key === "fd");
	expect(fd?.status).toBe("ready");
	expect(fd?.downloaded).toBeUndefined();
});

test("a file fetched ahead that no longer matches at its turn is downloaded again", async () => {
	const { engine, fetched, fd, file } = await setup();
	let cut = false;
	engine.subscribe((e) => {
		if (!cut && e.type === "app" && e.app.key === "fd" && e.app.downloaded) {
			cut = true;
			writeFileSync(file, "cut short");
		}
	});
	await engine.install(["slow", "fd"]);
	await engine.idle();
	expect(cut).toBe(true);
	expect(fetched).toEqual([{ slowWorking: true }, { slowWorking: false }]);
	expect(fd.at(-1)?.status).toBe("done");
});

test("while the first app downloads its own file, nothing behind it starts; once it moves on, the next one does", async () => {
	writeFileSync(
		join(t.dir, "seed.toml"),
		`
[apps.boom]
name = "Boom"
kind = "file"
repo = "o/boom"
asset = 'boom$'
dest = "~/.local/bin/boom"

[apps.fd]
name = "fd"
kind = "file"
repo = "o/fd"
asset = 'fd$'
dest = "~/.local/bin/fd"
`,
	);
	const bin = join(t.paths.home, ".local/bin");
	script(join(bin, "boom"), 'echo "boom 1.0.0"');
	script(join(bin, "fd"), 'echo "fd 10.5.1"');
	const files: Record<string, Uint8Array<ArrayBuffer>> = {
		// The new boom takes 0.3 s to answer its version, so its verify stage lasts that long.
		boom: new TextEncoder().encode('#!/bin/sh\nsleep 0.3\necho "boom 1.1.0"\n'),
		fd: new TextEncoder().encode('#!/bin/sh\necho "fd 10.5.2"\n'),
	};
	const tags: Record<string, string> = { boom: "v1.1.0", fd: "v10.5.2" };
	let letBoom = () => {};
	const asked: string[] = [];
	/** boom's status and stage at the moment fd's file is asked for. */
	let boomNow = "";
	const boomAtFd: string[] = [];
	const fetch: FetchLike = async (url) => {
		const latest = /repos\/o\/(\w+)\/releases\/latest$/.exec(url);
		if (latest) {
			const name = latest[1] ?? "";
			const body = files[name] ?? new Uint8Array();
			return Response.json({
				tag_name: tags[name],
				html_url: `https://github.com/o/${name}/releases/tag/${tags[name]}`,
				published_at: "2026-11-09T00:00:00Z",
				body: "",
				assets: [{ name, browser_download_url: `https://dl.test/${name}`, size: body.length, digest: null }],
			});
		}
		const name = url.replace("https://dl.test/", "");
		const body = files[name];
		if (!body) return new Response("missing", { status: 404 });
		asked.push(name);
		if (name === "fd") boomAtFd.push(boomNow);
		if (name === "boom") await new Promise<void>((r) => (letBoom = r));
		return new Response(body);
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
	engine.subscribe((e) => {
		if (e.type === "app" && e.app.key === "boom") boomNow = `${e.app.status} ${e.app.stage ?? ""}`.trim();
	});
	expect(await engine.install(["boom", "fd"])).toEqual({ started: true });
	await until(() => asked.length > 0);
	await Bun.sleep(100);
	// boom's own download is held: the line is its own, so fd has not been asked for.
	expect(asked).toEqual(["boom"]);
	letBoom();
	await engine.idle();
	expect(asked).toEqual(["boom", "fd"]);
	// fd came down while boom was past its own download, not at fd's turn.
	expect(boomAtFd).toHaveLength(1);
	expect(boomAtFd[0]).toMatch(/^working (backup|install|verify)$/);
	expect(engine.snapshot().run.results.map((r) => [r.key, r.result])).toEqual([
		["boom", "updated"],
		["fd", "updated"],
	]);
});
