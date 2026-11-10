import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
};

const GITHUB_API = "https://api.github.com";

export function isFailure(v: object): v is Failure {
	return "failure" in v;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function parseRelease(body: unknown): Release | null {
	if (typeof body !== "object" || body === null) return null;
	const b = body as Record<string, unknown>;
	const tag = str(b.tag_name);
	if (!tag) return null;
	const assets: Asset[] = [];
	if (Array.isArray(b.assets)) {
		for (const a of b.assets as Record<string, unknown>[]) {
			if (typeof a !== "object" || a === null) continue;
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

function readCache(file: string): Cached | null {
	try {
		const c = JSON.parse(readFileSync(file, "utf8")) as Partial<Cached>;
		return typeof c.etag === "string" && typeof c.body === "string" ? { etag: c.etag, body: c.body } : null;
	} catch {
		return null;
	}
}

/** releases/latest for owner/repo, revalidated with the cached etag so an unchanged release costs no budget. */
export async function fetchRelease(repo: string, opts: ReleaseOpts): Promise<Release | Failure> {
	const api = opts.api ?? GITHUB_API;
	const cacheFile = join(opts.cacheDir, `${repo.replace("/", "__")}.json`);
	const cached = readCache(cacheFile);
	const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "upkeep" };
	if (cached) headers["If-None-Match"] = cached.etag;
	if (opts.token && api === GITHUB_API) headers.Authorization = `Bearer ${opts.token}`;
	let res: Response;
	try {
		res = await opts.fetch(`${api}/repos/${repo}/releases/latest`, { headers });
	} catch (err) {
		return {
			failure: "network",
			detail: `Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const limit = Number(res.headers.get("x-ratelimit-limit"));
	const remaining = Number(res.headers.get("x-ratelimit-remaining"));
	const hasRate = res.headers.has("x-ratelimit-remaining") && Number.isFinite(limit) && Number.isFinite(remaining);
	if (hasRate) opts.onRate?.({ limit, remaining });
	const reset = Number(res.headers.get("x-ratelimit-reset"));
	const resetAt = reset > 0 ? new Date(reset * 1000).toISOString() : undefined;
	if (res.status === 304 && cached) {
		const r = toRelease(cached.body, repo);
		// A corrupt cache would otherwise stick until upstream's etag changes.
		if (isFailure(r)) rmSync(cacheFile, { force: true });
		return r;
	}
	const text = await res.text();
	// Only an error answer can be a rate limit: release notes may quote the phrase.
	if (
		!res.ok &&
		(text.includes("API rate limit exceeded") ||
			text.includes("secondary rate limit") ||
			((res.status === 403 || res.status === 429) && hasRate && remaining === 0))
	)
		return { failure: "rate", detail: "GitHub's request limit is used up. Try again after it resets.", resetAt };
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

function toRelease(text: string, repo: string): Release | Failure {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return { failure: "http", detail: `GitHub sent a release for ${repo} that is not JSON.` };
	}
	return parseRelease(body) ?? { failure: "http", detail: `GitHub sent no release tag for ${repo}.` };
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

/** A self-updater's latest version: "npm:<pkg>", "pypi:<pkg>" or "github:<owner>/<repo>". */
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
	const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
	const info = (typeof b.info === "object" && b.info !== null ? b.info : {}) as Record<string, unknown>;
	const version = str(scheme === "npm" ? b.version : info.version);
	return version ? { version } : { failure: "http", detail: `${url} sent no version.` };
}
