import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { AppSpec } from "../../shared/types";
import type { FetchLike } from "../github";
import { DEFAULT_SETTINGS } from "../store";
import { realRun, script, tempHome } from "../testkit";
import type { KindCtx } from "./context";
import { checkRelease, isBad } from "./release";

type Rel = { tag: string; prerelease?: boolean; file?: string };

let t: ReturnType<typeof tempHome>;
let lines: string[] = [];
/** The release list, newest first; releases/latest answers latest, and asking for the list fails when it is null. */
let list: Rel[] | null = [];
let latest = "v2.4.1";
let asked: string[] = [];
beforeEach(() => {
	t = tempHome("release-bad");
	lines = [];
	asked = [];
	latest = "v2.4.1";
	list = [{ tag: "v2.4.1" }, { tag: "v2.5.0-rc.1", prerelease: true }, { tag: "v2.4.0" }, { tag: "v2.3.0" }];
});
afterEach(() => t.cleanup());

/** A release body in GitHub's shape, with one file that has a digest, so no checksum file is asked for. */
const body = (r: Rel) => ({
	tag_name: r.tag,
	prerelease: r.prerelease === true,
	html_url: `https://github.com/o/tool/releases/tag/${r.tag}`,
	published_at: "2026-11-09T00:00:00Z",
	body: "",
	assets: [
		{
			name: r.file ?? "tool-linux",
			browser_download_url: `https://dl.test/${r.tag}/tool-linux`,
			size: 10,
			digest: `sha256:${"0".repeat(64)}`,
		},
	],
});

const fetch: FetchLike = async (url) => {
	asked.push(url);
	const api = "https://api.github.com/repos/o/tool/releases";
	if (url === `${api}/latest`) return Response.json(body({ tag: latest }));
	if (url === `${api}?per_page=10`) return list ? Response.json(list.map(body)) : new Response("{}", { status: 500 });
	return new Response("{}", { status: 404 });
};

function ctx(): KindCtx {
	return {
		paths: t.paths,
		run: realRun(t.paths),
		fetch,
		token: null,
		settings: DEFAULT_SETTINGS,
		log: (l) => lines.push(l),
		stage: () => {},
	};
}

const tool = (extra: Partial<AppSpec> = {}): AppSpec => ({
	key: "tool",
	name: "Tool",
	kind: "file",
	repo: "o/tool",
	asset: "tool-linux$",
	dest: "~/.local/bin/tool",
	bad_versions: ["2.4.1"],
	bad_reason: "crashes on start under Wayland",
	...extra,
});

const installed = (v: string) => script(join(t.paths.home, ".local/bin/tool"), `echo "tool ${v}"`);
const PASSED = "2.4.1 is marked as a bad version, so Upkeep passes over it: crashes on start under Wayland";

test("isBad matches a listed version by its version or tag, with or without a v", () => {
	expect(isBad({ bad_versions: ["2.4.1"] }, { tag: "v2.4.1", version: "2.4.1" })).toBe(true);
	expect(isBad({ bad_versions: ["v2.4.1"] }, { tag: "2.4.1", version: "2.4.1" })).toBe(true);
	expect(isBad({ bad_versions: ["nightly-3"] }, { tag: "nightly-3", version: null })).toBe(true);
	expect(isBad({ bad_versions: ["2.4"] }, { tag: "v2.4.1", version: "2.4.1" })).toBe(false);
	expect(isBad({}, { tag: "v2.4.1", version: "2.4.1" })).toBe(false);
});

test("a bad latest is passed over for the newest stable release that is not listed, and says why", async () => {
	installed("2.3.0");
	expect(await checkRelease(tool(), ctx())).toMatchObject({
		installed: "2.3.0",
		latest: "2.4.0",
		status: "ready",
		detail: PASSED,
		target: { version: "2.4.0", tag: "v2.4.0" },
	});
	expect(lines).toContain("v2.4.1 is listed in bad_versions: crashes on start under Wayland");
	// A table that follows pre-releases takes the candidate instead.
	expect(await checkRelease(tool({ prerelease: true }), ctx())).toMatchObject({ latest: "2.5.0-rc.1" });
});

test("with nothing newer than the installed copy left, the row rests where it is and never offers the bad version", async () => {
	installed("2.4.0");
	expect(await checkRelease(tool(), ctx())).toMatchObject({ installed: "2.4.0", status: "fresh", detail: PASSED });
	// Every release listed bad, or a list that cannot be read: nothing to offer, and no target.
	const none = await checkRelease(tool({ bad_versions: ["2.4.1", "2.4.0", "2.3.0"] }), ctx());
	expect(none).toMatchObject({ installed: "2.4.0", latest: "2.4.0", status: "fresh", detail: PASSED });
	expect(none?.target).toBeUndefined();
	list = null;
	expect((await checkRelease(tool(), ctx()))?.target).toBeUndefined();
});

test("a listed version that is not the latest costs no list request, and a missing copy with none to offer is a problem", async () => {
	installed("2.3.0");
	latest = "v2.4.0";
	expect(await checkRelease(tool(), ctx())).toMatchObject({ latest: "2.4.0", status: "ready" });
	expect(asked.some((u) => u.includes("per_page"))).toBe(false);
	latest = "v2.4.1";
	list = null;
	const missing = await checkRelease(tool({ dest: "~/.local/bin/absent", install_if_missing: true }), ctx());
	expect(missing).toMatchObject({ installed: null, status: "problem", detail: PASSED });
});
