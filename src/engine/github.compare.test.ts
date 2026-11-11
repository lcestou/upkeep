import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareRefs, type FetchLike, latestFromSource, pickDistTag } from "./github";

let dir = "";
let seen: string[] = [];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "upkeep-compare-"));
	seen = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const API = "http://gh.test";
const newest = Array.from({ length: 30 }, (_, i) => ({
	sha: `${String(i).padStart(2, "0")}${"a".repeat(38)}`,
	commit: { message: `commit ${i}\n\nbody ${i}` },
}));

function gh(compare: { status: number; body?: unknown }): FetchLike {
	return async (url) => {
		seen.push(url);
		if (url.includes("/compare/"))
			return compare.status === 200
				? Response.json(compare.body)
				: new Response('{"message":"Not Found"}', { status: compare.status });
		if (url.includes("/commits?")) return Response.json(newest);
		return new Response("", { status: 404 });
	};
}
const limited: FetchLike = async () => new Response('{"message":"API rate limit exceeded"}', { status: 403 });
const opts = (fetch: FetchLike) => ({ cacheDir: dir, fetch, api: API });

test("a big gap counts from ahead_by and lists the 30 newest commits, newest first", async () => {
	const r = await compareRefs(
		"o/r",
		"f2918cabb",
		"v0.9.0",
		opts(gh({ status: 200, body: { status: "ahead", ahead_by: 569 } })),
	);
	expect(r).toMatchObject({ status: "ahead", ahead: 569 });
	if ("failure" in r) throw new Error(r.detail);
	expect(r.commits).toHaveLength(30);
	expect(r.commits[0]).toEqual({ sha: newest[0]?.sha ?? "", title: "commit 0" });
	expect(seen).toEqual([
		`${API}/repos/o/r/compare/f2918cabb...v0.9.0?per_page=1`,
		`${API}/repos/o/r/commits?sha=v0.9.0&per_page=30`,
	]);
});

test("a small gap lists exactly that many commits", async () => {
	const r = await compareRefs("o/r", "abc", "v1.1", opts(gh({ status: 200, body: { status: "ahead", ahead_by: 3 } })));
	if ("failure" in r) throw new Error(r.detail);
	expect(r.commits.map((c) => c.title)).toEqual(["commit 0", "commit 1", "commit 2"]);
});

test("identical and behind need no commit list; an unknown base is named; a rate limit is a rate failure", async () => {
	expect(
		await compareRefs("o/r", "abc", "v1", opts(gh({ status: 200, body: { status: "identical", ahead_by: 0 } }))),
	).toEqual({
		status: "identical",
		ahead: 0,
		commits: [],
	});
	expect(seen.some((u) => u.includes("/commits?"))).toBe(false);
	expect(
		await compareRefs(
			"o/r",
			"dead",
			"v1",
			opts(gh({ status: 200, body: { status: "behind", ahead_by: 0, behind_by: 4 } })),
		),
	).toMatchObject({ status: "behind", ahead: 0 });
	expect(await compareRefs("o/r", "f2918cabb", "v1", opts(gh({ status: 404 })))).toEqual({
		failure: "http",
		detail: "GitHub does not know f2918cabb in o/r.",
	});
	expect(await compareRefs("o/r", "a", "b", opts(limited))).toMatchObject({ failure: "rate" });
});

test("the token goes only to the real GitHub", async () => {
	const auth: (string | null)[] = [];
	const f: FetchLike = async (_url, init) => {
		auth.push(new Headers(init?.headers).get("authorization"));
		return Response.json({ status: "identical", ahead_by: 0 });
	};
	await compareRefs("o/r", "a", "b", { cacheDir: dir, fetch: f, api: API, token: "secret" });
	await compareRefs("o/r", "a", "b", { cacheDir: dir, fetch: f, token: "secret" });
	expect(auth).toEqual([null, "Bearer secret"]);
});

test("npm-tags picks the highest stable at or above installed, else the highest prerelease", async () => {
	const tags = { latest: "0.2.2-rc.1", alpha: "0.2.2-alpha.3", next: "0.2.2-rc.1" };
	expect(pickDistTag(tags, "0.2.2-rc.1")).toBe("0.2.2-rc.1");
	expect(pickDistTag(tags, "0.2.2-alpha.3")).toBe("0.2.2-rc.1");
	expect(pickDistTag({ ...tags, old: "0.2.1" }, "0.2.2-rc.1")).toBe("0.2.2-rc.1");
	expect(pickDistTag({ ...tags, stable: "0.2.3" }, "0.2.2-rc.1")).toBe("0.2.3");
	expect(pickDistTag({ junk: "abc", ...tags }, "0.2.2-rc.1")).toBe("0.2.2-rc.1");
	const registry: FetchLike = async (url) => {
		seen.push(url);
		return Response.json({ latest: "0.1.0" });
	};
	expect(
		await latestFromSource("npm-tags:@deepseek-ai/dsh", { cacheDir: dir, fetch: registry, installed: "0.2.2-rc.1" }),
	).toEqual({
		failure: "http",
		detail: "No published version at or above 0.2.2-rc.1.",
	});
	expect(seen).toEqual(["https://registry.npmjs.org/-/package/@deepseek-ai/dsh/dist-tags"]);
	expect(
		await latestFromSource("npm-tags:x", {
			cacheDir: dir,
			fetch: async () => Response.json(tags),
			installed: "0.2.2-alpha.3",
		}),
	).toEqual({
		version: "0.2.2-rc.1",
	});
});
