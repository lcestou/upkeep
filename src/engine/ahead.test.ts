import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppSpec } from "../shared/types";
import { AHEAD_ROOM, type AheadItem, canFetchEarly, createAhead } from "./ahead";
import type { FetchLike } from "./github";

const BODY = new Uint8Array(4096).map((_, i) => i % 251);
const SHA = new Bun.CryptoHasher("sha256").update(BODY).digest("hex");
const url = (key: string) => `https://dl.test/${key}`;

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ahead-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fetch that answers each address only when the test lets it through, and rejects when its signal aborts. */
function held() {
	const asked: string[] = [];
	const release = new Map<string, () => void>();
	const fetch: FetchLike = (address, init) => {
		asked.push(address);
		return new Promise<Response>((resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			release.set(address, () =>
				resolve(address.endsWith("/bad") ? new Response("no", { status: 500 }) : new Response(BODY)),
			);
		});
	};
	return { asked, fetch, let: (key: string) => release.get(url(key))?.() };
}

/** One app's early file, its digest the body's unless given. */
const item = (key: string): AheadItem => ({
	key,
	asset: { name: `${key}.AppImage`, url: url(key), size: BODY.length, digest: `sha256:${SHA}` },
	file: join(dir, "dl", `${key}.AppImage`),
});

/** An Ahead over the held fetch, with free space set and what it reports collected. */
function ahead(fetch: FetchLike, free = AHEAD_ROOM * 2) {
	const ready: string[] = [];
	const lines: string[] = [];
	const a = createAhead({
		dir: join(dir, "dl"),
		fetch,
		token: null,
		retryMs: 1,
		freeBytes: () => free,
		onReady: (key) => ready.push(key),
		log: (key, text) => lines.push(`${key}: ${text}`),
	});
	return { a, ready, lines };
}

/** Long enough for a held fetch's promise chain to run its course; only for checking that nothing more happened. */
const settle = () => Bun.sleep(30);

/** Waits until cond holds, every 5 ms for up to 2 s: under load a held fetch's chain takes longer than settle. */
const until = async (cond: () => boolean, left = 400): Promise<void> => {
	if (cond() || left === 0) return;
	await Bun.sleep(5);
	return until(cond, left - 1);
};

test("nothing starts while the gate is closed; open, two at a time in run order, the third once one ends", async () => {
	const h = held();
	const { a, ready } = ahead(h.fetch);
	a.plan([item("a"), item("b"), item("c")]);
	await settle();
	expect(h.asked).toEqual([]);
	a.gate(true);
	await until(() => h.asked.length === 2);
	// The two start together, so either may reach the network first.
	expect(h.asked.toSorted()).toEqual([url("a"), url("b")]);
	h.let("a");
	await until(() => h.asked.length === 3);
	expect(ready).toEqual(["a"]);
	expect(h.asked[2]).toBe(url("c"));
	await a.cancel();
});

test("a gate shut again starts nothing new, and what runs keeps running", async () => {
	const h = held();
	const { a, ready } = ahead(h.fetch);
	a.plan([item("a"), item("b"), item("c")]);
	a.gate(true);
	await until(() => h.asked.length === 2);
	a.gate(false);
	h.let("a");
	await until(() => ready.length === 1);
	await settle();
	expect(ready).toEqual(["a"]);
	expect(h.asked.toSorted()).toEqual([url("a"), url("b")]);
	a.gate(true);
	await until(() => h.asked.length === 3);
	expect(h.asked[2]).toBe(url("c"));
	await a.cancel();
});

test("the room check counts the early downloads under way: a second large file waits for its turn", async () => {
	const h = held();
	const { a, lines } = ahead(h.fetch, AHEAD_ROOM + 1.5 * BODY.length);
	a.plan([item("a"), item("b")]);
	a.gate(true);
	await until(() => h.asked.length === 1 && lines.some((l) => l.startsWith("b:")));
	await settle();
	expect(h.asked).toEqual([url("a")]);
	expect(lines).toContain("b: Not downloaded ahead: the disk is short of room. It downloads at its turn.");
	await a.cancel();
});

test("a claim waits for a file still coming down, passes its progress on, and hands it over checked", async () => {
	const h = held();
	const { a, ready } = ahead(h.fetch);
	a.plan([item("a")]);
	a.gate(true);
	await until(() => h.asked.length === 1);
	const seen: number[] = [];
	const got = a.claim("a", (received) => seen.push(received));
	h.let("a");
	expect(await got).toMatchObject({ bytes: BODY.length, sha256: SHA });
	expect(seen.at(-1)).toBe(BODY.length);
	expect(ready).toEqual([]);
	expect(existsSync(item("a").file)).toBe(true);
	// Handed over: Stop no longer touches it.
	await a.cancel();
	expect(existsSync(item("a").file)).toBe(true);
});

test("a file that changed on disk after it came down is deleted at the claim, which answers null", async () => {
	const h = held();
	const { a, ready, lines } = ahead(h.fetch);
	a.plan([item("a")]);
	a.gate(true);
	await until(() => h.asked.length === 1);
	h.let("a");
	await until(() => ready.length === 1);
	expect(ready).toEqual(["a"]);
	writeFileSync(item("a").file, "short");
	expect(await a.claim("a", () => {})).toBeNull();
	expect(existsSync(item("a").file)).toBe(false);
	expect(lines).toContain(
		"a: The file fetched ahead no longer matches, so it downloads again: Download is 5 bytes, expected 4096.",
	);
});

test("an early download that fails leaves no file, is not tried again, and its claim answers null", async () => {
	const h = held();
	const { a, ready, lines } = ahead(h.fetch);
	const bad = { ...item("a"), asset: { ...item("a").asset, url: "https://dl.test/bad" } };
	a.plan([bad]);
	a.gate(true);
	await until(() => h.asked.length === 1);
	h.let("bad");
	await until(() => lines.some((l) => l.includes("failed")) && !existsSync(bad.file));
	expect(ready).toEqual([]);
	expect(existsSync(bad.file)).toBe(false);
	expect(lines).toContain(
		"a: Early download failed, so it downloads at its turn: Download failed: the server answered 500.",
	);
	a.plan([bad]);
	await settle();
	expect(h.asked).toEqual(["https://dl.test/bad"]);
	expect(await a.claim("a", () => {})).toBeNull();
});

test("a disk without room past the file's size downloads nothing ahead and says so", async () => {
	const h = held();
	const { a, lines } = ahead(h.fetch, AHEAD_ROOM + BODY.length - 1);
	a.plan([item("a")]);
	a.gate(true);
	await until(() => lines.length === 1);
	await settle();
	expect(h.asked).toEqual([]);
	expect(lines).toEqual(["a: Not downloaded ahead: the disk is short of room. It downloads at its turn."]);
});

test("a disk that cannot be measured counts as no room: nothing downloads ahead and the run goes on", async () => {
	const h = held();
	const lines: string[] = [];
	const a = createAhead({
		dir: join(dir, "dl"),
		fetch: h.fetch,
		token: null,
		freeBytes: () => {
			throw new Error("statfs: not supported");
		},
		onReady: () => {},
		log: (key, text) => lines.push(`${key}: ${text}`),
	});
	a.plan([item("a")]);
	a.gate(true);
	await until(() => lines.length === 1);
	expect(h.asked).toEqual([]);
	expect(lines).toEqual(["a: Not downloaded ahead: the disk is short of room. It downloads at its turn."]);
	await a.cancel();
});

test("cancel stops what is coming down, deletes every file not handed over, and nothing starts after it", async () => {
	const h = held();
	const { a, ready, lines } = ahead(h.fetch);
	a.plan([item("a"), item("b"), item("c")]);
	a.gate(true);
	await until(() => h.asked.length === 2);
	h.let("b");
	await until(() => ready.length === 1 && h.asked.length === 3);
	expect(existsSync(item("b").file)).toBe(true);
	const first = a.cancel();
	expect(a.cancel()).toBe(first);
	await first;
	for (const key of ["a", "b", "c"]) expect(existsSync(item(key).file)).toBe(false);
	a.plan([item("d")]);
	a.gate(true);
	await settle();
	// b's end freed its slot for c; d came after the cancel and never started.
	expect(h.asked.slice(0, 2).toSorted()).toEqual([url("a"), url("b")]);
	expect(h.asked.slice(2)).toEqual([url("c")]);
	expect(ready).toEqual(["b"]);
	expect(await a.claim("b", () => {})).toBeNull();
	// A cancel is not a failure: no line says one failed.
	expect(lines.some((l) => l.includes("failed"))).toBe(false);
});

test("only a release kind with a file, and nothing it stops or pauses, downloads ahead", () => {
	const spec = (kind: AppSpec["kind"], more: Partial<AppSpec> = {}): AppSpec => ({
		key: "x",
		name: "X",
		kind,
		...more,
	});
	const asset = item("x").asset;
	for (const kind of ["appimage", "archive", "file", "deb", "rpm"] as const)
		expect(canFetchEarly(spec(kind), asset)).toBe(true);
	for (const kind of ["source", "command", "claude-plugins", "manual"] as const)
		expect(canFetchEarly(spec(kind), asset)).toBe(false);
	expect(canFetchEarly(spec("appimage"), undefined)).toBe(false);
	const unit = { name: "u", active: ["true"], stop: ["true"], start: ["true"] };
	expect(canFetchEarly(spec("appimage", { serve: [unit] }), asset)).toBe(false);
	expect(canFetchEarly(spec("appimage", { pause: [unit] }), asset)).toBe(false);
});
