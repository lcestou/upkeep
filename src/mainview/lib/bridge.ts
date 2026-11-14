import type { Bridge, EngineEvent, Requests } from "../../shared/types";
import type { FixtureVariant } from "./fixture";
import type { SystemVariant } from "./fixture-system";

// The main process binds this schema in src/bun/rpc.ts; its answers live in src/bun/requests.ts.
export type UpkeepRPC = {
	bun: { requests: Requests; messages: Record<string, never> };
	webview: { requests: Record<string, never>; messages: { event: EngineEvent } };
};

const VARIANTS: FixtureVariant[] = ["default", "empty", "checking", "problems", "many", "built", "none"];
const SELF_PHASES = ["available", "preparing", "ready", "restarting", "failed", "rolled-back", "updated"] as const;
const SYSTEM_VARIANTS: SystemVariant[] = [
	"off",
	"show",
	"checking",
	"empty",
	"missing",
	"failed",
	"gl",
	"apt",
	"dnf",
	"install",
	"refuse",
];

// Requests that wait on real work (a download, a restore, a scan) get five minutes; the engine has its own step limits.
const LONG: ReadonlySet<string> = new Set(["restore", "restartApp", "install", "suggest", "scan", "addApps"]);
const SHORT_MS = 15_000;
const LONG_MS = 300_000;

/** Picks the fixture bridge when the URL asks for one (a plain browser, the specs), else the real Electrobun channel. Unknown fixture names fall back to the default variant. */
export async function getBridge(): Promise<Bridge> {
	const query = new URLSearchParams(location.search);
	if (query.has("fixture")) {
		const { createFixture } = await import("./fixture");
		const asked = query.get("fixture") ?? "";
		const variant = VARIANTS.find((v) => v === asked) ?? "default";
		const buttons = query.get("buttons");
		const system = SYSTEM_VARIANTS.find((v) => v === query.get("system"));
		return createFixture({
			variant,
			speed: Number(query.get("speed")) || 1,
			fail: query.get("fail") ?? undefined,
			buttons: buttons === "right" || buttons === "left" ? buttons : undefined,
			frame: query.get("frame") === "system" ? "system" : "own",
			corners: query.get("corners") === "square" ? "square" : "rounded",
			noHistory: query.get("history") === "none",
			system,
			cleanup: query.get("cleanup") === "on" ? "on" : undefined,
			scan: query.get("scan") === "unknown" ? "unknown" : query.get("scan") === "also" ? "also" : undefined,
			self: SELF_PHASES.find((v) => v === query.get("self")),
			selfTestFails: query.get("selftest") === "fail",
			rate: query.get("rate") === "out" ? "out" : query.get("rate") === "signed" ? "signed" : undefined,
		});
	}

	// Loaded only in the real window: a plain browser has no host socket to connect to.
	const { Electroview } = await import("electrobun/view");
	const listeners = new Set<(e: EngineEvent) => void>();
	const rpc = Electroview.defineRPC<UpkeepRPC>({
		maxRequestTime: SHORT_MS,
		handlers: {
			requests: {},
			messages: { event: (e) => listeners.forEach((l) => l(e)) },
		},
	});
	const electroview = new Electroview({ rpc });
	return {
		request<K extends keyof Requests>(name: K, params: Requests[K]["params"]) {
			const live = electroview.rpc ?? rpc;
			// SAFETY: the framework types each request separately; the schema in UpkeepRPC gives every key this one signature.
			const call = live.request[name] as (
				p: Requests[K]["params"],
				options: { maxRequestTime: number },
			) => Promise<Requests[K]["response"]>;
			return call(params, { maxRequestTime: LONG.has(name) ? LONG_MS : SHORT_MS });
		},
		onEvent(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
