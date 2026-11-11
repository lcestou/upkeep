import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { download, verifyAsset } from "./download";
import type { FetchLike } from "./github";

const PAYLOAD = new Uint8Array(200_000).map((_, i) => i % 251);
const SHA = new Bun.CryptoHasher("sha256").update(PAYLOAD).digest("hex");

let dir = "";
let server: ReturnType<typeof Bun.serve>;
let slowSent = 0;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === "/asset") return new Response(PAYLOAD, { headers: { "content-length": String(PAYLOAD.length) } });
			if (path === "/stall")
				return new Response(
					new ReadableStream({
						start(c) {
							c.enqueue(PAYLOAD.slice(0, 1000));
						},
					}),
				);
			if (path === "/slow")
				return new Response(
					new ReadableStream({
						async pull(c) {
							await Bun.sleep(60);
							c.enqueue(PAYLOAD.slice(0, 1000));
							slowSent += 1;
							if (slowSent === 8) c.close();
						},
					}),
				);
			return new Response("no", { status: 404 });
		},
	});
});
afterAll(() => {
	server.stop(true);
});
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "upkeep-download-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${server.port}`;

test("download streams to the file, reports progress and hashes", async () => {
	const file = join(dir, "dl/fd.tar.gz");
	const seen: number[] = [];
	const r = await download(`${base()}/asset`, file, { fetch, onProgress: (got, total) => seen.push(total ?? -1, got) });
	expect(r).toEqual({ bytes: PAYLOAD.length, sha256: SHA });
	expect(new Uint8Array(readFileSync(file))).toEqual(PAYLOAD);
	expect(seen.at(-1)).toBe(PAYLOAD.length);
	expect(seen[0]).toBe(PAYLOAD.length);
});

test("a download with no bytes for the stall limit is aborted", async () => {
	const file = join(dir, "stall.bin");
	await expect(download(`${base()}/stall`, file, { fetch, stallMs: 150 })).rejects.toThrow("Download stalled.");
});

test("a network error before the first byte is retried once", async () => {
	let calls = 0;
	const flaky: FetchLike = async (url, init) => {
		calls += 1;
		if (calls === 1) throw new TypeError("connection reset");
		return fetch(url, init);
	};
	const r = await download(`${base()}/asset`, join(dir, "retry.bin"), { fetch: flaky, retryMs: 10 });
	expect(r.sha256).toBe(SHA);
	expect(calls).toBe(2);
	let fails = 0;
	const down: FetchLike = async () => {
		fails += 1;
		throw new TypeError("offline");
	};
	await expect(download(`${base()}/asset`, join(dir, "down.bin"), { fetch: down, retryMs: 10 })).rejects.toThrow(
		"offline",
	);
	await Bun.sleep(30);
	expect(fails).toBe(2);
});

test("an HTTP error answer is not retried", async () => {
	let calls = 0;
	const counted: FetchLike = async (url, init) => {
		calls += 1;
		return fetch(url, init);
	};
	await expect(download(`${base()}/gone`, join(dir, "gone.bin"), { fetch: counted, retryMs: 10 })).rejects.toThrow(
		"Download failed: the server answered 404.",
	);
	expect(calls).toBe(1);
});

test("a slow download that keeps sending is not stalled", async () => {
	slowSent = 0;
	const r = await download(`${base()}/slow`, join(dir, "slow.bin"), { fetch, stallMs: 150 });
	expect(r.bytes).toBe(8000);
});

test("verifyAsset checks size and digest", () => {
	const r = { bytes: 10, sha256: "ab" };
	expect(() => verifyAsset(r, { size: 10, digest: "sha256:ab" })).not.toThrow();
	expect(() => verifyAsset(r, { size: 10, digest: null })).not.toThrow();
	expect(() => verifyAsset(r, { size: 11, digest: null })).toThrow("Download is 10 bytes, expected 11.");
	expect(() => verifyAsset(r, { size: 10, digest: "sha256:cd" })).toThrow("Checksum does not match the release.");
});

test("cancelling the caller's signal ends a download in flight, and it is not retried", async () => {
	let calls = 0;
	const counted: FetchLike = async (url, init) => {
		calls += 1;
		return fetch(url, init);
	};
	const ctl = new AbortController();
	setTimeout(() => ctl.abort(), 50);
	const started = Date.now();
	await expect(
		download(`${base()}/stall`, join(dir, "cancel.bin"), {
			fetch: counted,
			signal: ctl.signal,
			stallMs: 10_000,
			retryMs: 10,
		}),
	).rejects.toThrow();
	expect(Date.now() - started).toBeLessThan(5000);
	expect(calls).toBe(1);
});
