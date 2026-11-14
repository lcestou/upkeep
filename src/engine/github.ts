import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { MESSAGES } from "../shared/messages";
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

/** GitHub's budget from an answer's headers; resetAt is when the hour starts over, when GitHub says. */
export type Rate = { limit: number; remaining: number; resetAt?: string };

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
export function str(v: unknown): string {
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
export function record(v: unknown): Record<string, unknown> {
	// SAFETY: v is a non-null object, and reading any key of one gives a value or undefined, never a throw.
	return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/**
 * Null when the body has no tag. An asset that is not an object is skipped; a missing field reads as empty. Gitea and
 * Forgejo answer in this same shape, without the digest.
 */
export function parseRelease(body: unknown): Release | null {
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

/** One answer of a revalidated GET: fromCache when the server said 304 and text is what was cached. */
export type Revalidated = { res: Response; text: string; fromCache: boolean };

/**
 * A GET sent with the etag cached in cacheFile, so an unchanged answer costs no budget. A fresh 2xx answer with an
 * etag is cached through a temp name and a rename; any other answer is returned as it came and never cached. Throws
 * what fetch throws.
 */
export async function revalidate(
	url: string,
	cacheFile: string,
	headers: Record<string, string>,
	fetch: FetchLike,
): Promise<Revalidated> {
	const cached = readCache(cacheFile);
	const sent = cached ? { ...headers, "If-None-Match": cached.etag } : headers;
	const res = await fetch(url, { headers: sent });
	if (res.status === 304 && cached) return { res, text: cached.body, fromCache: true };
	const text = await res.text();
	const etag = res.headers.get("etag");
	if (res.ok && etag) {
		mkdirSync(dirname(cacheFile), { recursive: true });
		const tmp = `${cacheFile}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ etag, body: text }));
		renameSync(tmp, cacheFile);
	}
	return { res, text, fromCache: false };
}

type RateRead = { hasRate: boolean; remaining: number; resetAt?: string };

/** The budget headers of one GitHub answer, passed on to onRate. Absent headers read as no budget known. */
function readRate(res: Response, opts: ReleaseOpts): RateRead {
	const limit = Number(res.headers.get("x-ratelimit-limit"));
	const remaining = Number(res.headers.get("x-ratelimit-remaining"));
	const hasRate = res.headers.has("x-ratelimit-remaining") && Number.isFinite(limit) && Number.isFinite(remaining);
	const reset = Number(res.headers.get("x-ratelimit-reset"));
	const resetAt = reset > 0 ? new Date(reset * 1000).toISOString() : undefined;
	if (hasRate) opts.onRate?.(resetAt ? { limit, remaining, resetAt } : { limit, remaining });
	return { hasRate, remaining, resetAt };
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
			detail: MESSAGES.rateLimitSearch(),
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
			detail: MESSAGES.couldNotReachGithubSearch(err instanceof Error ? err.message : String(err)),
		};
	}
	const text = await res.text();
	const limited = rateFailure(res, text, readRate(res, opts));
	if (limited) return limited;
	try {
		return { status: res.status, body: res.ok ? JSON.parse(text) : null };
	} catch {
		return { failure: "http", detail: MESSAGES.githubNotJson(path) };
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
	if (cmp.status === 404) return { failure: "http", detail: MESSAGES.githubUnknownRef(base, repo) };
	if (cmp.status !== 200) return { failure: "http", detail: MESSAGES.githubAnsweredSearch(cmp.status, repo) };
	const c = record(cmp.body);
	const status = c.status;
	if (status !== "ahead" && status !== "behind" && status !== "identical" && status !== "diverged")
		return { failure: "http", detail: MESSAGES.githubNoComparison(repo) };
	const ahead = typeof c.ahead_by === "number" ? c.ahead_by : 0;
	if (ahead === 0) return { status, ahead, commits: [] };
	// Compare lists oldest first and stops at 250; the commits endpoint is newest first.
	const list = await githubJson(`/repos/${repo}/commits?sha=${head}&per_page=30`, opts);
	if (isFailure(list)) return list;
	if (list.status !== 200 || !Array.isArray(list.body))
		return { failure: "http", detail: MESSAGES.githubAnsweredSearch(list.status, repo) };
	const commits = list.body.slice(0, Math.min(30, ahead)).map((item) => {
		const x = record(item);
		const commit = record(x.commit);
		return { sha: str(x.sha), title: str(commit.message).split("\n")[0] ?? "" };
	});
	return { status, ahead, commits };
}

/** The names of the files and folders at a repo's root at ref, as GitHub lists them. */
export async function rootNames(repo: string, ref: string, opts: ReleaseOpts): Promise<string[] | Failure> {
	const r = await githubJson(`/repos/${repo}/contents?ref=${encodeURIComponent(ref)}`, opts);
	if (isFailure(r)) return r;
	if (r.status !== 200 || !Array.isArray(r.body))
		return { failure: "http", detail: MESSAGES.githubAnsweredSearch(r.status, repo) };
	return r.body.map((item) => str(record(item).name)).filter(Boolean);
}

/** One small text file of a repo at ref, or null when it cannot be read: a draft does without it. */
export async function repoText(repo: string, path: string, ref: string, opts: ReleaseOpts): Promise<string | null> {
	const r = await githubJson(`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, opts);
	if (isFailure(r) || r.status !== 200) return null;
	const f = record(r.body);
	return f.encoding === "base64" && typeof f.content === "string"
		? Buffer.from(f.content, "base64").toString("utf8")
		: null;
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
	const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "upkeep" };
	if (opts.token && api === GITHUB_API) headers.Authorization = `Bearer ${opts.token}`;
	let got: Revalidated;
	try {
		got = await revalidate(`${api}/repos/${repo}/releases/${which}`, cacheFile, headers, opts.fetch);
	} catch (err) {
		return {
			failure: "network",
			detail: MESSAGES.couldNotReachGithubSearch(err instanceof Error ? err.message : String(err)),
		};
	}
	const rate = readRate(got.res, opts);
	if (got.fromCache) {
		const r = toRelease(got.text, repo);
		// A corrupt cache would otherwise stick until upstream's etag changes.
		if (isFailure(r)) rmSync(cacheFile, { force: true });
		return r;
	}
	const limited = rateFailure(got.res, got.text, rate);
	if (limited) return limited;
	if (!got.res.ok) return { failure: "http", detail: MESSAGES.githubAnsweredSearch(got.res.status, repo) };
	return toRelease(got.text, repo);
}

/** A cached or fresh releases/latest body. Text that is not JSON or has no tag is an http failure. */
function toRelease(text: string, repo: string): Release | Failure {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return { failure: "http", detail: MESSAGES.githubReleaseNotJson(repo) };
	}
	return parseRelease(body) ?? { failure: "http", detail: MESSAGES.githubNoReleaseTag(repo) };
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

/**
 * The first asset matching pattern, skipping checksum and signature files and source rpms (which install only sources),
 * with the number of matches.
 */
export function pickAsset(release: Release, pattern: string): { asset: Asset; count: number; names: string[] } | null {
	const re = new RegExp(pattern);
	const matches = release.assets.filter(
		(a) => re.test(a.name) && !SIDE_FILES.test(a.name) && !/\.src\.rpm$/i.test(a.name),
	);
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
			detail: MESSAGES.couldNotReachUrl(url, err instanceof Error ? err.message : String(err)),
		};
	}
	if (!res.ok) return { failure: "http", detail: MESSAGES.urlAnswered(url, res.status) };
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
	if (!version || !at || at.protocol !== "https:") return { failure: "http", detail: MESSAGES.urlSentNoVersion(url) };
	const asset = { name: basename(at.pathname), url: at.href, size: 0, digest: null };
	return { version, release: { tag: version, version, url: "", publishedAt: "", notes: "", assets: [asset] } };
}

/**
 * A latest version from a source string: "npm:<pkg>", "pypi:<pkg>", "crates:<crate>", "github:<owner>/<repo>", "npm-tags:<pkg>" or
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
			: { failure: "http", detail: MESSAGES.noTrackedVersionTag(name) };
	}
	if (scheme === "json") return jsonRelease(name, opts);
	if (scheme === "npm-tags") {
		const url = `https://registry.npmjs.org/-/package/${name}/dist-tags`;
		let tags: unknown;
		try {
			const res = await opts.fetch(url, { headers: { Accept: "application/json" } });
			if (!res.ok) return { failure: "http", detail: MESSAGES.urlAnswered(url, res.status) };
			tags = await res.json();
		} catch (err) {
			return {
				failure: "network",
				detail: MESSAGES.couldNotReachUrl(url, err instanceof Error ? err.message : String(err)),
			};
		}
		const pick = pickDistTag(record(tags), opts.installed);
		if (pick) return { version: pick };
		return opts.installed
			? { failure: "http", detail: MESSAGES.noVersionAtOrAbove(opts.installed) }
			: { failure: "http", detail: MESSAGES.urlSentNoVersion(url) };
	}
	const url =
		scheme === "npm"
			? `https://registry.npmjs.org/${name}/latest`
			: scheme === "pypi"
				? `https://pypi.org/pypi/${name}/json`
				: scheme === "crates"
					? `https://crates.io/api/v1/crates/${name}`
					: null;
	if (!url) return { failure: "http", detail: MESSAGES.unknownVersionSource(source) };
	let body: unknown;
	try {
		// crates.io refuses a request that names no client.
		const headers: Record<string, string> = { Accept: "application/json" };
		if (scheme === "crates") headers["User-Agent"] = "upkeep";
		const res = await opts.fetch(url, { headers });
		if (!res.ok) return { failure: "http", detail: MESSAGES.urlAnswered(url, res.status) };
		body = await res.json();
	} catch (err) {
		return {
			failure: "network",
			detail: MESSAGES.couldNotReachUrl(url, err instanceof Error ? err.message : String(err)),
		};
	}
	const b = record(body);
	const info = record(b.info);
	const version = str(
		scheme === "npm" ? b.version : scheme === "crates" ? record(b.crate).max_stable_version : info.version,
	);
	return version ? { version } : { failure: "http", detail: MESSAGES.urlSentNoVersion(url) };
}
