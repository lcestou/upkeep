/**
 * Release sources beyond GitHub: GitLab (gitlab.com or self-hosted), Gitea and Forgejo (Codeberg or self-hosted),
 * and a plain web page that lists download links. Each answers in the Release shape github.ts gives, so a check, an
 * install and a restore point read every source the same way. The hosts named here are the ones a repo may name
 * without saying which forge runs there; any other host needs the table's forge field.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { MESSAGES } from "../shared/messages";
import {
	type Asset,
	type Failure,
	fetchRelease,
	isFailure,
	parseRelease,
	record,
	type Release,
	type ReleaseOpts,
	type Revalidated,
	revalidate,
	str,
} from "./github";
import { isNewer, tagVersion } from "./version";

/** The forges a self-hosted repo may name in its table's forge field. */
export const FORGES = ["gitlab", "gitea"] as const;
export type ForgeKind = (typeof FORGES)[number];

/** Where a repo lives: the forge's kind, its host, and the project path on it (owner/name, or group/…/name on GitLab). */
export type Forge = { kind: ForgeKind | "github"; host: string; path: string };

/** Hosts whose forge is known without a forge field. */
const KNOWN_HOSTS = new Map<string, Forge["kind"]>([
	["github.com", "github"],
	["gitlab.com", "gitlab"],
	["codeberg.org", "gitea"],
]);

const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The host of a host-form repo ("gitlab.com" for "gitlab.com/group/name"), lowercased, or null for the plain
 * owner/name form, which is GitHub's. A GitHub owner cannot hold a dot, so a dot in the first part is what marks a host.
 */
export function hostOf(repo: string): string | null {
	const first = repo.split("/")[0] ?? "";
	return first.includes(".") ? first.toLowerCase() : null;
}

/** The forge a host runs when it is one whose forge is known without a forge field, else undefined. */
export function hostKind(host: string): Forge["kind"] | undefined {
	return KNOWN_HOSTS.get(host);
}

/**
 * A table's repo read as a forge, or null when it is not a form Upkeep reads: owner/name (GitHub), or
 * host/owner/name, with any number of groups before the name on GitLab. A host Upkeep does not know needs forge; a
 * known host ignores it. "." and ".." are never a part, so a path cannot climb out of the API's.
 */
export function forgeOf(repo: string, forge?: ForgeKind): Forge | null {
	const parts = repo.split("/");
	if (!parts.every((p) => SEGMENT.test(p) && p !== "." && p !== "..")) return null;
	const host = hostOf(repo);
	if (host === null) return parts.length === 2 ? { kind: "github", host: "github.com", path: repo } : null;
	const kind = KNOWN_HOSTS.get(host) ?? forge;
	const path = parts.slice(1);
	if (kind === undefined || !HOST.test(host)) return null;
	if (kind === "gitlab" ? path.length < 2 : path.length !== 2) return null;
	return { kind, host, path: path.join("/") };
}

/** The https address git clones the repo from; an unreadable repo is taken as GitHub's owner/name, as before forges. */
export function cloneUrl(repo: string, forge?: ForgeKind): string {
	const f = forgeOf(repo, forge);
	return f ? `https://${f.host}/${f.path}.git` : `https://github.com/${repo}.git`;
}

/** The decoded last part of a URL's path, or "" when the path ends in a slash or holds a bad escape. */
function fileName(url: URL): string {
	const last = url.pathname.split("/").at(-1) ?? "";
	try {
		return decodeURIComponent(last);
	} catch {
		return "";
	}
}

/** An https URL read from text, or null for anything else: a download decides what gets installed. */
function httpsUrl(text: string, base?: string): URL | null {
	try {
		const u = new URL(text, base);
		return u.protocol === "https:" ? u : null;
	} catch {
		return null;
	}
}

/**
 * A GitLab release body. Its files are assets.links: the name a person reads there is a label ("binary: Linux
 * amd64"), so an asset is named by the file its link points at, direct_asset_url when given (the host's own
 * permanent address) else url. GitLab lists no size and no checksum, so the download is held to the floor (download.ts).
 * A link that is not https is skipped. Null when the body has no tag.
 */
function parseGitlab(body: unknown): Release | null {
	const b = record(body);
	const tag = str(b.tag_name);
	if (!tag) return null;
	const assets: Asset[] = [];
	const links = record(b.assets).links;
	for (const item of Array.isArray(links) ? links : []) {
		const l = record(item);
		const at = httpsUrl(str(l.direct_asset_url) || str(l.url));
		const name = at ? fileName(at) : "";
		if (at && name) assets.push({ name, url: at.href, size: 0, digest: null });
	}
	return {
		tag,
		version: tagVersion(tag),
		url: str(record(b["_links"]).self),
		publishedAt: str(b.released_at),
		notes: str(b.description),
		assets,
	};
}

/** A cached or fresh release body from a forge other than GitHub; text that is not JSON or has no tag is a failure. */
function readRelease(text: string, f: Forge): Release | Failure {
	let body: unknown = null;
	try {
		body = JSON.parse(text);
	} catch {
		// not JSON: no release, said below
	}
	const r = f.kind === "gitlab" ? parseGitlab(body) : parseRelease(body);
	if (!r) return { failure: "http", detail: MESSAGES.forgeSentNoRelease(f.host, f.path) };
	// A Gitea asset is the uploader's own address on the host; only https is taken.
	return { ...r, assets: r.assets.filter((a) => httpsUrl(a.url) !== null) };
}

/**
 * The latest release of a repo, or the release of opts.tag, from whichever forge the repo names. GitHub keeps its
 * token, budget and test server (fetchRelease); any other host gets neither token nor budget callback, so the
 * owner's GitHub token never leaves for another host. A repo that is not a readable form goes to GitHub as written,
 * as it did before forges, and fails there.
 */
export async function forgeRelease(
	repo: string,
	forge: ForgeKind | undefined,
	opts: ReleaseOpts,
): Promise<Release | Failure> {
	const f = forgeOf(repo, forge);
	if (!f || f.kind === "github") return fetchRelease(f?.path ?? repo, opts);
	const base = `https://${f.host}`;
	const tag = opts.tag === undefined ? null : encodeURIComponent(opts.tag);
	const url =
		f.kind === "gitlab"
			? `${base}/api/v4/projects/${encodeURIComponent(f.path)}/releases/${tag ?? "permalink/latest"}`
			: `${base}/api/v1/repos/${f.path}/releases/${tag === null ? "latest" : `tags/${tag}`}`;
	const cacheFile = join(
		opts.cacheDir,
		`${f.host}__${f.path.replaceAll("/", "__")}${tag === null ? "" : `@${tag}`}.json`,
	);
	let got: Revalidated;
	try {
		got = await revalidate(url, cacheFile, { Accept: "application/json", "User-Agent": "upkeep" }, opts.fetch);
	} catch (err) {
		return {
			failure: "network",
			detail: MESSAGES.couldNotReachUrl(f.host, err instanceof Error ? err.message : String(err)),
		};
	}
	if (got.fromCache) {
		const r = readRelease(got.text, f);
		// A corrupt cache would otherwise stick until the host's etag changes.
		if (isFailure(r)) rmSync(cacheFile, { force: true });
		return r;
	}
	if (got.res.status === 429) {
		// GitLab sends the reset as epoch seconds; Forgejo sends none.
		const reset = Number(got.res.headers.get("ratelimit-reset"));
		return {
			failure: "rate",
			detail: MESSAGES.forgeRateLimit(f.host),
			resetAt: reset > 1e9 ? new Date(reset * 1000).toISOString() : undefined,
		};
	}
	if (!got.res.ok) return { failure: "http", detail: MESSAGES.forgeAnswered(f.host, got.res.status, f.path) };
	return readRelease(got.text, f);
}

// An <a> tag's href, in double, single or no quotes.
const HREF = /<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

/** The character references an href can carry (&amp;, &#38;, &#x26; and the like), decoded; anything else is left. */
function decodeEntities(s: string): string {
	const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
	return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (all, e: string) => {
		const code =
			e.startsWith("#x") || e.startsWith("#X")
				? Number.parseInt(e.slice(2), 16)
				: e.startsWith("#")
					? Number(e.slice(1))
					: Number.NaN;
		if (Number.isInteger(code) && code > 0 && code < 0x110000) return String.fromCodePoint(code);
		return named[e.toLowerCase()] ?? all;
	});
}

/**
 * The download links of a web page, each resolved against the page's own address (after redirects) and named by the
 * file it points at. Only https links that name a file are kept; a link listed twice is kept once.
 * shortcut: a <base href> is not read; upgrade when a page that uses one is added.
 */
export function pageLinks(html: string, page: string): Asset[] {
	const seen = new Set<string>();
	const out: Asset[] = [];
	for (const m of html.matchAll(HREF)) {
		const raw = decodeEntities(m[1] ?? m[2] ?? m[3] ?? "");
		const at = httpsUrl(raw, page);
		const name = at ? fileName(at) : "";
		if (!at || !name || seen.has(at.href)) continue;
		seen.add(at.href);
		out.push({ name, url: at.href, size: 0, digest: null });
	}
	return out;
}

/**
 * A "links:<page>" source: the page's links whose file name matches pattern, as one release at the newest version a
 * matched name holds (2.10 is newer than 2.9). With opts.tag, the links of that version instead, for a restore point.
 * Every link of the chosen version that matches is an asset, so two matches are the table's to narrow, as with a
 * release. A name without a dotted version is passed over. Nothing on the page lists a size or a checksum, so each
 * download is held to the floor, as a json: one is.
 */
export async function linksRelease(page: string, pattern: string, opts: ReleaseOpts): Promise<Release | Failure> {
	if (!httpsUrl(page)) return { failure: "http", detail: MESSAGES.unknownVersionSource(`links:${page}`) };
	let res: Response;
	let html: string;
	try {
		res = await opts.fetch(page, { headers: { Accept: "text/html", "User-Agent": "upkeep" } });
		html = res.ok ? await res.text() : "";
	} catch (err) {
		return {
			failure: "network",
			detail: MESSAGES.couldNotReachUrl(page, err instanceof Error ? err.message : String(err)),
		};
	}
	if (!res.ok) return { failure: "http", detail: MESSAGES.urlAnswered(page, res.status) };
	const re = new RegExp(pattern);
	const matched = pageLinks(html, res.url || page).flatMap((a) => {
		const version = re.test(a.name) ? tagVersion(a.name) : null;
		return version ? [{ asset: a, version }] : [];
	});
	if (matched.length === 0) return { failure: "http", detail: MESSAGES.linksNoMatch(page, pattern) };
	// A prerelease (2.10rc1 reads 2.10rc) compares equal to its release, so stable versions are chosen among first.
	const stable = matched.filter((m) => /^[0-9.]+$/.test(m.version));
	const pool = stable.length > 0 ? stable : matched;
	let version = opts.tag ?? pool[0]?.version ?? "";
	if (opts.tag === undefined) for (const m of pool) if (isNewer(version, m.version)) version = m.version;
	const assets = matched.filter((m) => m.version === version).map((m) => m.asset);
	if (assets.length === 0) return { failure: "http", detail: MESSAGES.linksNoMatch(page, pattern) };
	return { tag: version, version, url: page, publishedAt: "", notes: "", assets };
}
