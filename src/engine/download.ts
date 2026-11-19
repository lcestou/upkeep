import { mkdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { MESSAGES } from "../shared/messages";
import { type Asset, type FetchLike, GITHUB_API } from "./github";

export type DownloadOpts = {
	fetch: FetchLike;
	onProgress?: (received: number, total: number | null) => void;
	signal?: AbortSignal;
	/** No bytes for this long aborts the download. Default 60 s. */
	stallMs?: number;
	/** Wait before the one retry after a network error. Default 2 s. */
	retryMs?: number;
	/**
	 * The asset's GitHub API address and the person's gh token, tried when the public link answers 404: a private
	 * repo's file is 404 there without a browser's sign-in, and the API serves it to the token instead.
	 */
	signedIn?: { url: string; token: string };
};

export type DownloadResult = { bytes: number; sha256: string };

/** Marks a download that went quiet, so download() does not retry it as a network error. */
class Stalled extends Error {}

/** A download the server answered with an error status; download() reads the status to try the signed-in way. */
class HttpFailed extends Error {
	/** Keeps the status beside the message the person reads. */
	constructor(readonly status: number) {
		super(MESSAGES.downloadHttpFailed(status));
	}
}

/** One try at the download. Sets started.any once the server answers, which tells the caller not to retry. */
async function attempt(
	url: string,
	file: string,
	opts: DownloadOpts,
	started: { any: boolean },
	headers?: Record<string, string>,
): Promise<DownloadResult> {
	const stallMs = opts.stallMs ?? 60_000;
	const ctl = new AbortController();
	const onOuterAbort = () => ctl.abort();
	opts.signal?.addEventListener("abort", onOuterAbort);
	let stalled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const arm = () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			stalled = true;
			ctl.abort();
		}, stallMs);
	};
	arm();
	const fh = await open(file, "w");
	try {
		const res = await opts.fetch(url, { signal: ctl.signal, redirect: "follow", headers });
		// An answer of any status is not a network error, so it is not retried.
		started.any = true;
		if (!res.ok || !res.body) throw new HttpFailed(res.status);
		const length = Number(res.headers.get("content-length"));
		const total = length > 0 ? length : null;
		const hasher = new Bun.CryptoHasher("sha256");
		let bytes = 0;
		opts.onProgress?.(0, total);
		const reader = res.body.getReader();
		for (;;) {
			// oxlint-disable-next-line no-await-in-loop -- a stream is read one chunk at a time
			const { done, value: chunk } = await reader.read();
			if (done) break;
			arm();
			hasher.update(chunk);
			// Awaited: a full disk must fail the download, not leave a short file behind a good hash.
			for (let off = 0; off < chunk.byteLength;) {
				// oxlint-disable-next-line no-await-in-loop -- a short write is finished before the next chunk
				off += (await fh.write(chunk, off)).bytesWritten;
			}
			bytes += chunk.byteLength;
			opts.onProgress?.(bytes, total);
		}
		await fh.sync();
		return { bytes, sha256: hasher.digest("hex") };
	} catch (err) {
		if (stalled) throw new Stalled(MESSAGES.downloadStalled());
		throw err;
	} finally {
		await fh.close();
		if (timer) clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onOuterAbort);
	}
}

/** One address with its retry: a network error before the server answers is tried once more, unless cancelled. */
async function fetchTo(
	url: string,
	file: string,
	opts: DownloadOpts,
	headers?: Record<string, string>,
): Promise<DownloadResult> {
	const started = { any: false };
	try {
		return await attempt(url, file, opts, started, headers);
	} catch (err) {
		if (err instanceof Stalled || started.any || opts.signal?.aborted) throw err;
		await new Promise((r) => setTimeout(r, opts.retryMs ?? 2000));
		// A cancel during the wait never reaches the second attempt: its listener would be added after the abort fired.
		opts.signal?.throwIfAborted();
		return attempt(url, file, opts, started, headers);
	}
}

/**
 * Streams url to file, hashing as it writes. A network error before the first byte is retried once. A 404 with
 * opts.signedIn is asked again at the API with the token, with the same retry; the token goes only to api.github.com,
 * never to url, and a cancel before the 404 lands stops it there.
 */
export async function download(url: string, file: string, opts: DownloadOpts): Promise<DownloadResult> {
	mkdirSync(dirname(file), { recursive: true });
	try {
		return await fetchTo(url, file, opts);
	} catch (err) {
		const signed = opts.signedIn;
		const isPrivate = err instanceof HttpFailed && err.status === 404 && signed?.url.startsWith(`${GITHUB_API}/`);
		if (!isPrivate || !signed || opts.signal?.aborted) throw err;
		return fetchTo(signed.url, file, opts, {
			Accept: "application/octet-stream",
			Authorization: `Bearer ${signed.token}`,
		});
	}
}

/** The signed-in way to an asset for download(), when it has a GitHub API address and the person has a gh token. */
export function signedIn(asset: Asset, token: string | null): DownloadOpts["signedIn"] {
	return asset.api && token ? { url: asset.api, token } : undefined;
}

/** Below this, a download whose size nobody listed is an error page or a cut, not a release. */
export const MIN_UNLISTED_BYTES = 1024 * 1024;

/**
 * Throws when the file is not the asset the release describes. An asset with no digest is checked by size only, and
 * one with no listed size (size 0) only by the floor; a truncated download above the floor is caught by the verify
 * probe and its restore point.
 */
export function verifyAsset(result: DownloadResult, asset: Pick<Asset, "size" | "digest">): void {
	if (asset.size > 0 && result.bytes !== asset.size)
		throw new Error(MESSAGES.downloadSizeMismatch(result.bytes, asset.size));
	if (asset.size === 0 && result.bytes < MIN_UNLISTED_BYTES) throw new Error(MESSAGES.downloadTooSmall(result.bytes));
	if (asset.digest) {
		const want = asset.digest.replace(/^sha256:/, "").toLowerCase();
		if (want !== result.sha256) throw new Error(MESSAGES.checksumMismatch());
	}
}

/**
 * The length the server states for url when asked with HEAD, following redirects, or undefined when it states none,
 * answers with an error or takes over 10 s. For showing only: a download is never held to it, since a compressed
 * answer states its compressed length.
 */
export async function statedSize(url: string, fetch: FetchLike): Promise<number | undefined> {
	try {
		const res = await fetch(url, {
			method: "HEAD",
			redirect: "follow",
			// The file's own length: a server that compresses on the fly would otherwise state the compressed one.
			headers: { "accept-encoding": "identity" },
			signal: AbortSignal.timeout(10_000),
		});
		const n = Number(res.headers.get("content-length"));
		return res.ok && n > 0 ? n : undefined;
	} catch {
		return undefined;
	}
}
