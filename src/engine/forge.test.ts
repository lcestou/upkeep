import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import codebergRelease from "./fixtures/codeberg_forgejo_forgejo.json";
import gitlabRelease from "./fixtures/gitlab-org_gitlab-runner.json";
import { cloneUrl, forgeOf, forgeRelease, linksRelease, pageLinks, zsyncHeader, zsyncRelease } from "./forge";
import { type Failure, type FetchLike, isFailure, type Release, type ReleaseOpts } from "./github";
import { tempHome } from "./testkit";

let t: ReturnType<typeof tempHome>;
let sent: { url: string; headers: Headers }[] = [];
beforeEach(() => {
	t = tempHome("forge");
	sent = [];
});
afterEach(() => t.cleanup());

const helloPage = readFileSync(join(import.meta.dir, "fixtures/gnu-hello-index.html"), "utf8");

/** A fetch that records each request and answers with what answer gives for its URL. */
function recording(answer: (url: string, headers: Headers) => Response): FetchLike {
	return async (url, init) => {
		const headers = new Headers(init?.headers);
		sent.push({ url, headers });
		return answer(url, headers);
	};
}

const opts = (fetch: FetchLike, more: Partial<ReleaseOpts> = {}): ReleaseOpts => ({
	cacheDir: join(t.paths.cache, "github"),
	token: "gho_secret",
	fetch,
	...more,
});

/** The release, or a thrown error naming the failure, so a test reads its fields directly. */
function ok(r: Release | Failure): Release {
	if (isFailure(r)) throw new Error(r.detail);
	return r;
}

test("repo forms: owner/name is GitHub, a known host needs no forge, any other host must name one", () => {
	expect(forgeOf("sharkdp/fd")).toEqual({ kind: "github", host: "github.com", path: "sharkdp/fd" });
	expect(forgeOf("github.com/sharkdp/fd")).toEqual({ kind: "github", host: "github.com", path: "sharkdp/fd" });
	expect(forgeOf("gitlab.com/group/sub/project")).toEqual({
		kind: "gitlab",
		host: "gitlab.com",
		path: "group/sub/project",
	});
	expect(forgeOf("Codeberg.org/forgejo/forgejo")).toEqual({
		kind: "gitea",
		host: "codeberg.org",
		path: "forgejo/forgejo",
	});
	expect(forgeOf("git.example.org/me/tool")).toBeNull();
	expect(forgeOf("git.example.org/me/tool", "gitea")).toEqual({
		kind: "gitea",
		host: "git.example.org",
		path: "me/tool",
	});
	// A forge field never overrides a known host.
	expect(forgeOf("codeberg.org/a/b", "gitlab")?.kind).toBe("gitea");
	for (const bad of [
		"a/b/c",
		"gitlab.com/one",
		"codeberg.org/a/b/c",
		"gitlab.com/g/../p",
		"a b/c",
		"git.ex_ample.org/a/b",
	])
		expect(forgeOf(bad, "gitlab")).toBeNull();
	expect(cloneUrl("gitlab.com/group/sub/project")).toBe("https://gitlab.com/group/sub/project.git");
	expect(cloneUrl("tmux/tmux")).toBe("https://github.com/tmux/tmux.git");
});

test("GitLab: the latest release read from gitlab.com's real answer, named by each link's file, with no token sent", async () => {
	let rated = false;
	const fetch = recording(() => Response.json(gitlabRelease, { headers: { etag: 'W/"g1"' } }));
	const r = ok(
		await forgeRelease("gitlab.com/gitlab-org/gitlab-runner", undefined, opts(fetch, { onRate: () => (rated = true) })),
	);
	expect(sent[0]?.url).toBe("https://gitlab.com/api/v4/projects/gitlab-org%2Fgitlab-runner/releases/permalink/latest");
	expect(sent[0]?.headers.has("authorization")).toBe(false);
	expect(rated).toBe(false);
	expect(r).toMatchObject({
		tag: "v19.3.6",
		version: "19.3.6",
		url: "https://gitlab.com/gitlab-org/gitlab-runner/-/releases/v19.3.6",
		publishedAt: "2026-11-06T12:11:01.468Z",
	});
	expect(r.assets.map((a) => a.name)).toContain("gitlab-runner_amd64.deb");
	expect(r.assets.find((a) => a.name === "gitlab-runner-linux-amd64")).toEqual({
		name: "gitlab-runner-linux-amd64",
		url: "https://gitlab.com/gitlab-org/gitlab-runner/-/releases/v19.3.6/downloads/binaries/gitlab-runner-linux-amd64",
		size: 0,
		digest: null,
	});
	// The etag is sent back, and an unchanged release is read from the cache.
	const again = recording(() => new Response(null, { status: 304 }));
	expect(ok(await forgeRelease("gitlab.com/gitlab-org/gitlab-runner", undefined, opts(again))).tag).toBe("v19.3.6");
	expect(sent[1]?.headers.get("if-none-match")).toBe('W/"g1"');
});

test("GitLab: a release by tag, a link that is not https, a 404, a rate limit and an unreachable host", async () => {
	const http = {
		...gitlabRelease,
		assets: {
			links: [
				{ name: "x", url: "http://plain.example.org/x.deb" },
				{ name: "y", url: "https://ok.example.org/y.deb" },
			],
		},
	};
	const r = ok(
		await forgeRelease(
			"gitlab.com/g/p",
			undefined,
			opts(
				recording(() => Response.json(http)),
				{ tag: "v1.0+b" },
			),
		),
	);
	expect(sent[0]?.url).toBe("https://gitlab.com/api/v4/projects/g%2Fp/releases/v1.0%2Bb");
	expect(r.assets.map((a) => a.name)).toEqual(["y.deb"]);
	expect(
		await forgeRelease("gitlab.com/g/p", undefined, opts(recording(() => new Response("{}", { status: 404 })))),
	).toEqual({
		failure: "http",
		detail: "gitlab.com answered 404 for g/p.",
	});
	expect(
		await forgeRelease(
			"gitlab.com/g/p",
			undefined,
			opts(recording(() => new Response("", { status: 429, headers: { "ratelimit-reset": "1794513420" } }))),
		),
	).toEqual({
		failure: "rate",
		detail: "gitlab.com's request limit is used up. Try again after it resets.",
		resetAt: new Date(1794513420 * 1000).toISOString(),
	});
	const down: FetchLike = async () => {
		throw new Error("connection refused");
	};
	expect(await forgeRelease("gitlab.com/g/p", undefined, opts(down))).toEqual({
		failure: "network",
		detail: "Could not reach gitlab.com: connection refused",
	});
	expect(await forgeRelease("gitlab.com/g/p", undefined, opts(recording(() => new Response("<html>"))))).toEqual({
		failure: "http",
		detail: "gitlab.com sent no release for g/p.",
	});
});

test("Codeberg and self-hosted Gitea: the latest and a tagged release from codeberg.org's real answer", async () => {
	const fetch = recording(() => Response.json(codebergRelease));
	const r = ok(await forgeRelease("codeberg.org/forgejo/forgejo", undefined, opts(fetch)));
	expect(sent[0]?.url).toBe("https://codeberg.org/api/v1/repos/forgejo/forgejo/releases/latest");
	expect(sent[0]?.headers.has("authorization")).toBe(false);
	expect(r).toMatchObject({
		tag: "v17.0.1",
		version: "17.0.1",
		url: "https://codeberg.org/forgejo/forgejo/releases/tag/v17.0.1",
	});
	expect(r.assets.find((a) => a.name === "forgejo-17.0.1-linux-amd64")).toEqual({
		name: "forgejo-17.0.1-linux-amd64",
		url: "https://codeberg.org/forgejo/forgejo/releases/download/v17.0.1/forgejo-17.0.1-linux-amd64",
		size: 122057320,
		digest: null,
	});
	// A self-hosted Gitea may hand out plain http addresses: those are never taken.
	const plain = {
		...codebergRelease,
		assets: [{ name: "tool-linux", size: 9, browser_download_url: "http://git.example.org/me/tool/tool-linux" }],
	};
	const own = ok(
		await forgeRelease(
			"git.example.org/me/tool",
			"gitea",
			opts(
				recording(() => Response.json(plain)),
				{ tag: "v2.0" },
			),
		),
	);
	expect(own.assets).toEqual([]);
	expect(sent[1]?.url).toBe("https://git.example.org/api/v1/repos/me/tool/releases/tags/v2.0");
	expect(sent[1]?.headers.has("authorization")).toBe(false); // A Gitea answer that names a GitHub API address for its file gets no signed-in way: the token never follows it.
	const named = {
		...codebergRelease,
		assets: [
			{
				name: "tool-linux",
				size: 9,
				browser_download_url: "https://git.example.org/me/tool/tool-linux",
				url: "https://api.github.com/repos/someone/private/releases/assets/1",
			},
		],
	};
	const gitea = ok(await forgeRelease("git.example.org/me/tool", "gitea", opts(recording(() => Response.json(named)))));
	expect(gitea.assets[0]?.api).toBeUndefined();
});

test("the GitHub token goes to GitHub only", async () => {
	const fetch = recording(() => Response.json({ tag_name: "v1.0.0", assets: [] }));
	await forgeRelease("sharkdp/fd", undefined, opts(fetch));
	await forgeRelease("github.com/sharkdp/fd", undefined, opts(fetch, { cacheDir: join(t.dir, "other") }));
	await forgeRelease("gitlab.com/a/b", undefined, opts(fetch));
	await forgeRelease("codeberg.org/a/b", undefined, opts(fetch));
	await forgeRelease("git.example.org/a/b", "gitlab", opts(fetch));
	await linksRelease("https://example.org/dl/", "x", opts(fetch));
	expect(sent.map((s) => [new URL(s.url).host, s.headers.get("authorization")])).toEqual([
		["api.github.com", "Bearer gho_secret"],
		["api.github.com", "Bearer gho_secret"],
		["gitlab.com", null],
		["codeberg.org", null],
		["git.example.org", null],
		["example.org", null],
	]);
});

test("links: the newest matching file on a real download page, by version, and a tagged one for a restore point", async () => {
	const page = "https://ftp.gnu.org/gnu/hello/";
	const fetch = recording(() => new Response(helloPage));
	const r = ok(await linksRelease(page, "^hello-[0-9.]+\\.tar\\.gz$", opts(fetch)));
	// 2.12.3 is newer than 2.9 and 2.12, though it sorts before them as text.
	expect(r).toEqual({
		tag: "2.12.3",
		version: "2.12.3",
		url: page,
		publishedAt: "",
		notes: "",
		assets: [
			{ name: "hello-2.12.3.tar.gz", url: "https://ftp.gnu.org/gnu/hello/hello-2.12.3.tar.gz", size: 0, digest: null },
		],
	});
	const old = ok(await linksRelease(page, "^hello-[0-9.]+\\.tar\\.gz$", opts(fetch, { tag: "2.10" })));
	expect(old.assets.map((a) => a.url)).toEqual(["https://ftp.gnu.org/gnu/hello/hello-2.10.tar.gz"]);
	expect(await linksRelease(page, "\\.AppImage$", opts(fetch))).toEqual({
		failure: "http",
		detail: "https://ftp.gnu.org/gnu/hello/ lists no download matching \\.AppImage$.",
	});
	expect(await linksRelease(page, "^hello-[0-9.]+\\.tar\\.gz$", opts(fetch, { tag: "9.9" }))).toMatchObject({
		failure: "http",
	});
	expect(await linksRelease("http://ftp.gnu.org/gnu/hello/", "x", opts(fetch))).toMatchObject({ failure: "http" });
	expect(await linksRelease(page, "x", opts(recording(() => new Response("", { status: 503 }))))).toEqual({
		failure: "http",
		detail: "https://ftp.gnu.org/gnu/hello/ answered 503.",
	});
});

test("links: hrefs resolve against the page, plain http and pages without a file are dropped, and a repeat is kept once", () => {
	const html = [
		`<a href="app-1.2.AppImage">one</a>`,
		`<A class=x HREF='../up/app-1.3.AppImage'>two</A>`,
		`<a href=https://cdn.example.org/app-1.4.AppImage?x=1&amp;y=2>three</a>`,
		`<a href="http://plain.example.org/app-9.9.AppImage">plain</a>`,
		`<a href="/dir/">dir</a>`,
		`<a href="app-1.2.AppImage">again</a>`,
	].join("\n");
	expect(pageLinks(html, "https://example.org/dl/").map((a) => a.url)).toEqual([
		"https://example.org/dl/app-1.2.AppImage",
		"https://example.org/up/app-1.3.AppImage",
		"https://cdn.example.org/app-1.4.AppImage?x=1&y=2",
	]);
});

test("links: a release wins over a prerelease of the same number, whatever the page's order; entities in hrefs decode", async () => {
	const html = `<a href="tool-2.10rc1.tar.gz">rc</a> <a href="tool-2.10.tar.gz">stable</a> <a href="dl?f=tool-2.9.tar.gz&#38;x=1">old</a>`;
	const fetch: FetchLike = async () => new Response(html, { status: 200 });
	const r = ok(await linksRelease("https://example.org/dl/", "^tool-[0-9.a-z]+\\.tar\\.gz$", opts(fetch)));
	expect(r.version).toBe("2.10");
	expect(r.assets.map((a) => a.name)).toEqual(["tool-2.10.tar.gz"]);
	// A dash prerelease is one too; a letter alone (tmux 3.6a) is a release and wins over 3.5.
	const dash = `<a href="tool-1.3.0-rc1.tar.gz">a</a> <a href="tool-1.2.0.tar.gz">b</a>`;
	const fetchDash: FetchLike = async () => new Response(dash, { status: 200 });
	expect(ok(await linksRelease("https://example.org/dl/", "^tool-.+\\.tar\\.gz$", opts(fetchDash))).version).toBe(
		"1.2.0",
	);
	const tmux = `<a href="tmux-3.5.tar.gz">a</a> <a href="tmux-3.6a.tar.gz">b</a>`;
	const fetchTmux: FetchLike = async () => new Response(tmux, { status: 200 });
	expect(ok(await linksRelease("https://example.org/dl/", "^tmux-.+\\.tar\\.gz$", opts(fetchTmux))).version).toBe(
		"3.6a",
	);
	expect(pageLinks(html, "https://example.org/dl/").map((a) => a.url)).toContain(
		"https://example.org/dl/dl?f=tool-2.9.tar.gz&x=1",
	);
});

/** The text of a .zsync file: its header, an empty line, then checksums that are not text. */
const zsyncFile = (fields: string[]) => `${fields.join("\n")}\n\n\x00\x01\x02binary`;

test("zsync: the header names the latest file, its address against the .zsync one, and its size", async () => {
	const address = "https://dl.example.org/app/App-latest-x86_64.AppImage.zsync";
	const body = zsyncFile([
		"zsync: 0.6.2",
		"Filename: App-2.3.1-x86_64.AppImage",
		"MTime: Tue, 17 Nov 2026 10:00:00 +0000",
		"Blocksize: 2048",
		"Length: 104857600",
		"URL: App-latest-x86_64.AppImage",
		"SHA-1: 0123456789abcdef0123456789abcdef01234567",
	]);
	const fetch = recording(() => new Response(body, { status: 206 }));
	expect(ok(await zsyncRelease(address, fetch))).toEqual({
		tag: "2.3.1",
		version: "2.3.1",
		url: address,
		publishedAt: "",
		notes: "",
		assets: [
			{
				name: "App-2.3.1-x86_64.AppImage",
				url: "https://dl.example.org/app/App-latest-x86_64.AppImage",
				size: 104857600,
				digest: null,
			},
		],
	});
	// Only the header is asked for, and nothing carries a token.
	expect(sent[0]?.headers.get("range")).toBe("bytes=0-8191");
	expect(sent[0]?.headers.get("authorization")).toBeNull();
	// The header stops at its empty line: a "URL:" in the checksums after it is never read.
	expect(zsyncHeader("Filename: a\n\nURL: b").has("url")).toBe(false);
});

test("zsync: a file that is not one, a plain http address, a failed answer and an unreachable host are failures", async () => {
	const address = "https://dl.example.org/app.AppImage.zsync";
	const answer = (fields: string[]) => recording(() => new Response(zsyncFile(fields)));
	const unreadable: Failure = { failure: "http", detail: `${address} is not a zsync file that names its download.` };
	expect(await zsyncRelease(address, answer(["Filename: a-1.0.AppImage", "URL: a"]))).toEqual(unreadable);
	expect(await zsyncRelease(address, answer(["zsync: 0.6.2", "URL: a"]))).toEqual(unreadable);
	// No URL line: never the .zsync file itself as the download.
	expect(await zsyncRelease(address, answer(["zsync: 0.6.2", "Filename: a-1.0.AppImage", "Length: 5000000"]))).toEqual(
		unreadable,
	);
	expect(await zsyncRelease(address, answer(["zsync: 0.6.2", "Filename: ../a-1.0.AppImage", "URL: a"]))).toEqual(
		unreadable,
	);
	// A download address that leaves https is refused, as a links: page's is.
	expect(
		await zsyncRelease(address, answer(["zsync: 0.6.2", "Filename: a-1.0.AppImage", "URL: http://dl.example.org/a"])),
	).toEqual(unreadable);
	// No version in the file name: the release has none, and a check says so. No Length: the floor holds it instead.
	const bare = ok(await zsyncRelease(address, answer(["zsync: 0.6.2", "Filename: a.AppImage", "URL: a"])));
	expect([bare.version, bare.tag, bare.assets[0]?.size]).toEqual([null, "a.AppImage", 0]);
	expect(await zsyncRelease("http://dl.example.org/a.zsync", answer([]))).toMatchObject({ failure: "http" });
	expect(
		await zsyncRelease(
			address,
			recording(() => new Response("", { status: 404 })),
		),
	).toEqual({
		failure: "http",
		detail: `${address} answered 404.`,
	});
	const down: FetchLike = async () => {
		throw new Error("connection refused");
	};
	expect(await zsyncRelease(address, down)).toEqual({
		failure: "network",
		detail: `Could not reach ${address}: connection refused`,
	});
});
