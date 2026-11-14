import { mkdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { MESSAGES } from "../shared/messages";
import type { Asset, FetchLike } from "./github";

export type DownloadOpts = {
	fetch: FetchLike;
	onProgress?: (received: number, total: number | null) => void;
	signal?: AbortSignal;
	/** No bytes for this long aborts the download. Default 60 s. */
	stallMs?: number;
	/** Wait before the one retry after a network error. Default 2 s. */
	retryMs?: number;
};

export type DownloadResult = { bytes: number; sha256: string };

/** Marks a download that went quiet, so download() does not retry it as a network error. */
class Stalled extends Error {}

/** One try at the download. Sets started.any once the server answers, which tells the caller not to retry. */
async function attempt(
	url: string,
	file: string,
	opts: DownloadOpts,
	started: { any: boolean },
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
		const res = await opts.fetch(url, { signal: ctl.signal, redirect: "follow" });
		// An answer of any status is not a network error, so it is not retried.
		started.any = true;
		if (!res.ok || !res.body) throw new Error(MESSAGES.downloadHttpFailed(res.status));
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

/** Streams url to file, hashing as it writes. A network error before the first byte is retried once. */
export async function download(url: string, file: string, opts: DownloadOpts): Promise<DownloadResult> {
	mkdirSync(dirname(file), { recursive: true });
	const started = { any: false };
	try {
		return await attempt(url, file, opts, started);
	} catch (err) {
		if (err instanceof Stalled || started.any || opts.signal?.aborted) throw err;
		await new Promise((r) => setTimeout(r, opts.retryMs ?? 2000));
		return attempt(url, file, opts, started);
	}
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
