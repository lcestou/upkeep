import { afterEach, beforeEach, expect, test } from "bun:test";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchLike } from "./github";
import { readWebhook, writeWebhook } from "./store";
import { tempHome } from "./testkit";
import {
	addressProblem,
	createNoticeSender,
	destinationOf,
	maskAddress,
	type NoticeBody,
	onHomeNetwork,
} from "./webhook";

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("webhook");
});
afterEach(() => t.cleanup());

test("https goes anywhere; plain http only to this computer or a home network", () => {
	expect(addressProblem("https://ntfy.sh/upkeep-a1b2")).toBeNull();
	expect(addressProblem("  https://ntfy.sh/x  ")).toBeNull();
	// The ntfy template address docs/window.md gives, braces unencoded.
	expect(addressProblem("https://ntfy.sh/your-topic?tpl=yes&t={{.title}}&m={{.message}}")).toBeNull();
	expect(maskAddress("https://ntfy.sh/your-topic?tpl=yes&t={{.title}}&m={{.message}}")).toBe("https://ntfy.sh/…");
	for (const a of [
		"http://localhost:8080/x",
		"http://127.0.0.1/x",
		"http://192.168.1.5/x",
		"http://10.0.0.2:2586/x",
		"http://172.20.0.1/x",
		"http://169.254.3.4/x",
		"http://100.101.102.103/x",
		"http://[::1]/x",
		"http://[fd00::5]/x",
		"http://[fe80::1]/x",
		"http://nas/x",
		"http://nas.lan/x",
		"http://ntfy.home.arpa/x",
		"http://box.local/x",
	])
		expect(addressProblem(a)).toBeNull();
	for (const a of ["http://ntfy.sh/x", "http://8.8.8.8/x", "http://172.32.0.1/x", "http://[2001:db8::1]/x"])
		expect(addressProblem(a)).toBe("plain");
	for (const a of ["ntfy.sh/x", "ftp://host/x", "file:///etc/passwd", "", "https://a b/x", "javascript:alert(1)"])
		expect(addressProblem(a)).toBe("address");
});

test("onHomeNetwork judges the address as written, never a public name", () => {
	expect(onHomeNetwork("LOCALHOST")).toBe(true);
	expect(onHomeNetwork("app.localhost")).toBe(true);
	expect(onHomeNetwork("example.com")).toBe(false);
	expect(onHomeNetwork("192.169.0.1")).toBe(false);
});

test("the mask keeps scheme, host and port and hides the path, query and credentials", () => {
	expect(maskAddress("https://ntfy.sh/secret-topic?auth=abc")).toBe("https://ntfy.sh/…");
	expect(maskAddress("https://user:pass@hooks.example.com:8443/")).toBe("https://hooks.example.com:8443/");
	expect(maskAddress("http://nas:2586")).toBe("http://nas:2586/");
	expect(maskAddress("not a url")).toBe("…");
});

test("the address is kept in a file only its owner can read, and a wider file is closed before it is used", () => {
	expect(readWebhook(t.paths)).toBeNull();
	writeWebhook(t.paths, "https://ntfy.sh/a");
	const file = join(t.paths.state, "webhook");
	expect(statSync(file).mode & 0o777).toBe(0o600);
	expect(readWebhook(t.paths)).toBe("https://ntfy.sh/a");
	writeFileSync(file, "https://ntfy.sh/b\n", { mode: 0o644 });
	expect(readWebhook(t.paths)).toBe("https://ntfy.sh/b");
	expect(statSync(file).mode & 0o777).toBe(0o600);
	writeWebhook(t.paths, null);
	expect(readWebhook(t.paths)).toBeNull();
});

/** A notice as the main process sends one. */
const BODY: NoticeBody = {
	title: "Upkeep",
	message: "1 update ready: bat",
	event: "ready",
	host: "box",
	version: "0.2.0",
	counts: { apps: 1, upToDate: 0, ready: 1, held: 0, failing: 0 },
	apps: [{ key: "bat", name: "bat", installed: "0.25.0", latest: "0.26.1" }],
};

/** A fetch that records each call and answers with status. */
function recording(status = 200) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fetch: FetchLike = async (url, init) => {
		calls.push({ url, init });
		return new Response("", { status });
	};
	return { calls, fetch };
}

test("a notice is one JSON POST to the kept address, with no redirect followed", async () => {
	writeWebhook(t.paths, "https://ntfy.sh/topic?tpl=yes");
	const { calls, fetch } = recording();
	const sender = createNoticeSender({ paths: t.paths, fetch, log: () => {} });
	expect(await sender.send(BODY)).toBe(true);
	expect(calls).toHaveLength(1);
	expect(calls[0]?.url).toBe("https://ntfy.sh/topic?tpl=yes");
	expect(calls[0]?.init?.method).toBe("POST");
	expect(calls[0]?.init?.redirect).toBe("error");
	expect(new Headers(calls[0]?.init?.headers).get("content-type")).toBe("application/json");
	expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(BODY);
});

test("no address, or one a hand edit made unsafe, sends nothing", async () => {
	const { calls, fetch } = recording();
	const sender = createNoticeSender({ paths: t.paths, fetch, log: () => {} });
	expect(await sender.send(BODY)).toBe(false);
	writeWebhook(t.paths, "http://ntfy.sh/topic");
	expect(await sender.send(BODY)).toBe(false);
	expect(calls).toHaveLength(0);
});

test("failures are logged once with the address masked, and again only after a notice went through", async () => {
	writeWebhook(t.paths, "https://ntfy.sh/secret-topic");
	let status = 500;
	const lines: string[] = [];
	const sender = createNoticeSender({
		paths: t.paths,
		fetch: async (url) => {
			if (status === 0) throw new Error(`Unable to connect to ${url}`);
			return new Response("", { status });
		},
		log: (l) => lines.push(l),
	});
	expect(await sender.send(BODY)).toBe(false);
	status = 0;
	expect(await sender.send(BODY)).toBe(false);
	expect(lines).toEqual(["Could not send the notice to https://ntfy.sh/…: it answered HTTP 500"]);
	status = 200;
	expect(await sender.send(BODY)).toBe(true);
	status = 0;
	expect(await sender.send(BODY)).toBe(false);
	expect(lines[1]).toBe("Could not send the notice to https://ntfy.sh/…: Unable to connect to https://ntfy.sh/…");
	expect(lines.join("\n")).not.toContain("secret-topic");
});

test("a receiver that never answers is given up after the timeout, never retried", async () => {
	writeWebhook(t.paths, "https://ntfy.sh/t");
	let calls = 0;
	const lines: string[] = [];
	const sender = createNoticeSender({
		paths: t.paths,
		// Answers only when the request's signal gives up, as a real fetch does.
		fetch: (_url, init) => {
			calls += 1;
			return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
		},
		log: (l) => lines.push(l),
		timeoutMs: 20,
	});
	const started = Date.now();
	expect(await sender.send(BODY)).toBe(false);
	expect(Date.now() - started).toBeLessThan(2000);
	expect(calls).toBe(1);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toStartWith("Could not send the notice to https://ntfy.sh/…:");
});

test("the destination keeps scheme, host, port and path, and masks user info, query and fragment", () => {
	expect(destinationOf("https://ntfy.sh/topic?auth=abc")).toBe("https://ntfy.sh/topic?…");
	expect(destinationOf(" https://me:pw@hooks.example.com:8443/in/x#frag ")).toBe(
		"https://…@hooks.example.com:8443/in/x#…",
	);
	expect(destinationOf("http://nas:2586")).toBe("http://nas:2586/");
	expect(destinationOf("not a url")).toBe("…");
});

test("an error that quotes the normalised address never carries its path or query into the log", async () => {
	// Written with an upper-case host and a default port: the parser's href differs from the text kept.
	writeWebhook(t.paths, "HTTPS://NTFY.sh:443/secret-topic?auth=tok");
	const lines: string[] = [];
	const sender = createNoticeSender({
		paths: t.paths,
		fetch: async (url) => {
			const u = new URL(url);
			throw new Error(`Unable to connect to ${u.href}, and to ${u.host}${u.pathname}${u.search}`);
		},
		log: (l) => lines.push(l),
	});
	expect(await sender.send(BODY)).toBe(false);
	expect(lines).toHaveLength(1);
	expect(lines[0]).not.toContain("secret-topic");
	expect(lines[0]).not.toContain("tok");
});

test("each address has its own failure streak: a new address's first failure is logged", async () => {
	const lines: string[] = [];
	const sender = createNoticeSender({
		paths: t.paths,
		fetch: async () => new Response("", { status: 503 }),
		log: (l) => lines.push(l),
	});
	writeWebhook(t.paths, "https://a.example.com/x");
	await sender.send(BODY);
	await sender.send(BODY);
	writeWebhook(t.paths, "https://b.example.com/x");
	await sender.send(BODY);
	expect(lines).toEqual([
		"Could not send the notice to https://a.example.com/…: it answered HTTP 503",
		"Could not send the notice to https://b.example.com/…: it answered HTTP 503",
	]);
});
