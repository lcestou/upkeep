import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSpec } from "../../shared/types";
import { listBackups } from "../backup";
import type { FetchLike } from "../github";
import type { Run } from "../run";
import { ok, realRun, recordingRun, script, tempHome } from "../testkit";
import type { KindCtx, Target } from "./context";
import { checkRelease, installRelease } from "./release";

let t: ReturnType<typeof tempHome>;
let lines: string[] = [];
/** Every request: its URL and the Authorization header it carried. */
let sent: [string, string | null][] = [];
/** Download bodies by URL. */
let files: Record<string, Uint8Array<ArrayBuffer>> = {};
/** API answers by URL. */
let api: Record<string, unknown> = {};
let page = "";

beforeEach(() => {
	t = tempHome("release-forge");
	mkdirSync(join(t.dir, "proc"));
	lines = [];
	sent = [];
	files = {};
	api = {};
	page = "";
});
afterEach(() => t.cleanup());

/** Over download.ts's floor: GitLab and a links page list no size, so a smaller file would be refused as a cut. */
const big = (head: string) => {
	const text = new TextEncoder().encode(`#!/bin/bash\n${head}\nexit 0\n#`);
	const out = new Uint8Array(1024 * 1024 + 64);
	out.fill(0x23);
	out.set(text);
	return out;
};

const fakeFetch: FetchLike = async (url, init) => {
	sent.push([url, new Headers(init?.headers).get("authorization")]);
	if (url in api) return Response.json(api[url]);
	if (url === "https://example.org/downloads/" && page) return new Response(page);
	const body = files[url];
	return body ? new Response(body) : new Response('{"message":"404 Not Found"}', { status: 404 });
};

function ctx(run: Run = realRun(t.paths)): KindCtx {
	return {
		paths: t.paths,
		run,
		fetch: fakeFetch,
		token: "gho_secret",
		settings: {
			keepBackups: 1,
			notify: true,
			checkAtLogin: false,
			checkEvery: "6h",
			frame: "own",
			buttons: "auto",
			corners: "rounded",
			language: "system",
		},
		log: (l) => lines.push(l),
		stage: () => {},
		procRoot: join(t.dir, "proc"),
	};
}

/** A GitLab release of tag whose links point at each file, published under its own API address. */
function gitlab(path: string, tag: string, names: string[], which = "permalink/latest"): void {
	const links = names.map((name) => {
		const url = `https://gitlab.example.org/${path}/-/releases/${tag}/downloads/${name}`;
		return { name: `binary: ${name}`, url: `https://s3.example.org/${tag}/${name}`, direct_asset_url: url };
	});
	api[`https://gitlab.com/api/v4/projects/${encodeURIComponent(path)}/releases/${which}`] = {
		tag_name: tag,
		description: "Notes.",
		released_at: "2026-11-06T12:00:00Z",
		_links: { self: `https://gitlab.com/${path}/-/releases/${tag}` },
		assets: { links },
	};
}

async function target(spec: AppSpec, c: KindCtx): Promise<Target> {
	const checked = await checkRelease(spec, c);
	if (!checked?.target) throw new Error(`no target: ${JSON.stringify(checked)}`);
	return checked.target;
}

test("an AppImage on GitLab: checked and installed from the release's links, held to the floor, no token sent", async () => {
	const spec: AppSpec = {
		key: "tool",
		name: "Tool",
		kind: "appimage",
		repo: "gitlab.com/group/sub/tool",
		asset: "x86_64\\.AppImage$",
		dest: "~/.local/bin/tool.AppImage",
	};
	const dest = script(join(t.paths.home, ".local/bin/tool.AppImage"), 'echo "tool 1.0.0"');
	chmodSync(dest, 0o755);
	gitlab("group/sub/tool", "v2.0.0", ["tool-2.0.0-x86_64.AppImage", "tool-2.0.0-aarch64.AppImage"]);
	const url = "https://gitlab.example.org/group/sub/tool/-/releases/v2.0.0/downloads/tool-2.0.0-x86_64.AppImage";
	files[url] = big('echo "tool 2.0.0"');
	const c = ctx();
	expect(await checkRelease(spec, c)).toMatchObject({
		installed: "1.0.0",
		latest: "2.0.0",
		status: "ready",
		releaseUrl: "https://gitlab.com/group/sub/tool/-/releases/v2.0.0",
		notes: "Notes.",
	});
	const outcome = await installRelease(spec, await target(spec, c), c);
	expect(outcome).toMatchObject({ result: "done", installed: "2.0.0" });
	expect(readFileSync(dest, "utf8")).toStartWith('#!/bin/bash\necho "tool 2.0.0"');
	expect(sent.map(([u]) => u)).toContain(url);
	expect(sent.every(([, auth]) => auth === null)).toBe(true);
	// A cut download, below the floor, is refused rather than installed.
	files[url] = new TextEncoder().encode('#!/bin/bash\necho "tool 2.0.0"\n');
	script(dest, 'echo "tool 1.0.0"');
	const next = await target(spec, c);
	await expect(installRelease(spec, next, c)).rejects.toThrow("Download is 30 bytes, too small to be a release.");
});

test("a deb on GitLab keeps the installed version's package, read from the release of its tag", async () => {
	const dest = script(join(t.dir, "usr/bin/tool"), 'echo "1.4.2"');
	const spec: AppSpec = {
		key: "tool",
		name: "Tool",
		kind: "deb",
		repo: "gitlab.com/g/tool",
		asset: "amd64\\.deb$",
		dest,
		sudo: true,
	};
	gitlab("g/tool", "v1.4.3", ["tool_1.4.3_amd64.deb"]);
	gitlab("g/tool", "v1.4.2", ["tool_1.4.2_amd64.deb"], "v1.4.2");
	files["https://gitlab.example.org/g/tool/-/releases/v1.4.3/downloads/tool_1.4.3_amd64.deb"] = big("new");
	files["https://gitlab.example.org/g/tool/-/releases/v1.4.2/downloads/tool_1.4.2_amd64.deb"] = big("old");
	const { run } = recordingRun(t.paths, (argv) => {
		if (argv[2] !== "dpkg") return undefined;
		script(dest, 'echo "1.4.3"');
		return ok();
	});
	const c = ctx(run);
	expect(await installRelease(spec, await target(spec, c), c)).toMatchObject({ result: "done", installed: "1.4.3" });
	expect(listBackups(t.paths, "tool").map((p) => p.version)).toEqual(["1.4.2"]);
	expect(sent.map(([u]) => u)).toContain("https://gitlab.com/api/v4/projects/g%2Ftool/releases/v1.4.2");
});

test("a file from a links: page: the newest matching link is checked and installed", async () => {
	const spec: AppSpec = {
		key: "tool",
		name: "Tool",
		kind: "file",
		latest: "links:https://example.org/downloads/",
		asset: "^tool-[0-9.]+-linux$",
		dest: "~/.local/bin/tool",
	};
	const dest = script(join(t.paths.home, ".local/bin/tool"), 'echo "tool 1.9.0"');
	page = ["tool-1.9.0-linux", "tool-1.10.0-linux", "tool-1.10.0-linux.sig", "tool-1.10.0-windows.exe"]
		.map((n) => `<a href="${n}">${n}</a>`)
		.join("\n");
	files["https://example.org/downloads/tool-1.10.0-linux"] = big('echo "tool 1.10.0"');
	const c = ctx();
	expect(await checkRelease(spec, c)).toMatchObject({ installed: "1.9.0", latest: "1.10.0", status: "ready" });
	expect(await installRelease(spec, await target(spec, c), c)).toMatchObject({ result: "done", installed: "1.10.0" });
	expect(readFileSync(dest, "utf8")).toStartWith('#!/bin/bash\necho "tool 1.10.0"');
	expect(sent.every(([, auth]) => auth === null)).toBe(true);
});

test("on aarch64 a table's aarch64 pattern picks the file, and a table with none is refused before any lookup", async () => {
	const spec: AppSpec = {
		key: "tool",
		name: "Tool",
		kind: "appimage",
		repo: "gitlab.com/group/sub/tool",
		asset: "x86_64\\.AppImage$",
		asset_aarch64: "aarch64\\.AppImage$",
		dest: "~/.local/bin/tool.AppImage",
	};
	script(join(t.paths.home, ".local/bin/tool.AppImage"), 'echo "tool 1.0.0"');
	gitlab("group/sub/tool", "v2.0.0", ["tool-2.0.0-x86_64.AppImage", "tool-2.0.0-aarch64.AppImage"]);
	const arm = { ...ctx(), arch: "aarch64" as const };
	expect((await target(spec, arm)).asset?.name).toBe("tool-2.0.0-aarch64.AppImage");
	expect((await target(spec, ctx())).asset?.name).toBe("tool-2.0.0-x86_64.AppImage");
	// Added on an x86_64 machine and checked on an arm64 one: its table names no file for this machine.
	sent = [];
	expect(await checkRelease({ ...spec, asset_aarch64: undefined }, arm)).toEqual({
		installed: "1.0.0",
		latest: null,
		status: "problem",
		detail: "The table for Tool names no release file for aarch64 machines.",
	});
	// And the other way round.
	expect((await checkRelease({ ...spec, asset: undefined }, ctx()))?.detail).toBe(
		"The table for Tool names no release file for x86_64 machines.",
	);
	expect(sent).toEqual([]);
});

test("on aarch64 a deb keeps the installed version's arm64 package, and a links: page is read for arm64 links", async () => {
	const dest = script(join(t.dir, "usr/bin/tool"), 'echo "1.4.2"');
	const spec: AppSpec = {
		key: "tool",
		name: "Tool",
		kind: "deb",
		repo: "gitlab.com/g/tool",
		asset: "amd64\\.deb$",
		asset_aarch64: "arm64\\.deb$",
		dest,
		sudo: true,
	};
	gitlab("g/tool", "v1.4.3", ["tool_1.4.3_amd64.deb", "tool_1.4.3_arm64.deb"]);
	gitlab("g/tool", "v1.4.2", ["tool_1.4.2_amd64.deb", "tool_1.4.2_arm64.deb"], "v1.4.2");
	files["https://gitlab.example.org/g/tool/-/releases/v1.4.3/downloads/tool_1.4.3_arm64.deb"] = big("new");
	files["https://gitlab.example.org/g/tool/-/releases/v1.4.2/downloads/tool_1.4.2_arm64.deb"] = big("old");
	const { run } = recordingRun(t.paths, (argv) => {
		if (argv[2] !== "dpkg") return undefined;
		script(dest, 'echo "1.4.3"');
		return ok();
	});
	const c = { ...ctx(run), arch: "aarch64" as const };
	expect(await installRelease(spec, await target(spec, c), c)).toMatchObject({ result: "done", installed: "1.4.3" });
	expect(listBackups(t.paths, "tool").map((p) => p.version)).toEqual(["1.4.2"]);

	const file: AppSpec = {
		key: "page",
		name: "Page",
		kind: "file",
		latest: "links:https://example.org/downloads/",
		asset: "^tool-[0-9.]+-linux-x86_64$",
		asset_aarch64: "^tool-[0-9.]+-linux-aarch64$",
		dest: "~/.local/bin/tool",
	};
	script(join(t.paths.home, ".local/bin/tool"), 'echo "tool 1.9.0"');
	page = ["tool-1.9.0-linux-aarch64", "tool-1.10.0-linux-x86_64"].map((n) => `<a href="${n}">${n}</a>`).join("\n");
	// Only the x86_64 build has 1.10.0 yet: an arm64 machine stays on 1.9.0.
	expect(await checkRelease(file, c)).toMatchObject({ latest: "1.9.0", status: "fresh" });
	expect(await checkRelease(file, ctx())).toMatchObject({ latest: "1.10.0", status: "ready" });
});
