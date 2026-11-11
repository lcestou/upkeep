import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSpec } from "../shared/types";
import {
	assetPattern,
	BAD_INPUT,
	CATALOGUE_WHY,
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
import lazygitRelease from "./fixtures/jesseduffield_lazygit.json";
import rustdeskRelease from "./fixtures/rustdesk_rustdesk.json";
import zenRelease from "./fixtures/zen-browser_desktop.json";
import type { Asset, FetchLike } from "./github";
import { ok, realRun, recordingRun, script, tempHome } from "./testkit";

type Fixture = { tag_name: string; assets: { name: string; size: number }[] };

let t: ReturnType<typeof tempHome>;
let releases: Record<string, Fixture> = {};
let searches: Record<string, { name: string; full_name: string; stargazers_count?: number }[]> = {};
let fetched: string[] = [];
let onPath: Record<string, string> = {};
let lines: string[] = [];
/** Asset bodies the fake download server serves; the release then lists their real size and digest. */
let bodies: Record<string, Uint8Array<ArrayBuffer>> = {};

const sha = (b: Uint8Array) => `sha256:${new Bun.CryptoHasher("sha256").update(b).digest("hex")}`;

/** A real .tar.gz or .zip built from files: "elf" is a tiny executable with ELF magic, "#!…" an executable script, anything else plain text. */
async function archive(files: Record<string, string>, zip = false): Promise<Uint8Array<ArrayBuffer>> {
	const src = mkdtempSync(join(t.dir, "arc-"));
	for (const [name, body] of Object.entries(files)) {
		mkdirSync(join(src, name, ".."), { recursive: true });
		if (body === "elf") {
			writeFileSync(join(src, name), Buffer.from("\x7fELF\x02\x01\x01", "latin1"));
			chmodSync(join(src, name), 0o755);
		} else {
			writeFileSync(join(src, name), body);
			// A script is executable but not a program Upkeep installs.
			if (body.startsWith("#!")) chmodSync(join(src, name), 0o755);
		}
	}
	const out = join(src, zip ? "../out.zip" : "../out.tar.gz");
	const argv = zip ? ["zip", "-qr", out, "."] : ["tar", "czf", out, "-C", src, "."];
	const r = await realRun(t.paths)(argv, { cwd: src });
	if (r.code !== 0) throw new Error(r.stderr || r.stdout);
	return new Uint8Array(readFileSync(out));
}

beforeEach(async () => {
	t = tempHome("discover");
	bodies = {};
	for (const libc of ["gnu", "musl"]) {
		const top = `fd-v10.5.2-x86_64-unknown-linux-${libc}`;
		// oxlint-disable-next-line no-await-in-loop -- both archives share one temp tree
		bodies[`${top}.tar.gz`] = await archive({
			[`${top}/fd`]: "elf",
			[`${top}/README.md`]: "fd",
			[`${top}/autocomplete/fd.bash`]: "x",
		});
	}
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
			assets: r.assets.map((a) => {
				const body = bodies[a.name];
				return {
					name: a.name,
					size: body ? body.length : a.size,
					browser_download_url: `https://dl.test/${a.name}`,
					digest: body ? sha(body) : null,
				};
			}),
		});
	}
	const q = /^https:\/\/api\.github\.com\/search\/repositories\?q=([^+]+)\+in:name/.exec(url);
	if (q) {
		if (q[1] === "limited") return new Response('{"message":"API rate limit exceeded"}', { status: 403 });
		return Response.json({ items: searches[decodeURIComponent(q[1] ?? "")] ?? [] });
	}
	const body = bodies[url.replace("https://dl.test/", "")];
	return body ? new Response(body) : new Response("", { status: 404 });
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
		usrLocal: join(t.dir, "usr/local"),
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

const CATALOGUE: AppSpec[] = [
	{
		key: "fd",
		name: "fd",
		kind: "archive",
		repo: "sharkdp/fd",
		asset: "x86_64-unknown-linux-gnu\\.tar\\.gz$",
		dest: "~/.local/bin/fd",
		bins: ["fd"],
	},
	{
		key: "claude",
		name: "Claude Code",
		kind: "command",
		check: ["claude", "--version"],
		latest: "npm:@anthropic-ai/claude-code",
		update: ["claude", "update"],
	},
];

test("a name, key or repo in the catalogue answers with its tested table, sure, and today's release", async () => {
	const c = { ...ctx().c, catalogue: CATALOGUE };
	for (const input of ["fd", " FD ", "sharkdp/fd", "https://github.com/sharkdp/fd"]) {
		// oxlint-disable-next-line no-await-in-loop -- one input at a time
		const r = await suggest(input, c);
		expect(r.suggestions).toHaveLength(1);
		expect(r.suggestions[0]).toMatchObject({
			spec: CATALOGUE[0],
			source: "catalogue",
			confidence: "sure",
			why: CATALOGUE_WHY,
			latest: "10.5.2",
			asset: { name: "fd-v10.5.2-x86_64-unknown-linux-gnu.tar.gz" },
		});
	}
	const claude = await suggest("claude code", c);
	expect(claude.suggestions[0]).toMatchObject({ spec: CATALOGUE[1], source: "catalogue", latest: null });
	expect(fetched.filter((u) => u.includes("anthropic"))).toEqual([]);
	expect(await suggest("not-in-it", c)).toEqual({ suggestions: [], problem: BAD_INPUT });
	const listed = { ...ctx([CATALOGUE[1] as AppSpec]).c, catalogue: CATALOGUE };
	expect((await suggest("claude", listed)).suggestions[0]?.problem).toBe("Claude Code is already in the list.");
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

test("32-bit, other architectures, and an asset that names no architecture all lose to this machine's build", () => {
	expect(machineAssets(names(lazygitRelease)).candidates.map((c) => c.asset.name)).toEqual([
		"lazygit_0.66.3_linux_x86_64.tar.gz",
	]);
	const odd = [
		"t_386.tar.gz",
		"t-i586.tar.gz",
		"t-ia32.tar.gz",
		"t-x86-32.zip",
		"t-loong64.tar.gz",
		"t-mips.tar.gz",
		"t.tar.gz",
		"t-linux-64bit.tar.gz",
		"t-x86-64.tar.gz",
	];
	expect(
		machineAssets(odd.map((name) => ({ name, url: "", size: 1, digest: null }))).candidates.map((c) => c.asset.name),
	).toEqual(["t-x86-64.tar.gz", "t-linux-64bit.tar.gz", "t.tar.gz"]);
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
			bins: ["fd-v10.5.2-x86_64-unknown-linux-gnu/fd"],
		},
		installed: "10.4.0",
		latest: "10.5.2",
		asset: { name: "fd-v10.5.2-x86_64-unknown-linux-gnu.tar.gz" },
		source: "repo",
		confidence: "sure",
		why: "Matched fd-v10.5.2-x86_64-unknown-linux-gnu.tar.gz for this machine. It installs fd. Found it installed at ~/.cargo/bin/fd.",
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
		why: "Matched fd-v10.5.2-x86_64-unknown-linux-musl.tar.gz for this machine. It installs fd. Nothing is installed at ~/.local/bin/fd yet, so Install will put it there.",
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
	const fd = elf(join(t.dir, "bin/fd"));
	searches.fd = [
		{ name: "fd-find", full_name: "x/fd-find" },
		{ name: "FD", full_name: "sharkdp/fd", stargazers_count: 41000 },
	];
	const hit = await suggest(fd, ctx().c);
	expect(hit.suggestions[0]).toMatchObject({
		spec: { repo: "sharkdp/fd", kind: "archive", dest: fd, bins: ["fd-v10.5.2-x86_64-unknown-linux-gnu/fd"] },
		confidence: "guess",
		why: "Guessed from the file name. Check that sharkdp/fd is the right project. Matched fd-v10.5.2-x86_64-unknown-linux-gnu.tar.gz for this machine. It installs fd. Could not read the installed version with --version.",
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
	for (const n of [
		"llama-server.bak-20260508-1744",
		"llama-server.bak-build826-2026-05-13",
		"x.old",
		"x.orig",
		"x.save",
		"x.prev",
		"x.BAK",
		"x~",
	])
		elf(join(bin, n));
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

test("scan skips a file named after an app the list tracks without a dest", async () => {
	const bin = join(t.paths.home, ".local/bin");
	elf(join(bin, "cursor.appimage"), { image: true });
	elf(join(bin, "Strata"));
	elf(join(bin, "cursory"));
	const specs: AppSpec[] = [
		{ key: "cursor", name: "Cursor", kind: "legacy", legacy_key: "cursor" },
		{ key: "strata-engine", name: "Strata", kind: "manual", process: "strata" },
	];
	const r = await scan(ctx(specs).c);
	expect(r.suggestions.map((s) => s.path)).toEqual([join(bin, "cursory")]);
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

const RG = "ripgrep-15.2.0-x86_64-unknown-linux-musl";
const ripgrep = async () => {
	bodies[`${RG}.tar.gz`] = await archive({
		[`${RG}/rg`]: "elf",
		[`${RG}/doc/rg.1`]: "man",
		[`${RG}/complete/_rg`]: "zsh",
	});
	releases["BurntSushi/ripgrep"] = {
		tag_name: "15.2.0",
		assets: [
			{ name: `${RG}.tar.gz`, size: 0 },
			{ name: "ripgrep-15.2.0-aarch64-unknown-linux-gnu.tar.gz", size: 1 },
			{ name: "ripgrep_15.2.0-1_amd64.deb", size: 1 },
		],
	};
};

test("an archive's programs are read from inside it: ripgrep ships rg", async () => {
	await ripgrep();
	onPath.rg = script(join(t.paths.home, ".cargo/bin/rg"), 'echo "ripgrep 15.1.0"');
	const r = await suggest("BurntSushi/ripgrep", ctx().c);
	expect(r.suggestions[0]).toMatchObject({
		spec: { key: "ripgrep", name: "ripgrep", kind: "archive", dest: "~/.cargo/bin/rg", bins: [`${RG}/rg`] },
		installed: "15.1.0",
		why: `Matched ${RG}.tar.gz for this machine. It installs rg. Found it installed at ~/.cargo/bin/rg.`,
	});
	// Nothing is kept.
	expect(readdirSync(join(t.paths.cache, "dl"))).toEqual([]);
});

test("a program the system's packages own is never the dest: Upkeep keeps its own in ~/.local/bin", async () => {
	await ripgrep();
	onPath.rg = script(join(t.dir, "usr/bin/rg"), 'echo "ripgrep 14.1.0"');
	const { c, calls } = ctx();
	const r = await suggest("BurntSushi/ripgrep", c);
	expect(r.suggestions[0]).toMatchObject({
		spec: { dest: "~/.local/bin/rg", bins: [`${RG}/rg`], install_if_missing: true },
		installed: null,
		why: `Matched ${RG}.tar.gz for this machine. It installs rg. A copy at ${onPath.rg} comes from the system's packages, so Upkeep will keep its own at ~/.local/bin/rg, which comes first on your PATH.`,
	});
	expect(r.suggestions[0]?.spec.sudo).toBeUndefined();
	// The system's copy is never run.
	expect(calls.some((x) => x.argv[0] === onPath.rg)).toBe(false);
});

test("a program in /usr/local stays where it is and is installed with sudo", async () => {
	await ripgrep();
	onPath.rg = script(join(t.dir, "usr/local/bin/rg"), 'echo "ripgrep 14.1.0"');
	const r = await suggest("BurntSushi/ripgrep", ctx().c);
	expect(r.suggestions[0]).toMatchObject({ spec: { dest: onPath.rg, sudo: true }, installed: "14.1.0" });
	expect(r.suggestions[0]?.spec.install_if_missing).toBeUndefined();
	expect(r.suggestions[0]?.why).toEndWith(`Found it installed at ${onPath.rg}.`);
});

test("a zip's programs are read too, the stem's program leads, and more than six are cut to the top or bin/", async () => {
	const files: Record<string, string> = { "tool/bin/tool": "elf", "tool/bin/helper": "elf", "tool/README": "x" };
	for (let i = 1; i <= 6; i++) files[`tool/libexec/extra${i}`] = "elf";
	bodies["tool-1.0-linux-x86_64.zip"] = await archive(files, true);
	releases["o/tool"] = { tag_name: "v1.0", assets: [{ name: "tool-1.0-linux-x86_64.zip", size: 0 }] };
	const r = await suggest("o/tool", ctx().c);
	expect(r.suggestions[0]?.spec).toMatchObject({
		dest: "~/.local/bin/tool",
		bins: ["tool/bin/tool", "tool/bin/helper"],
	});
	expect(r.suggestions[0]?.why).toContain(
		"It installs tool, helper. The archive holds 8 programs; only the first 6 are listed.",
	);
	expect(readdirSync(join(t.paths.cache, "dl"))).toEqual([]);
});

test("an archive with no program in it is refused, and a scan never opens one", async () => {
	bodies["docs-1.0-x86_64.tar.gz"] = await archive({ "docs/README": "x", "docs/run.sh": "#!/bin/sh" });
	releases["o/docs"] = { tag_name: "v1.0", assets: [{ name: "docs-1.0-x86_64.tar.gz", size: 0 }] };
	expect((await suggest("o/docs", ctx().c)).problem).toBe(
		"docs-1.0-x86_64.tar.gz holds no program Upkeep can install.",
	);
	await ripgrep();
	const bin = join(t.paths.home, ".local/bin");
	elf(join(bin, "ripgrep"));
	searches.ripgrep = [{ name: "ripgrep", full_name: "BurntSushi/ripgrep", stargazers_count: 50000 }];
	fetched = [];
	const { c, calls } = ctx();
	const r = await scan(c);
	expect(r.suggestions[0]?.spec.bins).toEqual(["ripgrep"]);
	expect(fetched.some((u) => u.startsWith("https://dl.test/"))).toBe(false);
	expect(calls).toEqual([]);
});

test("examples: what the owner gets for six repos", async () => {
	await ripgrep();
	releases["jesseduffield/lazygit"] = lazygitRelease;
	bodies["lazygit_0.66.3_linux_x86_64.tar.gz"] = await archive({ lazygit: "elf", LICENSE: "MIT", "README.md": "x" });
	releases["obsidianmd/obsidian-releases"] = {
		tag_name: "v1.9.4",
		assets: [
			{ name: "Obsidian-1.9.4.AppImage", size: 1 },
			{ name: "obsidian_1.9.4_amd64.deb", size: 1 },
			{ name: "Obsidian-1.9.4-arm64.AppImage", size: 1 },
			{ name: "obsidian-1.9.4.tar.gz", size: 1 },
		],
	};
	// rustdesk is the owner's dpkg install; nothing else is on disk. Only tar runs for real, on the test's own archives.
	const rec = recordingRun(t.paths, (argv) => {
		if (argv[0] === "tar" || argv[0] === "unzip") return undefined;
		if (argv[0] === "which") return argv[1] === "rustdesk" ? ok("/usr/bin/rustdesk\n") : none;
		return argv[0] === "/usr/bin/rustdesk" ? ok("1.5.1\n") : none;
	});
	const c: DiscoverCtx = { ...ctx().c, run: rec.run };
	const out: string[] = [];
	for (const repo of [
		"sharkdp/fd",
		"zen-browser/desktop",
		"rustdesk/rustdesk",
		"obsidianmd/obsidian-releases",
		"jesseduffield/lazygit",
		"BurntSushi/ripgrep",
	]) {
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
bins = ["fd-v10.5.2-x86_64-unknown-linux-gnu/fd"]
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

[apps.lazygit]
name = "lazygit"
kind = "archive"
repo = "jesseduffield/lazygit"
asset = '^lazygit_.*_linux_x86_64\\.tar\\.gz$'
dest = "~/.local/bin/lazygit"
bins = ["lazygit"]
install_if_missing = true

[apps.ripgrep]
name = "ripgrep"
kind = "archive"
repo = "BurntSushi/ripgrep"
asset = '^ripgrep-.*-x86_64-unknown-linux-musl\\.tar\\.gz$'
dest = "~/.local/bin/rg"
bins = ["${RG}/rg"]
install_if_missing = true
`);
	expect(rec.calls.filter((x) => !["which", "tar", "unzip"].includes(x.argv[0] ?? "")).map((x) => x.argv[0])).toEqual([
		"/usr/bin/rustdesk",
	]);
});
