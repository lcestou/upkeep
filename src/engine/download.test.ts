import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { download, needsSha512, signedIn, statedSize, verifyAsset } from "./download";
import type { FetchLike } from "./github";

const PAYLOAD = new Uint8Array(200_000).map((_, i) => i % 251);
const SHA = new Bun.CryptoHasher("sha256").update(PAYLOAD).digest("hex");
const SHA512 = new Bun.CryptoHasher("sha512").update(PAYLOAD).digest("hex");

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
	// SHA-512 only when asked for.
	expect(r).toEqual({ bytes: PAYLOAD.length, sha256: SHA });
	expect(await download(`${base()}/asset`, join(dir, "512.bin"), { fetch, sha512: true })).toEqual({
		bytes: PAYLOAD.length,
		sha256: SHA,
		sha512: SHA512,
	});
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

test("a private repo's file: the public link's 404 is asked again at GitHub's API with the token", async () => {
	const api = "https://api.github.com/repos/me/tool/releases/assets/7";
	const seen: { url: string; headers: Headers }[] = [];
	const gh: FetchLike = async (url, init) => {
		seen.push({ url: String(url), headers: new Headers(init?.headers) });
		return fetch(String(url) === api ? `${base()}/asset` : url, init);
	};
	const r = await download(`${base()}/private`, join(dir, "private.bin"), {
		fetch: gh,
		retryMs: 10,
		signedIn: { url: api, token: "tok" },
	});
	expect(r.sha256).toBe(SHA);
	expect(seen.map((s) => s.url)).toEqual([`${base()}/private`, api]);
	expect(seen[0]?.headers.get("authorization")).toBeNull();
	expect(seen[1]?.headers.get("authorization")).toBe("Bearer tok");
	expect(seen[1]?.headers.get("accept")).toBe("application/octet-stream");

	// A public file that downloads never touches the API, and the token never goes anywhere but api.github.com.
	seen.length = 0;
	await download(`${base()}/asset`, join(dir, "public.bin"), { fetch: gh, signedIn: { url: api, token: "tok" } });
	expect(seen.map((s) => s.url)).toEqual([`${base()}/asset`]);
	seen.length = 0;
	await expect(
		download(`${base()}/private`, join(dir, "elsewhere.bin"), {
			fetch: gh,
			retryMs: 10,
			signedIn: { url: `${base()}/asset`, token: "tok" },
		}),
	).rejects.toThrow("Download failed: the server answered 404.");
	expect(seen.map((s) => s.url)).toEqual([`${base()}/private`]);
});

test("the signed-in way keeps the retry, on both addresses, and a cancel stops it before the API", async () => {
	const api = "https://api.github.com/repos/me/tool/releases/assets/7";
	const signedIn = { url: api, token: "tok" };
	const asked: string[] = [];
	/** Answers each address from a script: "net" throws a network error, "404" is GitHub's not found, "ok" the file. */
	const scripted =
		(plan: string[]): FetchLike =>
		async (url, init) => {
			asked.push(String(url) === api ? "api" : "public");
			const step = plan.shift();
			if (step === "net") throw new TypeError("socket reset");
			if (step === "404") return new Response("Not Found", { status: 404 });
			return fetch(`${base()}/asset`, init);
		};
	// A network blip, then the public 404: still asked at the API.
	const r = await download(`${base()}/private`, join(dir, "blip.bin"), {
		fetch: scripted(["net", "404", "net", "ok"]),
		retryMs: 10,
		signedIn,
	});
	expect(r.sha256).toBe(SHA);
	expect(asked).toEqual(["public", "public", "api", "api"]);

	// Cancelled as the 404 lands: the API is never asked.
	asked.length = 0;
	const ctl = new AbortController();
	const cancelling: FetchLike = async () => {
		asked.push("public");
		ctl.abort();
		return new Response("Not Found", { status: 404 });
	};
	await expect(
		download(`${base()}/private`, join(dir, "cancel.bin"), { fetch: cancelling, signal: ctl.signal, signedIn }),
	).rejects.toThrow("Download failed: the server answered 404.");
	expect(asked).toEqual(["public"]);
});

test("signedIn: the API way only for an asset with an API address and a person with a token", () => {
	const asset = {
		name: "t",
		url: "u",
		size: 1,
		digest: null,
		api: "https://api.github.com/repos/a/b/releases/assets/1",
	};
	expect(signedIn(asset, "tok")).toEqual({ url: asset.api, token: "tok" });
	expect(signedIn(asset, null)).toBeUndefined();
	expect(signedIn({ ...asset, api: undefined }, "tok")).toBeUndefined();
});

test("a slow download that keeps sending is not stalled", async () => {
	slowSent = 0;
	const r = await download(`${base()}/slow`, join(dir, "slow.bin"), { fetch, stallMs: 150 });
	expect(r.bytes).toBe(8000);
});

test("verifyAsset checks size and digest, and says how", () => {
	const r = { bytes: 10, sha256: "ab", sha512: "ef" };
	expect(verifyAsset(r, { size: 10, digest: "sha256:ab" })).toBe("digest");
	expect(verifyAsset(r, { size: 10, digest: null })).toBe("size");
	expect(() => verifyAsset(r, { size: 11, digest: null })).toThrow("Download is 10 bytes, expected 11.");
	expect(() => verifyAsset(r, { size: 10, digest: "sha256:cd" })).toThrow("Checksum does not match the release.");
});

test("verifyAsset: the release's checksum file when there is no digest, and the digest wins when there is", () => {
	const r = { bytes: 10, sha256: "ab", sha512: "ef" };
	const sum = (algo: "sha256" | "sha512", hex: string) => ({ algo, hex, file: "SHA256SUMS" });
	expect(verifyAsset(r, { size: 10, digest: null, sum: sum("sha256", "ab") })).toBe("sums");
	expect(verifyAsset({ ...r, bytes: 2 ** 20 }, { size: 0, digest: null, sum: sum("sha512", "ef") })).toBe("sums");
	expect(() => verifyAsset(r, { size: 10, digest: null, sum: sum("sha256", "cd") })).toThrow(
		"Checksum does not match SHA256SUMS in the release, so nothing was installed. You can skip this version.",
	);
	// A file its checksum file vouches for needs no 1 MiB floor; needsSha512 asks for the second hash only for a sha512 sum.
	expect(verifyAsset({ bytes: 10, sha256: "ab" }, { size: 0, digest: null, sum: sum("sha256", "ab") })).toBe("sums");
	expect([
		needsSha512({ sum: sum("sha512", "ef") }),
		needsSha512({ sum: sum("sha256", "ab") }),
		needsSha512({}),
	]).toEqual([true, false, false]);
	// A result with no sha512 never passes a sha512 sum.
	expect(() =>
		verifyAsset({ bytes: 10, sha256: "ab" }, { size: 10, digest: null, sum: sum("sha512", "ef") }),
	).toThrow();
	expect(verifyAsset(r, { size: 10, digest: "sha256:ab", sum: sum("sha256", "cd") })).toBe("digest");
});

test("a redirect from https to plain http is refused before a byte is written", async () => {
	const leaky: FetchLike = async () => {
		const res = new Response(PAYLOAD);
		Object.defineProperty(res, "url", { value: "http://mirror.example/fd.tar.gz" });
		Object.defineProperty(res, "redirected", { value: true });
		return res;
	};
	await expect(
		download("https://example.org/fd.tar.gz", join(dir, "x.bin"), { fetch: leaky, retryMs: 1 }),
	).rejects.toThrow("The download was sent on to an address that is not https, so it was refused.");
	const kept: FetchLike = async () => {
		const res = new Response(PAYLOAD);
		Object.defineProperty(res, "url", { value: "https://mirror.example/fd.tar.gz" });
		Object.defineProperty(res, "redirected", { value: true });
		return res;
	};
	expect((await download("https://example.org/fd.tar.gz", join(dir, "y.bin"), { fetch: kept })).bytes).toBe(
		PAYLOAD.length,
	);
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

test("a download whose size nobody listed must be at least 1 MiB", () => {
	expect(() => verifyAsset({ bytes: 500_000, sha256: "ab" }, { size: 0, digest: null })).toThrow(
		"Download is 500000 bytes, too small to be a release.",
	);
	expect(verifyAsset({ bytes: 1024 * 1024, sha256: "ab" }, { size: 0, digest: null })).toBe("none");
});

test("statedSize: the length a HEAD answer states, else undefined", async () => {
	const answer = (res: Response | Error): FetchLike =>
		(async (_url: string, init?: RequestInit) => {
			expect(init?.method).toBe("HEAD");
			expect(new Headers(init?.headers).get("accept-encoding")).toBe("identity");
			if (res instanceof Error) throw res;
			return res;
		}) as FetchLike;
	const len = (n: string) => new Response(null, { headers: { "content-length": n } });
	expect(await statedSize("https://x.test/a", answer(len("328100344")))).toBe(328_100_344);
	expect(await statedSize("https://x.test/a", answer(new Response(null)))).toBeUndefined();
	expect(await statedSize("https://x.test/a", answer(len("0")))).toBeUndefined();
	expect(
		await statedSize(
			"https://x.test/a",
			answer(new Response(null, { status: 405, headers: { "content-length": "9" } })),
		),
	).toBeUndefined();
	expect(await statedSize("https://x.test/a", answer(new Error("offline")))).toBeUndefined();
});

test("a cancel during the wait before the retry stops it: the second try never starts", async () => {
	let calls = 0;
	const flaky: FetchLike = async () => {
		calls += 1;
		if (calls === 1) throw new TypeError("network down");
		return new Response(PAYLOAD);
	};
	const ctl = new AbortController();
	setTimeout(() => ctl.abort(), 20);
	const began = Date.now();
	// The wait is long: the cancel ends it at once rather than after it.
	await expect(
		download("https://x.test/asset", join(dir, "wait.bin"), { fetch: flaky, signal: ctl.signal, retryMs: 60_000 }),
	).rejects.toThrow();
	expect(calls).toBe(1);
	expect(Date.now() - began).toBeLessThan(5000);
});

test("a signal aborted before the call starts no download", async () => {
	let calls = 0;
	const counted: FetchLike = async () => {
		calls += 1;
		return new Response(PAYLOAD);
	};
	const ctl = new AbortController();
	ctl.abort();
	await expect(
		download("https://x.test/asset", join(dir, "early.bin"), { fetch: counted, signal: ctl.signal }),
	).rejects.toThrow();
	expect(calls).toBe(0);
});
