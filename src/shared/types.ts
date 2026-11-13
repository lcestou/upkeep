import type { LanguageSetting } from "./languages";

export type AppKind =
	| "appimage" // one AppImage file from a GitHub release
	| "archive" // one or more binaries inside a release tar.gz or zip
	| "file" // a single binary that is itself the release asset
	| "deb" // a .deb from a GitHub release, installed with dpkg
	| "rpm" // an .rpm from a GitHub release, installed with rpm -U
	| "source" // built from a git checkout or a clone of the release tag, with the steps in its table
	| "command" // a tool that updates itself with its own command
	| "claude-plugins" // every plugin in Claude Code's registry, through claude plugin update
	| "manual"; // tracked only; the owner runs the update

/** One table in apps.toml. Paths may start with ~/. */
export type AppSpec = {
	key: string;
	name: string;
	kind: AppKind;
	/**
	 * Where the releases are: owner/name on GitHub, or host/owner/name on GitLab (gitlab.com/group/sub/name), Codeberg
	 * or a self-hosted forge. Required for archive, file, deb and rpm unless latest is a links: page.
	 */
	repo?: string;
	/** The forge a repo on a host Upkeep does not know runs: GitLab, or Gitea and Forgejo. */
	forge?: "gitlab" | "gitea";
	/** Regular expression matched against release asset names, on an x86_64 machine. */
	asset?: string;
	/** The same pattern for an aarch64 machine. A release kind with none is not offered or checked there. */
	asset_aarch64?: string;
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
	/**
	 * command: where the latest version comes from: "npm:<pkg>", "npm-tags:<pkg>", "pypi:<pkg>", "crates:<crate>",
	 * "github:<owner>/<repo>" or "json:<url>". A release kind may take "links:<https page>", whose links matching asset are
	 * its downloads.
	 */
	latest?: string;
	/** command: argv that performs the update. */
	update?: string[];
	/** A command app: puts {version} (and {tag}) back, e.g. ["npm", "i", "-g", "pkg@{version}"]; it makes a restore point possible. */
	restore?: string[];
	/** claude-plugins: no version to show. Always "fresh", never counted as an update, runs in every background run when auto is set, and has "Run now" on its row. */
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
	/** False for a source build with no dir or stage, a command with no restore argv, Claude Code's plugins and a manual app. */
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
	/**
	 * "restored", "cleaned" and "skipped" appear only in history: the owner put a restore point back by hand, Cleanup
	 * deleted something, or Cleanup left an item alone on purpose (changed since review, no sudo, polkit said no).
	 */
	result: "updated" | "failed" | "rolled_back" | "restored" | "cleaned" | "skipped";
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
	/** The window's and the tray's language. "system" follows the desktop's; a code from LANGUAGES is the person's pick. */
	language: LanguageSetting;
	/** Upkeep installs its own new version while it sits in the tray, and restarts. Off: it tells the person and waits. */
	selfAuto: boolean;
	/** An `upkeep` command in ~/.local/bin that runs this install's command line. Off: no such file from Upkeep. */
	upkeepCommand: boolean;
};

/**
 * Where Upkeep's own update stands. "ready" means downloaded, verified and started once as a test: only a restart is
 * left. "failed" changed nothing; "rolled-back" means the start script put the version before back.
 */
export type SelfState =
	| { phase: "none" }
	| { phase: "available"; from: string; version: string }
	| { phase: "preparing"; from: string; version: string }
	| { phase: "ready"; from: string; version: string }
	| { phase: "restarting"; from: string; version: string }
	| { phase: "failed"; from: string; version: string; why: string }
	| { phase: "rolled-back"; from: string; version: string }
	| { phase: "updated"; from: string; version: string };

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
	/** A Cleanup row (key "cleanup:<id>"): the bytes it freed. */
	freed?: number;
};

export type LogLine = { at: string; key: string | null; text: string };

/** Opt-in areas beside the app list. Kept in extras.json, apart from state.json. */
export type ExtrasSettings = {
	/** "off": nothing runs. "show": list the system's own updates. */
	system: "off" | "show";
	/** True only while system is "show", and absent when off: the person may tick system rows and install them from Upkeep. */
	systemInstall?: boolean;
	/** True shows the Cleanup tab; absent when off. */
	cleanup?: boolean;
	/** True only while cleanup is on: the uv, bun, npm and pip download caches join Cleanup's list. */
	devCaches?: boolean;
};

/** Every candidate Cleanup knows. Hugging Face's models are never one: they are hours of downloads, not a cache. */
export type CleanupId =
	| "thumbnails"
	| "trash"
	| "leftovers"
	| "restore-points"
	| "apt-cache"
	| "flatpak-gl"
	| "autoremove"
	| "uv"
	| "bun"
	| "npm"
	| "pip"
	| "tmp"
	| "journal"
	| "kernels"
	| "timeshift"
	| "browser"
	| "playwright"
	| "hand-backups"
	| "upkeep-cache";

/** One thing Cleanup can delete on its own: a folder's contents, a leftover copy, a restore point, a runtime, a cache. */
export type CleanupPart = {
	id: string;
	/** A path, a restore point's app and version, a runtime's name or the packages: data, never a sentence. */
	label: string;
	/** What deleting it frees: the bytes of files with no other hard link. */
	bytes: number;
	ticked: boolean;
	/** newer-copy: a leftover copy newer than the installed file, so it starts unticked. */
	note?: "newer-copy";
};

export type CleanupItem = {
	id: CleanupId;
	/** safe is ticked by default; choice starts unticked; shown is measured and never deleted by Upkeep. */
	group: "safe" | "choice" | "shown";
	/** Bytes deleting it would free; null when it cannot be measured without root (packages, kernels, snapshots). */
	bytes: number | null;
	parts: CleanupPart[];
	/** Runs a command as administrator. */
	root: boolean;
	undo: "regrows" | "redownload" | "none";
	/** Package removal: the person types a word before it runs. */
	typeToConfirm: boolean;
	/** Facts a shown item's sentence names: the running and newest kernel, or how many snapshots and the newest. */
	info?: { running?: string; newest?: string; count?: number };
};

/** What Cleanup should delete: an item and the parts of it that are ticked. */
export type CleanupPick = { id: CleanupId; partIds: string[] };

/** One picked item in a cleanup run: waiting, being deleted, or its result. detail is a MESSAGES sentence. */
export type CleanupOutcome = {
	id: CleanupId;
	status: "queued" | "working" | "done" | "skipped" | "failed";
	/** Bytes freed, measured before and after. */
	freed: number;
	detail?: string;
};

/** The last cleanup: refused before anything ran (refused set, outcomes empty), running, or finished. */
export type CleanupRun = { at: string; outcomes: CleanupOutcome[]; refused: string | null };

export type CleanupState = {
	phase: "off" | "measuring" | "idle" | "cleaning";
	/** In the order the tab lists them; while measuring, the ones measured so far. */
	items: CleanupItem[];
	measuredAt: string | null;
	last: CleanupRun | null;
};

/** One pending update from the system's own lists. Upkeep installs one only when its id is in SystemState.installable. */
export type SystemRow = {
	/** "<source>:<package>", "flatpak:<ref>", "cinnamon:<spice type>:<uuid>" or "snap:<name>". */
	id: string;
	/** apt for Linux Mint's Update Manager and for apt; dnf; pacman; zypper; flatpak; cinnamon for Cinnamon's spices; snap. */
	source: "apt" | "dnf" | "pacman" | "zypper" | "flatpak" | "cinnamon" | "snap";
	name: string;
	type:
		| "security"
		| "package"
		| "kernel"
		| "driver"
		| "app"
		| "runtime"
		| "applet"
		| "desklet"
		| "extension"
		| "theme"
		| "snap";
	installed: string | null;
	latest: string;
	/** A Flatpak app with a process running now. */
	running: boolean;
	/** Kernel and driver rows: Update Manager is the place to install them. */
	note?: "update-manager-only";
};

/** One ticked row in a System install: waiting its turn, running, or its result. detail is a MESSAGES sentence. */
export type SystemOutcome = {
	id: string;
	name: string;
	from: string | null;
	to: string;
	status: "queued" | "working" | "done" | "failed";
	detail?: string;
};

/** The last System install: refused before anything ran (refused set, outcomes empty), running, or finished. */
export type SystemInstall = {
	at: string;
	/** The commands it ran or would have run, each as its literal argv. */
	commands: string[][];
	outcomes: SystemOutcome[];
	/** Why nothing ran, as a MESSAGES sentence; null once it started. */
	refused: string | null;
};

export type SystemState = {
	mode: ExtrasSettings["system"];
	phase: "off" | "checking" | "idle" | "installing";
	rows: SystemRow[];
	checkedAt: string | null;
	/** Codes, never sentences: the view words them. */
	problem: { code: "missing"; command: string } | { code: "failed"; command: string; detail: string } | null;
	/** The NVIDIA driver version whose Flatpak GL runtime is missing, or null. */
	glMissing: string | null;
	/** Which package list answered: Linux Mint's Update Manager, apt, dnf, pacman or zypper; null when none is installed. */
	packages: "mint" | "apt" | "dnf" | "pacman" | "zypper" | null;
	/** Ids of the rows Upkeep can install, present only while installing is switched on. Never a kernel or driver row. */
	installable?: string[];
	/** The last System install since Upkeep started, if any. */
	install?: SystemInstall;
};

export type ExtrasSnapshot = { settings: ExtrasSettings; system: SystemState; cleanup: CleanupState };

export type EngineEvent =
	| { type: "app"; app: AppState }
	| { type: "run"; run: RunState }
	| { type: "log"; line: LogLine }
	| { type: "meta"; rate: Snapshot["rate"]; checkedAt: string | null; settings: Settings }
	| { type: "removed"; key: string }
	| { type: "chrome"; chrome: WindowChrome }
	| { type: "extras"; extras: ExtrasSnapshot }
	| { type: "self"; self: SelfState };

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
	open: {
		params: { what: "manifest" | "log" | "release" | "changelog" | "bug" | "repo" | "self-notes"; key?: string };
		response: { ok: boolean };
	};
	copy: { params: { text: string }; response: { ok: boolean } };
	chrome: { params: Record<string, never>; response: WindowChrome };
	/** Asks for a folder and writes the settings and app list there as one file. Cancelled: ok false with no problem. */
	exportSetup: { params: Record<string, never>; response: { ok: boolean; file?: string; problem?: string } };
	/** Asks for an export file and replaces the settings and app list from it, then checks again. Refused during a run. */
	importSetup: { params: Record<string, never>; response: { ok: boolean; apps?: number; problems?: string[] } };
	/** The desktop's languages, most preferred first, as the main process reads them from its environment; the tray uses the same list. */
	languages: { params: Record<string, never>; response: string[] };
	window: { params: { op: WindowButton }; response: { ok: boolean } };
	suggest: { params: { input: string; asset?: string }; response: { suggestions: Suggestion[]; problem?: string } };
	scan: { params: Record<string, never>; response: { suggestions: Suggestion[] } };
	addApps: { params: { specs: AppSpec[] }; response: { added: string[]; problems: { key: string; detail: string }[] } };
	removeApp: { params: { key: string }; response: { ok: boolean; detail?: string } };
	restartApp: { params: { key: string }; response: { ok: boolean; detail?: string } };
	pickFile: { params: Record<string, never>; response: { path: string | null } };
	extras: { params: Record<string, never>; response: ExtrasSnapshot };
	/** Where Upkeep's own update stands. Changes come as self events. */
	self: { params: Record<string, never>; response: SelfState };
	/** Downloads, verifies and test-starts the offered version of Upkeep. Nothing the running one uses is changed. */
	selfUpdate: { params: Record<string, never>; response: { ok: boolean } };
	/** Swaps the tested version in and restarts Upkeep. Refused while anything is running. */
	selfRestart: { params: Record<string, never>; response: { ok: boolean } };
	/** Takes a finished self-update notice off the list. */
	selfDismiss: { params: Record<string, never>; response: { ok: boolean } };
	setExtras: { params: Partial<ExtrasSettings>; response: ExtrasSettings };
	systemCheck: { params: Record<string, never>; response: { started: boolean } };
	openTool: { params: { what: "update-manager" }; response: { ok: boolean } };
	/** The commands a System install of these rows would run, each as its literal argv; nothing runs. */
	systemPlan: { params: { ids: string[] }; response: { commands: string[][]; reason?: string } };
	/** Installs the rows, refused unless commands still equals what systemPlan answers now. Progress comes as extras events. */
	systemInstall: { params: { ids: string[]; commands: string[][] }; response: { started: boolean; reason?: string } };
	/** Measures every candidate again; the sizes come as extras events. */
	cleanupMeasure: { params: Record<string, never>; response: { started: boolean } };
	/** What deleting these picks would free and the commands it would run, each as its literal argv; nothing runs. */
	cleanupReview: {
		params: { picks: CleanupPick[] };
		response: { bytes: number; commands: string[][]; reason?: string };
	};
	/** Deletes the picks, refused unless commands still equals what cleanupReview answers now. Progress comes as extras events. */
	cleanupRun: {
		params: { picks: CleanupPick[]; commands: string[][]; typed?: string };
		response: { started: boolean; reason?: string };
	};
};

/** One answer per request, each taking that request's params: the main process's and the fixture's. */
export type RequestHandlers = {
	[K in keyof Requests]: (p: Requests[K]["params"]) => Requests[K]["response"] | Promise<Requests[K]["response"]>;
};

/** The surface the view programs against. The Electrobun bridge and the dev fixture both implement it. */
export type Bridge = {
	request<K extends keyof Requests>(name: K, params: Requests[K]["params"]): Promise<Requests[K]["response"]>;
	onEvent(listener: (event: EngineEvent) => void): () => void;
};
