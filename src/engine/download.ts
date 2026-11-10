import { mkdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
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

class Stalled extends Error {}

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
		if (!res.ok || !res.body) throw new Error(`Download failed: the server answered ${res.status}.`);
		started.any = true;
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
		if (stalled) throw new Stalled("Download stalled.");
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

/** Throws when the file is not the asset the release describes. An asset with no digest is checked by size only. */
export function verifyAsset(result: DownloadResult, asset: Pick<Asset, "size" | "digest">): void {
	if (asset.size > 0 && result.bytes !== asset.size)
		throw new Error(`Download is ${result.bytes} bytes, expected ${asset.size}.`);
	if (asset.digest) {
		const want = asset.digest.replace(/^sha256:/, "").toLowerCase();
		if (want !== result.sha256) throw new Error("Checksum does not match the release.");
	}
}
