import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AppSpec } from "../shared/types";
import { MESSAGES } from "../shared/messages";
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
import { aptRepoHas, copiesOf } from "./extras/system";
import { tomlTable } from "./manifest";
import fdRelease from "./fixtures/sharkdp_fd.json";
import lazygitRelease from "./fixtures/jesseduffield_lazygit.json";
import rustdeskRelease from "./fixtures/rustdesk_rustdesk.json";
import zenRelease from "./fixtures/zen-browser_desktop.json";
import codebergRelease from "./fixtures/codeberg_forgejo_forgejo.json";
import gitlabRelease from "./fixtures/gitlab-org_gitlab-runner.json";
import catalogueAssets from "./fixtures/catalogue-assets.json";
import type { Asset, FetchLike } from "./github";
import { ok, realRun, recordingRun, script, tempHome } from "./testkit";

type Fixture = { tag_name: string; assets: { name: string; size: number }[] };

let t: ReturnType<typeof tempHome>;
let releases: Record<string, Fixture> = {};
let searches: Record<string, { name: string; full_name: string; stargazers_count?: number }[]> = {};
let fetched: string[] = [];
let onPath: Record<string, string> = {};
let lines: string[] = [];
/** The read-only lists the other-copies check reads; a check of "what ran" leaves them out. */
const LISTS = new Set(["flatpak", "snap", "apt-cache"]);
/** What flatpak, snap and apt-cache print in a test; a tool with no entry is not installed. */
let systemLists: Record<string, string> = {};
/** What each tool manager's list prints in a test; a manager with no entry is not installed. */
let managers: Record<string, string> = {};
/** A repo's root at its release tag, by repo: the names in it and the text of the files a draft reads. */
let roots: Record<string, Record<string, string>> = {};
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
	managers = {};
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
	// A Debian system unless a test says otherwise: a .deb is offered only where dpkg is.
	onPath = { dpkg: "/usr/bin/dpkg" };
	systemLists = {};
	lines = [];
	roots = {};
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
	const listing = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/contents(?:\/([^?]+))?\?ref=/.exec(url);
	if (listing) {
		const root = roots[listing[1] ?? ""];
		if (!root) return new Response('{"message":"Not Found"}', { status: 404 });
		const path = listing[2];
		if (!path) return Response.json(Object.keys(root).map((name) => ({ name, type: "file" })));
		const text = root[path];
		return text === undefined
			? new Response('{"message":"Not Found"}', { status: 404 })
			: Response.json({ encoding: "base64", content: Buffer.from(text).toString("base64") });
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
		// The system's other copies: what each list prints in a test, none unless set.
		if (argv[0] === "flatpak" || argv[0] === "snap" || argv[0] === "apt-cache") {
			const out = systemLists[argv[0]];
			return out === undefined ? { code: 127, stdout: "", stderr: "", timedOut: false } : ok(out);
		}
		if (argv[0] === "uv" || argv[0] === "pipx" || argv[0] === "npm") {
			const out = managers[argv[0]];
			return out === undefined ? { code: 127, stdout: "", stderr: "", timedOut: false } : ok(out);
		}
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
	// An older GitLab link goes straight to tree/ or blob/ without the "-" marker.
	expect(readInput("https://gitlab.com/inkscape/inkscape/tree/master")).toEqual({
		repo: "gitlab.com/inkscape/inkscape",
	});
	expect(readInput("https://gitlab.com/g/sub/tool/blob/main/README.md")).toEqual({ repo: "gitlab.com/g/sub/tool" });
	// A group named like a route word is still a group.
	expect(readInput("https://gitlab.com/o/tags/proj")).toEqual({ repo: "gitlab.com/o/tags/proj" });
	expect(readInput(" https://github.com/zen-browser/desktop/releases/tag/1.24.1b ")).toEqual({
		repo: "zen-browser/desktop",
	});
	expect(readInput("https://github.com/sharkdp/fd.git")).toEqual({ repo: "sharkdp/fd" });
	expect(readInput("/opt/x/tool")).toEqual({ file: "/opt/x/tool" });
	expect(readInput("~/Applications/a.AppImage")).toEqual({ file: "~/Applications/a.AppImage" });
	expect(readInput("file:///home/u/a")).toEqual({ file: "file:///home/u/a" });
	expect(readInput("just words")).toBeNull();
	expect(readInput("a/b/c")).toBeNull();
});

test("input: GitLab and Codeberg links and host/owner/name, and a self-hosted forge only once a table names it", () => {
	expect(readInput("https://gitlab.com/gitlab-org/gitlab-runner/-/releases/v19.3.6")).toEqual({
		repo: "gitlab.com/gitlab-org/gitlab-runner",
	});
	expect(readInput("https://gitlab.com/inkscape/inkscape.git")).toEqual({ repo: "gitlab.com/inkscape/inkscape" });
	expect(readInput("gitlab.com/group/sub/project")).toEqual({ repo: "gitlab.com/group/sub/project" });
	expect(readInput("https://codeberg.org/forgejo/forgejo/releases")).toEqual({ repo: "codeberg.org/forgejo/forgejo" });
	expect(readInput("codeberg.org/forgejo/forgejo")).toEqual({ repo: "codeberg.org/forgejo/forgejo" });
	expect(readInput("github.com/sharkdp/fd")).toEqual({ repo: "sharkdp/fd" });
	// A host no table names could run any forge: it is not guessed.
	expect(readInput("https://git.example.org/me/tool")).toBeNull();
	const hosts = new Map([["git.example.org", "gitea" as const]]);
	expect(readInput("https://git.example.org/me/tool/releases", hosts)).toEqual({
		repo: "git.example.org/me/tool",
		forge: "gitea",
	});
	expect(readInput("git.example.org/me/tool", hosts)).toEqual({ repo: "git.example.org/me/tool", forge: "gitea" });
	// A Gitea repo is owner/name only, and a GitLab link with no project is not a repo.
	expect(readInput("codeberg.org/forgejo")).toBeNull();
	expect(readInput("https://gitlab.com/explore")).toBeNull();
	expect(readInput("ftp://gitlab.com/a/b")).toBeNull();
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
	const telegram: AppSpec = {
		key: "claude-code-telegram",
		name: "claude-code-telegram",
		kind: "command",
		check: ["x"],
		latest: "github:RichardAtCT/claude-code-telegram",
		update: ["y"],
	};
	const withTelegram = { ...ctx().c, catalogue: [...CATALOGUE, telegram] };
	expect(
		(await suggest("https://github.com/RichardAtCT/claude-code-telegram", withTelegram)).suggestions[0],
	).toMatchObject({
		spec: telegram,
		source: "catalogue",
	});
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
	// The .tar.xz build opens now; the source tarball beside it is never a candidate.
	const zen = machineAssets(names(zenRelease));
	expect(zen.candidates.map((c) => c.asset.name)).toEqual(["zen-x86_64.AppImage", "zen.linux-x86_64.tar.xz"]);
	expect(zen.unopened).toBe(false);
	expect(machineAssets(names(rustdeskRelease)).candidates.map((c) => [c.asset.name, c.kind])).toEqual([
		["rustdesk-1.5.1-x86_64.AppImage", "appimage"],
		["rustdesk-1.5.1-unsigned.tar.gz", "archive"],
		["rustdesk-1.5.1-x86_64.deb", "deb"],
		["rustdesk-1.5.1-0.x86_64.rpm", "rpm"],
		["rustdesk-1.5.1-0.x86_64-suse.rpm", "rpm"],
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
		"t-x86.64.tar.gz",
	];
	expect(
		machineAssets(odd.map((name) => ({ name, url: "", size: 1, digest: null }))).candidates.map((c) => c.asset.name),
	).toEqual(["t-x86-64.tar.gz", "t-x86.64.tar.gz", "t-linux-64bit.tar.gz", "t.tar.gz"]);
	// A macOS build that says only "mac" (Caddy) is left out; "mac" inside a word is not a system.
	const caddy = ["caddy_2.11.9_mac_amd64.tar.gz", "caddy_2.11.9_linux_amd64.tar.gz", "emacs-lsp_linux_amd64.tar.gz"];
	expect(
		machineAssets(caddy.map((name) => ({ name, url: "", size: 1, digest: null })))
			.candidates.map((c) => c.asset.name)
			.toSorted(),
	).toEqual(["caddy_2.11.9_linux_amd64.tar.gz", "emacs-lsp_linux_amd64.tar.gz"]);
});

test("kinds: bare names, -gh and the machine triple are files; archives the installer cannot open are named", () => {
	expect(kindOf("borg-linux-glibc236")).toBe("file");
	expect(kindOf("tool-1.2.3")).toBe("file");
	expect(kindOf("gh-x86_64-unknown-linux-gnu")).toBe("file");
	expect(kindOf("dsh-gh")).toBe("file");
	expect(kindOf("zen.linux-x86_64.tar.xz")).toBe("archive");
	expect(kindOf("fish-4.2.1-linux-x86_64.tar.zst")).toBe("archive");
	expect(kindOf("t.tar.bz2")).toBe("archive");
	expect(kindOf("t-x86_64.7z")).toBe("unopened");
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
	releases["o/sz"] = { tag_name: "v1.0", assets: [{ name: "sz-1.0-x86_64.7z", size: 1 }] };
	expect((await suggest("o/sz", ctx().c)).problem).toBe(
		"No asset of o/sz's latest release runs on this machine. Its Linux builds are .7z archives, which Upkeep cannot open yet.",
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
		problem: "Could not tell where oddtool comes from. Paste its repo or link to add it.",
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
		[join(bin, "oddtool"), "Could not tell where oddtool comes from. Paste its repo or link to add it."],
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
		{ key: "cursor", name: "Cursor", kind: "command", check: ["cursor", "--version"] },
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

/** Gives the temp home a uv tool, the way uv lays it out. */
function uvTool(name: string, receipt: string) {
	const dir = join(t.paths.home, ".local/share/uv/tools", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "uv-receipt.toml"), receipt);
}

test("scan offers what uv, pipx, npm and cargo installed, as command tables that update through them", async () => {
	managers.uv = "pr-agent v0.49.0\n- pr-agent\nyt-dlp v2026.8.19\n- yt-dlp\n";
	uvTool("pr-agent", readFileSync(join(import.meta.dir, "fixtures/uv-receipt-pr-agent.toml"), "utf8"));
	uvTool("yt-dlp", `[tool]\nrequirements = [{ name = "yt-dlp" }]\n`);
	managers.pipx = JSON.stringify({
		venvs: {
			black: { metadata: { main_package: { package: "black", package_version: "24.8.0", package_or_url: "black" } } },
		},
	});
	managers.npm = JSON.stringify({ dependencies: { npm: { version: "11.0.0" }, "@scope/Pkg": { version: "1.2.3" } } });
	mkdirSync(join(t.paths.home, ".cargo"), { recursive: true });
	writeFileSync(
		join(t.paths.home, ".cargo/.crates2.json"),
		JSON.stringify({
			installs: { "ripgrep 14.1.0 (registry+https://github.com/rust-lang/crates.io-index)": { bins: ["rg"] } },
		}),
	);
	const { c, calls } = ctx();
	const r = await scan(c);
	expect(
		r.suggestions.map((x) => [x.spec.key, x.installed, x.latest, x.source, x.confidence, x.why, x.problem ?? null]),
	).toEqual([
		["pr-agent", "0.49.0", null, "scan", "sure", "Installed with uv. Upkeep updates it the same way.", null],
		["yt-dlp", "2026.8.19", null, "scan", "sure", "Installed with uv. Upkeep updates it the same way.", null],
		["black", "24.8.0", null, "scan", "sure", "Installed with pipx. Upkeep updates it the same way.", null],
		["scope-pkg", "1.2.3", null, "scan", "sure", "Installed with npm. Upkeep updates it the same way.", null],
		["ripgrep", "14.1.0", null, "scan", "sure", "Installed with cargo. Upkeep updates it the same way.", null],
	]);
	const prAgent = r.suggestions[0]?.spec;
	expect(prAgent).toEqual({
		key: "pr-agent",
		name: "pr-agent",
		kind: "command",
		check: expect.any(Array),
		latest: "github:The-PR-Agent/pr-agent",
		update: [
			"uv",
			"tool",
			"install",
			"--reinstall",
			"--python",
			"3.12",
			"pr-agent[github] @ git+https://github.com/The-PR-Agent/pr-agent@{tag}",
		],
		restore: [
			"uv",
			"tool",
			"install",
			"--reinstall",
			"--python",
			"3.12",
			"pr-agent[github] @ git+https://github.com/The-PR-Agent/pr-agent@{tag}",
		],
	});
	expect(r.suggestions[1]?.spec.update).toEqual(["uv", "tool", "install", "--reinstall", "yt-dlp=={version}"]);
	expect(r.suggestions[2]?.spec.update).toEqual(["pipx", "install", "--force", "black=={version}"]);
	expect(r.suggestions[3]?.spec).toMatchObject({
		name: "@scope/Pkg",
		latest: "npm:@scope/Pkg",
		update: ["npm", "install", "-g", "@scope/Pkg@{version}"],
	});
	expect(r.suggestions[4]?.spec).toMatchObject({
		latest: "crates:ripgrep",
		update: ["cargo", "install", "--locked", "ripgrep@{version}"],
	});
	// The scan only asks each manager for its list; it never runs a tool the managers installed.
	expect(calls.filter((x) => !LISTS.has(x.argv[0] ?? "")).map((x) => x.argv.slice(0, 2).join(" "))).toEqual([
		"uv tool",
		"pipx list",
		"npm ls",
	]);
});

test("scan leaves out manager tools the list already tracks, by key, process, check, update or latest", async () => {
	managers.uv = "pr-agent v0.49.0\nyt-dlp v1.0\nhttpie v3.0\nruff v0.5.0\nblack v1.0\nfree v1.0\n";
	for (const n of ["pr-agent", "yt-dlp", "httpie", "ruff", "black", "free"])
		uvTool(n, `[tool]\nrequirements = [{ name = "${n}" }]\n`);
	const specs: AppSpec[] = [
		{ key: "pr-agent", name: "pr-agent", kind: "command", check: ["pr-agent", "--version"] },
		{ key: "dl", name: "Downloader", kind: "command", check: ["sh", "-c", "uv tool list | grep yt-dlp"] },
		{ key: "http", name: "HTTPie", kind: "manual", process: "httpie" },
		{ key: "r", name: "R", kind: "command", check: ["x"], latest: "pypi:ruff" },
		{ key: "b", name: "B", kind: "command", check: ["x"], update: ["pipx", "install", "--force", "black==1"] },
	];
	const r = await scan(ctx(specs).c);
	expect(r.suggestions.map((x) => x.spec.key)).toEqual(["free"]);
});

test("a tool whose name has a shell character is not offered", async () => {
	managers.npm = JSON.stringify({ dependencies: { "x;rm": { version: "1.0.0" }, "$(id)": { version: "1.0.0" } } });
	expect((await scan(ctx().c)).suggestions).toEqual([]);
});

test("a manager that is missing gives nothing, and a name Add app is given finds the tool a manager installed", async () => {
	expect((await scan(ctx().c)).suggestions).toEqual([]);
	managers.pipx = JSON.stringify({
		venvs: {
			black: { metadata: { main_package: { package: "black", package_version: "24.8.0", package_or_url: "black" } } },
		},
	});
	const r = await suggest("Black", ctx().c);
	expect(r.problem).toBeUndefined();
	expect(r.suggestions.map((x) => [x.spec.key, x.installed, x.source])).toEqual([["black", "24.8.0", "scan"]]);
	expect(await suggest("blackish", ctx().c)).toEqual({ suggestions: [], problem: BAD_INPUT });
	const listed = ctx([{ key: "black", name: "black", kind: "command" }]).c;
	expect(await suggest("black", listed)).toEqual({ suggestions: [], problem: BAD_INPUT });
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
	// A generic repo name whose program the owner does not contain is named by the program.
	expect(appName("glab", "gitlab-org/cli")).toBe("glab");
	expect(appName("", "acme-tools/cli")).toBe("Acme Tools");
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
	expect(calls.filter((x) => !["uv", "pipx", "npm"].includes(x.argv[0] ?? "") && !LISTS.has(x.argv[0] ?? ""))).toEqual(
		[],
	);
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
		if (argv[0] === "which") return argv[1] === "rustdesk" || argv[1] === "dpkg" ? ok(`/usr/bin/${argv[1]}\n`) : none;
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
	expect(
		rec.calls
			.filter((x) => !["which", "tar", "unzip"].includes(x.argv[0] ?? "") && !LISTS.has(x.argv[0] ?? ""))
			.map((x) => x.argv[0]),
	).toEqual(["/usr/bin/rustdesk"]);
});

test("a .deb is offered only where dpkg is: without it, a release of only a .deb runs nothing here", async () => {
	releases["o/debonly"] = { tag_name: "v1.0", assets: [{ name: "debonly_1.0_amd64.deb", size: 1 }] };
	expect((await suggest("o/debonly", ctx().c)).suggestions[0]?.spec.kind).toBe("deb");
	onPath = {};
	expect((await suggest("o/debonly", ctx().c)).problem).toBe(
		"No asset of o/debonly's latest release runs on this machine.",
	);
});

test("an .rpm is offered only where rpm is, and wins over a .deb when only rpm is on PATH", async () => {
	releases["o/rpmonly"] = {
		tag_name: "v1.0",
		// A source rpm sits beside the binary one in many releases and is never offered.
		assets: [
			{ name: "rpmonly-1.0.src.rpm", size: 1 },
			{ name: "rpmonly-1.0.x86_64.rpm", size: 1 },
		],
	};
	onPath = { rpm: "/usr/bin/rpm" };
	const got = (await suggest("o/rpmonly", ctx().c)).suggestions[0];
	expect(got?.spec.kind).toBe("rpm");
	expect(got?.alternatives).toEqual([]);
	expect(got?.spec.sudo).toBe(true);
	expect(got?.spec.dest).toBe("/usr/bin/rpmonly");
	onPath = {};
	expect((await suggest("o/rpmonly", ctx().c)).problem).toBe(
		"No asset of o/rpmonly's latest release runs on this machine.",
	);
	releases["o/both"] = {
		tag_name: "v1.0",
		assets: [
			{ name: "both_1.0_amd64.deb", size: 1 },
			{ name: "both-1.0.x86_64.rpm", size: 1 },
		],
	};
	onPath = { rpm: "/usr/bin/rpm" };
	expect((await suggest("o/both", ctx().c)).suggestions[0]?.spec.kind).toBe("rpm");
	onPath = { dpkg: "/usr/bin/dpkg" };
	expect((await suggest("o/both", ctx().c)).suggestions[0]?.spec.kind).toBe("deb");
	// A Debian system with the rpm tool installed still takes the .deb, and an .rpm-only release runs nothing there.
	onPath = { dpkg: "/usr/bin/dpkg", rpm: "/usr/bin/rpm" };
	expect((await suggest("o/both", ctx().c)).suggestions[0]?.spec.kind).toBe("deb");
	expect((await suggest("o/rpmonly", ctx().c)).problem).toBe(
		"No asset of o/rpmonly's latest release runs on this machine.",
	);
});

test("a release with no file for this machine gets a source build drafted from its Cargo.toml, as a guess", async () => {
	releases["o/tool"] = { tag_name: "v1.2.0", assets: [{ name: "tool-1.2.0-aarch64-apple-darwin.tar.gz", size: 1 }] };
	roots["o/tool"] = {
		"Cargo.toml": '[package]\nname = "tool-cli"\nversion = "1.2.0"\n\n[[bin]]\nname = "tl"\npath = "src/main.rs"\n',
		Makefile: "",
		src: "",
	};
	onPath.cargo = "/home/x/.cargo/bin/cargo";
	const s = (await suggest("o/tool", ctx().c)).suggestions[0];
	expect(s?.spec).toEqual({
		key: "tl",
		name: "tool",
		kind: "source",
		repo: "o/tool",
		dest: "~/.local/bin/tl",
		build: ["cargo install --locked --path . --root ~/.local"],
		install_if_missing: true,
	});
	expect(s?.confidence).toBe("guess");
	expect(s?.latest).toBe("1.2.0");
	expect(s?.problem).toBeUndefined();
	expect(s?.why).toBe(
		"No file of this release runs on this machine, so Upkeep drafted a source build from its Cargo.toml. Read the steps before adding it. Nothing is installed at ~/.local/bin/tl yet, so Install will put it there.",
	);
});

test("a drafted CMake build installs under /usr/local with sudo, and says when its tool is missing", async () => {
	releases["o/thing"] = { tag_name: "v2.0", assets: [] };
	roots["o/thing"] = { "CMakeLists.txt": "", "README.md": "" };
	onPath.sudo = "/usr/bin/sudo";
	const s = (await suggest("o/thing", ctx().c)).suggestions[0];
	expect(s?.spec.build?.[0]).toBe("cmake -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local");
	expect(s?.spec.sudo).toBe(true);
	expect(s?.spec.dest).toBe(join(t.dir, "usr/local/bin/thing"));
	expect(s?.problem).toBe("Building it needs cmake, which is not installed.");
	expect(s?.why).toContain(
		"It takes the program to be thing, after the repo; change the path if the build installs another name.",
	);
	onPath.cmake = "/usr/bin/cmake";
	expect((await suggest("o/thing", ctx().c)).suggestions[0]?.problem).toBeUndefined();
});

test("a repo with no build file Upkeep knows still says no file runs here", async () => {
	releases["o/plain"] = { tag_name: "v1.0", assets: [] };
	roots["o/plain"] = { "README.md": "", "build.zig": "" };
	expect((await suggest("o/plain", ctx().c)).problem).toBe(
		"No asset of o/plain's latest release runs on this machine.",
	);
});

test("a drafted build replaces only the copy where it installs: a stray one elsewhere would pass the check", async () => {
	releases["o/thing"] = { tag_name: "v2.0", assets: [] };
	roots["o/thing"] = { "CMakeLists.txt": "" };
	onPath.cmake = "/usr/bin/cmake";
	onPath.thing = join(t.paths.home, ".local/bin/thing");
	const s = (await suggest("o/thing", ctx().c)).suggestions[0];
	expect(s?.spec.dest).toBe(join(t.dir, "usr/local/bin/thing"));
	// The copy in the home folder runs first on PATH, so the card says to remove it.
	expect(s?.why).toContain(
		"A copy at ~/.local/bin/thing runs first on your PATH; remove it once the build is in, or it keeps running instead.",
	);
	onPath.thing = "/usr/bin/thing";
	expect((await suggest("o/thing", ctx().c)).suggestions[0]?.why).not.toContain("runs first on your PATH");
});

test("a catalogue app with no release file here gets the drafted build as a guess, not its own table as sure", async () => {
	releases["o/cat"] = { tag_name: "v1.0", assets: [{ name: "cat-1.0-aarch64.tar.gz", size: 1 }] };
	roots["o/cat"] = { "go.mod": "module example.com/cat\n" };
	onPath.go = "/usr/bin/go";
	const entry: AppSpec = {
		key: "cat",
		name: "Cat",
		kind: "archive",
		repo: "o/cat",
		asset: "x86_64",
		dest: "~/.local/bin/cat",
	};
	const s = (await suggest("cat", { ...ctx().c, catalogue: [entry] })).suggestions[0];
	expect(s?.spec.kind).toBe("source");
	expect(s?.confidence).toBe("guess");
	expect(s?.source).toBe("repo");
});

test("a catalogue table stays sure when the release's best file is of another kind than the table's", async () => {
	// The table names the archive, so that is the asset opened, not the AppImage the plan would rank first.
	bodies["both-1.0-x86_64-linux.tar.gz"] = await archive({ "both/both": "elf" });
	releases["o/both"] = {
		tag_name: "v1.0",
		assets: [
			{ name: "both-1.0-x86_64.AppImage", size: 1 },
			{ name: "both-1.0-x86_64-linux.tar.gz", size: 1 },
		],
	};
	const entry: AppSpec = {
		key: "both",
		name: "Both",
		kind: "archive",
		repo: "o/both",
		asset: "tar\\.gz$",
		dest: "~/.local/bin/both",
	};
	const s = (await suggest("both", { ...ctx().c, catalogue: [entry] })).suggestions[0];
	expect(s?.spec.kind).toBe("archive");
	expect(s?.source).toBe("catalogue");
	expect(s?.asset?.name).toBe("both-1.0-x86_64-linux.tar.gz");
	// Nothing at the table's dest: it lands in Ready to install.
	expect(s?.spec.install_if_missing).toBe(true);
});

test("a catalogue table: no matching release file is a problem, a picked file keeps a version wildcard, and version_args probe", async () => {
	releases["o/pick"] = {
		tag_name: "v1.2.0",
		assets: [
			{ name: "pick-1.2.0-x86_64.AppImage", size: 1 },
			{ name: "pick-v1.2.0-x86_64-linux.tar.gz", size: 1 },
		],
	};
	bodies["pick-v1.2.0-x86_64-linux.tar.gz"] = await archive({ "pick/pick": "elf" });
	const entry: AppSpec = {
		key: "pick",
		name: "Pick",
		kind: "archive",
		repo: "o/pick",
		asset: "musl\\.tar\\.gz$",
		dest: "~/.local/bin/pick",
		bins: ["pick"],
		version_args: ["version", "-s"],
	};
	const c = { ...ctx().c, catalogue: [entry] };
	// The table names a musl build this release does not ship: no other file stands in for it.
	expect((await suggest("pick", c)).problem).toBe("No release asset matches musl\\.tar\\.gz$.");
	// The table names a file the release has but this machine cannot take: that is what it says.
	const sz = { ...entry, asset: "\\.7z$" };
	releases["o/pick"]?.assets.push({ name: "pick-1.2.0-x86_64-linux.7z", size: 1 });
	expect((await suggest("pick", { ...ctx().c, catalogue: [sz] })).problem).toBe(
		"No asset of o/pick's latest release runs on this machine. Its Linux builds are .7z archives, which Upkeep cannot open yet.",
	);
	releases["o/pick"]?.assets.pop();
	// The person picks the archive in the window: the table keeps a pattern that still matches next release.
	const picked = (await suggest("pick", c, "pick-v1.2.0-x86_64-linux.tar.gz")).suggestions[0];
	expect(picked?.spec.asset).not.toContain("1.2.0");
	expect(new RegExp(picked?.spec.asset ?? "^$").test("pick-v1.3.0-x86_64-linux.tar.gz")).toBe(true);
	// Installed already: the version probe uses the table's own arguments.
	const bin = join(t.paths.home, ".local/bin/pick");
	elf(bin);
	const rec = ctx();
	await suggest("pick", { ...rec.c, catalogue: [{ ...entry, asset: "linux\\.tar\\.gz$" }] });
	expect(rec.calls.some((x) => x.argv[0] === bin && x.argv[1] === "version" && x.argv[2] === "-s")).toBe(true);
	// A table with probe = false never runs the installed program, and its version stays unread.
	const quiet = ctx();
	const s = await suggest("pick", { ...quiet.c, catalogue: [{ ...entry, asset: "linux\\.tar\\.gz$", probe: false }] });
	expect(quiet.calls.some((x) => x.argv[0] === bin)).toBe(false);
	expect(s.suggestions[0]).toMatchObject({ installed: null, spec: { probe: false } });
});

test("a crate cargo installed into a scanned folder is offered once, as cargo's table; an npm name does not hide a program", async () => {
	elf(join(t.paths.home, ".local/bin/freeze"));
	await Bun.write(
		join(t.paths.home, ".cargo/.crates2.json"),
		JSON.stringify({
			installs: { "freeze 1.0.0 (registry+https://github.com/rust-lang/crates.io-index)": { bins: ["freeze"] } },
		}),
	);
	expect((await scan(ctx().c)).suggestions.map((x) => [x.spec.key, x.spec.kind])).toEqual([["freeze", "command"]]);
	rmSync(join(t.paths.home, ".cargo"), { recursive: true });
	managers.npm = JSON.stringify({ dependencies: { freeze: { version: "1.0.0" } } });
	expect((await scan(ctx().c)).suggestions.map((x) => x.spec.kind).toSorted()).toEqual(["command", "file"]);
});

test("Add app from a GitLab link, a Codeberg repo and a self-hosted forge a table already names", async () => {
	const forges: FetchLike = async (url, init) => {
		fetched.push(url);
		if (url.startsWith("https://gitlab.com/api/v4/projects/gitlab-org%2Fgitlab-runner/"))
			return Response.json(gitlabRelease);
		if (url.startsWith("https://codeberg.org/api/v1/repos/forgejo/forgejo/")) return Response.json(codebergRelease);
		if (url.startsWith("https://git.example.org/api/v1/repos/me/forgejo/")) return Response.json(codebergRelease);
		if (url.startsWith("https://gitlab.com/api/")) return new Response('{"message":"404 Not Found"}', { status: 404 });
		return fakeFetch(url, init);
	};
	const runner = await suggest("https://gitlab.com/gitlab-org/gitlab-runner/-/releases", { ...ctx().c, fetch: forges });
	expect(runner.suggestions[0]?.spec).toMatchObject({
		kind: "file",
		repo: "gitlab.com/gitlab-org/gitlab-runner",
		asset: "^gitlab-runner-linux-amd64$",
		dest: "~/.local/bin/gitlab-runner",
	});
	expect(runner.suggestions[0]?.spec.forge).toBeUndefined();
	const forgejo = await suggest("codeberg.org/forgejo/forgejo", { ...ctx().c, fetch: forges });
	expect(forgejo.suggestions[0]?.spec).toMatchObject({
		kind: "file",
		repo: "codeberg.org/forgejo/forgejo",
		name: "forgejo",
	});
	expect(forgejo.suggestions[0]?.latest).toBe("17.0.1");
	expect(await suggest("https://gitlab.com/no/such", { ...ctx().c, fetch: forges })).toEqual({
		suggestions: [],
		problem: "gitlab.com/no/such has no published release.",
	});
	const known: AppSpec = {
		key: "other",
		name: "Other",
		kind: "file",
		repo: "git.example.org/me/other",
		forge: "gitea",
		asset: "x",
		dest: "~/x",
	};
	const own = await suggest("https://git.example.org/me/forgejo", { ...ctx([known]).c, fetch: forges });
	expect(own.suggestions[0]?.spec).toMatchObject({ repo: "git.example.org/me/forgejo", forge: "gitea" });
	expect(await suggest("https://git.example.org/me/forgejo", { ...ctx().c, fetch: forges })).toEqual({
		suggestions: [],
		problem: BAD_INPUT,
	});
	// No GitHub contents listing is asked of another forge: a drafted build is GitHub's alone.
	expect(fetched.some((u) => u.includes("/contents"))).toBe(false);
});

/** The asset names machineAssets keeps for an aarch64 machine, best first. */
const onArm = (list: string[]) =>
	machineAssets(
		list.map((name) => ({ name, url: "", size: 1, digest: null })),
		[],
		"aarch64",
	).candidates.map((c) => c.asset.name);

test("on aarch64 the asset filter keeps only builds that name aarch64 or arm64, on five real releases", () => {
	expect(onArm(names(fdRelease).map((a) => a.name))).toEqual([
		"fd-v10.5.2-aarch64-unknown-linux-gnu.tar.gz",
		"fd-v10.5.2-aarch64-unknown-linux-musl.tar.gz",
		"fd_10.5.2_arm64.deb",
		"fd-musl_10.5.2_arm64.deb",
	]);
	expect(onArm(catalogueAssets.ripgrep.assets)).toEqual([
		"ripgrep-15.2.0-aarch64-unknown-linux-gnu.tar.gz",
		"ripgrep-15.2.0-aarch64-unknown-linux-musl.tar.gz",
	]);
	expect(onArm(names(lazygitRelease).map((a) => a.name))).toEqual(["lazygit_0.66.3_linux_arm64.tar.gz"]);
	const zen = machineAssets(names(zenRelease), [], "aarch64");
	expect(zen.candidates.map((c) => c.asset.name)).toEqual(["zen-aarch64.AppImage", "zen.linux-aarch64.tar.xz"]);
	expect(zen.unopened).toBe(false);
	// The unsigned archive names no architecture: on an arm64 machine that is an x86_64 build, so it is left out.
	expect(machineAssets(names(rustdeskRelease), [], "aarch64").candidates.map((c) => [c.asset.name, c.kind])).toEqual([
		["rustdesk-1.5.1-aarch64.AppImage", "appimage"],
		["rustdesk-1.5.1-aarch64.deb", "deb"],
		["rustdesk-1.5.1-0.aarch64.rpm", "rpm"],
		["rustdesk-1.5.1-0.aarch64-suse.rpm", "rpm"],
	]);
	expect(machineAssets(names(rustdeskRelease), ["rpm"], "aarch64").candidates[0]?.asset.name).toBe(
		"rustdesk-1.5.1-0.aarch64.rpm",
	);
	// x86_64 in any spelling, 32-bit arm and a bare name are out; a package for every architecture is in.
	expect(
		onArm([
			"t-x86_64.tar.gz",
			"t_amd64.deb",
			"t-linux-x64.zip",
			"t-armhf.tar.gz",
			"t-armv7.tar.gz",
			"t.tar.gz",
			"t_1.0_all.deb",
			"t-1.0.noarch.rpm",
			"t-linux-arm64.tar.gz",
		]),
	).toEqual(["t-linux-arm64.tar.gz", "t_1.0_all.deb", "t-1.0.noarch.rpm"]);
});

const FD_ARM: AppSpec = { ...(CATALOGUE[0] as AppSpec), asset_aarch64: "aarch64-unknown-linux-gnu\\.tar\\.gz$" };

/** The fd aarch64 archives as real tarballs, so a lookup inside finds the program. */
async function fdArm() {
	for (const libc of ["gnu", "musl"]) {
		const top = `fd-v10.5.2-aarch64-unknown-linux-${libc}`;
		// oxlint-disable-next-line no-await-in-loop -- both archives share one temp tree
		bodies[`${top}.tar.gz`] = await archive({ [`${top}/fd`]: "elf" });
	}
}

test("on aarch64 a catalogue table's aarch64 pattern picks the file, and a picked file is kept in that field", async () => {
	await fdArm();
	const c = { ...ctx().c, catalogue: [FD_ARM], arch: "aarch64" as const };
	const r = await suggest("fd", c);
	expect(r.problem).toBeUndefined();
	expect(r.suggestions[0]).toMatchObject({
		spec: FD_ARM,
		source: "catalogue",
		asset: { name: "fd-v10.5.2-aarch64-unknown-linux-gnu.tar.gz" },
		alternatives: ["fd-v10.5.2-aarch64-unknown-linux-musl.tar.gz", "fd_10.5.2_arm64.deb", "fd-musl_10.5.2_arm64.deb"],
	});
	const picked = await suggest("fd", c, "fd-v10.5.2-aarch64-unknown-linux-musl.tar.gz");
	expect(picked.suggestions[0]?.spec).toEqual({
		...FD_ARM,
		install_if_missing: true,
		asset_aarch64: "^fd-.*-aarch64-unknown-linux-musl\\.tar\\.gz$",
	});
	// The same table on an x86_64 machine still takes its x86_64 pattern.
	const x86 = await suggest("fd", { ...ctx().c, catalogue: [FD_ARM] });
	expect(x86.suggestions[0]?.asset?.name).toBe("fd-v10.5.2-x86_64-unknown-linux-gnu.tar.gz");
});

test("on aarch64 a catalogue table with no aarch64 pattern is not offered, and nothing is looked up", async () => {
	const c = { ...ctx().c, catalogue: CATALOGUE, arch: "aarch64" as const };
	expect(await suggest("fd", c)).toEqual({
		suggestions: [],
		problem: "The table for fd names no release file for aarch64 machines.",
	});
	expect(fetched).toEqual([]);
	// A command table names no release file and is offered on any machine.
	expect((await suggest("claude", c)).suggestions[0]?.spec).toEqual(CATALOGUE[1]);
});

test("on aarch64 an app added by repo keeps its pattern as asset_aarch64, named without the architecture", async () => {
	await fdArm();
	const r = await suggest("sharkdp/fd", { ...ctx().c, arch: "aarch64" });
	const spec = r.suggestions[0]?.spec;
	expect(spec).toMatchObject({ key: "fd", name: "fd", asset_aarch64: "^fd-.*-aarch64-unknown-linux-gnu\\.tar\\.gz$" });
	expect(spec?.asset).toBeUndefined();
	expect(spec && tomlTable(spec)).toContain("asset_aarch64 = '^fd-.*-aarch64-unknown-linux-gnu\\.tar\\.gz$'");
});

test("on arm64 a file's name loses its arm suffix too, and a file naming arm64 beside another arch is no arm64 build", () => {
	expect(bareName("/home/owner/bin/tool-linux-arm64.AppImage")).toBe("tool");
	expect(bareName("rustdesk-aarch64.AppImage")).toBe("rustdesk");
	expect(bareName("tool-linux-x86_64.AppImage")).toBe("tool");
	const asset = (name: string) => ({ name, url: "", size: 1, digest: null });
	const names = machineAssets(
		[
			asset("tool-arm64-armv7-bundle.tar.gz"),
			asset("tool-linux-arm64.tar.gz"),
			asset("tool-i686-arm64.tar.gz"),
			asset("tool-x86_64-arm64-universal.tar.gz"),
			// armv8 is arm64 itself, and x64 inside a word names nothing.
			asset("other-linux-aarch64-armv8.tar.gz"),
			asset("third-arm64-x64ffmpeg.tar.gz"),
		],
		[],
		"aarch64",
	).candidates.map((c) => c.asset.name);
	expect(names.toSorted()).toEqual([
		"other-linux-aarch64-armv8.tar.gz",
		"third-arm64-x64ffmpeg.tar.gz",
		"tool-linux-arm64.tar.gz",
	]);
});

test("scan takes a catalogue app found at its table's dest from the catalogue, and not the programs its archive brings", async () => {
	releases["sharkdp/fd"] = {
		tag_name: "v10.0.0",
		assets: [{ name: "fd-v10.0.0-x86_64-unknown-linux-gnu.tar.gz", size: 2_000_000 }],
	};
	// SAFETY: CATALOGUE[0] is the fd table written above, so the spread holds every AppSpec field.
	const entry = { ...CATALOGUE[0], bins: ["fd-x/fd", "fd-x/fdx"] } as AppSpec;
	elf(join(t.paths.home, ".local/bin/fd"));
	elf(join(t.paths.home, ".local/bin/fdx"));
	const { c, calls } = ctx();
	const r = await scan({ ...c, catalogue: [entry] });
	expect(r.suggestions.map((s) => [s.spec.key, s.confidence, s.source, s.spec.asset, s.path])).toEqual([
		["fd", "sure", "scan", entry.asset, join(t.paths.home, ".local/bin/fd")],
	]);
	// The table is the catalogue's, so no name search was spent on it; nothing was downloaded and nothing found ran.
	expect(fetched.some((u) => u.includes("/search/") || u.startsWith("https://dl.test/"))).toBe(false);
	expect(calls.some((x) => x.argv.some((a) => a.includes(".local/bin/fd")))).toBe(false);
});

test("a catalogue app found through latest (json:) with nothing at its dest lands in Ready to install", async () => {
	const cursor: AppSpec = {
		key: "cursor",
		name: "Cursor",
		kind: "appimage",
		asset: "\\.AppImage$",
		dest: "~/.local/bin/cursor.appimage",
		latest: "json:https://api.test/cursor",
	};
	const ask = () => suggest("cursor", { ...ctx().c, catalogue: [cursor] });
	expect((await ask()).suggestions[0]?.spec.install_if_missing).toBe(true);
	// Installed already: the table stays as the catalogue wrote it.
	elf(join(t.paths.home, ".local/bin/cursor.appimage"), { image: true });
	expect((await ask()).suggestions[0]?.spec.install_if_missing).toBeUndefined();
});

test("a catalogue app the rate limit stops ends the scan there, as a search does", async () => {
	const bin = join(t.paths.home, ".local/bin");
	elf(join(bin, "fd"));
	elf(join(bin, "zzz"));
	const { c } = ctx();
	const limited: FetchLike = async (url, init) =>
		url.includes("/releases/latest")
			? new Response('{"message":"API rate limit exceeded"}', { status: 403 })
			: fakeFetch(url, init);
	const r = await scan({ ...c, fetch: limited, catalogue: CATALOGUE });
	expect(r.suggestions.map((s) => s.path)).toEqual([join(bin, "fd")]);
	expect(fetched.some((u) => u.includes("/search/"))).toBe(false);
});

test("a clone build not installed yet lands in Ready to install; a tool that updates itself says it shows up once installed", async () => {
	const tmux: AppSpec = {
		key: "tmux",
		name: "tmux",
		kind: "source",
		repo: "tmux/tmux",
		dest: "/nonexistent/upkeep-test/tmux",
		build: ["make"],
	};
	const claude = CATALOGUE[1];
	if (!claude) throw new Error("no claude table");
	const c = { ...ctx().c, catalogue: [tmux, claude] };
	expect((await suggest("tmux", c)).suggestions[0]?.spec.install_if_missing).toBe(true);
	// claude is not on the fake PATH.
	const tool = (await suggest("claude", c)).suggestions[0];
	expect(tool?.spec.install_if_missing).toBeUndefined();
	expect(tool?.why).toBe(`${CATALOGUE_WHY} ${MESSAGES.notInstalledYet("Claude Code")}`);
	onPath.claude = "/usr/bin/claude";
	expect((await suggest("claude", c)).suggestions[0]?.why).toBe(CATALOGUE_WHY);
});

test("a suggestion says what else keeps the app up to date, and can still be added", async () => {
	const zen: AppSpec = {
		key: "zen",
		name: "Zen Browser",
		kind: "appimage",
		asset: "\\.AppImage$",
		dest: "~/.local/bin/zen.appimage",
		latest: "json:https://api.test/zen",
	};
	systemLists.flatpak = "app.zen_browser.zen\tZen Browser\nio.github.other.App\tOther\n";
	systemLists.snap = "Name  Version  Rev  Tracking  Publisher  Notes\nzen-browser  1.0  1  latest/stable  x  -\n";
	const listed: AppSpec = { ...zen, key: "zen-old", name: "Zen (old table)" };
	const s = (await suggest("zen", { ...ctx([listed]).c, catalogue: [zen] })).suggestions[0];
	expect(s?.problem).toBeUndefined();
	expect(s?.also).toEqual([
		MESSAGES.alsoFlatpak("Zen Browser", "app.zen_browser.zen"),
		MESSAGES.alsoSnap("Zen Browser", "zen-browser"),
		MESSAGES.alsoSameDest("Zen (old table)"),
	]);
	// Nothing else installed: no note.
	systemLists = {};
	expect((await suggest("zen", { ...ctx().c, catalogue: [zen] })).suggestions[0]?.also).toBeUndefined();
});

test("a package app apt also knows from a repository says the system's updates install it too", async () => {
	const deb: AppSpec = {
		key: "rustdesk",
		name: "RustDesk",
		kind: "deb",
		repo: "rustdesk/rustdesk",
		dest: "/usr/bin/rustdesk",
	};
	expect(copiesOf("rustdesk", "RustDesk", { flatpaks: [], snaps: [] })).toEqual({ flatpak: null, snap: null });
	systemLists["apt-cache"] =
		"rustdesk:\n  Installed: 1.5.3\n  Version table:\n *** 1.5.3 500\n        500 https://repo.test/apt stable/main amd64 Packages\n        100 /var/lib/dpkg/status\n";
	const run = ctx().c.run;
	expect(await aptRepoHas({ run }, "rustdesk")).toBe(true);
	systemLists["apt-cache"] =
		"rustdesk:\n  Installed: 1.5.3\n  Version table:\n *** 1.5.3 100\n        100 /var/lib/dpkg/status\n";
	expect(await aptRepoHas({ run }, "rustdesk")).toBe(false);
	void deb;
});

test("scan finds a catalogue package app installed outside home, at its table's dest", async () => {
	const dest = join(t.dir, "usr/bin/rd");
	elf(dest);
	releases["rustdesk/rustdesk"] = {
		tag_name: "1.5.3",
		assets: [{ name: "rustdesk-1.5.3-x86_64.deb", size: 30_000_000 }],
	};
	const deb: AppSpec = {
		key: "rustdesk",
		name: "RustDesk",
		kind: "deb",
		repo: "rustdesk/rustdesk",
		asset: "^rustdesk-[0-9.]+-x86_64\\.deb$",
		dest,
	};
	const r = await scan({ ...ctx().c, catalogue: [deb] });
	expect(r.suggestions.map((s) => [s.spec.key, s.source, s.path, s.confidence])).toEqual([
		["rustdesk", "scan", dest, "sure"],
	]);
	// Already in the list: not offered again.
	expect((await scan({ ...ctx([deb]).c, catalogue: [deb] })).suggestions).toEqual([]);
});

test("Add app names the program a tarball needs when the system lacks it", async () => {
	releases["o/needxz"] = { tag_name: "v1.0", assets: [{ name: "needxz-1.0-x86_64-linux.tar.xz", size: 3 }] };
	bodies["needxz-1.0-x86_64-linux.tar.xz"] = new Uint8Array([1, 2, 3]);
	const base = ctx().c;
	// GNU tar on a system without xz (Ubuntu's minimal images).
	const run = Object.assign(
		async (argv: string[], opts?: Parameters<typeof base.run>[1]) =>
			argv[0] === "tar"
				? { code: 2, stdout: "", stderr: "tar (child): xz: Cannot exec: No such file or directory", timedOut: false }
				: base.run(argv, opts),
		base.run,
	);
	expect((await suggest("o/needxz", { ...base, run })).problem).toBe(
		"Opening needxz-1.0-x86_64-linux.tar.xz needs the xz program, which is not installed. Install xz from the system's packages, then try again.",
	);
});
