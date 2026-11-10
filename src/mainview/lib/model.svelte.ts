import type {
	AppState,
	AppStatus,
	Bridge,
	EngineEvent,
	HistoryRow,
	LogLine,
	Requests,
	RunState,
	Settings,
	Snapshot,
	WindowChrome,
} from "../../shared/types";
import { GROUP_LABEL, type GroupId, stateSentence } from "./copy";

export type View = "updates" | "history" | "settings";

export const GROUP_ORDER: GroupId[] = ["run", "ready", "manual", "problem", "held", "checking", "restart", "fresh"];

/**
 * Apps in a run form their own group until the summary is dismissed, so rows do not jump mid-run.
 * A row being checked again stays in the group of what it was before the check (prior).
 */
export function groupOf(app: AppState, prior?: AppStatus): GroupId {
	const status = app.status === "checking" && prior ? prior : app.status;
	// An update that waits on a restart keeps its own group, open above Fresh, until the app restarts.
	if (status === "fresh" && app.restartToApply) return "restart";
	switch (status) {
		case "manual":
		case "problem":
		case "held":
		case "checking":
		case "fresh":
		case "ready":
			return status;
		default:
			return "run";
	}
}

/** A newly ready app is ticked; one that was ready before (before the check began, for a re-check) keeps the owner's choice. */
export function newlyReady(was: AppStatus | undefined, after: AppState): boolean {
	return after.status === "ready" && was !== "ready";
}

const matches = (app: AppState, text: string) =>
	app.name.toLowerCase().includes(text) || (app.repo ?? "").toLowerCase().includes(text);

export function runLabel(phase: RunState["phase"]): string {
	return phase === "installing" ? GROUP_LABEL.installing : GROUP_LABEL.thisRun;
}

export type Group = { id: GroupId; label: string; apps: AppState[] };

const LOG_CAP = 2000;

export const IN_RUN: ReadonlySet<AppStatus> = new Set(["queued", "working", "done", "failed", "rolled_back"]);

const idleRun = (): RunState => ({
	id: null,
	phase: "idle",
	index: 0,
	total: 0,
	currentKey: null,
	stopping: false,
	results: [],
	retry: false,
});

export class Model {
	apps = $state<AppState[]>([]);
	run = $state<RunState>(idleRun());
	settings = $state<Settings>({
		keepBackups: 1,
		notify: true,
		checkAtLogin: false,
		frame: "own",
		buttons: "auto",
		corners: "rounded",
	});
	/** How the window is dressed; null until the main process answers (a system frame then). */
	chrome = $state<WindowChrome | null>(null);
	rate = $state<Snapshot["rate"]>(null);
	checkedAt = $state<string | null>(null);
	version = $state("");
	ticked = $state.raw<ReadonlySet<string>>(new Set());
	/** The app shown in the inspector; null means the inspector is closed. */
	openKey = $state<string | null>(null);
	/** Set when the owner picks a row during a run, so the inspector stops following the queue until it ends. */
	pinned = $state(false);
	/** True from a click on Install or Retry until the engine answers, so a second click cannot start a second run. */
	starting = $state(false);
	view = $state<View>("updates");
	log = $state<LogLine[]>([]);
	history = $state<HistoryRow[]>([]);
	loaded = $state(false);
	/** The status each app had when a re-check began, so its row and its tick survive the check. */
	prior = $state<Record<string, AppStatus>>({});
	/** The inspector shows the add pane instead of an app. */
	adding = $state(false);
	/** Text handed to the add pane from outside it (a drop); findSeq asks the pane to find it. */
	addInput = $state("");
	findSeq = $state(0);
	/** Bumped after an add, so the list opens Fresh when an added app landed there. */
	reveal = $state(0);
	/** Said in the add pane when a drop carried no path the window can read. */
	dropProblem = $state<string | null>(null);
	/** A short line the header shows for five seconds (Removed fd.). */
	notice = $state<string | null>(null);
	/** Added {name}. at the top of an app's pane for five seconds after it was added. */
	addedNote = $state<{ key: string; text: string } | null>(null);
	/** The text in the filter field. */
	filter = $state("");
	/** The engine's reason when it refused a request, shown until the next request. */
	refusal = $state<string | null>(null);

	groups: Group[] = $derived(
		GROUP_ORDER.map((id) => ({
			id,
			label: id === "run" ? runLabel(this.run.phase) : GROUP_LABEL[id],
			apps: this.shown.filter((a) => groupOf(a, this.prior[a.key]) === id),
		})).filter((g) => g.apps.length > 0),
	);
	#needle = $derived(this.filter.trim().toLowerCase());
	shown: AppState[] = $derived(this.#needle ? this.apps.filter((a) => matches(a, this.#needle)) : this.apps);
	ready: AppState[] = $derived(this.apps.filter((a) => a.status === "ready"));
	/** Nothing to decide: no run, nothing ready, by hand or needing a look, and no check under way. */
	allFresh: boolean = $derived(
		this.run.phase === "idle" &&
			this.apps.length > 0 &&
			this.apps.every((a) => a.status === "fresh" || a.status === "held"),
	);
	/** Ticked apps that can go into a run; during a re-check, the ones that were ready before it began still count. */
	tickedApps: AppState[] = $derived(
		this.apps.filter(
			(a) =>
				this.ticked.has(a.key) && (a.status === "ready" || (a.status === "checking" && this.prior[a.key] === "ready")),
		),
	);
	/** Every app queued in the current run; the ones back at ready in the summary were never started. */
	runKeys = $state.raw<ReadonlySet<string>>(new Set());
	notStarted: number = $derived(
		this.run.phase === "summary" ? this.apps.filter((a) => this.runKeys.has(a.key) && a.status === "ready").length : 0,
	);
	/** Fresh apps whose running copy predates their update. */
	restarts: AppState[] = $derived(
		this.apps.filter((a) => a.restartToApply && (a.status === "fresh" || a.status === "done")),
	);
	/** Ticked apps the filter hides; Install still counts them. */
	hiddenTicked: number = $derived(this.#needle ? this.tickedApps.filter((a) => !matches(a, this.#needle)).length : 0);

	tickedBytes: number | null = $derived.by(() => {
		const sizes = this.tickedApps.flatMap((a) => (typeof a.size === "number" ? [a.size] : []));
		return sizes.length === 0 ? null : sizes.reduce((s, n) => s + n, 0);
	});
	problems: number = $derived(this.apps.filter((a) => a.status === "problem").length);
	current: AppState | null = $derived(this.apps.find((a) => a.key === this.run.currentKey) ?? null);
	openApp: AppState | null = $derived(this.apps.find((a) => a.key === this.openKey) ?? null);
	sentence: string = $derived(
		stateSentence({
			run: this.run,
			ready: this.ready.length,
			problems: this.problems,
			currentName: this.current?.name ?? null,
			notStarted: this.notStarted,
		}),
	);
	failedKeys: string[] = $derived(this.run.results.filter((r) => r.result !== "updated").map((r) => r.key));
	/** The apps in this run in the engine's order: native kinds in list order, then the old script's. */
	queue: AppState[] = $derived(
		this.run.phase === "installing" || this.run.phase === "summary"
			? this.apps
					.filter((a) => IN_RUN.has(a.status))
					.toSorted((a, b) => Number(a.kind === "legacy") - Number(b.kind === "legacy"))
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
		const [snap, chrome] = await Promise.all([bridge.request("snapshot", {}), this.send("chrome", {})]);
		this.chrome = chrome;
		this.load(snap);
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
				const key = e.app.key;
				const i = this.apps.findIndex((a) => a.key === key);
				const before = i === -1 ? undefined : this.apps[i];
				if (i === -1) this.apps.push(e.app);
				else this.apps[i] = e.app;
				if (e.app.status === "queued" && !this.runKeys.has(key)) this.runKeys = new Set([...this.runKeys, key]);
				if (e.app.status === "checking") {
					// A re-check leaves the tick alone and remembers where the row was.
					if (before && before.status !== "checking" && !(key in this.prior)) this.prior[key] = before.status;
					return;
				}
				const was = key in this.prior ? this.prior[key] : before?.status;
				delete this.prior[key];
				if (newlyReady(was, e.app)) this.#tick(key, true);
				else if (e.app.status !== "ready" && this.ticked.has(key)) this.#tick(key, false);
				return;
			}
			case "run": {
				const before = this.run.phase;
				if (e.run.phase === "idle") this.runKeys = new Set();
				this.run = e.run;
				if (e.run.phase === "installing") {
					if (this.openKey && !this.pinned && e.run.currentKey) this.openKey = e.run.currentKey;
					return;
				}
				this.pinned = false;
				// A run that ends with failures opens the inspector on the first one; a clean run leaves it alone.
				const failed = e.run.results.find((r) => r.result !== "updated");
				if (before === "installing" && e.run.phase === "summary" && failed) this.openKey = failed.key;
				return;
			}
			case "log":
				this.log.push(e.line);
				if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP);
				return;
			case "chrome":
				this.chrome = e.chrome;
				return;
			case "removed": {
				this.apps = this.apps.filter((a) => a.key !== e.key);
				if (this.ticked.has(e.key)) this.#tick(e.key, false);
				if (this.openKey === e.key) this.openKey = null;
				delete this.prior[e.key];
				return;
			}
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

	/** Ready apps the filter shows; Select all, Select none and the header tick act on these. */
	shownReady: AppState[] = $derived(this.ready.filter((a) => this.shown.includes(a)));

	selectAll(): void {
		this.ticked = new Set([...this.ticked, ...this.shownReady.map((a) => a.key)]);
	}

	selectNone(): void {
		const hide = new Set(this.shownReady.map((a) => a.key));
		this.ticked = new Set([...this.ticked].filter((k) => !hide.has(k)));
	}

	select(key: string): void {
		this.adding = false;
		this.openKey = key;
		if (this.run.phase === "installing") this.pinned = true;
	}

	close(): void {
		this.openKey = null;
		this.adding = false;
	}

	openAdd(input?: string): void {
		this.openKey = null;
		this.adding = true;
		if (input !== undefined) {
			this.addInput = input;
			this.findSeq++;
		}
	}

	#timers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Sets a field now and clears it after ms, restarting the clock when set again. */
	flash(which: "notice" | "added", value: string, key = ""): void {
		clearTimeout(this.#timers.get(which));
		if (which === "notice") this.notice = value;
		else this.addedNote = { key, text: value };
		this.#timers.set(
			which,
			setTimeout(() => {
				if (which === "notice") this.notice = null;
				else this.addedNote = null;
			}, 5000),
		);
	}

	async #ask<T extends { started?: boolean; reason?: string }>(p: Promise<T>): Promise<T> {
		const res = await p;
		this.refusal = res.started === false ? (res.reason ?? null) : null;
		return res;
	}

	async install(keys: string[] = this.tickedApps.map((a) => a.key)): Promise<void> {
		const bridge = this.#bridge;
		if (!bridge || keys.length === 0 || this.starting) return;
		this.starting = true;
		try {
			await this.#ask(bridge.request("install", { keys }));
		} catch {
			// A run that did start reports itself through events; one that did not leaves the list as it was.
		} finally {
			this.starting = false;
		}
	}

	retry(): Promise<void> {
		return this.install(this.failedKeys);
	}

	async check(): Promise<void> {
		if (await this.send("check", {})) this.refusal = null;
	}

	async stopAfterCurrent(): Promise<void> {
		await this.send("stopAfterCurrent", {});
	}

	async dismiss(): Promise<void> {
		await this.send("dismissSummary", {});
	}

	async loadHistory(): Promise<void> {
		const rows = await this.send("history", { limit: 200 });
		if (rows) this.history = rows;
	}

	/**
	 * A request whose failure the view does not report: a rejection (a timeout, a lost window) resolves to null,
	 * and the row catches up through the engine's events.
	 */
	async send<K extends keyof Requests>(
		name: K,
		params: Requests[K]["params"],
	): Promise<Requests[K]["response"] | null> {
		try {
			return await this.request(name, params);
		} catch {
			return null;
		}
	}

	request: Bridge["request"] = (name, params) => {
		const bridge = this.#bridge;
		if (!bridge) return Promise.reject(new Error("No bridge."));
		return bridge.request(name, params);
	};
}
