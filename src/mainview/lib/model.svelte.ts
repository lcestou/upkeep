import type {
	AppState,
	AppStatus,
	Bridge,
	EngineEvent,
	ExtrasSettings,
	ExtrasSnapshot,
	SelfState,
	HistoryRow,
	LogLine,
	Requests,
	RunState,
	Settings,
	Snapshot,
	SystemRow,
	WindowButton,
	WindowChrome,
} from "../../shared/types";
import { followSetting } from "./language.svelte";
import { rangeClicks } from "./range";
import { GROUP_LABEL, type GroupId, stateSentence } from "./copy";

export type View = "updates" | "history" | "cleanup" | "settings";

export const GROUP_ORDER: GroupId[] = ["run", "ready", "manual", "problem", "held", "checking", "restart", "fresh"];

/**
 * Apps in a run form their own group until the summary is dismissed, so rows do not jump mid-run.
 * A row being checked again stays in the group of what it was before the check (prior). A fresh row with a watch
 * sign goes to Needs a look.
 */
export function groupOf(app: AppState, prior?: AppStatus): GroupId {
	const status = app.status === "checking" && prior ? prior : app.status;
	// An app with a sign since its update needs a look: folded away in Fresh, the sign would go unseen.
	if (status === "fresh" && app.watch) return "problem";
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

/** True when the lower-cased filter text is in the app's name or its repo; an app with no repo matches on name only. */
const matches = (app: AppState, text: string) =>
	app.name.toLowerCase().includes(text) || (app.repo ?? "").toLowerCase().includes(text);

/** The heading of the run group: "installing" while the run is going, the neutral "this run" label in any other phase. */
export function runLabel(phase: RunState["phase"]): string {
	return phase === "installing" ? GROUP_LABEL.installing : GROUP_LABEL.thisRun;
}

export type Group = { id: GroupId; label: string; apps: AppState[] };

// The window keeps the newest lines only; the whole run is in its log file (Open log file). Each row's pane reads
// its own lines from these, so a quiet app's early lines last as long as 2000 do.
const LOG_CAP = 2000;

export const IN_RUN: ReadonlySet<AppStatus> = new Set([
	"queued",
	"working",
	"done",
	"failed",
	"rolled_back",
	"stopped",
]);

/** An empty run state, used before the first snapshot and as the reset value; a fresh object each call so callers never share one. */
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

/** A log line as the window keeps it: the engine's line and its number in this window's run of lines. */
export type ShownLine = LogLine & { id: number };

/** The view's state: the engine's snapshot, applied events and the choices the person has made in the window. It never talks to the engine except through the bridge it is given. */
export class Model {
	apps = $state<AppState[]>([]);
	run = $state<RunState>(idleRun());
	/** The desktop's languages from the main process, most preferred first; empty until start() has them. */
	desktopLanguages: string[] = [];
	settings = $state<Settings>({
		keepBackups: 1,
		notify: true,
		checkAtLogin: false,
		checkEvery: "6h",
		frame: "own",
		buttons: "auto",
		corners: "rounded",
		language: "system",
		selfAuto: false,
		upkeepCommand: false,
		waitDays: 0,
		waitUnmetered: false,
		webhookReady: true,
		webhookRun: false,
		watchUpdates: true,
	});
	/** How the window is dressed; null until the main process answers (a system frame then). */
	chrome = $state<WindowChrome | null>(null);
	/**
	 * True from a close or minimize until the pointer comes into the window buttons again. Either hides the window with
	 * the pointer where it was, and a hidden webview never hears it leave, so a button would open in its hover colour.
	 */
	buttonsCold = $state(false);
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
	// A window rebuilt for a frame or corner change is opened with #settings, so the owner stays where he was.
	view = $state<View>(globalThis.location?.hash === "#settings" ? "settings" : "updates");
	/** The run's log lines, each with a number that never repeats, so a list keyed on it draws only the lines that came and went. */
	log = $state<ShownLine[]>([]);
	#logSeq = 0;
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
	/** The read-only System group; null until the main process answers. */
	extras = $state<ExtrasSnapshot | null>(null);
	/** Upkeep's own update; "none" until the main process says otherwise. */
	self = $state<SelfState>({ phase: "none" });
	/** True while a check, a run, a system install or a cleanup is going: Upkeep's own update waits for it. */
	get selfBusy(): boolean {
		return (
			this.run.phase === "checking" ||
			this.run.phase === "installing" ||
			this.extras?.system.phase === "installing" ||
			this.extras?.cleanup.phase === "cleaning"
		);
	}
	/** The engine's reason when it refused a request, shown until the next request. */
	refusal = $state<string | null>(null);

	groups: Group[] = $derived(
		GROUP_ORDER.map((id) => ({
			id,
			label: id === "run" ? runLabel(this.run.phase) : GROUP_LABEL[id],
			apps: this.#ordered(
				id,
				this.shown.filter((a) => groupOf(a, this.prior[a.key]) === id),
			),
		})).filter((g) => g.apps.length > 0),
	);
	/**
	 * The run's group lists its apps in the order they run, which the engine gives. Every other group is alphabetical
	 * by name, so an app is easy to find; History says which ones changed lately.
	 */
	#ordered(id: GroupId, apps: AppState[]): AppState[] {
		const order = this.run.queue;
		if (id !== "run" || !order)
			return apps.toSorted((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
		const at = (k: string) => {
			const i = order.indexOf(k);
			return i < 0 ? order.length : i;
		};
		return apps.toSorted((a, b) => at(a.key) - at(b.key));
	}
	/** The filter as matched: trimmed and lower case; empty means no filter. */
	get #needle(): string {
		return this.filter.trim().toLowerCase();
	}
	shown: AppState[] = $derived(this.#needle ? this.apps.filter((a) => matches(a, this.#needle)) : this.apps);
	/** System rows the filter shows; shown only while the setting is on. */
	systemShown: SystemRow[] = $derived(
		this.extras?.settings.system === "show"
			? (this.extras.system.rows ?? []).filter((r) => !this.#needle || r.name.toLowerCase().includes(this.#needle))
			: [],
	);
	/** System rows the person ticked. Nothing is ticked until they tick it. */
	systemTicked = $state.raw<ReadonlySet<string>>(new Set());
	/** System rows Upkeep can install now: only while the install switch is on, and only the ones the main process names. */
	systemCan: ReadonlySet<string> = $derived(
		new Set(this.extras?.settings.systemInstall === true ? (this.extras.system.installable ?? []) : []),
	);
	/** Ticked System rows the footer's Install takes; a tick on a row that left the list or became uninstallable drops. */
	systemPicked: string[] = $derived(
		(this.extras?.system.rows ?? [])
			.filter((r) => this.systemTicked.has(r.id) && this.systemCan.has(r.id))
			.map((r) => r.id),
	);
	/** The commands the person reads before a System install starts; null while not asking. */
	systemPlan = $state.raw<{ ids: string[]; commands: string[][] } | null>(null);
	/** Why the last System plan or start was refused, until the next press. */
	systemReason = $state<string | null>(null);
	/** The start time of the System install whose results were dismissed or replaced; the group hides that one. */
	systemSeen = $state<string | null>(null);
	/** True while Install now waits for the main process's answer; the footer's Install stays disabled meanwhile. */
	confirming = $state(false);
	/** True from a confirmed System install until it ends, when the ticked apps start: the two share one run lock. */
	#appsAfterSystem = false;
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
		const sizes = this.tickedApps.flatMap((a) => (a.size === undefined ? [] : [a.size]));
		return sizes.length === 0 ? null : sizes.reduce((s, n) => s + n, 0);
	});
	problems: number = $derived(this.apps.filter((a) => a.status === "problem").length);
	/** The app the run is installing now; null between apps and outside a run. */
	get current(): AppState | null {
		return this.apps.find((a) => a.key === this.run.currentKey) ?? null;
	}
	/** The app whose inspector is open; null when none is, or when its key left the list. */
	get openApp(): AppState | null {
		return this.apps.find((a) => a.key === this.openKey) ?? null;
	}
	sentence: string = $derived(
		stateSentence({
			run: this.run,
			ready: this.ready.length,
			problems: this.problems,
			currentName: this.current?.name ?? null,
			notStarted: this.notStarted,
			total: this.apps.length,
		}),
	);
	// A stopped app is the person's choice, not a failure: it is never offered as Retry.
	failedKeys: string[] = $derived(
		this.run.results.filter((r) => r.result !== "updated" && r.result !== "stopped").map((r) => r.key),
	);
	/** The apps in this run in the engine's order: list order, with apps added during the run after them. */
	queue: AppState[] = $derived(
		this.run.phase === "installing" || this.run.phase === "summary"
			? this.#ordered(
					"run",
					this.apps.filter((a) => IN_RUN.has(a.status)),
				)
			: [],
	);

	#bridge: Bridge | null;
	#off: (() => void) | null = null;

	/** With no bridge the model stays empty and every request resolves to nothing, which the unit tests and the empty window rely on. */
	constructor(bridge: Bridge | null = null) {
		this.#bridge = bridge;
	}

	/** Subscribes to events before asking for the snapshot so none are missed. A chrome or extras request that fails leaves them null; the snapshot request itself is allowed to reject. */
	async start(): Promise<void> {
		const bridge = this.#bridge;
		if (!bridge) return;
		this.#off = bridge.onEvent((e) => this.apply(e));
		const [snap, chrome, extras, languages, self] = await Promise.all([
			bridge.request("snapshot", {}),
			this.send("chrome", {}),
			this.send("extras", {}),
			this.send("languages", {}),
			this.send("self", {}),
		]);
		if (self) this.self = self;
		this.desktopLanguages = languages ?? [];
		this.chrome = chrome;
		if (extras) this.extras = extras;
		this.load(snap);
	}

	/** Unsubscribes from engine events. Safe to call twice. */
	stop(): void {
		this.#off?.();
		this.#off = null;
	}

	/** Replaces the whole list from a snapshot. Ticks only the apps that are ready, and discards earlier ticks. */
	load(snap: Snapshot): void {
		this.apps = snap.apps;
		this.run = snap.run;
		this.settings = snap.settings;
		followSetting(this.settings.language, this.desktopLanguages);
		this.rate = snap.rate;
		this.checkedAt = snap.checkedAt;
		this.version = snap.version;
		this.ticked = new Set(snap.apps.filter((a) => newlyReady(undefined, a)).map((a) => a.key));
		this.loaded = true;
	}

	/** Folds one engine event into the state. An app that is being checked again keeps its last known versions and its place in the list. */
	apply(e: EngineEvent): void {
		switch (e.type) {
			case "app": {
				const key = e.app.key;
				const i = this.apps.findIndex((a) => a.key === key);
				const before = i === -1 ? undefined : this.apps[i];
				// A row being checked keeps its last known versions until the answer arrives.
				const app: AppState =
					e.app.status === "checking" && before
						? { ...e.app, installed: e.app.installed ?? before.installed, latest: e.app.latest ?? before.latest }
						: e.app;
				if (i === -1) this.apps.push(app);
				else this.apps[i] = app;
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
				const failed = e.run.results.find((r) => r.result !== "updated" && r.result !== "stopped");
				if (before === "installing" && e.run.phase === "summary" && failed) this.openKey = failed.key;
				return;
			}
			case "log":
				this.log.push({ ...e.line, id: ++this.#logSeq });
				if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP);
				return;
			case "chrome":
				this.chrome = e.chrome;
				return;
			case "self":
				this.self = e.self;
				break;
			case "extras": {
				const was = this.extras?.system.phase;
				this.extras = e.extras;
				// A System install confirmed with apps ticked has ended: the apps run now.
				if (this.#appsAfterSystem && was === "installing" && e.extras.system.phase !== "installing") {
					this.#appsAfterSystem = false;
					void this.install();
				}
				// Cleanup switched off while its tab shows: the tab is gone, so Settings, where the switch is, shows.
				if (this.view === "cleanup" && !e.extras.settings.cleanup) this.view = "settings";
				return;
			}
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
				followSetting(this.settings.language, this.desktopLanguages);
				return;
		}
	}

	/** Adds or removes one key by swapping in a new set, because the ticked set is raw state and a mutation would not notify. */
	#tick(key: string, on: boolean): void {
		const next = new Set(this.ticked);
		if (on) next.add(key);
		else next.delete(key);
		this.ticked = next;
	}

	#span = rangeClicks();
	/**
	 * Flips the tick of a ready app. Any other status is ignored, so a row that cannot be installed never gets ticked.
	 * With `range` (a Shift-click) every ready app listed between the last one clicked and this one takes its new
	 * tick, in the order the window lists them. During a run a Shift-click joins only the app clicked.
	 */
	toggle(key: string, range = false): void {
		if (this.apps.find((a) => a.key === key)?.status !== "ready") return;
		// During a run a tick is a request to join it, as in a download manager; the row turns Queued.
		if (this.run.phase === "installing") {
			if (!this.run.stopping) void this.#join(key);
			return;
		}
		const on = !this.ticked.has(key);
		const ids = this.groups.flatMap((g) => g.apps.filter((a) => a.status === "ready").map((a) => a.key));
		const next = new Set(this.ticked);
		for (const one of this.#span(ids, key, range)) {
			if (on) next.add(one);
			else next.delete(one);
		}
		this.ticked = next;
	}

	/** Ready apps the filter shows; Select all, Select none and the header tick act on these. */
	shownReady: AppState[] = $derived(this.ready.filter((a) => this.shown.includes(a)));

	/** Ticks the ready apps the filter shows, keeping the ticks already made. */
	selectAll(): void {
		this.ticked = new Set([...this.ticked, ...this.shownReady.map((a) => a.key)]);
	}

	/** Unticks the ready apps and the System rows the filter shows; ticks on rows the filter hides stay. */
	selectNone(): void {
		const hide = new Set(this.shownReady.map((a) => a.key));
		this.ticked = new Set([...this.ticked].filter((k) => !hide.has(k)));
		const shownSystem = new Set(this.systemShown.map((r) => r.id));
		this.systemTicked = new Set([...this.systemTicked].filter((id) => !shownSystem.has(id)));
		this.systemPlan = null;
	}

	#systemSpan = rangeClicks();
	/**
	 * Ticks or unticks one System row, or with `range` (a Shift-click) every installable row shown since the last one
	 * clicked. An open command sheet closes, since its commands no longer match the ticks; the next press shows new
	 * ones. Swaps in a new set, because the ticked set is raw state and a mutation would not notify.
	 */
	tickSystem(id: string, on: boolean, range = false): void {
		const ids = this.systemShown.filter((r) => this.systemCan.has(r.id)).map((r) => r.id);
		const next = new Set(this.systemTicked);
		for (const one of this.#systemSpan(ids, id, range)) {
			if (on) next.add(one);
			else next.delete(one);
		}
		this.systemTicked = next;
		this.systemPlan = null;
	}

	/**
	 * The footer's Install. With System rows ticked it asks the main process for their commands and shows them, and
	 * nothing runs until the person confirms; with none it starts the app run. A plan that comes back empty shows its
	 * reason and still runs the ticked apps. A plan request with no answer runs nothing and keeps every tick, so the
	 * System rows are never dropped while the apps go ahead.
	 */
	async installTicked(): Promise<void> {
		if (this.starting || this.confirming) return;
		this.systemReason = null;
		const ids = this.systemPicked;
		if (ids.length === 0) return this.install();
		// An earlier install's result or refusal makes way for this one.
		this.systemSeen = this.extras?.system.install?.at ?? null;
		const answer = await this.send("systemPlan", { ids });
		if (!answer) return;
		if (answer.commands.length > 0) {
			this.systemPlan = { ids, commands: answer.commands };
			return;
		}
		this.systemReason = answer.reason ?? null;
		return this.install();
	}

	/**
	 * Starts the System install of exactly what the sheet showed (the main process refuses it if the list changed),
	 * then the ticked apps once it ends. A refused System install shows its reason and the apps start at once. Only the
	 * rows in the plan lose their tick: one ticked while the sheet was open waits for the next press.
	 */
	async confirmSystem(): Promise<void> {
		const p = this.systemPlan;
		this.systemPlan = null;
		if (!p) return;
		// Set before asking: the install could end before its answer arrives, and its end is what starts the apps.
		this.#appsAfterSystem = true;
		// The sheet is gone, so the footer's Install would enable again; `confirming` holds it until the answer. Not
		// `starting`, which would stop the apps from starting when the install ends before its answer.
		this.confirming = true;
		const answer = await this.send("systemInstall", p);
		this.confirming = false;
		if (answer?.started) {
			const ran = new Set(p.ids);
			this.systemTicked = new Set([...this.systemTicked].filter((id) => !ran.has(id)));
			return;
		}
		this.#appsAfterSystem = false;
		this.systemReason = answer?.reason ?? null;
		return this.install();
	}

	/** Opens an app in the inspector. During a run this pins the choice so the inspector stops following the queue. */
	select(key: string): void {
		this.adding = false;
		this.openKey = key;
		if (this.run.phase === "installing") this.pinned = true;
	}

	/** Closes the inspector and the add pane. */
	close(): void {
		this.openKey = null;
		this.adding = false;
	}

	/** Opens the add pane. When input is given it is handed over and findSeq is bumped to make the pane look it up; with none, what was typed before stays. */
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

	/** Remembers why the engine refused a request, or clears the reason when it accepted. Returns the answer unchanged. */
	async #ask<T extends { started?: boolean; reason?: string }>(p: Promise<T>): Promise<T> {
		const res = await p;
		this.refusal = res.started === false ? (res.reason ?? null) : null;
		return res;
	}

	/** Starts a run for the keys, by default the ticked apps. Does nothing with no keys or while a start is in flight; a rejected request is swallowed and the run's events tell the story. */
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

	/**
	 * Install now anyway: installs one app whose release is still settling, the wait in Settings set aside for it. Starts
	 * a run, or joins the one under way, as a tick would.
	 */
	async installNow(key: string): Promise<void> {
		const bridge = this.#bridge;
		if (!bridge || this.starting) return;
		this.starting = true;
		try {
			await this.#ask(bridge.request("install", { keys: [key], now: true }));
		} catch {
			// The row stays as it was; the refusal, if any, is shown by #ask.
		} finally {
			this.starting = false;
		}
	}

	/** Asks for one app to join the run under way. Not held by `starting`, so a second quick tick is never dropped. */
	async #join(key: string): Promise<void> {
		const bridge = this.#bridge;
		if (!bridge) return;
		try {
			await this.#ask(bridge.request("install", { keys: [key] }));
		} catch {
			// The row stays Ready; the refusal, if any, is shown by #ask.
		}
	}

	/** Starts a run for the apps that did not update last time. */
	retry(): Promise<void> {
		return this.install(this.failedKeys);
	}

	/** Asks for a check, and the system list as well when that group is on. A refused check leaves the last refusal showing. */
	async check(): Promise<void> {
		// The system list checks beside the apps; nothing waits on it.
		if (this.extras?.settings.system === "show") void this.send("systemCheck", {});
		// A check that did not start (a run or a check already going) leaves what the last refusal said.
		if ((await this.send("check", {}))?.started) this.refusal = null;
	}

	/**
	 * Turning the group on shows it at once in its checking state; turning it off removes it. Switching installing
	 * on or off keeps the list as it is: which rows can be installed comes from the main process's event.
	 */
	async setExtras(patch: Partial<ExtrasSettings>): Promise<void> {
		const settings = await this.send("setExtras", patch);
		if (!settings) return;
		if (this.extras && patch.system === undefined) {
			this.extras = { ...this.extras, settings };
			return;
		}
		const system = this.extras?.system;
		const on = settings.system === "show";
		this.extras = {
			settings,
			cleanup: this.extras?.cleanup ?? { phase: "off", items: [], measuredAt: null, last: null },
			system: {
				mode: settings.system,
				phase: on ? (system?.phase === "idle" && system.mode === "show" ? "idle" : "checking") : "off",
				rows: on ? (system?.rows ?? []) : [],
				checkedAt: on ? (system?.checkedAt ?? null) : null,
				problem: on ? (system?.problem ?? null) : null,
				glMissing: on ? (system?.glMissing ?? null) : null,
				packages: on ? (system?.packages ?? null) : null,
			},
		};
	}

	/** Ends the run now: the engine cuts or waits out the current step and puts the app back. */
	async stopNow(): Promise<void> {
		await this.send("stopNow", {});
	}

	/** Asks the engine to stop after the app now running; nothing waits on the answer. */
	async stopAfterCurrent(): Promise<void> {
		await this.send("stopAfterCurrent", {});
	}

	/** Clears the run summary on the engine's side. */
	async dismiss(): Promise<void> {
		await this.send("dismissSummary", {});
	}

	/** Loads the newest 200 history rows; a failed request leaves the rows already shown. */
	async loadHistory(): Promise<void> {
		const rows = await this.send("history", { limit: 200 });
		if (rows) this.history = rows;
	}

	/** Sends a title-bar op, from a button or a shortcut. Close and minimize mark the buttons cold (see buttonsCold). */
	windowOp(op: WindowButton): void {
		if (op !== "maximize") this.buttonsCold = true;
		void this.send("window", { op });
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
