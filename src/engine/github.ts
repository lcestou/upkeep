import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Run } from "./run";
import { tagVersion } from "./version";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type Asset = { name: string; url: string; size: number; digest: string | null };

export type Release = {
	tag: string;
	/** The tag's version, or null when it is not a tracked version (no dot). */
	version: string | null;
	url: string;
	publishedAt: string;
	notes: string;
	assets: Asset[];
};

export type Failure = { failure: "rate" | "network" | "http"; detail: string; resetAt?: string };

export type Rate = { limit: number; remaining: number };

export type ReleaseOpts = {
	cacheDir: string;
	token?: string | null;
	fetch: FetchLike;
	/** Called with the budget headers of each GitHub answer. */
	onRate?: (rate: Rate) => void;
	/** Tests point this at a local server. The token is only ever sent to the real one. */
	api?: string;
	/** npm-tags: the installed version, so the pick is never older than it. */
	installed?: string;
	/** A release by its tag instead of the latest one: the installed version's, for its restore point. */
	tag?: string;
};

const GITHUB_API = "https://api.github.com";

/** Tells a failure from a result by its failure field, which no result type carries. */
export function isFailure<T extends object>(v: T | Failure): v is Failure {
	return "failure" in v;
}

/** Anything that is not a string reads as empty, so a missing field and a wrong-typed one are the same. */
function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

/** The top-level "version" of a JSON text, never one nested deeper; undefined when it is not JSON or has none. */
export function jsonVersion(text: string): string | undefined {
	try {
		// A file saved with a byte-order mark is still JSON to the app that wrote it.
		return str(record(JSON.parse(text.replace(/^\uFEFF/, ""))).version).trim() || undefined;
	} catch {
		return undefined;
	}
}

/** A JSON value read as a table of fields. Anything that is not an object, null included, reads as an empty one. */
function record(v: unknown): Record<string, unknown> {
	// SAFETY: v is a non-null object, and reading any key of one gives a value or undefined, never a throw.
	return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/** Null when the body has no tag. An asset that is not an object is skipped; a missing field reads as empty. */
function parseRelease(body: unknown): Release | null {
	if (typeof body !== "object" || body === null) return null;
	const b = record(body);
	const tag = str(b.tag_name);
	if (!tag) return null;
	const assets: Asset[] = [];
	if (Array.isArray(b.assets)) {
		for (const item of b.assets) {
			if (typeof item !== "object" || item === null) continue;
			const a = record(item);
			assets.push({
				name: str(a.name),
				url: str(a.browser_download_url),
				size: typeof a.size === "number" ? a.size : 0,
				digest: typeof a.digest === "string" && a.digest ? a.digest : null,
			});
		}
	}
	return {
		tag,
		version: tagVersion(tag),
		url: str(b.html_url),
		publishedAt: str(b.published_at),
		notes: str(b.body),
		assets,
	};
}

type Cached = { etag: string; body: string };

/** Null for a missing, unreadable or malformed cache file, which then costs one full request. */
function readCache(file: string): Cached | null {
	try {
		const c = record(JSON.parse(readFileSync(file, "utf8")));
		return typeof c.etag === "string" && typeof c.body === "string" ? { etag: c.etag, body: c.body } : null;
	} catch {
		return null;
	}
}

type RateRead = { hasRate: boolean; remaining: number; resetAt?: string };

/** The budget headers of one GitHub answer, passed on to onRate. Absent headers read as no budget known. */
function readRate(res: Response, opts: ReleaseOpts): RateRead {
	const limit = Number(res.headers.get("x-ratelimit-limit"));
	const remaining = Number(res.headers.get("x-ratelimit-remaining"));
	const hasRate = res.headers.has("x-ratelimit-remaining") && Number.isFinite(limit) && Number.isFinite(remaining);
	if (hasRate) opts.onRate?.({ limit, remaining });
	const reset = Number(res.headers.get("x-ratelimit-reset"));
	return { hasRate, remaining, resetAt: reset > 0 ? new Date(reset * 1000).toISOString() : undefined };
}

/** Only an error answer can be a rate limit: release notes may quote the phrase. */
function rateFailure(res: Response, text: string, rate: RateRead): Failure | null {
	if (
		!res.ok &&
		(text.includes("API rate limit exceeded") ||
			text.includes("secondary rate limit") ||
			((res.status === 403 || res.status === 429) && rate.hasRate && rate.remaining === 0))
	)
		return {
			failure: "rate",
			detail: "GitHub's request limit is used up. Try again after it resets.",
			resetAt: rate.resetAt,
		};
	return null;
}

/** A GitHub API GET with the token, the budget headers and the rate rules of fetchRelease. */
async function githubJson(path: string, opts: ReleaseOpts): Promise<{ status: number; body: unknown } | Failure> {
	const api = opts.api ?? GITHUB_API;
	const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "upkeep" };
	if (opts.token && api === GITHUB_API) headers.Authorization = `Bearer ${opts.token}`;
	let res: Response;
	try {
		res = await opts.fetch(`${api}${path}`, { headers });
	} catch (err) {
		return {
			failure: "network",
			detail: `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const text = await res.text();
	const limited = rateFailure(res, text, readRate(res, opts));
	if (limited) return limited;
	try {
		return { status: res.status, body: res.ok ? JSON.parse(text) : null };
	} catch {
		return { failure: "http", detail: `GitHub sent an answer for ${path} that is not JSON.` };
	}
}

export type Comparison = {
	status: "ahead" | "behind" | "identical" | "diverged";
	ahead: number;
	commits: { sha: string; title: string }[];
};

/** How far head is ahead of base on GitHub, with up to 30 of the newest commits up to head. base is a sha or a tag. */
export async function compareRefs(
	repo: string,
	base: string,
	head: string,
	opts: ReleaseOpts,
): Promise<Comparison | Failure> {
	const cmp = await githubJson(`/repos/${repo}/compare/${base}...${head}?per_page=1`, opts);
	if (isFailure(cmp)) return cmp;
	if (cmp.status === 404) return { failure: "http", detail: `GitHub does not know ${base} in ${repo}.` };
	if (cmp.status !== 200) return { failure: "http", detail: `GitHub answered ${cmp.status} for ${repo}.` };
	const c = record(cmp.body);
	const status = c.status;
	if (status !== "ahead" && status !== "behind" && status !== "identical" && status !== "diverged")
		return { failure: "http", detail: `GitHub sent no comparison for ${repo}.` };
	const ahead = typeof c.ahead_by === "number" ? c.ahead_by : 0;
	if (ahead === 0) return { status, ahead, commits: [] };
	// Compare lists oldest first and stops at 250; the commits endpoint is newest first.
	const list = await githubJson(`/repos/${repo}/commits?sha=${head}&per_page=30`, opts);
	if (isFailure(list)) return list;
	if (list.status !== 200 || !Array.isArray(list.body))
		return { failure: "http", detail: `GitHub answered ${list.status} for ${repo}.` };
	const commits = list.body.slice(0, Math.min(30, ahead)).map((item) => {
		const x = record(item);
		const commit = record(x.commit);
		return { sha: str(x.sha), title: str(commit.message).split("\n")[0] ?? "" };
	});
	return { status, ahead, commits };
}

/** Null for an empty list. Throws, as Bun.semver.order does, when a string is not a semver version. */
const highest = (vs: string[]) => vs.toSorted((a, b) => Bun.semver.order(b, a))[0] ?? null;

/**
 * The dist-tags pick: the highest stable version at or above installed, else the highest prerelease at or above it.
 * A tag whose value is not semver is skipped, so one odd tag cannot fail the whole check.
 */
export function pickDistTag(tags: Record<string, unknown>, installed?: string): string | null {
	const ok = (v: string) => {
		try {
			return Bun.semver.order(v, installed ?? v) >= 0;
		} catch {
			return false;
		}
	};
	const versions = [...new Set(Object.values(tags).filter((v): v is string => typeof v === "string"))].filter(ok);
	return highest(versions.filter((v) => !v.includes("-"))) ?? highest(versions);
}

/**
 * releases/latest for owner/repo, or the release of opts.tag, revalidated with the cached etag so an unchanged
 * release costs no budget. Each tag has a cache file of its own.
 */
export async function fetchRelease(repo: string, opts: ReleaseOpts): Promise<Release | Failure> {
	const api = opts.api ?? GITHUB_API;
	const which = opts.tag === undefined ? "latest" : `tags/${encodeURIComponent(opts.tag)}`;
	const cacheFile = join(
		opts.cacheDir,
		`${repo.replace("/", "__")}${opts.tag === undefined ? "" : `@${encodeURIComponent(opts.tag)}`}.json`,
	);
	const cached = readCache(cacheFile);
	const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "upkeep" };
	if (cached) headers["If-None-Match"] = cached.etag;
	if (opts.token && api === GITHUB_API) headers.Authorization = `Bearer ${opts.token}`;
	let res: Response;
	try {
		res = await opts.fetch(`${api}/repos/${repo}/releases/${which}`, { headers });
	} catch (err) {
		return {
			failure: "network",
			detail: `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const rate = readRate(res, opts);
	if (res.status === 304 && cached) {
		const r = toRelease(cached.body, repo);
		// A corrupt cache would otherwise stick until upstream's etag changes.
		if (isFailure(r)) rmSync(cacheFile, { force: true });
		return r;
	}
	const text = await res.text();
	const limited = rateFailure(res, text, rate);
	if (limited) return limited;
	if (!res.ok) return { failure: "http", detail: `GitHub answered ${res.status} for ${repo}.` };
	const etag = res.headers.get("etag");
	if (etag) {
		mkdirSync(opts.cacheDir, { recursive: true });
		const tmp = `${cacheFile}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ etag, body: text }));
		renameSync(tmp, cacheFile);
	}
	return toRelease(text, repo);
}

/** A cached or fresh releases/latest body. Text that is not JSON or has no tag is an http failure. */
function toRelease(text: string, repo: string): Release | Failure {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return { failure: "http", detail: `GitHub sent a release for ${repo} that is not JSON.` };
	}
	return parseRelease(body) ?? { failure: "http", detail: `GitHub sent no release tag for ${repo}.` };
}

/** One repository of a search answer, with the fields discovery decides on. */
export type RepoHit = { name: string; fullName: string; stars: number };

/** The items of a repository search answer. An item without a string name and full name and a numeric star count is dropped. */
export function parseRepoSearch(body: unknown): RepoHit[] {
	const items = record(body).items;
	if (!Array.isArray(items)) return [];
	const hits: RepoHit[] = [];
	for (const item of items) {
		const i = record(item);
		if (typeof i.name === "string" && typeof i.full_name === "string" && typeof i.stargazers_count === "number")
			hits.push({ name: i.name, fullName: i.full_name, stars: i.stargazers_count });
	}
	return hits;
}

const SIDE_FILES = /\.(sha256|sig|asc|zsync)$/;

/** The first asset matching pattern, skipping checksum and signature files, with the number of matches. */
export function pickAsset(release: Release, pattern: string): { asset: Asset; count: number; names: string[] } | null {
	const re = new RegExp(pattern);
	const matches = release.assets.filter((a) => re.test(a.name) && !SIDE_FILES.test(a.name));
	const first = matches[0];
	return first ? { asset: first, count: matches.length, names: matches.map((m) => m.name) } : null;
}

/** The owner's GitHub token from the gh CLI, or null when gh is missing or logged out. */
export async function githubToken(run: Run): Promise<string | null> {
	const r = await run(["gh", "auth", "token"], { timeoutMs: 10_000 });
	const token = r.stdout.trim();
	return r.code === 0 && token ? token : null;
}

/**
 * A vendor's own update endpoint that answers {"version", "downloadUrl"} (Cursor's does), as a release with that one
 * asset. It lists no size and no checksum, so the download is held to a floor instead (download.ts). Only an https
 * download URL is taken: the answer decides what gets installed.
 */
async function jsonRelease(url: string, opts: ReleaseOpts): Promise<{ version: string; release: Release } | Failure> {
	let res: Response;
	try {
		res = await opts.fetch(url, { headers: { Accept: "application/json" } });
	} catch (err) {
		return {
			failure: "network",
			detail: `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	if (!res.ok) return { failure: "http", detail: `${url} answered ${res.status}.` };
	let body: unknown = null;
	try {
		body = await res.json();
	} catch {
		// not JSON: no version, said below
	}
	const b = record(body);
	const version = str(b.version);
	const download = str(b.downloadUrl);
	let at: URL | null = null;
	try {
		at = download ? new URL(download) : null;
	} catch {
		at = null;
	}
	if (!version || !at || at.protocol !== "https:") return { failure: "http", detail: `${url} sent no version.` };
	const asset = { name: basename(at.pathname), url: at.href, size: 0, digest: null };
	return { version, release: { tag: version, version, url: "", publishedAt: "", notes: "", assets: [asset] } };
}

/**
 * A latest version from a source string: "npm:<pkg>", "pypi:<pkg>", "github:<owner>/<repo>", "npm-tags:<pkg>" or
 * "json:<url>" (an object with "version" and "downloadUrl"; an AppImage takes it in place of repo).
 */
export async function latestFromSource(
	source: string,
	opts: ReleaseOpts,
): Promise<{ version: string; release?: Release } | Failure> {
	const sep = source.indexOf(":");
	const scheme = source.slice(0, sep);
	const name = source.slice(sep + 1);
	if (scheme === "github") {
		const r = await fetchRelease(name, opts);
		if (isFailure(r)) return r;
		return r.version
			? { version: r.version, release: r }
			: { failure: "http", detail: `${name} has no tracked version tag.` };
	}
	if (scheme === "json") return jsonRelease(name, opts);
	if (scheme === "npm-tags") {
		const url = `https://registry.npmjs.org/-/package/${name}/dist-tags`;
		let tags: unknown;
		try {
			const res = await opts.fetch(url, { headers: { Accept: "application/json" } });
			if (!res.ok) return { failure: "http", detail: `${url} answered ${res.status}.` };
			tags = await res.json();
		} catch (err) {
			return {
				failure: "network",
				detail: `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
		const pick = pickDistTag(record(tags), opts.installed);
		if (pick) return { version: pick };
		return opts.installed
			? { failure: "http", detail: `No published version at or above ${opts.installed}.` }
			: { failure: "http", detail: `${url} sent no version.` };
	}
	const url =
		scheme === "npm"
			? `https://registry.npmjs.org/${name}/latest`
			: scheme === "pypi"
				? `https://pypi.org/pypi/${name}/json`
				: null;
	if (!url) return { failure: "http", detail: `Unknown version source ${source}.` };
	let body: unknown;
	try {
		const res = await opts.fetch(url, { headers: { Accept: "application/json" } });
		if (!res.ok) return { failure: "http", detail: `${url} answered ${res.status}.` };
		body = await res.json();
	} catch (err) {
		return {
			failure: "network",
			detail: `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const b = record(body);
	const info = record(b.info);
	const version = str(scheme === "npm" ? b.version : info.version);
	return version ? { version } : { failure: "http", detail: `${url} sent no version.` };
}
