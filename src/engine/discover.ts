import {
	closeSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import type { AppKind, AppSpec, Suggestion } from "../shared/types";
import { download, verifyAsset } from "./download";
import {
	type Asset,
	type FetchLike,
	fetchRelease,
	isFailure,
	parseRepoSearch,
	type Release,
	type RepoHit,
} from "./github";
import { expandHome, type Paths } from "./paths";
import { probeVersion } from "./probe";
import type { Run } from "./run";

export type DiscoverCtx = {
	paths: Paths;
	run: Run;
	fetch: FetchLike;
	token: string | null;
	/** The apps already in the list. */
	specs: AppSpec[];
	/** Tested tables, looked up by name, key or repo before anything is guessed. */
	catalogue?: AppSpec[];
	log: (text: string) => void;
	/** Tests point this at a local server. The token is only ever sent to the real one. */
	api?: string;
	/** Where the owner's own system-wide installs live. Default /usr/local; tests point it at a temp dir. */
	usrLocal?: string;
	/** The pause between two name searches during a scan. Default 300 ms. */
	searchGapMs?: number;
};

export const BAD_INPUT = "Give an app's name, a GitHub repo like owner/name, a github.com link, or a file path.";
export const CATALOGUE_WHY = "From Upkeep's catalogue of tested apps.";

/** The kinds whose table names a release asset, so a catalogue entry of one is looked up on GitHub for today's release. */
const RELEASE_KINDS = new Set<AppKind>(["appimage", "archive", "file", "deb"]);

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** A repo, a file path, or null when the input is neither. */
export function readInput(input: string): { repo: string } | { file: string } | null {
	const text = input.trim();
	if (text.startsWith("/") || text.startsWith("~/") || text.startsWith("file://")) return { file: text };
	const parts = text.split("/");
	if (parts.length === 2 && parts.every((p) => SEGMENT.test(p))) return { repo: text };
	try {
		const url = new URL(text);
		if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
		const [owner, name] = url.pathname.split("/").filter(Boolean);
		const repo = name?.replace(/\.git$/, "");
		if (owner && repo && SEGMENT.test(owner) && SEGMENT.test(repo)) return { repo: `${owner}/${repo}` };
	} catch {
		// not a URL
	}
	return null;
}

const OTHER_SYSTEM =
	/darwin|macos|osx|apple|windows|win32|win64|\.exe$|\.msi$|\.dmg$|\.pkg$|android|freebsd|netbsd|openbsd/i;
const OTHER_ARCH =
	/arm64|aarch64|armv|arm-|armhf|armel|i[3-6]86|ia32|32-?bit|x86-32|x86(?![_-]64)|[_-]386(?![0-9])|ppc64|riscv|s390x|loong|mips/i;
// An asset that names this machine outright beats one that names no architecture.
const THIS_MACHINE = /x86_64|x86-64|amd64|x64|64-?bit/i;
const SIDE_FILE = /\.(sha256|sha512|sig|asc|zsync|sbom|json|txt|pem|minisig)$/i;
const OTHER_PACKAGE = /\.(rpm|apk|pacman|flatpak|snap)$/i;
const UNOPENED = /\.(tar\.xz|tar\.zst|tar\.bz2|7z)$/i;
const TRIPLE = /x86_64-unknown-linux-(gnu|musl)$/i;

export type Candidate = { asset: Asset; kind: AppKind };

/** The installable kind of an asset name, "unopened" for an archive the installer cannot open, null for anything else. */
export function kindOf(name: string): AppKind | "unopened" | null {
	const n = name.toLowerCase();
	if (n.endsWith(".appimage")) return "appimage";
	if (n.endsWith(".deb")) return "deb";
	if (n.endsWith(".tar.gz") || n.endsWith(".tgz") || n.endsWith(".zip")) return "archive";
	if (UNOPENED.test(n)) return "unopened";
	// A trailing ".3" is a version, not an extension.
	if (!/\.[a-z][a-z0-9]*$/.test(n) || n.endsWith("-gh") || TRIPLE.test(n)) return "file";
	return null;
}

/** The kind order of the plan: AppImage, then gnu, musl and other archives, then a bare file, then a deb last. */
function rank(c: Candidate): number {
	const n = c.asset.name.toLowerCase();
	if (c.kind === "appimage") return 0;
	if (c.kind === "archive") return n.includes("gnu") ? 1 : n.includes("musl") ? 2 : 3;
	return c.kind === "file" ? 4 : 5;
}

/** The release's assets that run on Linux x86_64, best first; prefer puts kinds that match what is on disk ahead. */
export function machineAssets(assets: Asset[], prefer: AppKind[] = []) {
	const candidates: Candidate[] = [];
	let unopened = false;
	for (const asset of assets) {
		const name = asset.name;
		if (OTHER_SYSTEM.test(name) || OTHER_ARCH.test(name) || SIDE_FILE.test(name) || OTHER_PACKAGE.test(name)) continue;
		const kind = kindOf(name);
		if (kind === "unopened") unopened = true;
		else if (kind) candidates.push({ asset, kind });
	}
	const preferred = (c: Candidate) => (prefer.includes(c.kind) ? 0 : 1);
	const named = (c: Candidate) => (THIS_MACHINE.test(c.asset.name) ? 0 : 1);
	// Within a rank the shortest name is the plain build; variants add words (sciter, unattended, musl).
	const sorted = candidates.toSorted(
		(a, b) =>
			preferred(a) - preferred(b) ||
			rank(a) - rank(b) ||
			named(a) - named(b) ||
			a.asset.name.length - b.asset.name.length,
	);
	return { candidates: sorted, unopened };
}

/** Escapes every regex metacharacter, so a file name is matched as plain text. */
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * An anchored pattern for name with the release's version made a wildcard. When that matches more
 * than one asset the pattern is the exact name, and widen says it will need editing at the next release.
 */
export function assetPattern(name: string, release: Pick<Release, "tag" | "version" | "assets">) {
	const versions = [release.tag, release.version, release.version ? `v${release.version}` : null]
		.filter((v): v is string => Boolean(v))
		.toSorted((a, b) => b.length - a.length);
	// ".*" first; when that also catches a variant, a wildcard that only spans a version.
	for (const wild of [".*", "[0-9][0-9A-Za-z.]*"]) {
		let body = escape(name);
		for (const v of versions) body = body.split(escape(v)).join(v.startsWith("v") && wild !== ".*" ? `v${wild}` : wild);
		const pattern = `^${body}$`;
		const re = new RegExp(pattern);
		if (release.assets.filter((a) => re.test(a.name)).length === 1) return { pattern, widen: false };
	}
	return { pattern: `^${escape(name)}$`, widen: versions.some((v) => name.includes(v)) };
}

/** The repo name as a person reads it: "zen-browser" becomes "Zen Browser", a lower-case tool like "fd" stays. */
export function displayName(repoName: string): string {
	if (repoName === repoName.toLowerCase() && !/[-_]/.test(repoName)) return repoName;
	return repoName
		.split(/[-_]+/)
		.filter(Boolean)
		.map((w) => w[0]?.toUpperCase() + w.slice(1))
		.join(" ");
}

/** Lower case with anything but letters, digits and dashes made a dash, so the key is a bare TOML key. */
export const keyOf = (repoName: string) => repoName.toLowerCase().replace(/[^a-z0-9-]/g, "-");

const EXTENSION = /\.(tar\.gz|tgz|zip|appimage|deb|tar\.xz|tar\.zst|tar\.bz2|7z)$/i;
const NOISE = new Set(["linux", "gnu", "musl", "unknown", "pc", "appimage", "setup", "installer", "portable", "bin"]);

/**
 * What an asset ships, in its own casing: the name without extension, version, architecture and system
 * words. "fd-v10.5.2-x86_64-unknown-linux-gnu.tar.gz" is "fd", "Obsidian-1.9.4.AppImage" is "Obsidian".
 */
export function stem(asset: string, release: Pick<Release, "tag" | "version">): string {
	let s = asset.replace(EXTENSION, "");
	const versions = [release.tag, release.version, release.version ? `v${release.version}` : null]
		.filter((v): v is string => Boolean(v))
		.toSorted((a, b) => b.length - a.length);
	for (const v of versions) s = s.split(v).join("-");
	s = s.replace(/x86[_-]64|amd64|x64/gi, "-");
	return s
		.split(/[-_.\s]+/)
		.filter((t) => t && !NOISE.has(t.toLowerCase()) && !/^v?\d+$/i.test(t))
		.join("-");
}

// Repo names that say nothing about the app: the owner names it instead.
const GENERIC_REPO = new Set([
	"desktop",
	"app",
	"releases",
	"release",
	"linux",
	"client",
	"core",
	"cli",
	"main",
	"bin",
	"dist",
	"builds",
]);

/** The name a person reads: the asset's own capitals, else the owner for a generic repo name, else the repo. */
export function appName(shipped: string, repo: string): string {
	const [owner = repo, repoName = repo] = repo.split("/");
	if (shipped.length >= 2 && shipped !== shipped.toLowerCase()) return shipped;
	if (GENERIC_REPO.has(repoName.toLowerCase())) return displayName(owner);
	return displayName(repoName);
}

/** The first 64 kB of a file, or null when it cannot be read. */
export function head(file: string, bytes = 65_536, at = 0): Buffer | null {
	let fd: number | null = null;
	try {
		fd = openSync(file, "r");
		const buf = Buffer.alloc(bytes);
		const n = readSync(fd, buf, 0, bytes, at);
		return buf.subarray(0, n);
	} catch {
		return null;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

/** False for a null or short head, so an unreadable file is never taken for a program. */
export const isElf = (b: Buffer | null) =>
	b !== null && b.length >= 4 && b.subarray(0, 4).toString("latin1") === "\x7fELF";
/** Checks the AppImage type-2 magic at byte 8 as well as the ELF header; a type-1 image does not count. */
export const isAppImage = (b: Buffer | null) =>
	isElf(b) && b !== null && b.length >= 11 && b.subarray(8, 11).toString("latin1") === "AI\x02";

/** A path under home written with ~, as apps.toml keeps it. A path elsewhere is returned as given. */
const tilde = (p: string, home: string) => (p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);

/** The installed AppImage of a repo: a regular file in the owner's app folders named after it. */
function findAppImage(ctx: DiscoverCtx, bin: string): string | null {
	for (const dir of [".local/bin", "Applications", "bin"]) {
		const root = join(ctx.paths.home, dir);
		let names: string[];
		try {
			names = readdirSync(root);
		} catch {
			continue;
		}
		for (const n of names.toSorted()) {
			const p = join(root, n);
			if (!n.toLowerCase().startsWith(bin)) continue;
			try {
				if (!lstatSync(p).isFile()) continue;
			} catch {
				continue;
			}
			if (isAppImage(head(p, 16))) return p;
		}
	}
	return null;
}

/** The path `which` prints for bin, as printed: a symlink on PATH is the dest, not its target. */
async function which(ctx: DiscoverCtx, bin: string): Promise<string | null> {
	const r = await ctx.run(["which", bin], { timeoutMs: 5000 });
	const p = r.code === 0 ? r.stdout.trim().split("\n")[0] : "";
	return p ? p : null;
}

export type RepoOpts = {
	/** The asset the owner picked. */
	asset?: string;
	/** A file on disk the suggestion is for: its kind decides the asset, and it is the dest. */
	file?: { path: string; appimage: boolean };
	source?: Suggestion["source"];
	confidence?: Suggestion["confidence"];
	/** The sentence on how the repo was found, put before the asset sentence. */
	found?: string;
	/** Run the version probe on dest. Never during a scan. */
	probe?: boolean;
};

export type RepoResult = { suggestion: Suggestion } | { problem: string; rate?: boolean };

/** A suggestion from a repo's latest release. */
export async function fromRepo(repo: string, ctx: DiscoverCtx, opts: RepoOpts = {}): Promise<RepoResult> {
	const release = await fetchRelease(repo, {
		cacheDir: join(ctx.paths.cache, "github"),
		token: ctx.token,
		fetch: ctx.fetch,
		api: ctx.api,
	});
	if (isFailure(release)) {
		if (release.failure === "http" && release.detail.includes(" 404 "))
			return { problem: `${repo} has no published release.` };
		return { problem: release.detail, rate: release.failure === "rate" };
	}
	if (!release.version) return { problem: `The latest tag ${release.tag} is not a version Upkeep can compare.` };
	const repoName = repo.split("/")[1] ?? repo;
	const home = ctx.paths.home;
	// An app is named after what it ships: the shortest stem of its builds, since variants add words
	// ("rustdesk-unsigned"). A stem too short to mean anything falls back to the repo.
	const shippedBy = (c: Candidate | undefined) => (c ? stem(c.asset.name, release) : "");
	const stems = machineAssets(release.assets)
		.candidates.map((c) => shippedBy(c).toLowerCase())
		.filter((x) => x.length >= 2)
		.toSorted((x, y) => x.length - y.length);
	const bin = stems[0] ?? repoName.toLowerCase();

	// What is on disk decides which kinds lead, and where the app goes.
	const image = opts.file ? null : findAppImage(ctx, bin);
	const onPath = opts.file ? null : await which(ctx, bin);
	let prefer: AppKind[] = [];
	if (opts.file) prefer = opts.file.appimage ? ["appimage"] : ["archive", "file"];
	else if (image) prefer = ["appimage"];
	// A program outside the home directory came from a package.
	else if (onPath) prefer = onPath.startsWith(`${home}/`) ? ["archive", "file"] : ["deb"];
	const { candidates, unopened } = machineAssets(release.assets, prefer);
	const usable = opts.file ? candidates.filter((c) => prefer.includes(c.kind)) : candidates;
	const picked = (opts.asset ? usable.find((c) => c.asset.name === opts.asset) : undefined) ?? usable[0];
	if (!picked) {
		const problem = `No asset of ${repo}'s latest release runs on this machine.`;
		return {
			problem: unopened
				? `${problem} Its Linux builds are .tar.xz, .tar.zst, .tar.bz2 or .7z archives, which Upkeep cannot open yet.`
				: problem,
		};
	}
	const kind = picked.kind;
	let dest: string;
	if (opts.file) dest = opts.file.path;
	else if (kind === "appimage") dest = image ?? join(home, ".local/bin", `${bin}.AppImage`);
	else if (kind === "deb") dest = onPath ?? `/usr/bin/${bin}`;
	else dest = onPath ?? join(home, ".local/bin", bin);
	// A program on PATH outside home and /usr/local belongs to the package manager: never install over it.
	let systemCopy: string | null = null;
	let rootDest = false;
	const place = (found: string | null, program: string) => {
		const usrLocal = ctx.usrLocal ?? "/usr/local";
		systemCopy = null;
		rootDest = false;
		if (!found || found.startsWith(`${home}/`)) return found ?? join(home, ".local/bin", program);
		if (found.startsWith(`${usrLocal}/`)) {
			rootDest = true;
			return found;
		}
		systemCopy = found;
		return join(home, ".local/bin", program);
	};
	if (!opts.file && (kind === "archive" || kind === "file")) dest = place(onPath, bin);
	const name = appName(shippedBy(picked), repo);
	const key = keyOf(bin);
	const { pattern, widen } = assetPattern(picked.asset.name, release);
	let bins = kind === "archive" ? [opts.file ? (dest.split("/").at(-1) ?? bin) : bin] : undefined;
	let installs: string | null = null;
	// A program's name cannot be guessed from the repo (ripgrep ships rg): look inside, but never during a scan.
	if (kind === "archive" && opts.probe !== false && picked.asset.size <= LOOK_INSIDE_MAX) {
		const found = await programsIn(picked.asset, ctx, key);
		if ("problem" in found) return { problem: found.problem };
		const want = opts.file ? (dest.split("/").at(-1) ?? bin) : bin;
		const lead = found.programs.find((p) => baseOf(p) === want) ?? found.programs[0] ?? want;
		bins = [lead, ...found.programs.filter((p) => p !== lead)];
		if (!opts.file) dest = place(await which(ctx, baseOf(lead)), baseOf(lead));
		installs = `It installs ${bins.map(baseOf).join(", ")}.`;
		if (found.more) installs += ` The archive holds ${found.more} programs; only the first ${MAX_BINS} are listed.`;
	}
	const spec: AppSpec = { key, name, kind, repo, asset: pattern, dest: tilde(dest, home) };
	if (bins) spec.bins = bins;
	if (kind === "deb" || rootDest) spec.sudo = true;
	const exists = existsSync(dest);
	if (!exists) spec.install_if_missing = true;

	const why = [
		opts.found,
		`Matched ${picked.asset.name} for this machine.`,
		installs ?? (systemCopy ? `It installs ${bin}.` : null),
	];
	if (systemCopy)
		why.push(
			`A copy at ${systemCopy} comes from the system's packages, so Upkeep will keep its own at ${spec.dest}, which comes first on your PATH.`,
		);
	else if (!opts.file)
		why.push(
			exists
				? `Found it installed at ${spec.dest}.`
				: `Nothing is installed at ${spec.dest} yet, so Install will put it there.`,
		);
	if (widen) why.push("The pattern is this release's exact asset name and will need widening.");
	let installed: string | null = null;
	// The system's copy is not the one Upkeep keeps, so its version is not "installed".
	if (exists && opts.probe !== false && !systemCopy) {
		const p = await probeVersion(dest, ["--version"], { run: ctx.run });
		if ("version" in p) installed = p.version;
		else why.push("Could not read the installed version with --version.");
	}
	const suggestion: Suggestion = {
		spec,
		installed,
		latest: release.version,
		asset: { name: picked.asset.name, size: picked.asset.size },
		alternatives: usable.filter((c) => c !== picked).map((c) => c.asset.name),
		source: opts.source ?? "repo",
		confidence: opts.confidence ?? "sure",
		why: why.filter(Boolean).join(" "),
	};
	if (opts.file) suggestion.path = opts.file.path;
	if (ctx.specs.some((s) => s.key === key)) suggestion.problem = `${name} is already in the list.`;
	return { suggestion };
}

const LOOK_INSIDE_MAX = 150 * 1024 * 1024;
const MAX_BINS = 6;
/** The last path segment; a path ending in a slash gives an empty string. */
const baseOf = (p: string) => p.split("/").at(-1) ?? p;

/**
 * The programs an archive holds, as archive paths: regular files with ELF magic and an execute bit. The
 * asset is downloaded and checked, listed, unpacked under cache/dl, read, and deleted again.
 */
export async function programsIn(
	asset: Asset,
	ctx: DiscoverCtx,
	key: string,
): Promise<{ programs: string[]; more: number } | { problem: string }> {
	const dl = join(ctx.paths.cache, "dl");
	const file = join(dl, `discover-${key}-${asset.name}`);
	let dir = "";
	try {
		verifyAsset(await download(asset.url, file, { fetch: ctx.fetch }), asset);
		const zip = asset.name.toLowerCase().endsWith(".zip");
		const list = await ctx.run(zip ? ["unzip", "-Z1", file] : ["tar", "tzf", file], { timeoutMs: 60_000 });
		if (list.code !== 0) return { problem: `${asset.name} holds no program Upkeep can install.` };
		const listed = new Set(
			list.stdout
				.split("\n")
				.map((l) => l.trim().replace(/^\.\//, ""))
				.filter((l) => l && !l.endsWith("/")),
		);
		dir = mkdtempSync(join(dl, `discover-${key}-x-`));
		const x = await ctx.run(zip ? ["unzip", "-q", file, "-d", dir] : ["tar", "xzf", file, "-C", dir], {
			timeoutMs: 300_000,
		});
		if (x.code !== 0) return { problem: `${asset.name} holds no program Upkeep can install.` };
		let programs = [...listed].filter((p) => {
			const full = join(dir, p);
			try {
				const st = lstatSync(full);
				return st.isFile() && (st.mode & 0o111) !== 0 && isElf(head(full, 4));
			} catch {
				return false;
			}
		});
		programs.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
		if (programs.length === 0) return { problem: `${asset.name} holds no program Upkeep can install.` };
		let more = 0;
		if (programs.length > MAX_BINS) {
			more = programs.length;
			// Keep what sits at the top of the archive (under its one top directory, if it has one) or in a bin/ directory.
			const top = new Set(programs.map((p) => p.split("/")[0]));
			const rootDepth = top.size === 1 && programs.every((p) => p.includes("/")) ? 2 : 1;
			const kept = programs.filter((p) => p.split("/").length <= rootDepth || p.split("/").at(-2) === "bin");
			programs = (kept.length > 0 ? kept : programs).slice(0, MAX_BINS);
		}
		return { programs, more };
	} catch (err) {
		return { problem: err instanceof Error ? err.message : String(err) };
	} finally {
		rmSync(file, { force: true });
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
}

const MB2 = 2 * 1024 * 1024;

/** The gh-releases-zsync repo an AppImage carries in its update information, or null. */
export function embeddedRepo(file: string): string | null {
	let size = 0;
	try {
		size = statSync(file).size;
	} catch {
		return null;
	}
	for (const part of [head(file, MB2, 0), size > MB2 ? head(file, MB2, size - MB2) : null]) {
		const m = part ? /gh-releases-zsync\|([A-Za-z0-9_.-]+)\|([A-Za-z0-9_.-]+)\|/.exec(part.toString("latin1")) : null;
		if (m) return `${m[1]}/${m[2]}`;
	}
	return null;
}

/** A file's base name as a project name: no .AppImage, no -x86_64 or -linux, no version. */
export function bareName(file: string): string {
	let n = (file.split("/").at(-1) ?? file).replace(/\.appimage$/i, "");
	for (let prev = ""; prev !== n;) {
		prev = n;
		n = n.replace(/[-_.](x86_64|amd64|linux)$/i, "").replace(/[-_.]?v?\d+(\.\d+)+[a-z0-9._-]*$/i, "");
	}
	return n;
}

const MIN_STARS = 300;

type Search = { repo: string } | { none: true } | { problem: string; rate: boolean };

/** GitHub's repository search for a project named name; only an exact name match counts. */
async function searchRepo(name: string, ctx: DiscoverCtx): Promise<Search> {
	const api = ctx.api ?? "https://api.github.com";
	const headers = new Headers({ Accept: "application/vnd.github+json", "User-Agent": "upkeep" });
	if (ctx.token && api === "https://api.github.com") headers.set("Authorization", `Bearer ${ctx.token}`);
	let res: Response;
	try {
		res = await ctx.fetch(
			`${api}/search/repositories?q=${encodeURIComponent(name)}+in:name&sort=stars&order=desc&per_page=5`,
			{ headers },
		);
	} catch (err) {
		return { problem: `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`, rate: false };
	}
	if (res.status === 403 || res.status === 429)
		return { problem: "GitHub's request limit is used up. Try again after it resets.", rate: true };
	if (!res.ok) return { problem: `GitHub answered ${res.status} for ${name}.`, rate: false };
	let items: RepoHit[] = [];
	try {
		items = parseRepoSearch(await res.json());
	} catch {
		// not JSON: no match
	}
	// A wrong repo is worse than none: only an exact name with a following counts.
	const hit = items.find((i) => i.name.toLowerCase() === name.toLowerCase() && i.stars >= MIN_STARS);
	return hit ? { repo: hit.fullName } : { none: true };
}

/** A suggestion for a file whose source is unknown: the path is kept so the view can prefill a repo. */
function fileProblem(path: string, home: string, problem: string, source: Suggestion["source"]): Suggestion {
	const base = path.split("/").at(-1) ?? path;
	return {
		spec: { key: keyOf(bareName(base)), name: base, kind: "file", dest: tilde(path, home) },
		installed: null,
		latest: null,
		asset: null,
		alternatives: [],
		source,
		path,
		confidence: "guess",
		why: problem,
		problem,
	};
}

/** The problem line for a file Upkeep cannot trace to a repo; it asks the person for one. */
const unknownSource = (base: string) => `Could not tell where ${base} comes from. Paste its GitHub repo to add it.`;

/** A suggestion for a file on disk. Never runs it; probe allows the version probe once a repo is known. */
export async function fromFile(
	input: string,
	ctx: DiscoverCtx,
	opts: { asset?: string; scan?: boolean } = {},
): Promise<{ suggestion: Suggestion; rate?: boolean; searched: boolean } | { problem: string }> {
	const home = ctx.paths.home;
	let path = input.trim();
	if (path.startsWith("file://")) {
		try {
			path = decodeURIComponent(new URL(path).pathname);
		} catch {
			return { problem: `There is no file at ${input}.` };
		}
	}
	path = expandHome(path, home);
	let regular = false;
	try {
		regular = statSync(path).isFile();
	} catch {
		// absent
	}
	if (!regular) return { problem: `There is no file at ${path}.` };
	const base = path.split("/").at(-1) ?? path;
	const start = head(path);
	if (!isElf(start))
		return { problem: `${base} is not a program Upkeep can track (it is not a compiled binary or an AppImage).` };
	const appimage = isAppImage(start);
	const source = opts.scan ? "scan" : "file";
	const file = { path, appimage };
	const embedded = appimage ? embeddedRepo(path) : null;
	let repo = embedded;
	let searched = false;
	if (!repo) {
		searched = true;
		const s = await searchRepo(bareName(base), ctx);
		if ("problem" in s) return { suggestion: fileProblem(path, home, s.problem, source), rate: s.rate, searched };
		if ("none" in s)
			return {
				suggestion: fileProblem(path, home, unknownSource(base), source),
				searched,
			};
		repo = s.repo;
	}
	const r = await fromRepo(repo, ctx, {
		asset: opts.asset,
		file,
		source,
		confidence: embedded ? "sure" : "guess",
		found: embedded
			? "The AppImage names its own release source."
			: `Guessed from the file name. Check that ${repo} is the right project.`,
		probe: !opts.scan,
	});
	if ("problem" in r) {
		// A guessed repo without a release for this machine was not the right guess.
		const problem = embedded || r.rate ? r.problem : unknownSource(base);
		return { suggestion: fileProblem(path, home, problem, source), rate: r.rate, searched };
	}
	return { suggestion: r.suggestion, searched };
}

/** Answers the owner's paste: a repo, a link to one, or a file. */
export async function suggest(
	input: string,
	ctx: DiscoverCtx,
	asset?: string,
): Promise<{ suggestions: Suggestion[]; problem?: string }> {
	const entry = inCatalogue(input, ctx.catalogue ?? []);
	if (entry) return fromCatalogue(entry, ctx, asset);
	const what = readInput(input);
	if (!what) return { suggestions: [], problem: BAD_INPUT };
	if ("repo" in what) {
		const r = await fromRepo(what.repo, ctx, { asset });
		return "problem" in r ? { suggestions: [], problem: r.problem } : { suggestions: [r.suggestion] };
	}
	const r = await fromFile(what.file, ctx, { asset });
	return "problem" in r ? { suggestions: [], problem: r.problem } : { suggestions: [r.suggestion] };
}

// Leftovers: our own temp names, and the owner's backups ("llama-server.bak-20260508", "x.old", "x~").
const SKIP_NAME = /\.backup-|\.upkeep-new$|\.tmp$|\.(bak|backup|old|orig|save|prev)([-._]|$)|~$/i;
const MAX_SCAN = 40;

/** The catalogue's table for what was typed: an app's key or name, or its repo or github.com link, in any case. */
function inCatalogue(input: string, catalogue: AppSpec[]): AppSpec | undefined {
	const text = input.trim().toLowerCase();
	const read = readInput(input);
	const repo = read && "repo" in read ? read.repo.toLowerCase() : null;
	return catalogue.find(
		(c) =>
			c.key.toLowerCase() === text ||
			c.name.toLowerCase() === text ||
			(repo !== null && c.repo?.toLowerCase() === repo),
	);
}

/**
 * A catalogue table as a suggestion, sure and taken as written. A release kind still asks GitHub for today's release
 * and asset (asset is the picker's choice, else the table's pattern); a source or command table needs no lookup.
 */
async function fromCatalogue(
	entry: AppSpec,
	ctx: DiscoverCtx,
	asset?: string,
): Promise<{ suggestions: Suggestion[]; problem?: string }> {
	const sure = { source: "catalogue" as const, confidence: "sure" as const, why: CATALOGUE_WHY };
	if (!entry.repo || !RELEASE_KINDS.has(entry.kind)) {
		const s: Suggestion = { spec: entry, installed: null, latest: null, asset: null, alternatives: [], ...sure };
		if (ctx.specs.some((x) => x.key === entry.key)) s.problem = `${entry.name} is already in the list.`;
		return { suggestions: [s] };
	}
	const pattern = asset ?? entry.asset;
	const r = await fromRepo(entry.repo, ctx, { asset: pattern });
	if ("problem" in r) return { suggestions: [], problem: r.problem };
	return { suggestions: [{ ...r.suggestion, spec: { ...entry, asset: pattern }, ...sure }] };
}

/** Installed AppImages and binaries that are not in the list. Nothing found is ever run. */
export async function scan(ctx: DiscoverCtx): Promise<{ suggestions: Suggestion[] }> {
	const home = ctx.paths.home;
	const listed = new Set<string>();
	// Apps with no dest in the list (the old script's, the owner's by-hand ones) are known by name only.
	const known = new Set<string>();
	for (const s of ctx.specs) {
		for (const n of [s.key, s.legacy_key, s.process]) if (n) known.add(n.toLowerCase());
		if (!s.dest) continue;
		const dest = expandHome(s.dest, home);
		listed.add(dest);
		for (const b of s.bins ?? []) listed.add(join(dest.slice(0, dest.lastIndexOf("/")), b.split("/").at(-1) ?? b));
	}
	const files: string[] = [];
	for (const dir of [".local/bin", "Applications", "bin"]) {
		const root = join(home, dir);
		let names: string[];
		try {
			names = readdirSync(root).toSorted();
		} catch {
			continue;
		}
		for (const n of names) {
			const p = join(root, n);
			if (SKIP_NAME.test(n) || listed.has(p) || known.has(n.replace(/\.appimage$/i, "").toLowerCase())) continue;
			try {
				const st = lstatSync(p);
				if (!st.isFile() || (st.mode & 0o111) === 0) continue;
			} catch {
				continue;
			}
			if (isElf(head(p, 16))) files.push(p);
		}
	}
	if (files.length > MAX_SCAN) ctx.log(`Found ${files.length} programs; looking at the first ${MAX_SCAN}.`);
	const suggestions: Suggestion[] = [];
	let searchedLast = false;
	for (const f of files.slice(0, MAX_SCAN)) {
		// oxlint-disable-next-line no-await-in-loop -- name searches run one at a time, with a pause between
		if (searchedLast) await Bun.sleep(ctx.searchGapMs ?? 300);
		// oxlint-disable-next-line no-await-in-loop -- see above
		const r = await fromFile(f, ctx, { scan: true });
		if ("problem" in r) continue;
		suggestions.push(r.suggestion);
		searchedLast = r.searched;
		if (r.rate) {
			ctx.log(r.suggestion.problem ?? "");
			break;
		}
	}
	return { suggestions };
}
