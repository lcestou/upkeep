import { basename } from "node:path";
import type { Asset, FetchLike, Release, Sum } from "./github";

/** A checksum file bigger than this is not one: it is skipped unread. */
export const MAX_SUM_BYTES = 1024 * 1024;

/** SHA256SUMS, checksums.txt, goreleaser's <project>_<version>_checksums.txt and the like. */
const LIST = /^(?:.*[._-])?(?:sha(?:256|512)sums?|checksums?)(?:\.txt)?$/i;

/** electron-builder's update file for Linux, which lists each file's sha512 in base64. */
const YML = /^latest-linux(?:-[a-z0-9]+)?\.ya?ml$/i;

/** The extensions of a checksum file kept beside one asset, holding that asset's hash. */
const OWN = [".sha256", ".sha256sum", ".sha512"];

/** The algorithm a hex digest's length names, or null for any other length or a non-hex string. */
function algoOf(hex: string): Sum["algo"] | null {
	if (!/^[0-9a-f]+$/i.test(hex)) return null;
	return hex.length === 64 ? "sha256" : hex.length === 128 ? "sha512" : null;
}

/**
 * The release's files that may hold a hash for the asset named name, best first: its own .sha256 beside it, then a
 * list for the whole release, then electron-builder's yml. A file listed with a size over MAX_SUM_BYTES is left out.
 */
export function sumFiles(release: Pick<Release, "assets">, name: string): Asset[] {
	const rank = (n: string) => (OWN.some((e) => n === `${name}${e}`) ? 0 : LIST.test(n) ? 1 : YML.test(n) ? 2 : -1);
	return release.assets
		.filter((a) => a.name !== name && rank(a.name) >= 0 && a.size <= MAX_SUM_BYTES)
		.toSorted((a, b) => rank(a.name) - rank(b.name));
}

/**
 * The hash a sha256sum-style text gives for name: "hash  name", "hash *name" (a path's base name counts, "./name"
 * too) or BSD's "SHA256 (name) = hash". A line with a hash alone counts only when own says the file is the asset's
 * own. Null when no line names it. A line for name with a hash of an unknown length is passed over, not trusted.
 */
export function sumIn(text: string, name: string, own: boolean): Omit<Sum, "file"> | null {
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		const bsd = /^SHA(?:256|512) ?\((.+)\) ?= ?(\S+)$/i.exec(line);
		const gnu = /^(\S+)(?:\s+\*?(.+))?$/.exec(line);
		const hex = bsd?.[2] ?? gnu?.[1] ?? "";
		const file = bsd ? bsd[1] : gnu?.[2];
		const algo = algoOf(hex);
		if (!algo) continue;
		if (file === undefined ? own : basename(file.trim()) === name) return { algo, hex: hex.toLowerCase() };
	}
	return null;
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
 */
async function readSmall(url: string, fetch: FetchLike): Promise<string | null> {
	if (!url.startsWith("https://")) return null;
	try {
		const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
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

/**
 * The hash the release's own checksum file lists for asset, read from the first of sumFiles that names it. Null when
 * the release has none, none names the asset or none can be read: the download is then checked as before. Same origin
 * as the asset, so it proves the file arrived whole, not who built it.
 */
export async function releaseSum(
	release: Pick<Release, "assets">,
	asset: Asset,
	fetch: FetchLike,
): Promise<Sum | null> {
	for (const side of sumFiles(release, asset.name)) {
		// oxlint-disable-next-line no-await-in-loop -- the best file is read first, and the rest only when it names nothing
		const text = await readSmall(side.url, fetch);
		if (text === null) continue;
		const own = OWN.some((e) => side.name === `${asset.name}${e}`);
		const sum = YML.test(side.name) ? sumInYml(text, asset.name) : sumIn(text, asset.name, own);
		if (sum) return { ...sum, file: side.name };
	}
	return null;
}
