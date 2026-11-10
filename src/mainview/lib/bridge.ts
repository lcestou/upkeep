import type { Bridge, EngineEvent, Requests } from "../../shared/types";
import type { FixtureVariant } from "./fixture";

// The main process declares the same schema in src/bun/rpc.ts.
export type UpkeepRPC = {
	bun: { requests: Requests; messages: Record<string, never> };
	webview: { requests: Record<string, never>; messages: { event: EngineEvent } };
};

const VARIANTS: FixtureVariant[] = ["default", "empty", "checking", "problems", "many"];

export async function getBridge(): Promise<Bridge> {
	const query = new URLSearchParams(location.search);
	if (query.has("fixture")) {
		const { createFixture } = await import("./fixture");
		const asked = query.get("fixture") ?? "";
		const variant = VARIANTS.find((v) => v === asked) ?? "default";
		return createFixture({ variant, speed: Number(query.get("speed")) || 1 });
	}

	// Loaded only in the real window: a plain browser has no host socket to connect to.
	const { Electroview } = await import("electrobun/view");
	const listeners = new Set<(e: EngineEvent) => void>();
	const rpc = Electroview.defineRPC<UpkeepRPC>({
		maxRequestTime: 15000,
		handlers: {
			requests: {},
			messages: { event: (e) => listeners.forEach((l) => l(e)) },
		},
	});
	const electroview = new Electroview({ rpc });
	return {
		request<K extends keyof Requests>(name: K, params: Requests[K]["params"]) {
			const live = electroview.rpc ?? rpc;
			// The framework types each request separately; indexing by a generic key needs the one signature.
			const call = live.request[name] as (p: Requests[K]["params"]) => Promise<Requests[K]["response"]>;
			return call(params);
		},
		onEvent(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
