import { isIP } from "node:net";
import type { FetchLike } from "./github";
import type { Counts } from "./status";
import type { Paths } from "./paths";
import { readWebhook } from "./store";

/** How long one notice may take before it is given up: a slow receiver never holds anything else back. */
export const NOTICE_TIMEOUT_MS = 10_000;

/** The IPv4 ranges a home network or this computer uses: loopback, the private ranges, link-local and CGNAT (Tailscale). */
const LOCAL_V4: [number, number][] = [
	[0x7f000000, 8],
	[0x0a000000, 8],
	[0xac100000, 12],
	[0xc0a80000, 16],
	[0xa9fe0000, 16],
	[0x64400000, 10],
];

/** Name endings that only resolve inside a home network (RFC 6762, RFC 8375 and the common router suffixes). */
const LOCAL_SUFFIXES = [".localhost", ".local", ".lan", ".home", ".home.arpa", ".internal"];

/**
 * Whether a URL's hostname is this computer or a home network: a private, loopback, link-local or CGNAT address, a
 * name with no dot (a LAN name such as "nas"), or a name ending in a home-only suffix. A public name that a person's
 * own DNS points inward reads as public: only the address itself is judged, never what it resolves to.
 */
export function onHomeNetwork(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (isIP(host) === 4) {
		const n = host.split(".").reduce((a, p) => a * 256 + Number(p), 0);
		return LOCAL_V4.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
	}
	if (isIP(host) === 6) return host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
	return host === "localhost" || !host.includes(".") || LOCAL_SUFFIXES.some((s) => host.endsWith(s));
}

/**
 * Why text cannot take notices: "address" when it is not an http or https URL with a host, "plain" when it is http to
 * a host off the home network, where every hop would read the app list and any token in the address. null when it
 * can. Credentials in the URL (user:pass@) are allowed: some receivers take them there.
 */
export function addressProblem(text: string): "address" | "plain" | null {
	let url: URL;
	try {
		url = new URL(text.trim());
	} catch {
		return "address";
	}
	if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || /\s/.test(text.trim()))
		return "address";
	return url.protocol === "http:" && !onHomeNetwork(url.hostname) ? "plain" : null;
}

/**
 * The address as Settings and the log show it: scheme, host and port, then "/…" when a path or query follows (an
 * ntfy topic works as a password, and a token may sit in the query). Credentials are never shown. Text that is not
 * a URL shows as "…".
 */
export function maskAddress(text: string): string {
	try {
		const url = new URL(text);
		const rest = url.pathname !== "/" || url.search !== "" || url.hash !== "";
		return `${url.protocol}//${url.host}${rest ? "/…" : "/"}`;
	} catch {
		return "…";
	}
}

/** One app in a notice: a ready one's versions, or a run's result for it. */
export type NoticeApp = {
	key: string;
	name: string;
	installed?: string | null;
	latest?: string | null;
	from?: string | null;
	to?: string | null;
	result?: string;
	detail?: string;
};

/** The JSON a notice address gets: title and message for a person, the rest for a program. */
export type NoticeBody = {
	title: string;
	message: string;
	event: "ready" | "run";
	host: string;
	version: string;
	counts: Counts;
	apps: NoticeApp[];
};

/** What createNoticeSender hands back: one send per notice, true when the receiver took it. */
export type NoticeSender = { send(body: NoticeBody): Promise<boolean> };

/** What createNoticeSender needs: where the address is kept, the network, and where a failure is written. */
export type NoticeDeps = { paths: Paths; fetch: FetchLike; log: (line: string) => void; timeoutMs?: number };

/**
 * Posts notices to the kept address, one try each. A failure (no answer in timeoutMs, a refused connection, an answer
 * other than 2xx, a redirect, which is refused so an https address can never be sent on to http) is logged once with
 * the masked address; later failures stay quiet until a notice goes through again. send never throws, and the
 * callers do not await it, so a check or run never waits on the receiver. No address kept, or one that no longer
 * passes addressProblem (a hand-edited file), sends nothing.
 */
export function createNoticeSender(deps: NoticeDeps): NoticeSender {
	let failing = false;
	return {
		async send(body) {
			const address = readWebhook(deps.paths);
			if (!address || addressProblem(address)) return false;
			let why: string | null = null;
			try {
				const res = await deps.fetch(address, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
					redirect: "error",
					signal: AbortSignal.timeout(deps.timeoutMs ?? NOTICE_TIMEOUT_MS),
				});
				if (!res.ok) why = `it answered HTTP ${res.status}`;
			} catch (err) {
				why = err instanceof Error ? err.message : String(err);
			}
			if (why === null) {
				failing = false;
				return true;
			}
			// An error that quotes the address must not put its secret in the log.
			const masked = maskAddress(address);
			if (!failing) deps.log(`Could not send the notice to ${masked}: ${why.replaceAll(address, masked)}`);
			failing = true;
			return false;
		},
	};
}
