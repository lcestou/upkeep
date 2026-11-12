export type AppKind =
	| "appimage" // one AppImage file from a GitHub release
	| "archive" // one or more binaries inside a release tar.gz or zip
	| "file" // a single binary that is itself the release asset
	| "deb" // a .deb from a GitHub release, installed with dpkg
	| "source" // built from a git checkout or a clone of the release tag, with the steps in its table
	| "command" // a tool that updates itself with its own command
	| "claude-plugins" // every plugin in Claude Code's registry, through claude plugin update
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
	/** source: shell steps run in dir (or the clone, or stage), in order. {dir}, {stage}, {tag}, {version} and {needs} are filled in. */
	build?: string[];
	/** command: argv that prints the installed version. */
	check?: string[];
	/** command: where the latest version comes from: "npm:<pkg>", "pypi:<pkg>" or "github:<owner>/<repo>". */
	latest?: string;
	/** command: argv that performs the update. */
	update?: string[];
	/** A command app: puts {version} (and {tag}) back, e.g. ["npm", "i", "-g", "pkg@{version}"]; it makes a restore point possible. */
	restore?: string[];
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
	/** argv that restarts the app, offered as Restart now once an update waits on a restart, e.g. ["systemctl", "restart", "rustdesk"] for a service. */
	restart?: string[];
	/** A desktop app Upkeep may close and open again from dest to finish an update. Needs process, which names what to close. */
	relaunch?: boolean;
	/** The background run installs this app without asking. */
	auto?: boolean;
	/** One line shown in the row's details. */
	note?: string;
	/** List the app as ready to install when nothing is at dest yet. Set when the owner adds an app that is not installed. */
	install_if_missing?: boolean;
	// The source fields below are all optional and read only when kind is "source".
	/** An existing git checkout, updated in place to the release tag. Without it the tag is cloned into the cache, as today. */
	dir?: string;
	/** How dir moves to the release tag. "ff": fast-forward its branch. "reset": hard reset, refused when HEAD is on no remote ref. "detach": check the tag out detached. Default "ff". */
	move?: "ff" | "reset" | "detach";
	/** argv printing the commit the installed copy was built from. When set, the row is ready when the release tag is ahead of it on GitHub, and the pane lists the newest commits. Needs repo. */
	commit?: string[];
	/** A directory the build writes into beside the live copy. {tag} and {version} are filled in. Steps see it as {stage}. */
	stage?: string;
	/** argv printing, one per line, the directories the installed copy needs at run time. Run before the build (its first line is {needs} in steps) and again after verify (what is live). Kept while a restore point names them. */
	needs?: string[];
	/** Globs of build directories that may be deleted after a verified update: never what needs prints after verify, never what a kept point names. Directories only. */
	prune?: string[];
	/** Paths in dir (globs allowed) saved in the restore point before the build and put back on a rollback, by rename, never by copying over a live path. A symlink is kept as a link. */
	keep?: string[];
	/** Directories a running process executes from that the build rewrites. Before the build each is renamed to <path>.upkeep-live and copied back, so the running process keeps its open files. Anything it starts or imports later reads the new tree. */
	hold?: string[];
	/** Command output saved in the restore point as {point}/<file>. Runs after the fetch and before the build, so {tag} is fetched. */
	record?: { file: string; run: string[] }[];
	/** Shell steps run in dir on a rollback, after the files are back. {point} is the restore point's directory. */
	undo?: string[];
	/** Shell steps that must exit 0 after the build, before anything in serve is stopped. */
	check_built?: string[];
	/** Values written into JSON config files after the build: key (top level), or array plus flag (the value after flag in that array). Symlinks are skipped. */
	config?: { file: string; key?: string; array?: string; flag?: string; value: string | number | boolean }[];
	/** Files or directories moved into place while serve is stopped. The replaced one goes into the restore point. */
	place?: { from: string; to: string }[];
	/** What must not be happening for the update to go ahead. Checked before and after pause; when "stopped", after serve stops. */
	busy?: { process?: string; run?: string[]; say: string; when?: "stopped" }[];
	/** Units held off for the whole update, each only when it was running. No start means stop only (a oneshot run in progress). */
	pause?: Service[];
	/** Services the update stops and starts, each only when it was running. */
	serve?: Serve[];
	/** Tests run after serve is back, or after the build when nothing in serve was running (url tests are then skipped). */
	test?: Test[];
};

/** since: argv whose output must differ after the start from before the stop, proving a new process. */
export type Service = { name: string; active: string[]; stop: string[]; start?: string[]; since?: string[] };
/** health: polled every 2 s until it answers status (default 200) with expect in the body, within wait_s (default 120). */
export type Serve = Service & {
	start: string[];
	health?: string;
	status?: number;
	expect?: string;
	wait_s?: number;
	test?: Test[];
};
/** A command (run) or an HTTP POST (url plus body). Fails on a non-zero exit or status, a missing expect, or a fail_on match. required false only logs. */
export type Test = {
	name?: string;
	run?: string[];
	url?: string;
	body?: string;
	expect?: string;
	fail_on?: string;
	timeout_s?: number;
	required?: boolean;
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
	source: "repo" | "file" | "scan" | "catalogue";
	/** The file found on disk, for file and scan suggestions. */
	path?: string;
	/** "sure" when the file or the release names its source; "guess" when the repo came from a name search. */
	confidence: "sure" | "guess";
	/** One sentence on how this was worked out. */
	why: string;
	/** Set when the suggestion cannot be added as it stands. */
	problem?: string;
};

export type Stage = "download" | "backup" | "build" | "install" | "verify";

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
	/** The newest commits up to the release tag, newest first, at most 30 and never more than ahead. */
	commits?: { sha: string; title: string }[];
	/** How many commits the release is ahead of the installed build. */
	ahead?: number;
	/** The app has a live process right now. */
	running: boolean;
	/** Set after a run replaced a running app. */
	restartToApply: boolean;
	/** Newest first. Empty when none. */
	restorePoints: RestorePoint[];
	/** False for deb, source, command, legacy and manual. */
	canRestore: boolean;
	/** The table says how to restart it (restart or relaunch), so a waiting restart offers Restart now. */
	canRestart?: boolean;
	/** relaunch: Restart now closes the app's windows, so it asks first. */
	closes?: boolean;
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
	/** installing and summary: the run's apps in the order they run, apps added during the run included. */
	queue?: string[];
};

export type Settings = {
	keepBackups: number;
	notify: boolean;
	checkAtLogin: boolean;
	/** How often Upkeep checks on its own while it runs, in the window or the tray. */
	checkEvery: "6h" | "daily" | "ask";
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

/** Opt-in areas beside the app list. Kept in extras.json, apart from state.json. */
export type ExtrasSettings = {
	/** "off": nothing runs. "show": list the system's own updates, read-only. */
	system: "off" | "show";
};

/** One pending update from Update Manager's list or from Flatpak. Read-only: Upkeep never installs these. */
export type SystemRow = {
	/** "apt:<source>" or "flatpak:<ref>". */
	id: string;
	source: "apt" | "flatpak";
	name: string;
	type: "security" | "package" | "kernel" | "driver" | "app" | "runtime";
	installed: string | null;
	latest: string;
	/** A Flatpak app with a process running now. */
	running: boolean;
	/** Kernel and driver rows: Update Manager is the place to install them. */
	note?: "update-manager-only";
};

export type SystemState = {
	mode: ExtrasSettings["system"];
	phase: "off" | "checking" | "idle";
	rows: SystemRow[];
	checkedAt: string | null;
	/** Codes, never sentences: the view words them. */
	problem: { code: "missing"; command: string } | { code: "failed"; command: string; detail: string } | null;
	/** The NVIDIA driver version whose Flatpak GL runtime is missing, or null. */
	glMissing: string | null;
};

export type ExtrasSnapshot = { settings: ExtrasSettings; system: SystemState };

export type EngineEvent =
	| { type: "app"; app: AppState }
	| { type: "run"; run: RunState }
	| { type: "log"; line: LogLine }
	| { type: "meta"; rate: Snapshot["rate"]; checkedAt: string | null; settings: Settings }
	| { type: "removed"; key: string }
	| { type: "chrome"; chrome: WindowChrome }
	| { type: "extras"; extras: ExtrasSnapshot };

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
	restartApp: { params: { key: string }; response: { ok: boolean; detail?: string } };
	pickFile: { params: Record<string, never>; response: { path: string | null } };
	extras: { params: Record<string, never>; response: ExtrasSnapshot };
	setExtras: { params: Partial<ExtrasSettings>; response: ExtrasSettings };
	systemCheck: { params: Record<string, never>; response: { started: boolean } };
	openTool: { params: { what: "update-manager" }; response: { ok: boolean } };
};

/** The surface the view programs against. The Electrobun bridge and the dev fixture both implement it. */
export type Bridge = {
	request<K extends keyof Requests>(name: K, params: Requests[K]["params"]): Promise<Requests[K]["response"]>;
	onEvent(listener: (event: EngineEvent) => void): () => void;
};
