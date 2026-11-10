import type {
	AppState,
	Bridge,
	EngineEvent,
	HistoryRow,
	LogLine,
	RunState,
	Settings,
	Snapshot,
} from "../../shared/types";
import { GROUP_LABEL, type GroupId, stateSentence } from "./copy";

export type View = "updates" | "history" | "settings";

export const GROUP_ORDER: GroupId[] = ["ready", "manual", "problem", "held", "checking", "fresh"];

/** Apps in a run stay in Ready to install until the summary is dismissed, so rows do not jump mid-run. */
export function groupOf(app: AppState): GroupId {
	switch (app.status) {
		case "manual":
		case "problem":
		case "held":
		case "checking":
		case "fresh":
			return app.status;
		default:
			return "ready";
	}
}

/** A newly ready app is ticked; one that was already ready keeps the owner's choice. */
export function newlyReady(before: AppState | undefined, after: AppState): boolean {
	return after.status === "ready" && before?.status !== "ready";
}

export type Group = { id: GroupId; label: string; apps: AppState[] };

const LOG_CAP = 2000;

const idleRun = (): RunState => ({
	id: null,
	phase: "idle",
	index: 0,
	total: 0,
	currentKey: null,
	stopping: false,
	results: [],
});

export class Model {
	apps = $state<AppState[]>([]);
	run = $state<RunState>(idleRun());
	settings = $state<Settings>({ keepBackups: 1, notify: true, checkAtLogin: false });
	rate = $state<Snapshot["rate"]>(null);
	checkedAt = $state<string | null>(null);
	version = $state("");
	ticked = $state.raw<ReadonlySet<string>>(new Set());
	open = $state<string | null>(null);
	view = $state<View>("updates");
	log = $state<LogLine[]>([]);
	history = $state<HistoryRow[]>([]);
	loaded = $state(false);
	/** The engine's reason when it refused a request, shown until the next request. */
	refusal = $state<string | null>(null);

	groups: Group[] = $derived(
		GROUP_ORDER.map((id) => ({ id, label: GROUP_LABEL[id], apps: this.apps.filter((a) => groupOf(a) === id) })).filter(
			(g) => g.apps.length > 0,
		),
	);
	ready: AppState[] = $derived(this.apps.filter((a) => a.status === "ready"));
	tickedApps: AppState[] = $derived(this.ready.filter((a) => this.ticked.has(a.key)));
	tickedBytes: number | null = $derived.by(() => {
		const sizes = this.tickedApps.flatMap((a) => (typeof a.size === "number" ? [a.size] : []));
		return sizes.length === 0 ? null : sizes.reduce((s, n) => s + n, 0);
	});
	problems: number = $derived(this.apps.filter((a) => a.status === "problem").length);
	current: AppState | null = $derived(this.apps.find((a) => a.key === this.run.currentKey) ?? null);
	openApp: AppState | null = $derived(this.apps.find((a) => a.key === this.open) ?? null);
	sentence: string = $derived(
		stateSentence({
			run: this.run,
			ready: this.ready.length,
			problems: this.problems,
			currentName: this.current?.name ?? null,
		}),
	);
	failedKeys: string[] = $derived(this.run.results.filter((r) => r.result !== "updated").map((r) => r.key));
	queue: AppState[] = $derived(
		this.run.phase === "installing" || this.run.phase === "summary"
			? this.apps.filter((a) => ["queued", "working", "done", "failed", "rolled_back"].includes(a.status))
			: [],
	);

	#bridge: Bridge | null;
	#off: (() => void) | null = null;

	constructor(bridge: Bridge | null = null) {
		this.#bridge = bridge;
	}

	async start(): Promise<void> {
		const bridge = this.#bridge;
		if (!bridge) return;
		this.#off = bridge.onEvent((e) => this.apply(e));
		this.load(await bridge.request("snapshot", {}));
	}

	stop(): void {
		this.#off?.();
		this.#off = null;
	}

	load(snap: Snapshot): void {
		this.apps = snap.apps;
		this.run = snap.run;
		this.settings = snap.settings;
		this.rate = snap.rate;
		this.checkedAt = snap.checkedAt;
		this.version = snap.version;
		this.ticked = new Set(snap.apps.filter((a) => newlyReady(undefined, a)).map((a) => a.key));
		this.loaded = true;
	}

	apply(e: EngineEvent): void {
		switch (e.type) {
			case "app": {
				const i = this.apps.findIndex((a) => a.key === e.app.key);
				const before = i === -1 ? undefined : this.apps[i];
				if (i === -1) this.apps.push(e.app);
				else this.apps[i] = e.app;
				if (newlyReady(before, e.app)) this.#tick(e.app.key, true);
				else if (e.app.status !== "ready" && this.ticked.has(e.app.key)) this.#tick(e.app.key, false);
				return;
			}
			case "run":
				this.run = e.run;
				return;
			case "log":
				this.log.push(e.line);
				if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP);
				return;
			case "meta":
				this.rate = e.rate;
				this.checkedAt = e.checkedAt;
				this.settings = e.settings;
				return;
		}
	}

	#tick(key: string, on: boolean): void {
		const next = new Set(this.ticked);
		if (on) next.add(key);
		else next.delete(key);
		this.ticked = next;
	}

	toggle(key: string): void {
		if (this.apps.find((a) => a.key === key)?.status !== "ready") return;
		this.#tick(key, !this.ticked.has(key));
	}

	selectAll(): void {
		this.ticked = new Set(this.ready.map((a) => a.key));
	}

	selectNone(): void {
		this.ticked = new Set();
	}

	/** A and C open a row in place and close it again; B keeps one row selected in its tag pane. */
	toggleRow(key: string, select = false): void {
		this.open = select || this.open !== key ? key : null;
	}

	async #ask<T extends { started?: boolean; reason?: string }>(p: Promise<T>): Promise<T> {
		const res = await p;
		this.refusal = res.started === false ? (res.reason ?? null) : null;
		return res;
	}

	async install(keys: string[] = this.tickedApps.map((a) => a.key)): Promise<void> {
		const bridge = this.#bridge;
		if (!bridge || keys.length === 0) return;
		this.open = null;
		await this.#ask(bridge.request("install", { keys }));
	}

	retry(): Promise<void> {
		return this.install(this.failedKeys);
	}

	async check(): Promise<void> {
		if (this.#bridge) await this.#ask(this.#bridge.request("check", {}));
	}

	async stopAfterCurrent(): Promise<void> {
		await this.#bridge?.request("stopAfterCurrent", {});
	}

	async dismiss(): Promise<void> {
		await this.#bridge?.request("dismissSummary", {});
	}

	async loadHistory(): Promise<void> {
		if (this.#bridge) this.history = await this.#bridge.request("history", { limit: 200 });
	}

	request: Bridge["request"] = (name, params) => {
		const bridge = this.#bridge;
		if (!bridge) return Promise.reject(new Error("No bridge."));
		return bridge.request(name, params);
	};
}
