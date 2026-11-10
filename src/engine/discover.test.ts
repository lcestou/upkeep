import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSpec } from "../shared/types";
import {
	assetPattern,
	BAD_INPUT,
	bareName,
	type DiscoverCtx,
	appName,
	displayName,
	keyOf,
	kindOf,
	machineAssets,
	readInput,
	scan,
	stem,
	suggest,
} from "./discover";
import { tomlTable } from "./manifest";
import fdRelease from "./fixtures/sharkdp_fd.json";
import rustdeskRelease from "./fixtures/rustdesk_rustdesk.json";
import zenRelease from "./fixtures/zen-browser_desktop.json";
import type { Asset, FetchLike } from "./github";
import { ok, recordingRun, script, tempHome } from "./testkit";

type Fixture = { tag_name: string; assets: { name: string; size: number }[] };

let t: ReturnType<typeof tempHome>;
let releases: Record<string, Fixture> = {};
let searches: Record<string, { name: string; full_name: string }[]> = {};
let fetched: string[] = [];
let onPath: Record<string, string> = {};
let lines: string[] = [];

beforeEach(() => {
	t = tempHome("discover");
	releases = {
		"sharkdp/fd": fdRelease,
		"zen-browser/desktop": zenRelease,
		"rustdesk/rustdesk": rustdeskRelease,
	};
	searches = {};
	fetched = [];
	onPath = {};
	lines = [];
});
afterEach(() => t.cleanup());

const fakeFetch: FetchLike = async (url) => {
	fetched.push(url);
	const rel = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/releases\/latest$/.exec(url);
	if (rel) {
		const r = releases[rel[1] ?? ""];
		if (!r) return new Response('{"message":"Not Found"}', { status: 404 });
		return Response.json({
			tag_name: r.tag_name,
			html_url: "",
			assets: r.assets.map((a) => ({
				name: a.name,
				size: a.size,
				browser_download_url: `https://dl.test/${a.name}`,
				digest: null,
			})),
		});
	}
	const q = /^https:\/\/api\.github\.com\/search\/repositories\?q=([^+]+)\+in:name/.exec(url);
	if (q) {
		if (q[1] === "limited") return new Response('{"message":"API rate limit exceeded"}', { status: 403 });
		return Response.json({ items: searches[decodeURIComponent(q[1] ?? "")] ?? [] });
	}
	return new Response("", { status: 404 });
};

function ctx(specs: AppSpec[] = []) {
	// which is answered from a fake PATH; everything else runs for real on temp files only.
	const rec = recordingRun(t.paths, (argv) => {
		if (argv[0] !== "which") return undefined;
		const p = onPath[argv[1] ?? ""];
		return p ? ok(`${p}\n`) : { code: 1, stdout: "", stderr: "", timedOut: false };
	});
	const c: DiscoverCtx = {
		paths: t.paths,
		run: rec.run,
		fetch: fakeFetch,
		token: null,
		specs,
		log: (l) => lines.push(l),
		searchGapMs: 0,
	};
	return { c, calls: rec.calls };
}

const names = (f: Fixture) => f.assets.map((a) => ({ name: a.name, url: "", size: a.size, digest: null }) as Asset);

/** An ELF header, with the AppImage type-2 magic when image is set, and an optional update-information string. */
function elf(file: string, opts: { image?: boolean; zsync?: string; size?: number } = {}): string {
	const b = Buffer.alloc(opts.size ?? 4096);
	b.write("\x7fELF", 0, "latin1");
	if (opts.image) b.write("AI\x02", 8, "latin1");
	if (opts.zsync) b.write(opts.zsync, 1024, "latin1");
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, b);
	chmodSync(file, 0o755);
	return file;
}

test("input: a repo, a github.com link, a file path, or neither", () => {
	expect(readInput("sharkdp/fd")).toEqual({ repo: "sharkdp/fd" });
	expect(readInput(" https://github.com/zen-browser/desktop/releases/tag/1.24.1b ")).toEqual({
		repo: "zen-browser/desktop",
	});
	expect(readInput("https://github.com/sharkdp/fd.git")).toEqual({ repo: "sharkdp/fd" });
	expect(readInput("/opt/x/tool")).toEqual({ file: "/opt/x/tool" });
	expect(readInput("~/Applications/a.AppImage")).toEqual({ file: "~/Applications/a.AppImage" });
	expect(readInput("file:///home/u/a")).toEqual({ file: "file:///home/u/a" });
	expect(readInput("https://gitlab.com/a/b")).toBeNull();
	expect(readInput("just words")).toBeNull();
	expect(readInput("a/b/c")).toBeNull();
});

test("suggest refuses input that is not a repo, a link or a path", async () => {
	expect(await suggest("fd please", ctx().c)).toEqual({ suggestions: [], problem: BAD_INPUT });
});

test("the asset filter keeps what runs on Linux x86_64, best first, on three real releases", () => {
	expect(machineAssets(names(fdRelease)).candidates.map((c) => c.asset.name)).toEqual([
		"fd-v10.5.2-x86_64-unknown-linux-gnu.tar.gz",
		"fd-v10.5.2-x86_64-unknown-linux-musl.tar.gz",
		"fd_10.5.2_amd64.deb",
		"fd-musl_10.5.2_amd64.deb",
	]);
	const zen = machineAssets(names(zenRelease));
	expect(zen.candidates.map((c) => c.asset.name)).toEqual(["zen-x86_64.AppImage"]);
	expect(zen.unopened).toBe(true);
	expect(machineAssets(names(rustdeskRelease)).candidates.map((c) => [c.asset.name, c.kind])).toEqual([
		["rustdesk-1.5.1-x86_64.AppImage", "appimage"],
		["rustdesk-1.5.1-unsigned.tar.gz", "archive"],
		["rustdesk-1.5.1-x86_64.deb", "deb"],
		["rustdesk-1.5.1-x86_64-sciter.deb", "deb"],
		["rustdesk-unattended-wayland-1.5.1-x86_64.deb", "deb"],
	]);
	// What is on disk leads.
	expect(machineAssets(names(rustdeskRelease), ["deb"]).candidates[0]?.asset.name).toBe("rustdesk-1.5.1-x86_64.deb");
});

test("kinds: bare names, -gh and the machine triple are files; archives the installer cannot open are named", () => {
	expect(kindOf("borg-linux-glibc236")).toBe("file");
	expect(kindOf("tool-1.2.3")).toBe("file");
	expect(kindOf("gh-x86_64-unknown-linux-gnu")).toBe("file");
	expect(kindOf("dsh-gh")).toBe("file");
	expect(kindOf("zen.linux-x86_64.tar.xz")).toBe("unopened");
	expect(kindOf("a.tgz")).toBe("archive");
	expect(kindOf("notes.html")).toBeNull();
});

test("the pattern makes the version a wildcard, matches one asset, and falls back to the exact name", () => {
	const fd = { tag: "v10.5.2", version: "10.5.2", assets: names(fdRelease) };
	expect(assetPattern("fd-v10.5.2-x86_64-unknown-linux-gnu.tar.gz", fd)).toEqual({
		pattern: "^fd-.*-x86_64-unknown-linux-gnu\\.tar\\.gz$",
		widen: false,
	});
	expect(assetPattern("fd_10.5.2_amd64.deb", fd)).toEqual({ pattern: "^fd_.*_amd64\\.deb$", widen: false });
	const zen = { tag: "1.24.1b", version: "1.24.1", assets: names(zenRelease) };
	expect(assetPattern("zen-x86_64.AppImage", zen)).toEqual({ pattern: "^zen-x86_64\\.AppImage$", widen: false });
	const rustdesk = { tag: "1.5.1", version: "1.5.1", assets: names(rustdeskRelease) };
	expect(assetPattern("rustdesk-1.5.1-x86_64.deb", rustdesk)).toEqual({
		pattern: "^rustdesk-[0-9][0-9A-Za-z.]*-x86_64\\.deb$",
		widen: false,
	});
	const clash = {
		tag: "v1.0",
		version: "1.0",
		assets: names({
			tag_name: "v1.0",
			assets: [
				{ name: "app-1.0-x.zip", size: 1 },
				{ name: "app-1.0b-x.zip", size: 1 },
			],
		}),
	};
	expect(assetPattern("app-1.0-x.zip", clash)).toEqual({ pattern: "^app-1\\.0-x\\.zip$", widen: true });
});

test("names and keys", () => {
	expect(displayName("fd")).toBe("fd");
	expect(displayName("zen-browser")).toBe("Zen Browser");
	expect(displayName("LRCGET")).toBe("LRCGET");
	expect(displayName("my_tool")).toBe("My Tool");
	expect(keyOf("Zen.Browser")).toBe("zen-browser");
	expect(bareName("rustdesk-1.5.1-x86_64.AppImage")).toBe("rustdesk");
	expect(bareName("Cursor-2.0.1-x86_64.AppImage")).toBe("Cursor");
	expect(bareName("lrcget")).toBe("lrcget");
});

test("from a repo: an archive installed on PATH is found there and probed for its version", async () => {
	onPath.fd = script(join(t.paths.home, ".cargo/bin/fd"), 'echo "fd 10.4.0"');
	const { c } = ctx();
	const r = await suggest("sharkdp/fd", c);
	expect(r.problem).toBeUndefined();
	expect(r.suggestions[0]).toMatchObject({
		spec: {
			key: "fd",
			name: "fd",
			kind: "archive",
			repo: "sharkdp/fd",
			asset: "^fd-.*-x86_64-unknown-linux-gnu\\.tar\\.gz$",
			dest: "~/.cargo/bin/fd",
			bins: ["fd"],
		},
		installed: "10.4.0",
		latest: "10.5.2",
		asset: { name: "fd-v10.5.2-x86_64-unknown-linux-gnu.tar.gz" },
		source: "repo",
		confidence: "sure",
		why: "Matched fd-v10.5.2-x86_64-unknown-linux-gnu.tar.gz for this machine. Found it installed at ~/.cargo/bin/fd.",
	});
	expect(r.suggestions[0]?.spec.install_if_missing).toBeUndefined();
	expect(r.suggestions[0]?.alternatives).toEqual([
		"fd-v10.5.2-x86_64-unknown-linux-musl.tar.gz",
		"fd_10.5.2_amd64.deb",
		"fd-musl_10.5.2_amd64.deb",
	]);
});

test("from a repo: nothing installed goes to ~/.local/bin and is listed to install; a named asset is used", async () => {
	const r = await suggest("https://github.com/sharkdp/fd", ctx().c, "fd-v10.5.2-x86_64-unknown-linux-musl.tar.gz");
	expect(r.suggestions[0]).toMatchObject({
		spec: { asset: "^fd-.*-x86_64-unknown-linux-musl\\.tar\\.gz$", dest: "~/.local/bin/fd", install_if_missing: true },
		installed: null,
		why: "Matched fd-v10.5.2-x86_64-unknown-linux-musl.tar.gz for this machine. Nothing is installed at ~/.local/bin/fd yet, so Install will put it there.",
	});
});

test("from a repo: an installed AppImage is found by name and magic in ~/Applications", async () => {
	elf(join(t.paths.home, "Applications/notes.txt"));
	const img = elf(join(t.paths.home, "Applications/RustDesk-1.4.0.AppImage"), { image: true });
	const { c, calls } = ctx();
	const r = await suggest("rustdesk/rustdesk", c);
	expect(r.suggestions[0]?.spec).toMatchObject({
		kind: "appimage",
		dest: "~/Applications/RustDesk-1.4.0.AppImage",
		asset: "^rustdesk-.*-x86_64\\.AppImage$",
	});
	// The fake image prints nothing it understands, so the version stays unknown and the why says so.
	expect(r.suggestions[0]?.installed).toBeNull();
	expect(r.suggestions[0]?.why).toEndWith("Could not read the installed version with --version.");
	expect(calls.some((x) => x.argv[0] === img)).toBe(true);
});

test("from a repo: a program on PATH outside home makes the deb lead, with sudo", async () => {
	onPath.rustdesk = script(join(t.dir, "usr/bin/rustdesk"), 'echo "1.5.0"');
	const r = await suggest("rustdesk/rustdesk", ctx().c);
	expect(r.suggestions[0]).toMatchObject({
		spec: { kind: "deb", dest: onPath.rustdesk, sudo: true, asset: "^rustdesk-[0-9][0-9A-Za-z.]*-x86_64\\.deb$" },
		installed: "1.5.0",
	});
});

test("from a repo: no release, a tag that is not a version, nothing for this machine, and a taken key", async () => {
	expect((await suggest("o/none", ctx().c)).problem).toBe("o/none has no published release.");
	releases["o/nightly"] = { tag_name: "nightly", assets: [] };
	expect((await suggest("o/nightly", ctx().c)).problem).toBe(
		"The latest tag nightly is not a version Upkeep can compare.",
	);
	releases["o/mac"] = { tag_name: "v1.0", assets: [{ name: "mac-1.0.dmg", size: 1 }] };
	expect((await suggest("o/mac", ctx().c)).problem).toBe("No asset of o/mac's latest release runs on this machine.");
	releases["o/xz"] = { tag_name: "v1.0", assets: [{ name: "xz-1.0-x86_64.tar.xz", size: 1 }] };
	expect((await suggest("o/xz", ctx().c)).problem).toBe(
		"No asset of o/xz's latest release runs on this machine. Its Linux builds are .tar.xz, .tar.zst, .tar.bz2 or .7z archives, which Upkeep cannot open yet.",
	);
	const taken = await suggest("sharkdp/fd", ctx([{ key: "fd", name: "fd", kind: "archive" }]).c);
	expect(taken.suggestions[0]?.problem).toBe("fd is already in the list.");
});

test("from a file: an AppImage that names its own release source", async () => {
	const img = elf(join(t.paths.home, "Downloads/zen.AppImage"), {
		image: true,
		zsync: "gh-releases-zsync|zen-browser|desktop|latest|zen-x86_64.AppImage.zsync",
	});
	const r = await suggest(`file://${img}`, ctx().c);
	expect(r.suggestions[0]).toMatchObject({
		spec: {
			key: "zen",
			name: "Zen Browser",
			kind: "appimage",
			repo: "zen-browser/desktop",
			dest: "~/Downloads/zen.AppImage",
		},
		source: "file",
		path: img,
		confidence: "sure",
		why: "The AppImage names its own release source. Matched zen-x86_64.AppImage for this machine. Could not read the installed version with --version.",
	});
	expect(fetched.some((u) => u.includes("/search/"))).toBe(false);
});

test("from a file: the source in the last 2 MB of a big AppImage is found too", async () => {
	const img = join(t.dir, "big.AppImage");
	const b = Buffer.alloc(5 * 1024 * 1024);
	b.write("\x7fELF", 0, "latin1");
	b.write("AI\x02", 8, "latin1");
	b.write("gh-releases-zsync|zen-browser|desktop|latest|x", b.length - 500, "latin1");
	writeFileSync(img, b);
	expect((await suggest(img, ctx().c)).suggestions[0]?.spec.repo).toBe("zen-browser/desktop");
});

test("from a file: a name search hit is a guess, a miss keeps the path", async () => {
	const fd = elf(join(t.dir, "bin/fd-v10.5.2-x86_64-unknown-linux-gnu"));
	searches.fd = [
		{ name: "fd-find", full_name: "x/fd-find" },
		{ name: "FD", full_name: "sharkdp/fd" },
	];
	const hit = await suggest(fd, ctx().c);
	expect(hit.suggestions[0]).toMatchObject({
		spec: { repo: "sharkdp/fd", kind: "archive", dest: fd, bins: ["fd-v10.5.2-x86_64-unknown-linux-gnu"] },
		confidence: "guess",
		why: "Guessed from the file name. Check that sharkdp/fd is the right project. Matched fd-v10.5.2-x86_64-unknown-linux-gnu.tar.gz for this machine. Could not read the installed version with --version.",
	});
	const odd = elf(join(t.dir, "bin/oddtool"));
	const miss = await suggest(odd, ctx().c);
	expect(miss.suggestions[0]).toMatchObject({
		path: odd,
		problem: "Could not tell where oddtool comes from. Paste its GitHub repo to add it.",
	});
});

test("from a file: no file, and a file that is not a program", async () => {
	expect((await suggest("~/nope", ctx().c)).problem).toBe(`There is no file at ${join(t.paths.home, "nope")}.`);
	const sh = script(join(t.dir, "run.sh"), "echo hi");
	expect((await suggest(sh, ctx().c)).problem).toBe(
		"run.sh is not a program Upkeep can track (it is not a compiled binary or an AppImage).",
	);
});

test("scan skips listed apps, symlinks, scripts and leftovers, and never runs what it finds", async () => {
	const bin = join(t.paths.home, ".local/bin");
	const listed = elf(join(bin, "fd"));
	const listedBin = elf(join(bin, "ya"));
	elf(join(bin, "zen.AppImage"), { image: true, zsync: "gh-releases-zsync|zen-browser|desktop|latest|z" });
	elf(join(bin, "oddtool"));
	elf(join(bin, "fd.backup-1"));
	elf(join(bin, "x.upkeep-new"));
	elf(join(bin, "y.tmp"));
	symlinkSync(listed, join(bin, "fd-link"));
	script(join(bin, "helper"), "echo hi");
	const notExec = elf(join(t.paths.home, "bin/data"));
	chmodSync(notExec, 0o644);
	const specs: AppSpec[] = [
		{ key: "fd", name: "fd", kind: "archive", dest: "~/.local/bin/fd", bins: ["fd"] },
		{ key: "yazi", name: "Yazi", kind: "archive", dest: "~/.local/bin/yazi", bins: ["x/ya"] },
	];
	const { c, calls } = ctx(specs);
	const r = await scan(c);
	expect(r.suggestions.map((s) => [s.path, s.problem ?? null])).toEqual([
		[join(bin, "oddtool"), "Could not tell where oddtool comes from. Paste its GitHub repo to add it."],
		[join(bin, "zen.AppImage"), null],
	]);
	expect(r.suggestions.every((s) => s.installed === null && s.source === "scan")).toBe(true);
	expect(calls.filter((x) => x.argv.some((a) => a.startsWith(bin)))).toEqual([]);
	expect(listedBin).toBeDefined();
});

test("a rate-limited search stops the scan with what it has", async () => {
	const bin = join(t.paths.home, ".local/bin");
	elf(join(bin, "aaa"));
	elf(join(bin, "limited"));
	elf(join(bin, "zzz"));
	const r = await scan(ctx().c);
	expect(r.suggestions.map((s) => s.path)).toEqual([join(bin, "aaa"), join(bin, "limited")]);
	expect(lines).toContain("GitHub's request limit is used up. Try again after it resets.");
});

const rel = (tag: string, version: string) => ({ tag, version });

test("an app is named after what it ships", () => {
	expect(stem("fd-v10.5.2-x86_64-unknown-linux-gnu.tar.gz", rel("v10.5.2", "10.5.2"))).toBe("fd");
	expect(stem("zen-x86_64.AppImage", rel("1.24.1b", "1.24.1"))).toBe("zen");
	expect(stem("rustdesk-1.5.1-x86_64.deb", rel("1.5.1", "1.5.1"))).toBe("rustdesk");
	expect(stem("Obsidian-1.9.4.AppImage", rel("v1.9.4", "1.9.4"))).toBe("Obsidian");
	expect(stem("lrcget_2.2.2_amd64.AppImage", rel("2.2.2", "2.2.2"))).toBe("lrcget");
	expect(stem("bun-linux-x64.zip", rel("bun-v1.3.2", "1.3.2"))).toBe("bun");
	expect(stem("x86_64.AppImage", rel("1.0", "1.0"))).toBe("");
	expect(appName("Obsidian", "obsidianmd/obsidian-releases")).toBe("Obsidian");
	expect(appName("zen", "zen-browser/desktop")).toBe("Zen Browser");
	expect(appName("fd", "sharkdp/fd")).toBe("fd");
	expect(appName("", "o/my_tool")).toBe("My Tool");
});

test("a generic repo name finds the owner's AppImage by what the release ships", async () => {
	elf(join(t.paths.home, ".local/bin/zen-browser.AppImage"), { image: true });
	const r = await suggest("zen-browser/desktop", ctx().c);
	expect(r.suggestions[0]?.spec).toMatchObject({
		key: "zen",
		name: "Zen Browser",
		dest: "~/.local/bin/zen-browser.AppImage",
	});
	expect(r.suggestions[0]?.spec.install_if_missing).toBeUndefined();
});

test("a repo whose stems are all too short falls back to the repo name", async () => {
	releases["o/tool"] = { tag_name: "v1.0", assets: [{ name: "x86_64.AppImage", size: 1 }] };
	expect((await suggest("o/tool", ctx().c)).suggestions[0]?.spec).toMatchObject({ key: "tool", name: "tool" });
});

const none = { code: 1, stdout: "", stderr: "", timedOut: false };

test("examples: what the owner gets for four repos", async () => {
	releases["obsidianmd/obsidian-releases"] = {
		tag_name: "v1.9.4",
		assets: [
			{ name: "Obsidian-1.9.4.AppImage", size: 1 },
			{ name: "obsidian_1.9.4_amd64.deb", size: 1 },
			{ name: "Obsidian-1.9.4-arm64.AppImage", size: 1 },
			{ name: "obsidian-1.9.4.tar.gz", size: 1 },
		],
	};
	// rustdesk is the owner's dpkg install; nothing else is on disk. The fake runner answers its probe and runs nothing.
	const rec = recordingRun(t.paths, (argv) => {
		if (argv[0] === "which") return argv[1] === "rustdesk" ? ok("/usr/bin/rustdesk\n") : none;
		return argv[0] === "/usr/bin/rustdesk" ? ok("1.5.1\n") : none;
	});
	const c: DiscoverCtx = { ...ctx().c, run: rec.run };
	const out: string[] = [];
	for (const repo of ["sharkdp/fd", "zen-browser/desktop", "rustdesk/rustdesk", "obsidianmd/obsidian-releases"]) {
		// oxlint-disable-next-line no-await-in-loop -- in order, for a stable listing
		const spec = (await suggest(repo, c)).suggestions[0]?.spec;
		if (spec) out.push(tomlTable(spec));
	}
	expect(out.join("\n")).toBe(`[apps.fd]
name = "fd"
kind = "archive"
repo = "sharkdp/fd"
asset = '^fd-.*-x86_64-unknown-linux-gnu\\.tar\\.gz$'
dest = "~/.local/bin/fd"
bins = ["fd"]
install_if_missing = true

[apps.zen]
name = "Zen Browser"
kind = "appimage"
repo = "zen-browser/desktop"
asset = '^zen-x86_64\\.AppImage$'
dest = "~/.local/bin/zen.AppImage"
install_if_missing = true

[apps.rustdesk]
name = "rustdesk"
kind = "deb"
repo = "rustdesk/rustdesk"
asset = '^rustdesk-[0-9][0-9A-Za-z.]*-x86_64\\.deb$'
dest = "/usr/bin/rustdesk"
sudo = true

[apps.obsidian]
name = "Obsidian"
kind = "appimage"
repo = "obsidianmd/obsidian-releases"
asset = '^Obsidian-[0-9][0-9A-Za-z.]*\\.AppImage$'
dest = "~/.local/bin/obsidian.AppImage"
install_if_missing = true
`);
	expect(rec.calls.filter((x) => x.argv[0] !== "which").map((x) => x.argv[0])).toEqual(["/usr/bin/rustdesk"]);
});
