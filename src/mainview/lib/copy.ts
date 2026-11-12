// Every string a person reads, pasted from the plan's copy table (F5).
import type {
	AppKind,
	AppState,
	RunResult,
	RunState,
	Settings,
	Stage,
	SystemRow,
	SystemState,
} from "../../shared/types";
import { formatBytes, plural } from "./format";

export const KIND_LABEL = {
	appimage: "AppImage",
	archive: "Binary",
	file: "Binary",
	deb: ".deb",
	source: "Source build",
	command: "Updates itself",
	legacy: "Updater script",
	manual: "By hand",
} satisfies Record<AppKind, string>;

export const STAGE_NAME = {
	download: "Download",
	backup: "Back up",
	build: "Build",
	install: "Install",
	verify: "Verify",
} satisfies Record<Stage, string>;

export type GroupId = "run" | "restart" | "ready" | "manual" | "problem" | "held" | "checking" | "fresh";

export const GROUP_LABEL = {
	ready: "Ready to install",
	installing: "Installing",
	thisRun: "This run",
	restart: "Restart to finish",
	manual: "By hand",
	problem: "Needs a look",
	held: "Held back",
	checking: "Checking",
	fresh: "Fresh",
} satisfies Record<Exclude<GroupId, "run"> | "installing" | "thisRun", string>;

export const COLUMN = {
	app: "App",
	kind: "Kind",
	version: "Version",
	size: "Size",
	restore: "Restore point",
	status: "Status",
} as const;

export const CHIP = {
	running: { text: "In use", title: "In use now. The update applies when you restart it." },
	runningLegacy: { text: "In use", title: "In use now. Updating closes it and opens it again." },
	root: { text: "Root", title: "Installs with sudo." },
	auto: { text: "Auto", title: "Installed without asking when Upkeep checks in the background." },
} as const;

export const TEXT = {
	updates: "Updates",
	history: "History",
	settings: "Settings",
	check: "Check again",
	selectAll: "Select all",
	selectNone: "Select none",
	nothingSelected: "Nothing selected",
	stop: "Stop after this one",
	done: "Done",
	none: "None",
	noneYet: "none yet",
	versionless: "checks itself when run",
	runNow: "Run now",
	whatChanged: "What changed",
	noNotes: "No release notes.",
	installedAt: "Installed at",
	source: "Source",
	restorePoints: "Restore points",
	holdUpdates: "Hold updates",
	releaseHold: "Release hold",
	openRelease: "Open release page",
	installAuto: "Install automatically",
	runItYourself: "Run it yourself:",
	copy: "Copy",
	copied: "Copied",
	log: "Show log",
	logTitle: "Log",
	hideLog: "Hide log",
	backToList: "Back to list",
	retry: "Retry",
	filter: "Filter apps",
	clearFilter: "Clear filter",
	sizesUnknown: "Some sizes are not known until they download.",
	whyTick: "Tick an update to install.",
	whyChecking: "Wait for the check to finish.",
	whyNothing: "Nothing to install.",
	openLog: "Open log file",
	noLog: "No log lines yet.",
	noRuns: "No runs yet.",
	updated: "Updated",
	failed: "Failed",
	rolledBack: "Rolled back",
	restored: "Restored",
	notify: "Notify when updates are ready",
	startAtLogin: "Start at login",
	startAtLoginHint: "Opens in the tray and checks for updates.",
	keepBackups: "Restore points to keep",
	checkEvery: "Check for updates",
	appList: "App list",
	openManifest: "Open apps.toml",
} as const;

/** Button text for a restore point; the version is the one it restores to. */
export const restoreLabel = (v: string) => `Restore ${v}`;
/** Button text that skips one version without holding the app. */
export const skipLabel = (v: string) => `Skip ${v}`;
/** Button text that undoes a skip of that version. */
export const stopSkipLabel = (v: string) => `Stop skipping ${v}`;
/** The release line in the pane; relative is already a phrase such as "3 days ago". */
export const releasedLabel = (relative: string) => `Released ${relative}`;
/** Tooltip over the checked time; relative is already a phrase such as "2 hours ago". */
export const checkedTitle = (relative: string) => `Checked ${relative}`;
/** The note after a restore finishes. It ends with a full stop, unlike the button label. */
export const restoredText = (v: string) => `Restored ${v}.`;
/** Shown on the Stop button once pressed, while the running app finishes. */
export const stoppingLabel = (name: string) => `Stopping after ${name}`;
/** The Retry button when n apps failed; always reads "failed", even for a rolled-back app. */
export const retryLabel = (n: number) => `Retry ${n} failed`;
/** The rate-limit line in Settings. Counts requests, not apps. */
export const rateText = (remaining: number, limit: number) =>
	`GitHub requests left this hour: ${remaining} of ${limit}`;
/** The version shown in About, with no leading v. */
export const versionText = (v: string) => `Version ${v}`;

/** Install button text. Zero reads as the generic label, because the button is disabled then. */
export function installLabel(n: number): string {
	if (n === 0) return "Install updates";
	return n === 1 ? "Install 1 update" : `Install ${n} updates`;
}

/** partial: some ticked app has no known size, so the total is a floor. hidden: ticked apps the filter hides. */
export function selectionText(n: number, bytes: number | null, partial = false, hidden = 0): string {
	if (n === 0) return TEXT.nothingSelected;
	const size = bytes === null ? "" : ` · ${partial ? "at least " : ""}${formatBytes(bytes)}`;
	return `${n} selected${size}${hidden > 0 ? ` · ${hidden} hidden` : ""}`;
}

/** Why a kind keeps no restore point, said in the pane only. */
export const NO_RESTORE = {
	appimage: undefined,
	archive: undefined,
	file: undefined,
	manual: undefined,
	deb: undefined,
	source: "Built in a fresh clone, so there is no restore point.",
	command: "It updates itself, and its table has no restore command.",
	legacy: "Upkeep hands this one to lutechi-updater.",
} satisfies Record<AppKind, string | undefined>;

/** A row's version cell when nothing is installed, read in place of "to". */
export const notInstalledLine = (latest: string) => `Not installed. ${latest} is the latest.`;
/** Version cell text for an installed app. */
export const installedText = (v: string) => `Installed ${v}`;
/** The detail of a row whose last try failed; the fixture matches the text before the reason to clear it. */
export const lastTryFailed = (why: string) => `Last try failed. ${why}`;
/** The pane's heading over a built app's commits; from is the installed build's commit, when it is known. */
export const commitsHeading = (n: number, from: string | null) =>
	`${n} ${n === 1 ? "commit" : "commits"} since ${from ?? "the installed build"}`;
/** The line under a capped commits list. Text, not a link: the pane's release link already opens the project. */
export const moreCommits = (n: number, shown: number) => `All ${n} on GitHub (${n - shown} not shown)`;
/** The restart sentence over the list; names are joined with commas and never trimmed. */
export const restartLine = (names: string[]) => `Restart ${names.join(", ")} to finish.`;
/** How many apps are updated by hand; the number is not pluralised. */
export const byHandLine = (n: number) => `${n} more by hand`;
export const RUN_TEXT = {
	inProgress: "A run is in progress.",
	retry: "Retry",
	restartPending: "Restart pending",
} as const;
/** The all-fresh line. n is not pluralised, so a list of one reads "All 1 apps". */
export const allFreshLine = (n: number) => `All ${n} apps are up to date.`;
/** The list with no apps yet, as a new person first sees it. */
export const EMPTY_LINE =
	"Add the apps you want Upkeep to keep up to date: type a name such as fd, or paste a GitHub repo.";
/** The empty-filter message; the text is quoted exactly as typed after trimming by the caller. */
export const noMatch = (text: string) => `No app matches "${text}".`;

/** The text in a row's status cell. While working, the stem shows it beside the stem. */
export function statusText(app: AppState): string {
	switch (app.status) {
		case "checking":
			return "Checking";
		case "ready":
			return "Ready";
		case "fresh":
			return app.restartToApply ? `Restart ${app.name} to finish` : "Fresh";
		case "manual":
			return "By hand";
		case "held":
			return app.skipped ? `Skipping ${app.skipped}` : "Held";
		case "problem":
			return "Needs a look";
		case "queued":
			return "Queued";
		case "working":
			return workingText(app.stage, app.stagePct, app.size);
		case "done":
			return app.restartToApply ? `Restart ${app.name} to finish` : `Updated to ${app.installed ?? app.latest ?? ""}`;
		case "failed":
			return "Failed";
		case "rolled_back":
			return `Rolled back to ${app.installed ?? ""}`;
	}
}

/** "12.1 of 30 MB": the received part in the total's own unit, derived from the percent. */
function partOf(pct: number, total: number): string {
	const whole = formatBytes(total);
	const unit = whole.split(" ")[1] ?? "B";
	const scale = 1000 ** Math.max(0, ["B", "kB", "MB", "GB", "TB"].indexOf(unit));
	return `${((total * pct) / 100 / scale).toFixed(1)} of ${whole}`;
}

/** The status cell while an app works: the stage's verb, or for a download the percent, or the received part of the total when the size is known. */
export function workingText(stage: Stage | undefined, pct: number | null | undefined, size?: number): string {
	switch (stage) {
		case "backup":
			return "Backing up";
		case "build":
			return "Building";
		case "install":
			return "Installing";
		case "verify":
			return "Verifying";
		default:
			if (pct === null || pct === undefined) return "Downloading";
			return size !== undefined ? `Downloading ${partOf(pct, size)}` : `Downloading ${Math.round(pct)}%`;
	}
}

/** "3 updated, 1 failed": the summary sentence, also the heading count of a run in History. */
export function resultCounts(results: readonly { result: RunResult["result"] }[]): string {
	const ok = results.filter((r) => r.result === "updated").length;
	const failed = results.filter((r) => r.result === "failed" || r.result === "rolled_back").length;
	return failed === 0 ? `${ok} updated` : `${ok} updated, ${failed} failed`;
}

/** A History run's sentence; a retry says so first. */
export const runSentence = (rows: readonly { result: RunResult["result"]; retry?: boolean }[]) =>
	`${rows.some((r) => r.retry) ? "Retry: " : ""}${resultCounts(rows)}`;

/** The line shown when saving apps.toml fails. The reason comes from the engine, so it has no final stop. */
export const tomlWriteFailed = (reason: string) => `Could not write apps.toml: ${reason}. Nothing was changed.`;

export type SentenceInput = {
	run: RunState;
	ready: number;
	problems: number;
	currentName: string | null;
	notStarted?: number;
	/** How many apps the list holds; zero says so instead of calling an empty list fresh. */
	total?: number;
};

/** The one-line state of the whole list in the header. A run phase wins over ready and problem counts; an empty list says so, and a list with nothing to do says everything is fresh. */
export function stateSentence({ run, ready, problems, currentName, notStarted = 0, total }: SentenceInput): string {
	if (run.phase === "checking") return `Checking ${run.index} of ${run.total}`;
	if (run.phase === "installing")
		return `${run.retry ? "Retrying" : "Installing"} ${currentName ?? ""}, ${run.index} of ${run.total}`;
	if (run.phase === "summary") return resultCounts(run.results) + (notStarted > 0 ? `, ${notStarted} not started` : "");
	if (total === 0) return "No apps yet";
	if (ready > 0) return plural(ready, "1 update ready", `${ready} updates ready`);
	if (problems > 0) return plural(problems, "1 needs a look", `${problems} need a look`);
	return "Everything is fresh";
}

/** Add app and Remove from Upkeep, as the add-app view spec writes them. */
export const ADD = {
	button: "Add app",
	title: "Add an app",
	label: "App name, GitHub repo, link or file",
	placeholder: "fd, or owner/repo",
	find: "Find",
	runs: "Updates by running",
	finding: "Finding",
	hint: "Type an app's name, paste a repo such as sharkdp/fd or a github.com link, or drop a file anywhere on this window.",
	pick: "Choose a file",
	scan: "Scan this computer",
	scanning: "Scanning",
	lookingRelease: "Looking at the latest release",
	lookingDisk: "Looking through ~/.local/bin, ~/Applications and ~/bin",
	asset: "Asset",
	installedAt: "Installed at",
	notInstalled: "Not installed",
	add: "Add to Upkeep",
	nothingNew: "Nothing new found.",
	tickToAdd: "Tick an app to add it.",
	pasteRepo: "Paste its repo",
	drop: "Drop to add it to Upkeep",
	unreadable: "Could not read where that file is. Use Choose a file.",
	slow: "That took too long. Try again.",
	remove: "Remove from Upkeep",
	removeYes: "Remove",
	keep: "Keep",
	waitRun: "Wait for the run to finish.",
} as const;

/** Notice after one app was added. */
export const addedOne = (name: string) => `Added ${name}.`;
/** Notice after a batch of added apps, singular and plural. */
export const addedMany = (n: number) => (n === 1 ? "Added 1 app." : `Added ${n} apps.`);
/** Heading over scan results. */
export const foundApps = (n: number) => (n === 1 ? "Found 1 app not in the list" : `Found ${n} apps not in the list`);
/** Button text for adding the ticked scan results. */
export const addApps = (n: number) => (n === 1 ? "Add 1 app" : `Add ${n} apps`);
/** The confirmation question before removing; says the app itself stays installed. */
export const removeAsk = (name: string) => `Remove ${name} from the list? The app itself stays installed.`;
/** Notice after an app was removed from the list. */
export const removedNote = (name: string) => `Removed ${name}.`;

/** The built-in window frame and About. */
export const WIN = {
	close: "Close",
	minimize: "Minimize",
	maximize: "Maximize",
	restore: "Restore",
	group: "Window",
	frame: "Window frame",
	frameOwn: "Built in",
	frameSystem: "System",
	frameHelp: "Built in puts the title bar inside Upkeep's own header. System uses the desktop's.",
	buttons: "Window buttons",
	buttonsAuto: "Follow the desktop",
	buttonsLeft: "Left",
	buttonsRight: "Right",
	corners: "Window corners",
	cornersRounded: "Rounded",
	cornersSquare: "Square",
	cornersHelp: "A rounded window has no shadow from the desktop.",
	about: "About",
	word: "UPKEEP",
	tagline: "Keeps the apps your package manager misses up to date.",
} as const;

/** The System group: the system's own pending updates, shown read-only. Flatpak anywhere; packages where Linux Mint's Update Manager is installed. */
export const SYS = {
	extras: "Extras",
	setting: "Show system updates",
	settingHelp:
		"Lists your system's own pending updates: Flatpak apps and runtimes, and on Linux Mint the packages its Update Manager would install. Not counted in the tray number.",
	group: "System",
	open: "Open Update Manager",
	mintOnly: "Package updates are listed on Linux Mint only. Flatpak updates still show here.",
	noFlatpak: "Flatpak is not installed, so only package updates are listed.",
	checking: "Checking system updates",
	none: "No system updates.",
	newBuild: "new build",
	restartNote: "Needs a restart after it installs.",
	type: {
		security: "Security",
		package: "Package",
		kernel: "Kernel",
		driver: "Driver",
		app: "Flatpak app",
		runtime: "Flatpak runtime",
	} satisfies Record<SystemRow["type"], string>,
} as const;

/** The group's subline: when it was checked, or that a check is under way. */
export function systemChecked(relative: string | null, checking: boolean, source = "Update Manager"): string {
	if (checking) return `From ${source}, checking`;
	return relative ? `From ${source}, checked ${relative}` : `From ${source}`;
}

/** True when the problem is a missing command that starts with the tool name; the arguments after the name do not matter. */
const absentTool = (problem: SystemState["problem"], tool: string) =>
	problem?.code === "missing" && problem.command.startsWith(tool);
/** True on a system without Linux Mint's Update Manager: no package list, no button for it, and nothing wrong. */
export const noMint = (problem: SystemState["problem"]) => absentTool(problem, "mintupdate-cli");

/** A source this system simply does not have is said quietly, not as a fault. Null when the problem is a real one. */
export function systemAbsent(problem: SystemState["problem"]): string | null {
	if (noMint(problem)) return SYS.mintOnly;
	return absentTool(problem, "flatpak") ? SYS.noFlatpak : null;
}

/** Sentence for a System list problem. A missing tool says so; a failed read names the source and appends the detail when there is one. */
export function systemProblem(problem: NonNullable<SystemState["problem"]>): string {
	if (problem.code === "missing") return `${problem.command} is not installed, so this part of the list is empty.`;
	const source = problem.command.startsWith("flatpak") ? "Flatpak's" : "Update Manager's";
	return problem.detail ? `Could not read ${source} list: ${problem.detail}` : `Could not read ${source} list.`;
}

/** The NVIDIA runtime warning; the version is the one the driver needs. */
export const glLine = (version: string) =>
	`Flatpak apps cannot use the GPU until the NVIDIA ${version} runtime is installed. A Flatpak update installs it.`;

/** The "Check for updates" choices, in the order Settings lists them. */
export const CHECK_EVERY = [
	{ v: "6h", label: "Every 6 hours" },
	{ v: "daily", label: "Once a day" },
	{ v: "ask", label: "Only when I ask" },
] as const satisfies readonly { v: Settings["checkEvery"]; label: string }[];
