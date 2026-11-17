import {
	closeSync,
	existsSync,
	lstatSync,
	realpathSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { MESSAGES } from "../shared/messages";
import type { AppKind, AppSpec, Suggestion } from "../shared/types";
import { type Arch, assetField, assetFor } from "./arch";
import { download, signedIn, verifyAsset } from "./download";
import { draftFor } from "./draft";
import { type ForgeKind, forgeOf, forgeRelease, hostKind, hostOf } from "./forge";
import {
	type Asset,
	type FetchLike,
	isFailure,
	parseRepoSearch,
	type Release,
	type RepoHit,
	repoText,
	rootNames,
} from "./github";
import { isPackage, PACKAGE_TOOL, readOnlyUsr } from "./kinds/package";
import { installedFiles, unpackProblem } from "./kinds/release";
import { listTools, toolSpec, toolKey } from "./managers";
import { parseManifest } from "./manifest";
import { expandHome, type Paths } from "./paths";
import { probeVersion } from "./probe";
import { aptRepoHas, copiesOf, readCopies, type SystemCopies } from "./extras/system";
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
	/** The catalogue online, <url>/<key>.toml, for a name the shipped copy does not have. */
	catalogueUrl?: string;
	log: (text: string) => void;
	/** Tests point this at a local server. The token is only ever sent to the real one. */
	api?: string;
	/** Where the owner's own system-wide installs live. Default /usr/local; tests point it at a temp dir. */
	usrLocal?: string;
	/** The pause between two name searches during a scan. Default 300 ms. */
	searchGapMs?: number;
	/** The machine's architecture, which decides the release files offered. Default x86_64. */
	arch?: Arch;
};

export const BAD_INPUT = MESSAGES.badInput();
export const CATALOGUE_WHY = MESSAGES.catalogueWhy();

/** The kinds whose table names a release asset, so a catalogue entry of one is looked up on GitHub for today's release. */
const RELEASE_KINDS = new Set<AppKind>(["appimage", "archive", "file", "deb", "rpm"]);

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** A repo as Add app reads it: forge only for a host whose forge is not known from the host alone. */
export type RepoInput = { repo: string; forge?: ForgeKind };

/**
 * A repo, a file path, or null when the input is neither. A repo is owner/name (GitHub's), host/owner/name, or a link
 * into a project on github.com, gitlab.com, codeberg.org or a self-hosted forge named in hosts (host to forge, from
 * the tables already known). A GitLab project path runs until its "-" part (gitlab.com/group/name/-/releases), and
 * a GitHub repo comes back as plain owner/name.
 */
export function readInput(
	input: string,
	hosts: ReadonlyMap<string, ForgeKind> = new Map(),
): RepoInput | { file: string } | null {
	const text = input.trim();
	if (text.startsWith("/") || text.startsWith("~/") || text.startsWith("file://")) return { file: text };
	let host: string;
	let parts: string[];
	try {
		const url = new URL(text);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		host = url.hostname.toLowerCase().replace(/^www\./, "");
		parts = url.pathname.split("/").filter(Boolean);
	} catch {
		parts = text.split("/");
		const named = hostOf(text);
		if (named === null) return parts.length === 2 && parts.every((p) => SEGMENT.test(p)) ? { repo: text } : null;
		host = named;
		parts = parts.slice(1);
	}
	const forge = hosts.get(host);
	const kind = hostKind(host) ?? forge;
	if (kind === undefined) return null;
	// Newer GitLab links mark the web part with "-"; older ones go straight to tree/, blob/, releases or tags. A group
	// and a project come first, so a route word counts only from the third part on.
	const end = parts.findIndex(
		(p, i) => p === "-" || (i >= 2 && ["tree", "blob", "releases", "tags", "commits"].includes(p)),
	);
	const path = (kind === "gitlab" ? parts.slice(0, end === -1 ? parts.length : end) : parts.slice(0, 2))
		.join("/")
		.replace(/\.git$/, "");
	const f = forgeOf(`${host}/${path}`, forge);
	if (!f) return null;
	if (f.kind === "github") return { repo: f.path };
	return hostKind(host) === undefined ? { repo: `${host}/${f.path}`, forge: f.kind } : { repo: `${host}/${f.path}` };
}

/** The self-hosted forges the tables already name, host to forge, so a link to one of them reads as a repo. */
function forgeHosts(ctx: DiscoverCtx): Map<string, ForgeKind> {
	const hosts = new Map<string, ForgeKind>();
	for (const s of [...ctx.specs, ...(ctx.catalogue ?? [])]) {
		const host = s.repo ? hostOf(s.repo) : null;
		if (host && s.forge) hosts.set(host, s.forge);
	}
	return hosts;
}

// "mac" only as a whole word: Caddy ships caddy_2.11.9_mac_amd64.tar.gz, and "mac" inside a name ("emacs") is no system.
const OTHER_SYSTEM =
	/darwin|macos|osx|apple|(?:^|[-_.])mac(?:[-_.]|$)|windows|win32|win64|\.exe$|\.msi$|\.dmg$|\.pkg$|android|freebsd|netbsd|openbsd/i;
const OTHER_ARCH =
	/arm64|aarch64|armv|arm-|armhf|armel|i[3-6]86|ia32|32-?bit|x86-32|x86(?![_.-]64)|[_-]386(?![0-9])|ppc64|riscv|s390x|loong|mips/i;
// An asset that names this machine outright beats one that names no architecture.
// DB Browser for SQLite spells it x86.64.
const THIS_MACHINE = /x86[_.-]64|amd64|x64|64-?bit/i;
// An aarch64 build always says so: a release names its x86_64 build only by leaving the architecture out. A Debian
// package calls it arm64, an rpm aarch64.
const ARM = /aarch64|arm64/i;
// A package built for every architecture (a script, Python): it names none and runs on both.
const ANY_ARCH = /[_.](all|noarch)\.(deb|rpm)$/i;
const SIDE_FILE = /\.(sha256|sha512|sig|asc|zsync|sbom|json|txt|pem|minisig)$/i;
// A source rpm installs only its sources into rpmbuild, never the program. An Arch package is a tarball for pacman.
const OTHER_PACKAGE = /\.(apk|pacman|flatpak|snap|src\.rpm|pkg\.tar\.(zst|xz|gz))$/i;
// GNU tar opens gzip, xz, bzip2 and zstd archives itself; a 7z needs a tool most systems lack.
const UNOPENED = /\.7z$/i;
const TARBALL = /\.(tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tbz2?|tar\.zst)$/i;
// A source tarball names no architecture, like most x86_64 builds, but holds no program (zen.source.tar.zst).
const SOURCE = /(^|[-_.])(source|sources|src|orig)[-_.]/i;
const TRIPLE = /x86_64-unknown-linux-(gnu|musl)$/i;

export type Candidate = { asset: Asset; kind: AppKind };

/** The installable kind of an asset name, "unopened" for an archive the installer cannot open, null for anything else. */
export function kindOf(name: string): AppKind | "unopened" | null {
	const n = name.toLowerCase();
	if (n.endsWith(".appimage")) return "appimage";
	if (n.endsWith(".deb")) return "deb";
	if (n.endsWith(".rpm")) return "rpm";
	if (TARBALL.test(n) || n.endsWith(".zip")) return "archive";
	if (UNOPENED.test(n)) return "unopened";
	// A trailing ".3" is a version, not an extension.
	if (!/\.[a-z][a-z0-9]*$/.test(n) || n.endsWith("-gh") || TRIPLE.test(n)) return "file";
	return null;
}

/** The kind order of the plan: AppImage, then gnu, musl and other archives, then a bare file, then a deb or rpm last. */
function rank(c: Candidate): number {
	const n = c.asset.name.toLowerCase();
	if (c.kind === "appimage") return 0;
	if (c.kind === "archive") return n.includes("gnu") ? 1 : n.includes("musl") ? 2 : 3;
	return c.kind === "file" ? 4 : 5;
}

/**
 * Whether a release file built for some architecture runs on arch. On x86_64 a name that names no architecture counts,
 * since that is how most releases ship it; on aarch64 only a name that says aarch64 or arm64, or a package built for
 * every architecture, so an unnamed x86_64 build is never installed on an arm64 machine.
 */
const forArch = (name: string, arch: Arch) =>
	arch === "aarch64"
		? (ARM.test(name) && !NOT_ARM64.test(name.replace(ARM, ""))) || ANY_ARCH.test(name)
		: !OTHER_ARCH.test(name);
/** Another architecture's token, read with the arm64 name taken out: a file naming arm64 and armv7 is no arm64 build. */
// Whole tokens only: armv8 is arm64 itself, and "x64" or "x86" inside a longer word names no architecture.
const NOT_ARM64 =
	/armv[4-7]|armhf|armel|i[3-6]86|ia32|(?:^|[-_.])(?:x86_64|x86-64|amd64|x64|x86)(?:$|[-_.])|[_-]386(?![0-9])|ppc64|riscv|s390x|loong|mips/i;

/** The release's assets that run on Linux on arch, best first; prefer puts kinds that match what is on disk ahead. */
export function machineAssets(assets: Asset[], prefer: AppKind[] = [], arch: Arch = "x86_64") {
	const candidates: Candidate[] = [];
	let unopened = false;
	for (const asset of assets) {
		const name = asset.name;
		if (OTHER_SYSTEM.test(name) || !forArch(name, arch) || SIDE_FILE.test(name) || OTHER_PACKAGE.test(name)) continue;
		if (SOURCE.test(name)) continue;
		const kind = kindOf(name);
		if (kind === "unopened") unopened = true;
		else if (kind) candidates.push({ asset, kind });
	}
	const preferred = (c: Candidate) => (prefer.includes(c.kind) ? 0 : 1);
	const named = (c: Candidate) => ((arch === "aarch64" ? ARM : THIS_MACHINE).test(c.asset.name) ? 0 : 1);
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

const EXTENSION = /\.(tar\.gz|tgz|zip|appimage|deb|rpm|tar\.xz|tar\.zst|tar\.bz2|7z)$/i;
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
	s = s.replace(/x86[_-]64|amd64|x64|aarch64|arm64/gi, "-");
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

/**
 * The name a person reads: the asset's own capitals, else for a generic repo name the program it ships when the owner
 * does not contain it (gitlab-org/cli ships glab) and the owner when it does (zen-browser/desktop ships zen), else the repo.
 */
export function appName(shipped: string, repo: string): string {
	const [owner = repo, repoName = repo] = repo.split("/");
	if (shipped.length >= 2 && shipped !== shipped.toLowerCase()) return shipped;
	if (!GENERIC_REPO.has(repoName.toLowerCase())) return displayName(repoName);
	const bin = shipped.toLowerCase();
	return bin.length >= 2 && !GENERIC_REPO.has(bin) && !owner.toLowerCase().includes(bin) ? shipped : displayName(owner);
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

/**
 * The sentence for a program the table would replace that is not one: a kind that installs a program (an AppImage, an
 * archive's bin, a bare file) finding a script or any other non-program at dest. Another tool with the same name (a
 * Python httpx where the table installs ProjectDiscovery's) would be overwritten. Null when dest is free or a program;
 * a symlink is read through, and a folder app's link into its own folder is its own, whatever it points at (a launcher
 * script). Wrong for a table whose bin is itself a script with no folder: none in the catalogue, whose bins are ELF.
 */
function otherAtDest(kind: AppKind, dest: string, home: string, folder?: string): string | null {
	if (kind !== "appimage" && kind !== "archive" && kind !== "file") return null;
	if (!existsSync(dest)) return null;
	if (folder) {
		try {
			if (lstatSync(dest).isSymbolicLink() && realpathSync(dest).startsWith(`${realpathSync(folder)}/`)) return null;
		} catch {
			// the folder is not there yet: whatever sits at dest is not its link
		}
	}
	return isElf(head(dest, 4)) ? null : MESSAGES.otherProgramAtDest(tilde(dest, home));
}

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
	/** A catalogue table's asset pattern: the release asset it matches is the one picked, and none matching is a problem. */
	pattern?: string;
	/** Arguments for the version probe on dest, as the table gives them. Default ["--version"]. */
	versionArgs?: string[];
	/** A file on disk the suggestion is for: its kind decides the asset, and it is the dest. */
	file?: { path: string; appimage: boolean };
	source?: Suggestion["source"];
	confidence?: Suggestion["confidence"];
	/** The sentence on how the repo was found, put before the asset sentence. */
	found?: string;
	/** Run the version probe on dest. Never during a scan. */
	probe?: boolean;
	/** false: dest is never run for its version, though the archive may still be opened (a table with probe = false). */
	askVersion?: boolean;
	/** false: no check of what sits at the dest fromRepo works out; a catalogue table checks its own dest instead. */
	destCheck?: boolean;
	/** The forge of a repo on a self-hosted host, as its table or the link says. */
	forge?: ForgeKind;
};

export type RepoResult = { suggestion: Suggestion } | { problem: string; rate?: boolean };

/** A suggestion from a repo's latest release. */
export async function fromRepo(repo: string, ctx: DiscoverCtx, opts: RepoOpts = {}): Promise<RepoResult> {
	const release = await forgeRelease(repo, opts.forge, {
		cacheDir: join(ctx.paths.cache, "github"),
		token: ctx.token,
		fetch: ctx.fetch,
		api: ctx.api,
	});
	if (isFailure(release)) {
		if (release.failure === "http" && release.detail.includes(" 404 "))
			return { problem: MESSAGES.noPublishedRelease(repo) };
		return { problem: release.detail, rate: release.failure === "rate" };
	}
	if (!release.version) return { problem: MESSAGES.latestNotComparable(release.tag) };
	// Named by its owner and name: a host and GitLab's groups say nothing about the app.
	const named = repo.split("/").slice(-2).join("/");
	const repoName = named.split("/")[1] ?? named;
	const home = ctx.paths.home;
	// An app is named after what it ships: the shortest stem of its builds, since variants add words
	// ("rustdesk-unsigned"). A stem too short to mean anything falls back to the repo.
	const shippedBy = (c: Candidate | undefined) => (c ? stem(c.asset.name, release) : "");
	const stems = machineAssets(release.assets, [], ctx.arch)
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
	else if (onPath) prefer = onPath.startsWith(`${home}/`) ? ["archive", "file"] : ["deb", "rpm"];
	const { candidates, unopened } = machineAssets(release.assets, prefer, ctx.arch);
	// A package installs only through the system's own package tool. dpkg marks a Debian system: a .deb needs it, and
	// an .rpm is refused there even when the rpm tool is installed, since its files would sit outside dpkg's records.
	// A read-only /usr takes neither.
	// A file on disk never takes a package, so a scan runs nothing for it.
	const missing = new Set<string>();
	const packages = new Set(candidates.map((c) => c.kind).filter(isPackage));
	if (!opts.file && packages.size > 0) {
		const dpkg = (await which(ctx, PACKAGE_TOOL.deb)) !== null;
		if (!dpkg) missing.add("deb");
		if (packages.has("rpm") && (dpkg || (await which(ctx, PACKAGE_TOOL.rpm)) === null)) missing.add("rpm");
		// An image-based system has rpm but takes no package outside its image.
		if ([...packages].some((k) => !missing.has(k)) && (await readOnlyUsr(ctx.run)))
			for (const k of packages) missing.add(k);
	}
	const installable = candidates.filter((c) => !missing.has(c.kind));
	const usable = opts.file ? installable.filter((c) => prefer.includes(c.kind)) : installable;
	const byPattern = opts.pattern ? new RegExp(opts.pattern) : null;
	// A table whose pattern matches nothing this release ships is not quietly swapped for another file.
	if (
		opts.pattern &&
		byPattern &&
		!opts.asset &&
		usable.length > 0 &&
		!usable.some((c) => byPattern.test(c.asset.name))
	) {
		// The file is there but this machine cannot take it (a .deb without dpkg, an archive it cannot open).
		if (!release.assets.some((a) => byPattern.test(a.name))) return { problem: MESSAGES.noAssetMatches(opts.pattern) };
		const forMachine = MESSAGES.noAssetForMachine(repo);
		return { problem: unopened ? MESSAGES.unopenedArchives(forMachine) : forMachine };
	}
	const picked =
		(opts.asset ? usable.find((c) => c.asset.name === opts.asset) : undefined) ??
		(byPattern ? usable.find((c) => byPattern.test(c.asset.name)) : undefined) ??
		usable[0];
	if (!picked) {
		const drafted = opts.file ? null : await draftSource(repo, release, ctx, opts, bin);
		if (drafted) return drafted;
		const problem = MESSAGES.noAssetForMachine(repo);
		return {
			problem: unopened ? MESSAGES.unopenedArchives(problem) : problem,
		};
	}
	const kind = picked.kind;
	let dest: string;
	if (opts.file) dest = opts.file.path;
	else if (kind === "appimage") dest = image ?? join(home, ".local/bin", `${bin}.AppImage`);
	else if (isPackage(kind)) dest = onPath ?? `/usr/bin/${bin}`;
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
	const name = appName(shippedBy(picked), named);
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
		installs = MESSAGES.itInstalls(bins.map(baseOf).join(", "));
		if (found.more) installs += MESSAGES.archiveHoldsMore(found.more, MAX_BINS);
	}
	const spec: AppSpec = { key, name, kind, repo, [assetField(ctx.arch)]: pattern, dest: tilde(dest, home) };
	if (opts.forge) spec.forge = opts.forge;
	if (bins) spec.bins = bins;
	if (isPackage(kind) || rootDest) spec.sudo = true;
	const exists = existsSync(dest);
	if (!exists) spec.install_if_missing = true;

	const why = [
		opts.found,
		MESSAGES.matchedAsset(picked.asset.name),
		installs ?? (systemCopy ? MESSAGES.itInstalls(bin) : null),
	];
	if (systemCopy) why.push(MESSAGES.systemCopyKept(systemCopy, String(spec.dest)));
	else if (!opts.file)
		why.push(exists ? MESSAGES.foundInstalledAt(String(spec.dest)) : MESSAGES.nothingInstalledAt(String(spec.dest)));
	if (widen) why.push(MESSAGES.patternNeedsWidening());
	let installed: string | null = null;
	// The system's copy is not the one Upkeep keeps, so its version is not "installed".
	if (exists && opts.probe !== false && opts.askVersion !== false && !systemCopy) {
		const p = await probeVersion(dest, opts.versionArgs ?? ["--version"], { run: ctx.run });
		if ("version" in p) installed = p.version;
		else why.push(MESSAGES.couldNotReadVersion());
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
	if (ctx.specs.some((s) => s.key === key)) suggestion.problem = MESSAGES.alreadyInList(name);
	else if (!opts.file && opts.destCheck !== false) {
		const other = otherAtDest(kind, dest, home);
		if (other) suggestion.problem = other;
	}
	return { suggestion };
}

/**
 * A source table drafted from the repo's build files at the release tag, offered as a guess for the person to read;
 * null when the root holds no build file Upkeep knows, or GitHub cannot list it, or the repo is not on GitHub (only
 * GitHub's contents API is read). The program goes where it is
 * already found in the home folder or /usr/local, else where its build installs it. A missing build tool is the
 * suggestion's problem, so the card says so instead of offering a build that cannot run.
 */
async function draftSource(
	repo: string,
	release: Release,
	ctx: DiscoverCtx,
	opts: RepoOpts,
	bin: string,
): Promise<RepoResult | null> {
	if (forgeOf(repo, opts.forge)?.kind !== "github") return null;
	const gh = { cacheDir: join(ctx.paths.cache, "github"), token: ctx.token, fetch: ctx.fetch, api: ctx.api };
	const names = await rootNames(repo, release.tag, gh);
	if (isFailure(names)) return null;
	let draft = draftFor(names, null, bin);
	if (!draft) return null;
	// Cargo.toml and go.mod name the program they build; the other build files do not say.
	if (draft.file === "Cargo.toml" || draft.file === "go.mod")
		draft = draftFor(names, await repoText(repo, draft.file, release.tag, gh), bin) ?? draft;
	const home = ctx.paths.home;
	const usrLocal = ctx.usrLocal ?? "/usr/local";
	// Only a copy where the build installs is the one it replaces: a stray copy elsewhere would pass the check
	// after the build while the new one sits unused.
	const dest = draft.system ? join(usrLocal, "bin", draft.bin) : join(home, ".local/bin", draft.bin);
	// which prints the copy that runs now. One in the home folder comes before the system folders on PATH, so it
	// keeps running after the build unless the person removes it (cargo's own ~/.cargo/bin, an old ~/.local/bin copy).
	const found = await which(ctx, draft.bin);
	const shadow = found && found !== dest && found.startsWith(`${home}/`) ? found : null;
	const spec: AppSpec = {
		key: keyOf(draft.bin),
		name: appName(draft.bin, repo.split("/").slice(-2).join("/")),
		kind: "source",
		repo,
		dest: tilde(dest, home),
		build: draft.build,
	};
	if (draft.system) spec.sudo = true;
	const exists = existsSync(dest);
	if (!exists) spec.install_if_missing = true;
	const missing = (await Promise.all(draft.tools.map(async (t) => ((await which(ctx, t)) ? null : t)))).filter(
		(t): t is string => t !== null,
	);
	let installed: string | null = null;
	if (exists && opts.probe !== false) {
		const p = await probeVersion(dest, ["--version"], { run: ctx.run });
		if ("version" in p) installed = p.version;
	}
	const suggestion: Suggestion = {
		spec,
		installed,
		latest: release.version,
		asset: null,
		alternatives: [],
		source: opts.source ?? "repo",
		confidence: "guess",
		why: [
			opts.found,
			MESSAGES.draftedFrom(draft.file),
			draft.named ? null : MESSAGES.draftNamedAfterRepo(draft.bin),
			shadow ? MESSAGES.draftOtherCopyFirst(tilde(shadow, home)) : null,
			exists ? MESSAGES.foundInstalledAt(String(spec.dest)) : MESSAGES.nothingInstalledAt(String(spec.dest)),
		]
			.filter(Boolean)
			.join(" "),
	};
	if (missing.length > 0) suggestion.problem = MESSAGES.draftNeedsTools(missing.join(", "));
	else if (ctx.specs.some((s) => s.key === spec.key)) suggestion.problem = MESSAGES.alreadyInList(spec.name);
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
		verifyAsset(await download(asset.url, file, { fetch: ctx.fetch, signedIn: signedIn(asset, ctx.token) }), asset);
		const zip = asset.name.toLowerCase().endsWith(".zip");
		const list = await ctx.run(zip ? ["unzip", "-Z1", file] : ["tar", "tf", file], { timeoutMs: 60_000 });
		if (list.code !== 0)
			return {
				problem:
					list.code === 127 || /Cannot exec/.test(list.stderr)
						? unpackProblem(asset.name, list, zip ? "unzip" : "tar")
						: MESSAGES.noProgramInArchive(asset.name),
			};
		const listed = new Set(
			list.stdout
				.split("\n")
				.map((l) => l.trim().replace(/^\.\//, ""))
				.filter((l) => l && !l.endsWith("/")),
		);
		dir = mkdtempSync(join(dl, `discover-${key}-x-`));
		const x = await ctx.run(zip ? ["unzip", "-q", file, "-d", dir] : ["tar", "xf", file, "-C", dir], {
			timeoutMs: 300_000,
		});
		if (x.code !== 0) return { problem: MESSAGES.noProgramInArchive(asset.name) };
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
		if (programs.length === 0) return { problem: MESSAGES.noProgramInArchive(asset.name) };
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
		n = n.replace(/[-_.](x86_64|amd64|aarch64|arm64|linux)$/i, "").replace(/[-_.]?v?\d+(\.\d+)+[a-z0-9._-]*$/i, "");
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
		return {
			problem: MESSAGES.couldNotReachGithubSearch(err instanceof Error ? err.message : String(err)),
			rate: false,
		};
	}
	if (res.status === 403 || res.status === 429) return { problem: MESSAGES.rateLimitSearch(), rate: true };
	if (!res.ok) return { problem: MESSAGES.githubAnsweredSearch(res.status, name), rate: false };
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
			return { problem: MESSAGES.noFileAt(input) };
		}
	}
	path = expandHome(path, home);
	let regular = false;
	try {
		regular = statSync(path).isFile();
	} catch {
		// absent
	}
	if (!regular) return { problem: MESSAGES.noFileAt(path) };
	const base = path.split("/").at(-1) ?? path;
	const start = head(path);
	if (!isElf(start)) return { problem: MESSAGES.notTrackable(base) };
	const appimage = isAppImage(start);
	const source = opts.scan ? "scan" : "file";
	// A catalogue app found where its table installs it is that app: the tested table, and no name search.
	const entry = (ctx.catalogue ?? []).find((e) => e.dest && expandHome(e.dest, home) === path);
	if (entry) {
		const r = await fromCatalogue(entry, ctx, opts.asset, !opts.scan);
		const found = r.suggestions[0];
		if (found) return { suggestion: { ...found, source, path }, searched: false };
		// A used-up rate limit is passed on, so a scan stops asking GitHub.
		return {
			suggestion: fileProblem(path, home, r.problem ?? MESSAGES.unknownSource(base), source),
			rate: r.rate,
			searched: false,
		};
	}
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
				suggestion: fileProblem(path, home, MESSAGES.unknownSource(base), source),
				searched,
			};
		repo = s.repo;
	}
	const r = await fromRepo(repo, ctx, {
		asset: opts.asset,
		file,
		source,
		confidence: embedded ? "sure" : "guess",
		found: embedded ? MESSAGES.appImageNamesSource() : MESSAGES.guessedFromFileName(repo),
		probe: !opts.scan,
	});
	if ("problem" in r) {
		// A guessed repo without a release for this machine was not the right guess.
		const problem = embedded || r.rate ? r.problem : MESSAGES.unknownSource(base);
		return { suggestion: fileProblem(path, home, problem, source), rate: r.rate, searched };
	}
	return { suggestion: r.suggestion, searched };
}

/** Answers the owner's paste: a repo, a link to one, or a file; each suggestion says what else keeps the app up to date. */
export async function suggest(
	input: string,
	ctx: DiscoverCtx,
	asset?: string,
): Promise<{ suggestions: Suggestion[]; problem?: string }> {
	const r = await suggestFor(input, ctx, asset);
	return { ...r, suggestions: await withAlso(r.suggestions, ctx) };
}

/** suggest's answer before the other copies are looked up. */
async function suggestFor(
	input: string,
	ctx: DiscoverCtx,
	asset?: string,
): Promise<{ suggestions: Suggestion[]; problem?: string }> {
	const entry = inCatalogue(input, ctx.catalogue ?? [], forgeHosts(ctx));
	if (entry) return fromCatalogue(entry, ctx, asset);
	const online = await onlineEntry(input, ctx);
	if (online) return fromCatalogue(online, ctx, asset, true, MESSAGES.catalogueOnlineWhy());
	const what = readInput(input, forgeHosts(ctx));
	if (!what) {
		// A bare name that is not in the catalogue may still be a tool one of the managers installed.
		const text = input.trim().toLowerCase();
		const tools = (await managedSuggestions(ctx)).filter((s) => s.spec.name.toLowerCase() === text);
		return tools.length > 0 ? { suggestions: tools } : { suggestions: [], problem: BAD_INPUT };
	}
	if ("repo" in what) {
		const r = await fromRepo(what.repo, ctx, { asset, forge: what.forge });
		return "problem" in r ? { suggestions: [], problem: r.problem } : { suggestions: [r.suggestion] };
	}
	const r = await fromFile(what.file, ctx, { asset });
	return "problem" in r ? { suggestions: [], problem: r.problem } : { suggestions: [r.suggestion] };
}

// Leftovers: our own temp names, and the owner's backups ("llama-server.bak-20260508", "x.old", "x~").
const SKIP_NAME = /\.backup-|\.upkeep-new$|\.tmp$|\.(bak|backup|old|orig|save|prev)([-._]|$)|~$/i;
const MAX_SCAN = 40;

/** The GitHub repo a table names, in its repo field or as a github: latest source; empty when it names none. */
const repoOf = (c: AppSpec) => (c.repo ?? (c.latest?.startsWith("github:") ? c.latest.slice(7) : "")).toLowerCase();

/**
 * The catalogue's table for what was typed: an app's key or name, or its repo or github.com link, in any case. A
 * table that names its repo only in latest ("github:owner/name") is found by that repo too.
 */
function inCatalogue(input: string, catalogue: AppSpec[], hosts: ReadonlyMap<string, ForgeKind>): AppSpec | undefined {
	const text = input.trim().toLowerCase();
	const read = readInput(input, hosts);
	const repo = read && "repo" in read ? read.repo.toLowerCase() : null;
	return catalogue.find(
		(c) => c.key.toLowerCase() === text || c.name.toLowerCase() === text || (repo !== null && repoOf(c) === repo),
	);
}

/** The kinds a table fetched from the catalogue online may have: each installs a release file into home, without root. */
const ONLINE_KINDS = new Set<AppKind>(["appimage", "archive", "file"]);
/**
 * The only fields a table fetched online may carry: what picks, places and reads a release file. A command (restart,
 * update, build, check), root (sudo, which a .deb or .rpm also needs) or closing a process (relaunch) comes only with
 * a version of Upkeep whose catalogue was reviewed.
 */
const ONLINE_FIELDS = new Set<string>([
	"key",
	"name",
	"kind",
	"repo",
	"forge",
	"asset",
	"asset_aarch64",
	"dest",
	"bins",
	"folder",
	"version_args",
	"meta_path",
	"probe",
	"note",
	"process",
]);

// The catalogue's list of keys online, by address, kept an hour: Add app asks for it once, not per name.
const indexes = new Map<string, { at: number; keys: Set<string> }>();
const INDEX_HOURS = 1;

/**
 * The keys the catalogue online holds, from <catalogueUrl>/index.txt (one key a line; a test keeps it equal to the
 * tables). Read at most once an hour per address; an empty set when it cannot be read, so nothing else is asked.
 */
async function onlineKeys(ctx: DiscoverCtx): Promise<Set<string>> {
	const url = ctx.catalogueUrl ?? "";
	const now = Date.now();
	const kept = indexes.get(url);
	if (kept && now - kept.at < INDEX_HOURS * 3_600_000) return kept.keys;
	let keys = new Set<string>();
	try {
		const r = await ctx.fetch(`${url}/index.txt`, { signal: AbortSignal.timeout(10_000) });
		if (r.ok)
			keys = new Set(
				(await r.text())
					.split("\n")
					.map((l) => l.trim())
					.filter(Boolean),
			);
	} catch {
		// unreachable: no keys, and the next Add app asks again
		return keys;
	}
	indexes.set(url, { at: now, keys });
	return keys;
}

/**
 * The catalogue's table for a bare name the shipped copy does not have, read from the repo: <catalogueUrl>/<key>.toml,
 * the key made of the name as keyOf makes one, so "Hydra Launcher" finds hydra-launcher but not hydralauncher. Only a
 * key on the public list (onlineKeys) is asked for, so a private name is never sent. Null for a link, a path, a table that does not load, one of another key, a kind other than an AppImage, archive or file,
 * or a field beyond ONLINE_FIELDS: only the shipped copy, reviewed with this version, may run a command or use root.
 * The fetch gives up after 10 s. Never throws.
 */
async function onlineEntry(input: string, ctx: DiscoverCtx): Promise<AppSpec | null> {
	const name = input.trim();
	if (!ctx.catalogueUrl || !/^[\w][\w .+-]*$/.test(name)) return null;
	const key = keyOf(name).replace(/-+/g, "-").replace(/^-|-$/g, "");
	// The name is matched against the public list here: one that is not on it never leaves this machine.
	if (!key || !(await onlineKeys(ctx)).has(key)) return null;
	try {
		const r = await ctx.fetch(`${ctx.catalogueUrl}/${encodeURIComponent(key)}.toml`, {
			signal: AbortSignal.timeout(10_000),
		});
		if (!r.ok) return null;
		const { apps, errors } = parseManifest(await r.text(), `catalogue/${key}.toml`);
		const table = apps[0];
		if (errors.length > 0 || apps.length !== 1 || !table || table.key !== key || !ONLINE_KINDS.has(table.kind))
			return null;
		if (Object.keys(table).some((f) => !ONLINE_FIELDS.has(f))) return null;
		return table;
	} catch {
		return null;
	}
}

/**
 * A catalogue table as a suggestion, sure and taken as written. A release kind still asks GitHub for today's release
 * and asset (asset is the picker's choice, else the table's pattern); a source or command table needs no lookup. A
 * release table with no pattern for this machine's architecture is refused rather than given another arch's file.
 * probe false (a scan) neither opens the release's archive nor runs the installed program.
 */
async function fromCatalogue(
	entry: AppSpec,
	ctx: DiscoverCtx,
	asset?: string,
	probe = true,
	from = CATALOGUE_WHY,
): Promise<{ suggestions: Suggestion[]; problem?: string; rate?: boolean }> {
	const sure = { source: "catalogue" as const, confidence: "sure" as const, why: from };
	const pattern = assetFor(entry, ctx.arch);
	// A table tested on one architecture says nothing about the other's files: no pattern for this one, no offer.
	if (RELEASE_KINDS.has(entry.kind) && pattern === undefined)
		return { suggestions: [], problem: MESSAGES.noAssetForArch(entry.name, ctx.arch ?? "x86_64") };
	if (!entry.repo || !RELEASE_KINDS.has(entry.kind)) {
		// A release app found through latest (json:, links:), or a clone build that probes its dest (tmux), with
		// nothing at its dest yet would be skipped by every check: it lands in Ready to install, as a repo one does below.
		const clone = entry.kind === "source" && !entry.check && !entry.stage && !entry.dir;
		const absent = entry.dest !== undefined && !existsSync(expandHome(entry.dest, ctx.paths.home));
		const missing = absent && (RELEASE_KINDS.has(entry.kind) || clone);
		const spec = missing ? { ...entry, install_if_missing: true } : entry;
		const s: Suggestion = { spec, installed: null, latest: null, asset: null, alternatives: [], ...sure };
		if (ctx.specs.some((x) => x.key === entry.key)) s.problem = MESSAGES.alreadyInList(entry.name);
		// A tool that updates itself, or a build that reads its own check, cannot be installed by Upkeep the first
		// time: the card says it shows up once it is there. sh -c checks name no program to look for.
		else if (!missing && (await notThere(entry, ctx))) s.why = `${from} ${MESSAGES.notInstalledYet(entry.name)}`;
		return { suggestions: [s] };
	}
	// An asset the person picked is a name; the table's own asset is a pattern.
	const r = await fromRepo(entry.repo, ctx, {
		...(asset ? { asset } : { pattern }),
		versionArgs: entry.version_args,
		askVersion: entry.probe !== false,
		destCheck: false,
		forge: entry.forge,
		probe,
	});
	if ("problem" in r) {
		// A table that installs a .deb or .rpm, on a machine that takes neither (no dpkg, an image-based system): the
		// same repo's other files, an AppImage or an archive, are looked at as for a repo typed in. A drafted build is
		// not offered in its place.
		if (isPackage(entry.kind) && !asset && !r.rate) {
			const other = await fromRepo(entry.repo, ctx, { probe, forge: entry.forge });
			if (!("problem" in other) && other.suggestion.spec.kind !== "source") return { suggestions: [other.suggestion] };
		}
		return { suggestions: [], problem: r.problem, rate: r.rate };
	}
	// No release file runs here, so the catalogue's table cannot install it: the drafted build stays a guess.
	if (r.suggestion.spec.kind === "source") return { suggestions: [r.suggestion] };
	// A picked asset is kept as the pattern fromRepo made of its name, with the version a wildcard, so it still matches next release.
	const field = assetField(ctx.arch);
	const spec: AppSpec = { ...entry, [field]: asset ? (r.suggestion.spec[field] ?? pattern) : pattern };
	// Nothing at the table's dest yet: the app lands in Ready to install, as one added by repo does.
	if (entry.dest && !existsSync(expandHome(entry.dest, ctx.paths.home))) spec.install_if_missing = true;
	// A picked file whose name could not be made a pattern says so, as Add app does for a repo.
	const widen = asset && r.suggestion.why.includes(MESSAGES.patternNeedsWidening());
	const why = widen ? `${from} ${MESSAGES.patternNeedsWidening()}` : from;
	const folder = entry.folder ? expandHome(entry.folder, ctx.paths.home) : undefined;
	const other = entry.dest
		? otherAtDest(entry.kind, expandHome(entry.dest, ctx.paths.home), ctx.paths.home, folder)
		: null;
	const found: Suggestion = { ...r.suggestion, spec, ...sure, why };
	if (!found.problem && other) found.problem = other;
	return { suggestions: [found] };
}

/**
 * True when a command or check-reading source table's program is not on PATH. A check run through sh or bash names
 * no program, and a table with no check has none to look for: both are false, so nothing is claimed.
 */
async function notThere(entry: AppSpec, ctx: DiscoverCtx): Promise<boolean> {
	if (entry.kind !== "command" && entry.kind !== "source") return false;
	const bin = entry.check?.[0];
	if (!bin || bin === "sh" || bin === "bash") return false;
	return (await which(ctx, bin)) === null;
}

/** Whether one argument of a table names the tool: as a whole word, so "yt-dlp" is not found inside "yt-dlp-extra". */
const mentions = (arg: string, name: string) =>
	new RegExp(`(^|[^A-Za-z0-9._-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9._-])`).test(arg);

/**
 * One suggestion for each tool a manager (uv, pipx, npm, cargo) installed that the list does not track yet: by key, by
 * the process name, by a check or update that names the tool, or by a latest source for the same package. The
 * manager's own record names the source, so each is sure. The latest version is left for the check after adding.
 */
async function managedSuggestions(ctx: DiscoverCtx): Promise<Suggestion[]> {
	const out: Suggestion[] = [];
	const seen = new Map<string, { s: Suggestion; manager: string }>();
	for (const tool of await listTools(ctx.run, ctx.paths.home)) {
		const key = toolKey(tool.name);
		const spec = toolSpec(tool, key);
		const first = seen.get(key);
		// The same tool from a second manager (ruff from uv and from pipx): one row, and its card says so.
		if (first && first.manager !== tool.manager) {
			first.s.also = [...(first.s.also ?? []), MESSAGES.alsoOtherManager(tool.name, tool.manager)];
			continue;
		}
		if (!spec || first) continue;
		const tracked = ctx.specs.some(
			(s) =>
				s.key === key ||
				s.process?.toLowerCase() === key ||
				s.latest === spec.latest ||
				[...(s.check ?? []), ...(s.update ?? [])].some((a) => mentions(a, tool.name)),
		);
		if (tracked) continue;
		const s: Suggestion = {
			spec,
			installed: tool.version,
			latest: null,
			asset: null,
			alternatives: [],
			source: "scan",
			confidence: "sure",
			why: MESSAGES.installedWith(tool.manager),
		};
		seen.set(key, { s, manager: tool.manager });
		out.push(s);
	}
	return out;
}

/** Installed AppImages and binaries that are not in the list, and the tools uv, pipx, npm and cargo installed. Nothing found is ever run. */
export async function scan(ctx: DiscoverCtx): Promise<{ suggestions: Suggestion[] }> {
	const home = ctx.paths.home;
	const listed = new Set<string>();
	// Apps with no dest in the list (self-updating tools, by-hand ones) are known by name only.
	const known = new Set<string>();
	for (const s of ctx.specs) {
		for (const n of [s.key, s.process]) if (n) known.add(n.toLowerCase());
		if (!s.dest) continue;
		const dest = expandHome(s.dest, home);
		listed.add(dest);
		for (const f of installedFiles(s, dest, home)) listed.add(f);
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
	// The other programs a found catalogue app's archive brings (uvx beside uv) are that app, not apps of their own.
	const found = new Set(files);
	const bundled = new Set<string>();
	for (const e of ctx.catalogue ?? []) {
		const dest = e.dest ? expandHome(e.dest, home) : "";
		if (!found.has(dest)) continue;
		for (const f of installedFiles(e, dest, home)) bundled.add(f);
		bundled.delete(dest);
	}
	files.splice(0, files.length, ...files.filter((f) => !bundled.has(f)));
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
	// cargo can put a crate's program in a scanned folder (cargo install --root ~/.local): its manager's table wins,
	// being sure, and the program is not offered twice. Only cargo: uv, pipx and npm leave scripts or links the scan
	// skips, so a program of the same name there is another app.
	// A catalogue package app (.deb, .rpm) lives outside home, where the file scan above never looks.
	for (const e of ctx.catalogue ?? []) {
		if (!isPackage(e.kind) || !e.dest || known.has(e.key) || listed.has(e.dest) || !existsSync(e.dest)) continue;
		// oxlint-disable-next-line no-await-in-loop -- one release lookup at a time, as the file scan does
		const r = await fromCatalogue(e, ctx, undefined, false);
		const pkg = r.suggestions[0];
		if (pkg) suggestions.push({ ...pkg, source: "scan", path: e.dest });
		if (r.rate) break;
	}
	const managed = await managedSuggestions(ctx);
	const keys = new Set(managed.filter((m) => m.spec.update?.[0] === "cargo").map((m) => m.spec.key));
	return { suggestions: await withAlso([...suggestions.filter((x) => !keys.has(x.spec.key)), ...managed], ctx) };
}

/**
 * What else keeps this app up to date, as engine sentences: a Flatpak or Snap of it (from copies, read once by the
 * caller), or another table in specs on the same dest or repo. Read-only and cheap; the apt repository check, which
 * asks apt once per app, is Add app's alone.
 */
export function alsoOf(spec: AppSpec, specs: AppSpec[], copies: SystemCopies, home: string): string[] {
	const also: string[] = [];
	const other = copiesOf(spec.key, spec.name, copies);
	if (other.flatpak) also.push(MESSAGES.alsoFlatpak(spec.name, other.flatpak));
	if (other.snap) also.push(MESSAGES.alsoSnap(spec.name, other.snap));
	const dest = spec.dest ? expandHome(spec.dest, home) : null;
	for (const x of specs) {
		if (x.key === spec.key) continue;
		if (dest && x.dest && expandHome(x.dest, home) === dest) also.push(MESSAGES.alsoSameDest(x.name));
		else if (spec.repo && x.repo?.toLowerCase() === spec.repo.toLowerCase()) also.push(MESSAGES.alsoSameRepo(x.name));
	}
	return also;
}

/**
 * Adds to each suggestion that can be added what else already keeps the app up to date: a Flatpak or Snap of it, an
 * apt repository for a package app, or a table in the list on the same repo or dest. Read-only; the lists are read
 * once. A warning only: the person may still add it, for two versions side by side.
 */
async function withAlso(suggestions: Suggestion[], ctx: DiscoverCtx): Promise<Suggestion[]> {
	if (!suggestions.some((s) => !s.problem)) return suggestions;
	const copies = await readCopies(ctx);
	const home = ctx.paths.home;
	const out: Suggestion[] = [];
	for (const s of suggestions) {
		if (s.problem) {
			out.push(s);
			continue;
		}
		const { spec } = s;
		// A note the suggestion came with (a second manager's copy) stays first.
		const also = [...(s.also ?? []), ...alsoOf(spec, ctx.specs, copies, home)];
		// oxlint-disable-next-line no-await-in-loop -- only a package app asks apt, one at a time
		if (isPackage(spec.kind) && (await aptRepoHas(ctx, spec.key))) also.push(MESSAGES.alsoAptRepo(spec.key));
		out.push(also.length > 0 ? { ...s, also } : s);
	}
	return out;
}
