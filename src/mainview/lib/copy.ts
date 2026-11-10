// Every string a person reads, pasted from the plan's copy table (F5).
import type { AppKind, AppState, RunResult, RunState, Stage, SystemRow, SystemState } from "../../shared/types";
import { formatBytes, plural } from "./format";

export const KIND_LABEL: Record<AppKind, string> = {
	appimage: "AppImage",
	archive: "Binary",
	file: "Binary",
	deb: ".deb",
	source: "Source build",
	command: "Updates itself",
	legacy: "Updater script",
	manual: "By hand",
};

export const STAGE_NAME: Record<Stage, string> = {
	download: "Download",
	backup: "Back up",
	install: "Install",
	verify: "Verify",
};

export type GroupId = "run" | "restart" | "ready" | "manual" | "problem" | "held" | "checking" | "fresh";

export const GROUP_LABEL: Record<Exclude<GroupId, "run"> | "installing" | "thisRun", string> = {
	ready: "Ready to install",
	installing: "Installing",
	thisRun: "This run",
	restart: "Restart to finish",
	manual: "By hand",
	problem: "Needs a look",
	held: "Held back",
	checking: "Checking",
	fresh: "Fresh",
};

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
	checkAtLogin: "Check at login",
	keepBackups: "Restore points to keep",
	appList: "App list",
	openManifest: "Open apps.toml",
} as const;

export const restoreLabel = (v: string) => `Restore ${v}`;
export const skipLabel = (v: string) => `Skip ${v}`;
export const stopSkipLabel = (v: string) => `Stop skipping ${v}`;
export const releasedLabel = (relative: string) => `Released ${relative}`;
export const checkedTitle = (relative: string) => `Checked ${relative}`;
export const restoredText = (v: string) => `Restored ${v}.`;
export const stoppingLabel = (name: string) => `Stopping after ${name}`;
export const retryLabel = (n: number) => `Retry ${n} failed`;
export const rateText = (remaining: number, limit: number) =>
	`GitHub requests left this hour: ${remaining} of ${limit}`;
export const versionText = (v: string) => `Version ${v}`;

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
export const NO_RESTORE: Partial<Record<AppKind, string>> = {
	deb: "dpkg owns these files, so there is no restore point.",
	source: "Built from source, so there is no restore point.",
	command: "It updates itself, so there is no restore point.",
	legacy: "Upkeep hands this one to lutechi-updater.",
};

/** A row's version cell when nothing is installed, read in place of "to". */
export const notInstalledLine = (latest: string) => `Not installed. ${latest} is the latest.`;
export const installedText = (v: string) => `Installed ${v}`;
export const lastTryFailed = (why: string) => `Last try failed. ${why}`;
export const restartLine = (names: string[]) => `Restart ${names.join(", ")} to finish.`;
export const byHandLine = (n: number) => `${n} more by hand`;
export const RUN_TEXT = {
	inProgress: "A run is in progress.",
	retry: "Retry",
	restartPending: "Restart pending",
} as const;
export const allFreshLine = (n: number) => `All ${n} apps are up to date.`;
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

export function workingText(stage: Stage | undefined, pct: number | null | undefined, size?: number): string {
	switch (stage) {
		case "backup":
			return "Backing up";
		case "install":
			return "Installing";
		case "verify":
			return "Verifying";
		default:
			if (typeof pct !== "number") return "Downloading";
			return typeof size === "number" ? `Downloading ${partOf(pct, size)}` : `Downloading ${Math.round(pct)}%`;
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

export const tomlWriteFailed = (reason: string) => `Could not write apps.toml: ${reason}. Nothing was changed.`;

export type SentenceInput = {
	run: RunState;
	ready: number;
	problems: number;
	currentName: string | null;
	notStarted?: number;
};

export function stateSentence({ run, ready, problems, currentName, notStarted = 0 }: SentenceInput): string {
	if (run.phase === "checking") return `Checking ${run.index} of ${run.total}`;
	if (run.phase === "installing")
		return `${run.retry ? "Retrying" : "Installing"} ${currentName ?? ""}, ${run.index} of ${run.total}`;
	if (run.phase === "summary") return resultCounts(run.results) + (notStarted > 0 ? `, ${notStarted} not started` : "");
	if (ready > 0) return plural(ready, "1 update ready", `${ready} updates ready`);
	if (problems > 0) return plural(problems, "1 needs a look", `${problems} need a look`);
	return "Everything is fresh";
}

/** Add app and Remove from Upkeep, as the add-app view spec writes them. */
export const ADD = {
	button: "Add app",
	title: "Add an app",
	label: "GitHub repo, link or file",
	placeholder: "owner/repo",
	find: "Find",
	finding: "Finding",
	hint: "Paste a repo such as sharkdp/fd, a github.com link, or drop a file anywhere on this window.",
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

export const addedOne = (name: string) => `Added ${name}.`;
export const addedMany = (n: number) => (n === 1 ? "Added 1 app." : `Added ${n} apps.`);
export const foundApps = (n: number) => (n === 1 ? "Found 1 app not in the list" : `Found ${n} apps not in the list`);
export const addApps = (n: number) => (n === 1 ? "Add 1 app" : `Add ${n} apps`);
export const removeAsk = (name: string) => `Remove ${name} from the list? The app itself stays installed.`;
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

/** The System group: Update Manager's own list, shown read-only. */
export const SYS = {
	extras: "Extras",
	setting: "Show system updates",
	settingHelp:
		"Lists what Update Manager would install: Mint and Ubuntu packages, and Flatpak apps and runtimes. Not counted in the tray number.",
	group: "System",
	open: "Open Update Manager",
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
export function systemChecked(relative: string | null, checking: boolean): string {
	if (checking) return "From Update Manager, checking";
	return relative ? `From Update Manager, checked ${relative}` : "From Update Manager";
}

export function systemProblem(problem: NonNullable<SystemState["problem"]>): string {
	if (problem.code === "missing") return `${problem.command} is not installed, so this part of the list is empty.`;
	const source = problem.command.startsWith("flatpak") ? "Flatpak's" : "Update Manager's";
	return problem.detail ? `Could not read ${source} list: ${problem.detail}` : `Could not read ${source} list.`;
}

export const glLine = (version: string) =>
	`Flatpak apps cannot use the GPU until the NVIDIA ${version} runtime is installed. Update Manager's Flatpak update installs it.`;
