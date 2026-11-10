export type AppKind =
	| "appimage" // one AppImage file from a GitHub release
	| "archive" // one or more binaries inside a release tar.gz or zip
	| "file" // a single binary that is itself the release asset
	| "deb" // a .deb from a GitHub release, installed with dpkg
	| "source" // cloned at the release tag and built
	| "command" // a tool that updates itself with its own command
	| "legacy" // delegated to the old lutechi-updater script
	| "manual"; // tracked only; the owner runs the update

/** One table in apps.toml. Paths may start with ~/. */
export type AppSpec = {
	key: string;
	name: string;
	kind: AppKind;
	/** owner/repo on GitHub. Required for appimage, archive, file, deb, source. */
	repo?: string;
	/** Regular expression matched against release asset names. */
	asset?: string;
	/** The installed file the version probe runs. */
	dest?: string;
	/** archive: paths inside the archive; each installs into dest's directory under its base name. */
	bins?: string[];
	/** Arguments after dest for the version probe. Default ["--version"]. */
	version_args?: string[];
	/** appimage: a metainfo or .desktop path inside the image, read instead of running a probe. */
	meta_path?: string;
	/** Install with sudo. */
	sudo?: boolean;
	/** source: shell steps run in the clone, in order. */
	build?: string[];
	/** command: argv that prints the installed version. */
	check?: string[];
	/** command: where the latest version comes from: "npm:<pkg>", "pypi:<pkg>" or "github:<owner>/<repo>". */
	latest?: string;
	/** command: argv that performs the update. */
	update?: string[];
	/** legacy and manual: the name the old script prints in --check for this app. */
	legacy_name?: string;
	/** legacy: the argument the old script takes for this app. */
	legacy_key?: string;
	/** legacy: true when the old script prints no --check line and the app checks itself when run.
	 * Such an app is always "fresh" in the list, is never counted as an update, runs in every
	 * background run when auto is set, and can be run from its row with "Run now". */
	versionless?: boolean;
	/** manual: the command the owner runs. */
	run?: string;
	/** Exact process name for the running check when the path match cannot see it. */
	process?: string;
	/** The background run installs this app without asking. */
	auto?: boolean;
	/** One line shown in the row's details. */
	note?: string;
	/** List the app as ready to install when nothing is at dest yet. Set when the owner adds an app that is not installed. */
	install_if_missing?: boolean;
};

/** One app Upkeep proposes to add, with everything needed to add it in one press. */
export type Suggestion = {
	/** The table that would be written to apps.toml. */
	spec: AppSpec;
	/** The version found on disk, when the app is already installed. */
	installed: string | null;
	latest: string | null;
	/** The release asset the spec's pattern matches today. */
	asset: { name: string; size: number } | null;
	/** Other assets of that release that would also run on this machine, by name, for a picker. */
	alternatives: string[];
	source: "repo" | "file" | "scan";
	/** The file found on disk, for file and scan suggestions. */
	path?: string;
	/** "sure" when the file or the release names its source; "guess" when the repo came from a name search. */
	confidence: "sure" | "guess";
	/** One sentence on how this was worked out. */
	why: string;
	/** Set when the suggestion cannot be added as it stands. */
	problem?: string;
};

export type Stage = "download" | "backup" | "install" | "verify";

export type AppStatus =
	| "checking" // no result yet
	| "fresh" // installed equals latest
	| "ready" // an update is available and can be installed here
	| "manual" // an update is available and the owner runs it
	| "held" // the owner is holding this app or skipping this version
	| "problem" // could not be checked
	| "queued" // ticked, waiting its turn in a run
	| "working" // being installed now
	| "done" // updated in this run
	| "failed" // this run could not update it; nothing was changed or the change was undone
	| "rolled_back"; // installed, would not start, previous copy restored

export type RestorePoint = { version: string; at: string };

export type AppState = {
	key: string;
	name: string;
	kind: AppKind;
	repo?: string;
	installed: string | null;
	latest: string | null;
	status: AppStatus;
	/** A sentence for problem, failed and rolled_back, and for a passed row that needs a note. */
	detail?: string;
	/** Bytes of the release asset, when known. */
	size?: number;
	/** Release notes body, plain text. */
	notes?: string;
	releaseUrl?: string;
	publishedAt?: string;
	/** The app has a live process right now. */
	running: boolean;
	/** Set after a run replaced a running app. */
	restartToApply: boolean;
	/** Newest first. Empty when none. */
	restorePoints: RestorePoint[];
	/** False for deb, source, command, legacy and manual. */
	canRestore: boolean;
	auto: boolean;
	sudo: boolean;
	versionless: boolean;
	/** manual: the command to run. */
	run?: string;
	note?: string;
	dest?: string;
	/** The stages this app's install walks, with widths that sum to 100. */
	stages: { id: Stage; weight: number }[];
	/** While working: the stage in progress and its percent, 0 to 100, or null when it cannot be measured. */
	stage?: Stage;
	stagePct?: number | null;
	/** The version a skip is set for, when status is held because of a skip. */
	skipped?: string;
	held: boolean;
};

export type RunPhase = "idle" | "checking" | "installing" | "summary";

export type RunResult = {
	key: string;
	name: string;
	from: string | null;
	to: string | null;
	/** "restored" appears only in history: the owner put a restore point back by hand. */
	result: "updated" | "failed" | "rolled_back" | "restored";
	detail?: string;
	ms: number;
};

export type RunState = {
	id: string | null;
	phase: RunPhase;
	/** checking: apps checked so far and in all. installing: position in the queue and its length. */
	index: number;
	total: number;
	currentKey: string | null;
	stopping: boolean;
	results: RunResult[];
	/** This run was started from a summary to try the failed apps again. */
	retry: boolean;
};

export type Settings = {
	keepBackups: number;
	notify: boolean;
	checkAtLogin: boolean;
	/** "own": Upkeep draws its title bar inside its header. "system": the desktop's window frame. */
	frame: "own" | "system";
	/** Which side the window buttons sit on when the frame is Upkeep's own. "auto" follows the desktop. */
	buttons: "auto" | "left" | "right";
	/** The window's corners when the frame is Upkeep's own. A rounded window is see-through outside its corners, and the desktop draws no shadow under it. */
	corners: "rounded" | "square";
};

export type WindowButton = "close" | "minimize" | "maximize";

/** How the window is dressed right now. Answered by the main process, not the engine. */
export type WindowChrome = {
	/** True when Upkeep draws its own title bar and window buttons. */
	own: boolean;
	side: "left" | "right";
	/** The buttons to draw on that side, left to right. */
	order: WindowButton[];
	maximized: boolean;
	/** True when the window was built see-through so the view can round its own corners. Never true with the desktop's frame. */
	rounded: boolean;
};

export type Snapshot = {
	apps: AppState[];
	run: RunState;
	settings: Settings;
	/** GitHub API budget after the last check. */
	rate: { limit: number; remaining: number } | null;
	checkedAt: string | null;
	version: string;
};

export type HistoryRow = RunResult & {
	runId: string;
	at: string;
	stages: Partial<Record<Stage, number>>;
	retry?: boolean;
};

export type LogLine = { at: string; key: string | null; text: string };

export type EngineEvent =
	| { type: "app"; app: AppState }
	| { type: "run"; run: RunState }
	| { type: "log"; line: LogLine }
	| { type: "meta"; rate: Snapshot["rate"]; checkedAt: string | null; settings: Settings }
	| { type: "removed"; key: string }
	| { type: "chrome"; chrome: WindowChrome };

/** What the view can ask of the main process. */
export type Requests = {
	snapshot: { params: Record<string, never>; response: Snapshot };
	check: { params: { keys?: string[] }; response: { started: boolean } };
	install: { params: { keys: string[] }; response: { started: boolean; reason?: string } };
	stopAfterCurrent: { params: Record<string, never>; response: { stopping: boolean } };
	dismissSummary: { params: Record<string, never>; response: { ok: boolean } };
	restore: { params: { key: string; version: string }; response: { ok: boolean; detail?: string } };
	setSkip: { params: { key: string; version: string | null }; response: { ok: boolean } };
	setHold: { params: { key: string; held: boolean }; response: { ok: boolean } };
	setAuto: { params: { key: string; auto: boolean }; response: { ok: boolean } };
	setSettings: { params: Partial<Settings>; response: Settings };
	history: { params: { limit: number }; response: HistoryRow[] };
	runLog: { params: { runId: string }; response: LogLine[] };
	open: { params: { what: "manifest" | "log" | "release"; key?: string }; response: { ok: boolean } };
	copy: { params: { text: string }; response: { ok: boolean } };
	chrome: { params: Record<string, never>; response: WindowChrome };
	window: { params: { op: WindowButton }; response: { ok: boolean } };
	suggest: { params: { input: string; asset?: string }; response: { suggestions: Suggestion[]; problem?: string } };
	scan: { params: Record<string, never>; response: { suggestions: Suggestion[] } };
	addApps: { params: { specs: AppSpec[] }; response: { added: string[]; problems: { key: string; detail: string }[] } };
	removeApp: { params: { key: string }; response: { ok: boolean; detail?: string } };
	pickFile: { params: Record<string, never>; response: { path: string | null } };
};

/** The surface the view programs against. The Electrobun bridge and the dev fixture both implement it. */
export type Bridge = {
	request<K extends keyof Requests>(name: K, params: Requests[K]["params"]): Promise<Requests[K]["response"]>;
	onEvent(listener: (event: EngineEvent) => void): () => void;
};
