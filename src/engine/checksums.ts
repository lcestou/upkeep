import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { type Asset, type FetchLike, GITHUB_API, record, type Release, str, type Sum } from "./github";

/** A checksum file bigger than this is not one: it is skipped unread. */
export const MAX_SUM_BYTES = 1024 * 1024;

/** SHA256SUMS, checksums.txt, goreleaser's <project>_<version>_checksums.txt and the like. */
const LIST = /^(?:.*[._-])?(?:sha(?:256|512)sums?|checksums?)(?:\.txt)?$/i;

/** electron-builder's update file for Linux, which lists each file's sha512 in base64. */
const YML = /^latest-linux(?:-[a-z0-9]+)?\.ya?ml$/i;

/** The extensions of a checksum file kept beside one asset, holding that asset's hash, matched in any case. */
const OWN = [".sha256", ".sha256sum", ".sha512", ".sha512sum"];

/** Whether file is asset's own checksum file: asset's name with one of OWN after it, in any case. */
function isOwn(file: string, asset: string): boolean {
	return OWN.some((e) => file.toLowerCase() === `${asset}${e}`.toLowerCase());
}

/** The algorithm a hex digest's length names, or null for any other length or a non-hex string. */
function algoOf(hex: string): Sum["algo"] | null {
	if (!/^[0-9a-f]+$/i.test(hex)) return null;
	return hex.length === 64 ? "sha256" : hex.length === 128 ? "sha512" : null;
}

/**
 * The release's files that may hold a hash for the asset named name, best first: its own .sha256 beside it, then a
 * list for the whole release, then electron-builder's yml. Another asset's own file (other.AppImage.sha256sum) is
 * left out, since it cannot name this one, and so is a file listed with a size over MAX_SUM_BYTES.
 */
export function sumFiles(release: Pick<Release, "assets">, name: string): Asset[] {
	const others = release.assets.map((a) => a.name).filter((n) => n !== name);
	const rank = (n: string) =>
		isOwn(n, name) ? 0 : others.some((o) => isOwn(n, o)) ? -1 : LIST.test(n) ? 1 : YML.test(n) ? 2 : -1;
	return release.assets
		.filter((a) => a.name !== name && rank(a.name) >= 0 && a.size <= MAX_SUM_BYTES)
		.toSorted((a, b) => rank(a.name) - rank(b.name));
}

/**
 * The hash a sha256sum-style text gives for name: "hash  name", "hash *name" or BSD's "SHA256 (name) = hash". A line
 * naming name exactly wins; otherwise a path whose base name is name counts ("./name", "dist/name"), but only when
 * every such line gives the same hash: x86_64/app.tar.gz and aarch64/app.tar.gz cannot be told apart, so neither is
 * trusted. The asset's own file (own) with a single hash line gives that hash whatever path it names. A line with a
 * hash of an unknown length is passed over. Null when nothing names it.
 */
export function sumIn(text: string, name: string, own: boolean): Omit<Sum, "file"> | null {
	const lines: { algo: Sum["algo"]; hex: string; file: string | undefined }[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		const bsd = /^SHA(?:256|512) ?\((.+)\) ?= ?(\S+)$/i.exec(line);
		const gnu = /^(\S+)(?:\s+\*?(.+))?$/.exec(line);
		const hex = bsd?.[2] ?? gnu?.[1] ?? "";
		const algo = algoOf(hex);
		if (algo) lines.push({ algo, hex: hex.toLowerCase(), file: (bsd ? bsd[1] : gnu?.[2])?.trim() });
	}
	const only = lines.length === 1 ? lines[0] : undefined;
	if (own && only) return { algo: only.algo, hex: only.hex };
	const exact = lines.find((l) => l.file === name || l.file === `./${name}`);
	if (exact) return { algo: exact.algo, hex: exact.hex };
	const byBase = lines.filter((l) => l.file !== undefined && basename(l.file) === name);
	const first = byBase[0];
	return first && byBase.every((l) => l.hex === first.hex) ? { algo: first.algo, hex: first.hex } : null;
}

/**
 * The sha512 electron-builder's latest-linux.yml gives for name, from the "url:" or "path:" entry naming it and the
 * "sha512:" line after it, turned from base64 into hex. Null when no entry names it or its value is not a sha512.
 */
export function sumInYml(text: string, name: string): Omit<Sum, "file"> | null {
	let current = "";
	for (const raw of text.split(/\r?\n/)) {
		const m = /^\s*(?:-\s*)?(url|path|sha512):\s*['"]?([^'"\s]+)['"]?\s*$/.exec(raw);
		if (!m) continue;
		const value = m[2] ?? "";
		if (m[1] !== "sha512") current = basename(value);
		else if (current === name) {
			const hex = Buffer.from(value, "base64").toString("hex");
			return algoOf(hex) === "sha512" ? { algo: "sha512", hex } : null;
		}
	}
	return null;
}

/**
 * The text at url, or null when it is not https, the answer is an error, a redirect leaves https, it takes over 15 s
 * or it grows past MAX_SUM_BYTES. Never throws: a checksum file that cannot be read leaves the download as it was.
 * A 404 for a file with a GitHub API address is asked again there with the person's token, as a private repo's asset
 * is; the token goes only to api.github.com.
 */
async function readSmall(
	side: Asset,
	fetch: FetchLike,
	token: string | null,
	cancel?: AbortSignal,
): Promise<string | null> {
	// Stop now ends the read at once, like any download of the run.
	const limit = () => (cancel ? AbortSignal.any([cancel, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000));
	if (!side.url.startsWith("https://")) return null;
	try {
		let res = await fetch(side.url, { redirect: "follow", signal: limit() });
		if (res.status === 404 && token && side.api?.startsWith(`${GITHUB_API}/`))
			res = await fetch(side.api, {
				redirect: "follow",
				signal: limit(),
				headers: { Accept: "application/octet-stream", Authorization: `Bearer ${token}` },
			});
		if (!res.ok || !res.body || (res.redirected && !res.url.startsWith("https://"))) return null;
		const reader = res.body.getReader();
		const parts: Uint8Array[] = [];
		let bytes = 0;
		for (;;) {
			// oxlint-disable-next-line no-await-in-loop -- a stream is read one chunk at a time
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_SUM_BYTES) {
				// oxlint-disable-next-line no-await-in-loop -- the loop ends here
				await reader.cancel();
				return null;
			}
			parts.push(value);
		}
		return Buffer.concat(parts).toString("utf8");
	} catch {
		return null;
	}
}

/** What the checksum files gave for one release file; whole is false when one could not be read, so a miss may not be final. */
type Found = { sum: Sum | null; whole: boolean };

/** Reads sumFiles in order until one names the asset; see releaseSum. */
async function readSums(
	release: Pick<Release, "assets">,
	asset: Asset,
	fetch: FetchLike,
	token: string | null,
	cancel: AbortSignal | undefined,
): Promise<Found> {
	let whole = true;
	for (const side of sumFiles(release, asset.name)) {
		// oxlint-disable-next-line no-await-in-loop -- the best file is read first, and the rest only when it names nothing
		const text = await readSmall(side, fetch, token, cancel);
		if (text === null) {
			whole = false;
			continue;
		}
		const sum = YML.test(side.name)
			? sumInYml(text, asset.name)
			: sumIn(text, asset.name, isOwn(side.name, asset.name));
		if (sum) return { sum: { ...sum, file: side.name }, whole };
	}
	return { sum: null, whole };
}

/**
 * The hash the release's own checksum file lists for asset, read from the first of sumFiles that names it. Null when
 * the release has none, none names the asset or none can be read: the download is then checked as before. Same origin
 * as the asset, so it proves the file arrived whole, not who built it.
 */
export async function releaseSum(
	release: Pick<Release, "assets">,
	asset: Asset,
	fetch: FetchLike,
	token: string | null = null,
	cancel?: AbortSignal,
): Promise<Sum | null> {
	return (await readSums(release, asset, fetch, token, cancel)).sum;
}

/** How long a kept hash is trusted before a check reads the checksum files again, so a changed one is seen. */
export const SUM_KEEP_MS = 6 * 60 * 60 * 1000;

/** How long a kept miss stands: CI often uploads the checksum file minutes after it publishes the release. */
export const MISS_KEEP_MS = 60 * 60 * 1000;

/** What cachedSum needs besides the release: the sign-in, Stop now, the clock, and whether to read past the cache. */
export type SumOpts = { token: string | null; cancel?: AbortSignal; now: number; fresh?: boolean };

/**
 * releaseSum, kept in cacheFile for this tag and file address, so a row that waits for its update does not fetch the
 * checksum files (or ask GitHub's API for a private one) at every check. A hash is kept SUM_KEEP_MS, so a checksum file
 * changed under the same tag is seen by a later check (and then holds the row as a changed release); a miss is kept
 * MISS_KEEP_MS, and only when every file was read. fresh reads past the cache, for a download that failed a kept hash.
 */
export async function cachedSum(
	cacheFile: string,
	release: Pick<Release, "assets" | "tag">,
	asset: Asset,
	fetch: FetchLike,
	opts: SumOpts,
): Promise<Sum | null> {
	const key = `${release.tag}\n${asset.url}`;
	try {
		const c = record(JSON.parse(readFileSync(cacheFile, "utf8")));
		// A missing or odd time reads as NaN, which is never young enough.
		const age = opts.now - Number(c.at);
		// A kept miss, or a hash as cachedSum wrote it, while young enough; anything else a hand edit or a crash left is read past.
		if (!opts.fresh && c.key === key && c.sum === null && age < MISS_KEEP_MS) return null;
		const r = record(c.sum);
		const hex = str(r.hex);
		const algo = algoOf(hex);
		if (!opts.fresh && c.key === key && age < SUM_KEEP_MS && algo && algo === r.algo && str(r.file))
			return { algo, hex: hex.toLowerCase(), file: str(r.file) };
	} catch {
		// no cache yet, or an unreadable one: read the files again
	}
	const found = await readSums(release, asset, fetch, opts.token, opts.cancel);
	if (found.sum || found.whole) {
		try {
			mkdirSync(dirname(cacheFile), { recursive: true });
			writeFileSync(cacheFile, JSON.stringify({ key, sum: found.sum, at: opts.now }));
		} catch {
			// a cache that cannot be written costs one more read next check
		}
	}
	return found.sum;
}
