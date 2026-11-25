import { DEFAULT_SETTINGS } from "../store";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { AppSpec } from "../../shared/types";
import type { FetchLike } from "../github";
import { ok, script, strictRun, tempHome } from "../testkit";
import type { KindCtx } from "./context";
import { checkSource, tagCommitOf } from "./source";

let t: ReturnType<typeof tempHome>;
let release: Record<string, unknown> = {};
let comparison: Record<string, unknown> | null = null;
let fetched: string[] = [];
beforeEach(() => {
	t = tempHome("source-check");
	release = { tag_name: "v0.9.0", html_url: "https://github.com/o/srv/releases/tag/v0.9.0", body: "Notes." };
	comparison = null;
	fetched = [];
});
afterEach(() => t.cleanup());

const commits = Array.from({ length: 30 }, (_, i) => ({ sha: `c${i}`, commit: { message: `title ${i}\nbody` } }));

const fakeFetch: FetchLike = async (url) => {
	fetched.push(url);
	if (url.endsWith("/releases/latest")) return Response.json(release);
	if (url.includes("/compare/"))
		return comparison ? Response.json(comparison) : new Response('{"message":"Not Found"}', { status: 404 });
	if (url.includes("/commits?")) return Response.json(commits);
	if (url.endsWith("/dist-tags")) return Response.json({ latest: "0.2.2-rc.1", alpha: "0.2.2-alpha.3" });
	return new Response("", { status: 404 });
};

const PROBE = ["sh", "-c", "print the installed version"];
const COMMIT = ["sh", "-c", "print the built commit"];

function ctx(answers: Record<string, string | null>) {
	const { run, calls } = strictRun((argv) => {
		const out = answers[argv.join(" ")];
		// A remote that does not answer leaves the tag's commit unread, which every older case expects.
		if (out === undefined && argv.includes("ls-remote")) return { code: 128, stdout: "", stderr: "", timedOut: false };
		if (out === undefined) return undefined;
		return out === null ? { code: 127, stdout: "", stderr: "", timedOut: false } : ok(out);
	});
	const c: KindCtx = {
		paths: t.paths,
		run,
		fetch: fakeFetch,
		token: null,
		settings: DEFAULT_SETTINGS,
		log: () => {},
		stage: () => {},
	};
	return { c, calls };
}

const srv = (extra: Partial<AppSpec> = {}): AppSpec => ({
	key: "srv",
	name: "Server",
	kind: "source",
	repo: "o/srv",
	dir: "~/srv",
	build: ["make"],
	check: PROBE,
	commit: COMMIT,
	...extra,
});

const A = "a".repeat(40);
const B = "b".repeat(40);
const LS_DIR = (home: string) =>
	["git", "-C", `${home}/srv`, "ls-remote", "origin", "refs/tags/v0.9.0", "refs/tags/v0.9.0^{}"].join(" ");

test("a release ahead of the built commit is ready and carries the newest commits", async () => {
	comparison = { status: "ahead", ahead_by: 569 };
	// An annotated tag: the peeled ^{} line is the commit the build must find.
	const { c, calls } = ctx({
		[PROBE.join(" ")]: "f2918cabb\n",
		[COMMIT.join(" ")]: "f2918cabb\n",
		[LS_DIR(t.paths.home)]: `${A}\trefs/tags/v0.9.0\n${B}\trefs/tags/v0.9.0^{}\n`,
	});
	const r = await checkSource(srv(), c);
	expect(r).toMatchObject({
		installed: "f2918cabb",
		latest: "0.9.0",
		status: "ready",
		ahead: 569,
		target: { from: "f2918cabb", version: "0.9.0", tag: "v0.9.0", commit: B },
		notes: "Notes.",
	});
	expect(r?.commits).toHaveLength(30);
	expect(r?.commits?.[0]).toEqual({ sha: "c0", title: "title 0" });
	expect(fetched).toContain("https://api.github.com/repos/o/srv/compare/f2918cabb...v0.9.0?per_page=1");
	expect(calls.map((x) => x.argv.join(" "))).toEqual([PROBE.join(" "), COMMIT.join(" "), LS_DIR(t.paths.home)]);
	expect(calls[1]?.opts.timeoutMs).toBe(10_000);
});

test("identical or behind is fresh; diverged is ready with its sentence", async () => {
	const answers = { [PROBE.join(" ")]: "0.9.0", [COMMIT.join(" ")]: "abc" };
	comparison = { status: "identical", ahead_by: 0 };
	expect(await checkSource(srv(), ctx(answers).c)).toMatchObject({ status: "fresh", ahead: 0, commits: [] });
	comparison = { status: "behind", ahead_by: 0 };
	expect(await checkSource(srv(), ctx(answers).c)).toMatchObject({ status: "fresh" });
	comparison = { status: "diverged", ahead_by: 2 };
	expect(await checkSource(srv(), ctx(answers).c)).toMatchObject({
		status: "ready",
		ahead: 2,
		detail: "Built from a commit that is not on the release's history.",
	});
});

test("a dotless tag shows as the latest when the row compares commits; without commit it is a problem", async () => {
	release = { tag_name: "b6912", body: "" };
	comparison = { status: "ahead", ahead_by: 3 };
	const answers = { [PROBE.join(" ")]: "f2918cabb", [COMMIT.join(" ")]: "f2918cabb" };
	expect(await checkSource(srv(), ctx(answers).c)).toMatchObject({
		latest: "b6912",
		status: "ready",
		target: { tag: "b6912" },
	});
	const { commit: _c, ...noCommit } = srv();
	expect(await checkSource(noCommit, ctx(answers).c)).toMatchObject({
		status: "problem",
		detail: "The latest tag b6912 is not a tracked version.",
	});
});

test("without commit, a newer release is ready by version; an absent check leaves the row out", async () => {
	const { commit: _c, ...spec } = srv();
	release = { tag_name: "v1.9.6" };
	expect(await checkSource(spec, ctx({ [PROBE.join(" ")]: "1.9.5" }).c)).toMatchObject({
		installed: "1.9.5",
		latest: "1.9.6",
		status: "ready",
	});
	release = { tag_name: "v1.9.5" };
	expect(await checkSource(spec, ctx({ [PROBE.join(" ")]: "1.9.5" }).c)).toMatchObject({ status: "fresh" });
	expect(await checkSource(spec, ctx({ [PROBE.join(" ")]: null }).c)).toBeNull();
});

test("npm-tags gets the installed version; an unknown commit and an unreadable one are problems", async () => {
	const { commit: _c, repo: _r, ...spec } = srv({ latest: "npm-tags:pkg" });
	expect(await checkSource(spec, ctx({ [PROBE.join(" ")]: "0.2.2-alpha.3" }).c)).toMatchObject({
		installed: "0.2.2-alpha.3",
		latest: "0.2.2-rc.1",
		status: "ready",
	});
	comparison = null;
	expect(await checkSource(srv(), ctx({ [PROBE.join(" ")]: "f00", [COMMIT.join(" ")]: "f00" }).c)).toMatchObject({
		status: "problem",
		detail: "GitHub does not know f00 in o/srv.",
	});
	expect(await checkSource(srv(), ctx({ [PROBE.join(" ")]: "f00", [COMMIT.join(" ")]: "" }).c)).toMatchObject({
		status: "problem",
		detail: "Could not read the commit the installed copy was built from.",
	});
});

test("the check's first line is the version as written: prereleases compare in full, an empty first line is unknown", async () => {
	const { commit: _c, repo: _r, ...spec } = srv({ latest: "npm-tags:pkg" });
	expect(await checkSource(spec, ctx({ [PROBE.join(" ")]: "0.2.2-rc.1\n" }).c)).toMatchObject({
		installed: "0.2.2-rc.1",
		latest: "0.2.2-rc.1",
		status: "fresh",
	});
	for (const out of ["\n0.2.2", "   \n0.2.2", "  "])
		// oxlint-disable-next-line no-await-in-loop -- one case at a time, each with its own runner
		expect(await checkSource(spec, ctx({ [PROBE.join(" ")]: out }).c)).toMatchObject({
			installed: null,
			status: "problem",
			detail: "Version probe failed: The version probe printed nothing.",
		});
});

test("a source row without check takes the old path and probes dest", async () => {
	release = { tag_name: "3.6a" };
	const dest = script(`${t.dir}/tmux`, "exit 0");
	// A lightweight tag has only its own line, which is the commit.
	const ls = ["git", "ls-remote", "https://github.com/tmux/tmux.git", "refs/tags/3.6a", "refs/tags/3.6a^{}"];
	const { c, calls } = ctx({ [`${dest} --version`]: "tmux 3.6", [ls.join(" ")]: `${A}\trefs/tags/3.6a\n` });
	const r = await checkSource(
		{ key: "tmux", name: "tmux", kind: "source", repo: "tmux/tmux", dest, build: ["make"] },
		c,
	);
	expect(r).toMatchObject({ installed: "3.6", latest: "3.6a", status: "ready", target: { commit: A } });
	expect(calls.map((x) => x.argv)).toEqual([[dest, "--version"], ls]);
});

test("tagCommitOf reads the peeled commit first, else the tag's own line, and nothing that is not a hash", () => {
	expect(tagCommitOf(`${A}\trefs/tags/v1\n${B}\trefs/tags/v1^{}\n`, "v1")).toBe(B);
	expect(tagCommitOf(`${A}\trefs/tags/v1\n`, "v1")).toBe(A);
	expect(tagCommitOf(`${A}\trefs/tags/v10\n`, "v1")).toBeNull();
	expect(tagCommitOf("nothing\trefs/tags/v1\n", "v1")).toBeNull();
	expect(tagCommitOf("", "v1")).toBeNull();
});

test("a stage row reads no tag commit, and a row that is fresh asks no remote", async () => {
	const { c, calls } = ctx({ [PROBE.join(" ")]: "0.8.0\n" });
	const staged = await checkSource(srv({ dir: undefined, stage: "~/stage", commit: undefined }), c);
	expect(staged?.status).toBe("ready");
	expect(staged?.target?.commit).toBeUndefined();
	const fresh = ctx({ [PROBE.join(" ")]: "0.9.0\n" });
	expect((await checkSource(srv({ commit: undefined }), fresh.c))?.status).toBe("fresh");
	expect(fresh.calls.some((x) => x.argv.includes("ls-remote"))).toBe(false);
	expect(calls.some((x) => x.argv.includes("ls-remote"))).toBe(false);
});

test("a bad latest whose release list cannot be read is a problem, not a pass", async () => {
	const { c } = ctx({ [PROBE.join(" ")]: "0.8.0\n" });
	const r = await checkSource(srv({ commit: undefined, bad_versions: ["0.9.0"], bad_reason: "eats data" }), c);
	expect(r).toMatchObject({ installed: "0.8.0", latest: null, status: "problem", offline: false });
	expect(r?.detail).not.toContain("bad version");
});
