import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	compareRefs,
	type Failure,
	type FetchLike,
	fetchRelease,
	githubToken,
	isFailure,
	jsonVersion,
	latestFromSource,
	parseRepoSearch,
	pickAsset,
	type Release,
} from "./github";
import type { Run } from "./run";

const RELEASE = {
	tag_name: "v10.5.2",
	html_url: "https://github.com/sharkdp/fd/releases/tag/v10.5.2",
	published_at: "2026-11-01T10:00:00Z",
	body: "Fixes.",
	assets: [
		{ name: "fd-v10.5.2-x86_64-unknown-linux-gnu.tar.gz.sha256", browser_download_url: "u0", size: 90, digest: null },
		{ name: "fd-v10.5.2-x86_64-unknown-linux-gnu.tar.gz", browser_download_url: "u1", size: 1000, digest: "sha256:ab" },
		{ name: "fd-v10.5.2-x86_64-unknown-linux-gnu.tar.gz.sig", browser_download_url: "u2", size: 9, digest: null },
		{ name: "fd-v10.5.2-x86_64-unknown-linux-musl.tar.gz", browser_download_url: "u3", size: 999, digest: null },
	],
};

const loggedOut: Run = async () => ({ code: 1, stdout: "", stderr: "not logged in", timedOut: false });
const down: FetchLike = async () => {
	throw new Error("offline");
};

let dir = "";
let server: ReturnType<typeof Bun.serve>;
let hits: { url: string; headers: Headers }[] = [];
let mode: "ok" | "rate" | "rate-body" | "notes" | "missing" = "ok";

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch(req) {
			hits.push({ url: req.url, headers: req.headers });
			const rate = { "x-ratelimit-limit": "60", "x-ratelimit-remaining": mode === "rate" ? "0" : "41" };
			if (mode === "rate")
				return new Response('{"message":"limit"}', {
					status: 403,
					headers: { ...rate, "x-ratelimit-reset": "1800000000" },
				});
			if (mode === "rate-body")
				return new Response('{"message":"API rate limit exceeded for 1.2.3.4."}', { status: 403, headers: rate });
			if (mode === "notes")
				return new Response(JSON.stringify({ ...RELEASE, body: "Handles API rate limit exceeded answers." }), {
					headers: { ...rate, etag: '"e2"' },
				});
			if (mode === "missing") return new Response('{"message":"Not Found"}', { status: 404, headers: rate });
			if (req.headers.get("if-none-match") === '"e1"') return new Response(null, { status: 304, headers: rate });
			return new Response(JSON.stringify(RELEASE), { headers: { ...rate, etag: '"e1"' } });
		},
	});
});
afterAll(() => {
	server.stop(true);
});
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "upkeep-github-"));
	hits = [];
	mode = "ok";
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const api = () => `http://127.0.0.1:${server.port}`;

test("fetchRelease reads the release, caches it, and revalidates with the etag", async () => {
	const rates: number[] = [];
	const opts = { cacheDir: dir, fetch, api: api(), onRate: (r: { remaining: number }) => rates.push(r.remaining) };
	const first = await fetchRelease("sharkdp/fd", opts);
	if (isFailure(first)) throw new Error(first.detail);
	expect(first.tag).toBe("v10.5.2");
	expect(first.version).toBe("10.5.2");
	expect(first.publishedAt).toBe("2026-11-01T10:00:00Z");
	expect(first.assets[1]).toEqual({ name: RELEASE.assets[1]?.name ?? "", url: "u1", size: 1000, digest: "sha256:ab" });
	expect(await Bun.file(join(dir, "sharkdp__fd.json")).exists()).toBe(true);
	const second = await fetchRelease("sharkdp/fd", opts);
	expect(hits[1]?.headers.get("if-none-match")).toBe('"e1"');
	expect(second).toEqual(first);
	expect(rates).toEqual([41, 41]);
});

test("a 403 with no budget left is a rate failure, never up to date", async () => {
	mode = "rate";
	const r = await fetchRelease("sharkdp/fd", { cacheDir: dir, fetch, api: api() });
	expect(r).toEqual({
		failure: "rate",
		detail: "GitHub's request limit is used up. Try again after it resets.",
		resetAt: new Date(1800000000 * 1000).toISOString(),
	});
});

test("a body that says the rate limit was exceeded is a rate failure", async () => {
	mode = "rate-body";
	const r = await fetchRelease("sharkdp/fd", { cacheDir: dir, fetch, api: api() });
	expect(isFailure(r) && r.failure).toBe("rate");
});

test("a release whose notes quote the rate limit phrase is a release, and its cache is written", async () => {
	mode = "notes";
	const r = await fetchRelease("sharkdp/fd", { cacheDir: dir, fetch, api: api() });
	expect(isFailure(r)).toBe(false);
	expect(readdirSync(dir)).toEqual(["sharkdp__fd.json"]);
});

test("a corrupt cached body answered by a 304 is dropped so the next check starts clean", async () => {
	writeFileSync(join(dir, "sharkdp__fd.json"), JSON.stringify({ etag: '"e1"', body: "not json" }));
	const r = await fetchRelease("sharkdp/fd", { cacheDir: dir, fetch, api: api() });
	expect(isFailure(r) && r.failure).toBe("http");
	expect(readdirSync(dir)).toEqual([]);
});

test("a 404 is a failure with the status", async () => {
	mode = "missing";
	const r = await fetchRelease("a/b", { cacheDir: dir, fetch, api: api() });
	expect(r).toEqual({ failure: "http", detail: "GitHub answered 404 for a/b." });
});

test("the token goes to api.github.com and nowhere else", async () => {
	await fetchRelease("sharkdp/fd", { cacheDir: dir, fetch, api: api(), token: "secret" });
	expect(hits[0]?.headers.get("authorization")).toBeNull();
	const seen: { url: string; auth: string | null }[] = [];
	const fake: FetchLike = async (url, init) => {
		seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
		return new Response(JSON.stringify(RELEASE));
	};
	await fetchRelease("sharkdp/fd", { cacheDir: dir, fetch: fake, token: "secret" });
	expect(seen).toEqual([{ url: "https://api.github.com/repos/sharkdp/fd/releases/latest", auth: "Bearer secret" }]);
});

test("pickAsset skips checksum and signature files and counts matches", () => {
	const release: Release = {
		tag: "v1.0",
		version: "1.0",
		url: "",
		publishedAt: "",
		notes: "",
		assets: RELEASE.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size, digest: a.digest })),
	};
	expect(pickAsset(release, "x86_64-unknown-linux-gnu\\.tar\\.gz")).toEqual({
		asset: { name: "fd-v10.5.2-x86_64-unknown-linux-gnu.tar.gz", url: "u1", size: 1000, digest: "sha256:ab" },
		count: 1,
		names: ["fd-v10.5.2-x86_64-unknown-linux-gnu.tar.gz"],
	});
	expect(pickAsset(release, "linux")?.count).toBe(2);
	expect(pickAsset(release, "\\.zsync$")).toBeNull();
});

test("githubToken trims gh's answer and is null when gh fails", async () => {
	const calls: string[][] = [];
	const ok: Run = async (argv) => {
		calls.push(argv);
		return { code: 0, stdout: "gho_abc\n", stderr: "", timedOut: false };
	};
	expect(await githubToken(ok)).toBe("gho_abc");
	expect(calls).toEqual([["gh", "auth", "token"]]);
	expect(await githubToken(loggedOut)).toBeNull();
});

test("latestFromSource reads npm, PyPI and GitHub", async () => {
	const urls: string[] = [];
	const fake: FetchLike = async (url) => {
		urls.push(url);
		if (url.includes("npmjs")) return Response.json({ version: "2.1.400" });
		if (url.includes("pypi")) return Response.json({ info: { version: "0.9.1" } });
		return Response.json(RELEASE);
	};
	const opts = { cacheDir: dir, fetch: fake };
	expect(await latestFromSource("npm:@anthropic-ai/claude-code", opts)).toEqual({ version: "2.1.400" });
	expect(await latestFromSource("pypi:headroom-ai", opts)).toEqual({ version: "0.9.1" });
	const gh = await latestFromSource("github:sharkdp/fd", opts);
	expect("version" in gh && gh.version).toBe("10.5.2");
	expect(urls).toEqual([
		"https://registry.npmjs.org/@anthropic-ai/claude-code/latest",
		"https://pypi.org/pypi/headroom-ai/json",
		"https://api.github.com/repos/sharkdp/fd/releases/latest",
	]);
	const failed = await latestFromSource("npm:x", { cacheDir: dir, fetch: down });
	expect(isFailure(failed) && failed.failure).toBe("network");
});

const answer =
	(body: unknown): FetchLike =>
	async () =>
		Response.json(body);

test("an unreachable GitHub is a network failure for a release and for a comparison, never up to date", async () => {
	const want: Failure = { failure: "network", detail: "Could not reach GitHub: offline" };
	expect(await fetchRelease("sharkdp/fd", { cacheDir: dir, fetch: down, api: api() })).toEqual(want);
	expect(await compareRefs("o/r", "abc", "main", { cacheDir: dir, fetch: down, api: api() })).toEqual(want);
});

test("npm dist-tags: offline is a network failure, and nothing at or above the installed version is a problem", async () => {
	const url = "https://registry.npmjs.org/-/package/x/dist-tags";
	expect(await latestFromSource("npm-tags:x", { cacheDir: dir, fetch: down })).toEqual({
		failure: "network",
		detail: `Could not reach ${url}: offline`,
	});
	const old = answer({ latest: "1.0.0", next: "1.1.0-rc.1" });
	expect(await latestFromSource("npm-tags:x", { cacheDir: dir, fetch: old, installed: "2.0.0" })).toEqual({
		failure: "http",
		detail: "No published version at or above 2.0.0.",
	});
	expect(await latestFromSource("npm-tags:x", { cacheDir: dir, fetch: answer({}) })).toEqual({
		failure: "http",
		detail: `${url} sent no version.`,
	});
	expect(await latestFromSource("npm-tags:x", { cacheDir: dir, fetch: old, installed: "1.0.0" })).toEqual({
		version: "1.0.0",
	});
});

test("a version source with an unknown scheme is refused without a request", async () => {
	expect(await latestFromSource("cargo:fd", { cacheDir: dir, fetch: down })).toEqual({
		failure: "http",
		detail: "Unknown version source cargo:fd.",
	});
});

test("a search item without a string name, full name and star count is dropped", () => {
	const body = {
		items: [
			{ name: "fd", full_name: "sharkdp/fd", stargazers_count: 40000 },
			null,
			{ name: "fd", full_name: "x/fd" },
			{ name: 3, full_name: "y/fd", stargazers_count: 9 },
		],
	};
	expect(parseRepoSearch(body)).toEqual([{ name: "fd", fullName: "sharkdp/fd", stars: 40000 }]);
	expect(parseRepoSearch({ items: "none" })).toEqual([]);
	expect(parseRepoSearch(null)).toEqual([]);
});

test("a tagged release has a cache file of its own, and two tags never share one", async () => {
	const opts = { cacheDir: dir, fetch, api: api() };
	await fetchRelease("sharkdp/fd", { ...opts, tag: "v1/2" });
	await fetchRelease("sharkdp/fd", { ...opts, tag: "v1_2" });
	expect(hits.map((h) => new URL(h.url).pathname)).toEqual([
		"/repos/sharkdp/fd/releases/tags/v1%2F2",
		"/repos/sharkdp/fd/releases/tags/v1_2",
	]);
	expect(readdirSync(dir).toSorted()).toEqual(["sharkdp__fd@v1%2F2.json", "sharkdp__fd@v1_2.json"]);
});

test("a json: source gives the version and its one download; anything off is a failure, never up to date", async () => {
	const url = "https://api2.example.test/updates/linux-x64/app";
	const dl = "https://downloads.example.test/production/abc/linux/x64/Cursor-3.29.15-x86_64.AppImage";
	expect(
		await latestFromSource(`json:${url}`, { cacheDir: dir, fetch: answer({ version: "3.29.15", downloadUrl: dl }) }),
	).toEqual({
		version: "3.29.15",
		release: {
			tag: "3.29.15",
			version: "3.29.15",
			url: "",
			publishedAt: "",
			notes: "",
			assets: [{ name: "Cursor-3.29.15-x86_64.AppImage", url: dl, size: 0, digest: null }],
		},
	});
	const none: Failure = { failure: "http", detail: `${url} sent no version.` };
	const bad = [
		{ version: "3.29.15" },
		{ downloadUrl: dl },
		{ version: "1", downloadUrl: "http://x.test/a" },
		{ version: "1", downloadUrl: "not a url" },
		[],
	];
	const answers = await Promise.all(
		bad.map((body) => latestFromSource(`json:${url}`, { cacheDir: dir, fetch: answer(body) })),
	);
	expect(answers).toEqual(bad.map(() => none));
	expect(
		await latestFromSource(`json:${url}`, { cacheDir: dir, fetch: async () => new Response("", { status: 500 }) }),
	).toEqual({
		failure: "http",
		detail: `${url} answered 500.`,
	});
	const offline = await latestFromSource(`json:${url}`, { cacheDir: dir, fetch: down });
	expect(isFailure(offline) && offline.failure).toBe("network");
});

test("a json: answer that is not JSON is the source's failure, not the network's", async () => {
	const url = "https://api.example.test/x";
	expect(await latestFromSource(`json:${url}`, { cacheDir: dir, fetch: async () => new Response("<html>") })).toEqual({
		failure: "http",
		detail: `${url} sent no version.`,
	});
	expect(jsonVersion('{"engines": {"version": "1"}, "version": " 2.0 "}')).toBe("2.0");
	expect(jsonVersion("not json")).toBeUndefined();
});
