import { existsSync, lstatSync, openSync, readdirSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { AppKind, AppSpec, Suggestion } from "../shared/types";
import { type Asset, type FetchLike, fetchRelease, isFailure, type Release } from "./github";
import type { Paths } from "./paths";
import { probeVersion } from "./probe";
import type { Run } from "./run";

export type DiscoverCtx = {
	paths: Paths;
	run: Run;
	fetch: FetchLike;
	token: string | null;
	/** The apps already in the list. */
	specs: AppSpec[];
	log: (text: string) => void;
	/** Tests point this at a local server. The token is only ever sent to the real one. */
	api?: string;
	/** The pause between two name searches during a scan. Default 300 ms. */
	searchGapMs?: number;
};

export const BAD_INPUT = "Give a GitHub repo like owner/name, a github.com link, or a file path.";

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
const OTHER_ARCH = /arm64|aarch64|armv[0-9]|arm-|i686|i386|x86(?!_64)|ppc64|riscv|s390x/i;
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

function rank(c: Candidate): number {
	const n = c.asset.name.toLowerCase();
	if (c.kind === "appimage") return 0;
	if (c.kind === "archive") return n.includes("gnu") ? 1 : n.includes("musl") ? 2 : 3;
	return c.kind === "file" ? 4 : 5;
}

/** The release's assets that run on Linux x86_64, best first; prefer puts kinds that match what is on disk ahead. */
export function machineAssets(assets: Asset[], prefer: AppKind[] = []): { candidates: Candidate[]; unopened: boolean } {
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
	return { candidates: candidates.toSorted((a, b) => preferred(a) - preferred(b) || rank(a) - rank(b)), unopened };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * An anchored pattern for name with the release's version made a wildcard. When that matches more
 * than one asset the pattern is the exact name, and widen says it will need editing at the next release.
 */
export function assetPattern(
	name: string,
	release: Pick<Release, "tag" | "version" | "assets">,
): { pattern: string; widen: boolean } {
	const versions = [release.tag, release.version, release.version ? `v${release.version}` : null]
		.filter((v): v is string => Boolean(v))
		.toSorted((a, b) => b.length - a.length);
	let body = escape(name);
	for (const v of versions) body = body.split(escape(v)).join(".*");
	const pattern = `^${body}$`;
	const re = new RegExp(pattern);
	if (release.assets.filter((a) => re.test(a.name)).length === 1) return { pattern, widen: false };
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

export const keyOf = (repoName: string) => repoName.toLowerCase().replace(/[^a-z0-9-]/g, "-");

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

export const isElf = (b: Buffer | null) =>
	b !== null && b.length >= 4 && b.subarray(0, 4).toString("latin1") === "\x7fELF";
export const isAppImage = (b: Buffer | null) =>
	isElf(b) && b !== null && b.length >= 11 && b.subarray(8, 11).toString("latin1") === "AI\x02";

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
	const bin = repoName.toLowerCase();
	const home = ctx.paths.home;

	// What is on disk decides which kinds lead, and where the app goes.
	let onDisk: { kinds: AppKind[]; path: string } | null = null;
	if (opts.file) {
		onDisk = { kinds: opts.file.appimage ? ["appimage"] : ["archive", "file"], path: opts.file.path };
	} else {
		const image = findAppImage(ctx, bin);
		const onPath = image ? null : await which(ctx, bin);
		if (image) onDisk = { kinds: ["appimage"], path: image };
		else if (onPath) onDisk = { kinds: onPath.startsWith("/usr/") ? ["deb"] : ["archive", "file"], path: onPath };
	}
	const { candidates, unopened } = machineAssets(release.assets, onDisk?.kinds);
	const usable = opts.file ? candidates.filter((c) => onDisk?.kinds.includes(c.kind)) : candidates;
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
	const sameKindDisk = onDisk && onDisk.kinds.includes(kind) ? onDisk.path : null;
	const dest =
		sameKindDisk ??
		(kind === "appimage"
			? join(home, ".local/bin", `${bin}.AppImage`)
			: kind === "deb"
				? `/usr/bin/${bin}`
				: join(home, ".local/bin", bin));
	const name = displayName(repoName);
	const key = keyOf(repoName);
	const { pattern, widen } = assetPattern(picked.asset.name, release);
	const spec: AppSpec = { key, name, kind, repo, asset: pattern, dest: tilde(dest, home) };
	if (kind === "archive") spec.bins = [opts.file ? (dest.split("/").at(-1) ?? bin) : bin];
	if (kind === "deb") spec.sudo = true;
	const exists = existsSync(dest);
	if (!exists) spec.install_if_missing = true;

	const why = [opts.found, `Matched ${picked.asset.name} for this machine.`];
	if (!opts.file)
		why.push(
			exists
				? `Found it installed at ${spec.dest}.`
				: `Nothing is installed at ${spec.dest} yet, so Install will put it there.`,
		);
	if (widen) why.push("The pattern is this release's exact asset name and will need widening.");
	let installed: string | null = null;
	if (exists && opts.probe !== false) {
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
