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
	get appimage() {
		// @wc-ignore
		return "AppImage";
	},
	get archive() {
		return "Binary";
	},
	get file() {
		return "Binary";
	},
	get deb() {
		return ".deb";
	},
	get source() {
		return "Source build";
	},
	get command() {
		return "Updates itself";
	},
	get "claude-plugins"() {
		return "Plugins";
	},
	get manual() {
		return "By hand";
	},
} satisfies Record<AppKind, string>;

export const STAGE_NAME = {
	get download() {
		return "Download";
	},
	get backup() {
		return "Back up";
	},
	get build() {
		return "Build";
	},
	get install() {
		return "Install";
	},
	get verify() {
		return "Verify";
	},
} satisfies Record<Stage, string>;

export type GroupId = "run" | "restart" | "ready" | "manual" | "problem" | "held" | "checking" | "fresh";

export const GROUP_LABEL = {
	get ready() {
		return "Ready to install";
	},
	get installing() {
		return "Installing";
	},
	get thisRun() {
		return "This run";
	},
	get restart() {
		return "Restart to finish";
	},
	get manual() {
		return "By hand";
	},
	get problem() {
		return "Needs a look";
	},
	get held() {
		return "Held back";
	},
	get checking() {
		return "Checking";
	},
	get fresh() {
		return "Fresh";
	},
} satisfies Record<Exclude<GroupId, "run"> | "installing" | "thisRun", string>;

export const COLUMN = {
	get app() {
		return "App";
	},
	get kind() {
		return "Kind";
	},
	get version() {
		return "Version";
	},
	get size() {
		return "Size";
	},
	get restore() {
		return "Restore point";
	},
	get status() {
		return "Status";
	},
} as const;

export const CHIP = {
	running: {
		get text() {
			return "In use";
		},
		get title() {
			return "In use now. The update applies when you restart it.";
		},
	},
	root: {
		get text() {
			return "Root";
		},
		get title() {
			return "Installs with sudo.";
		},
	},
	auto: {
		get text() {
			return "Auto";
		},
		get title() {
			return "Installed without asking when Upkeep checks in the background.";
		},
	},
} as const;

export const TEXT = {
	get updates() {
		return "Updates";
	},
	get history() {
		return "History";
	},
	get settings() {
		return "Settings";
	},
	get check() {
		return "Check again";
	},
	get selectAll() {
		return "Select all";
	},
	get selectNone() {
		return "Select none";
	},
	get nothingSelected() {
		return "Nothing selected";
	},
	get stop() {
		return "Stop after this one";
	},
	get done() {
		return "Done";
	},
	get none() {
		return "None";
	},
	get noneYet() {
		// @wc-include
		return "none yet";
	},
	get versionless() {
		// @wc-include
		return "checks itself when run";
	},
	get runNow() {
		return "Run now";
	},
	get whatChanged() {
		return "What changed";
	},
	get noNotes() {
		return "No release notes.";
	},
	get installedAt() {
		return "Installed at";
	},
	get source() {
		return "Source";
	},
	get restorePoints() {
		return "Restore points";
	},
	get holdUpdates() {
		return "Hold updates";
	},
	get releaseHold() {
		return "Release hold";
	},
	get openRelease() {
		return "Open release page";
	},
	get installAuto() {
		return "Install automatically";
	},
	get runItYourself() {
		return "Run it yourself:";
	},
	get copy() {
		return "Copy";
	},
	get copied() {
		return "Copied";
	},
	get log() {
		return "Show log";
	},
	get logTitle() {
		return "Log";
	},
	get hideLog() {
		return "Hide log";
	},
	get backToList() {
		return "Back to list";
	},
	get retry() {
		return "Retry";
	},
	get filter() {
		return "Filter apps";
	},
	get clearFilter() {
		return "Clear filter";
	},
	get sizesUnknown() {
		return "Some sizes are not known until they download.";
	},
	get whyTick() {
		return "Tick an update to install.";
	},
	get whyChecking() {
		return "Wait for the check to finish.";
	},
	get whyNothing() {
		return "Nothing to install.";
	},
	get openLog() {
		return "Open log file";
	},
	get noLog() {
		return "No log lines yet.";
	},
	get noRuns() {
		return "No runs yet.";
	},
	get updated() {
		return "Updated";
	},
	get failed() {
		return "Failed";
	},
	get rolledBack() {
		return "Rolled back";
	},
	get restored() {
		return "Restored";
	},
	get notify() {
		return "Notify when updates are ready";
	},
	get startAtLogin() {
		return "Start at login";
	},
	get startAtLoginHint() {
		return "Opens in the tray and checks for updates.";
	},
	get keepBackups() {
		return "Restore points to keep";
	},
	get checkEvery() {
		return "Check for updates";
	},
	get appList() {
		return "App list";
	},
	get language() {
		return "Language";
	},
	get languageSystem() {
		return "Same as the system";
	},
	get openManifest() {
		return "Open apps.toml";
	},
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
export const retryLabel = (n: number) => plural(n, ["Retry # failed", "Retry # failed"]);
/** The rate-limit line in Settings. Counts requests, not apps. */
export const rateText = (remaining: number, limit: number) =>
	`GitHub requests left this hour: ${remaining} of ${limit}`;
/** The version shown in About, with no leading v. */
export const versionText = (v: string) => `Version ${v}`;

/** Install button text. Zero reads as the generic label, because the button is disabled then. */
export function installLabel(n: number): string {
	if (n === 0) return "Install updates";
	return plural(n, ["Install # update", "Install # updates"]);
}

/** A size that is a floor: some ticked app has no known size yet. */
// @wc-include
const atLeast = (size: string) => `at least ${size}`;

/** partial: some ticked app has no known size, so the total is a floor. hidden: ticked apps the filter hides. */
export function selectionText(n: number, bytes: number | null, partial = false, hidden = 0): string {
	if (n === 0) return TEXT.nothingSelected;
	const size = bytes === null ? "" : ` · ${partial ? atLeast(formatBytes(bytes)) : formatBytes(bytes)}`;
	const tail = hidden > 0 ? ` · ${plural(hidden, ["# hidden", "# hidden"])}` : "";
	return `${plural(n, ["# selected", "# selected"])}${size}${tail}`;
}

/** Why a kind keeps no restore point, said in the pane only. */
export const NO_RESTORE = {
	appimage: undefined,
	archive: undefined,
	file: undefined,
	manual: undefined,
	deb: undefined,
	get source() {
		return "Built in a fresh clone, so there is no restore point.";
	},
	get command() {
		return "It updates itself, and its table has no restore command.";
	},
	get "claude-plugins"() {
		return "Claude Code keeps no older plugin to go back to.";
	},
} satisfies Record<AppKind, string | undefined>;

/** A row's version cell when nothing is installed, read in place of "to". */
export const notInstalledLine = (latest: string) => `Not installed. ${latest} is the latest.`;
/** Version cell text for an installed app. */
export const installedText = (v: string) => `Installed ${v}`;
/** The detail of a row whose last try failed; the fixture matches the text before the reason to clear it. */
export const lastTryFailed = (why: string) => `Last try failed. ${why}`;
/** The pane's heading over a built app's commits; from is the installed build's commit, when it is known. */
export const commitsHeading = (n: number, from: string | null) =>
	from === null
		? plural(n, ["# commit since the installed build", "# commits since the installed build"])
		: `${plural(n, ["# commit", "# commits"])} ${sinceCommit(from)}`;
/** The tail of the commits heading when the installed build's commit is known. */
// @wc-include
const sinceCommit = (from: string) => `since ${from}`;
/** The line under a capped commits list. Text, not a link: the pane's release link already opens the project. */
export const moreCommits = (n: number, shown: number) => `All ${n} on GitHub (${n - shown} not shown)`;
/** The restart sentence over the list; names are joined with commas and never trimmed. */
export const restartLine = (names: string[]) => `Restart ${names.join(", ")} to finish.`;
/** How many apps are updated by hand; the number is not pluralised. */
export const byHandLine = (n: number) => plural(n, ["# more by hand", "# more by hand"]);
export const RUN_TEXT = {
	get inProgress() {
		return "A run is in progress.";
	},
	get retry() {
		return "Retry";
	},
	get restartPending() {
		return "Restart pending";
	},
} as const;
/** The all-fresh line. English reads "All 1 apps" for a list of one; other languages may use their own forms. */
export const allFreshLine = (n: number) => plural(n, ["All # apps are up to date.", "All # apps are up to date."]);
/** The list with no apps yet, as a new person first sees it. */
export const emptyLine = () =>
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

/** "1 failed", in the language shown; the summary marks the part equal to this with the failure colour. */
const failedCount = (n: number) => plural(n, ["# failed", "# failed"]);

/** The failed part of a run's summary as resultCounts words it, or null when nothing failed. */
export function failedPart(results: readonly { result: RunResult["result"] }[]): string | null {
	const failed = results.filter((r) => r.result === "failed" || r.result === "rolled_back").length;
	return failed === 0 ? null : failedCount(failed);
}

/**
 * Whether a failure is about writing the app list, so the pane can offer to open apps.toml. The file name is the
 * same in every language and in the engine's own English messages, so it is what is looked for.
 */
export const aboutManifest = (failure: string | null | undefined) => Boolean(failure?.includes("apps.toml"));

/** "3 updated, 1 failed": the summary sentence, also the heading count of a run in History. */
export function resultCounts(results: readonly { result: RunResult["result"] }[]): string {
	const ok = results.filter((r) => r.result === "updated").length;
	const failed = results.filter((r) => r.result === "failed" || r.result === "rolled_back").length;
	const updated = plural(ok, ["# updated", "# updated"]);
	return failed === 0 ? updated : `${updated}, ${failedCount(failed)}`;
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
	if (run.phase === "summary")
		return (
			resultCounts(run.results) + (notStarted > 0 ? `, ${plural(notStarted, ["# not started", "# not started"])}` : "")
		);
	if (total === 0) return "No apps yet";
	if (ready > 0) return plural(ready, ["# update ready", "# updates ready"]);
	if (problems > 0) return plural(problems, ["# needs a look", "# need a look"]);
	return "Everything is fresh";
}

/** Add app and Remove from Upkeep, as the add-app view spec writes them. */
export const ADD = {
	get button() {
		return "Add app";
	},
	get title() {
		return "Add an app";
	},
	get label() {
		return "App name, GitHub repo, link or file";
	},
	get placeholder() {
		// @wc-include
		return "fd, or owner/repo";
	},
	get find() {
		return "Find";
	},
	get runs() {
		return "Updates by running";
	},
	get finding() {
		return "Finding";
	},
	get hint() {
		return "Type an app's name, paste a repo such as sharkdp/fd or a github.com link, or drop a file anywhere on this window.";
	},
	get pick() {
		return "Choose a file";
	},
	get scan() {
		return "Scan this computer";
	},
	get scanning() {
		return "Scanning";
	},
	get lookingRelease() {
		return "Looking at the latest release";
	},
	get lookingDisk() {
		return "Looking through ~/.local/bin, ~/Applications and ~/bin";
	},
	get asset() {
		return "Asset";
	},
	get installedAt() {
		return "Installed at";
	},
	get notInstalled() {
		return "Not installed";
	},
	get add() {
		return "Add to Upkeep";
	},
	get nothingNew() {
		return "Nothing new found.";
	},
	get tickToAdd() {
		return "Tick an app to add it.";
	},
	get pasteRepo() {
		return "Paste its repo";
	},
	get drop() {
		return "Drop to add it to Upkeep";
	},
	get unreadable() {
		return "Could not read where that file is. Use Choose a file.";
	},
	get slow() {
		return "That took too long. Try again.";
	},
	get remove() {
		return "Remove from Upkeep";
	},
	get removeYes() {
		return "Remove";
	},
	get keep() {
		return "Keep";
	},
	get waitRun() {
		return "Wait for the run to finish.";
	},
} as const;

/** Notice after one app was added. */
export const addedOne = (name: string) => `Added ${name}.`;
/** Notice after a batch of added apps, singular and plural. */
export const addedMany = (n: number) => plural(n, ["Added # app.", "Added # apps."]);
/** Heading over scan results. */
export const foundApps = (n: number) => plural(n, ["Found # app not in the list", "Found # apps not in the list"]);
/** Button text for adding the ticked scan results. */
export const addApps = (n: number) => plural(n, ["Add # app", "Add # apps"]);
/** The confirmation question before removing; says the app itself stays installed. */
export const removeAsk = (name: string) => `Remove ${name} from the list? The app itself stays installed.`;
/** Notice after an app was removed from the list. */
export const removedNote = (name: string) => `Removed ${name}.`;

/** Restart now, for an app whose table says how to restart it. */
export const RESTART = {
	get now() {
		return "Restart now";
	},
	get yes() {
		return "Restart";
	},
	get notNow() {
		return "Not now";
	},
} as const;
/** The question before Upkeep closes apps to reopen them; unsaved work is the cost. */
export const restartAsk = (names: string[]) =>
	names.length === 1
		? `${names[0]} will close and reopen. Unsaved work in it is lost.`
		: `${names.join(", ")} will close and reopen. Unsaved work in them is lost.`;
/** The Restart to finish group's button: restarts every app in it whose table says how. */
export const restartAllLabel = (names: string[]) =>
	names.length === 1 ? `Restart ${names[0]} now` : plural(names.length, ["Restart # apps now", "Restart # apps now"]);
/** Notice after a restart worked. */
export const restartedNote = (names: string[]) => `Restarted ${names.join(", ")}.`;

/** The built-in window frame and About. */
export const WIN = {
	get close() {
		return "Close";
	},
	get minimize() {
		return "Minimize";
	},
	get maximize() {
		return "Maximize";
	},
	get restore() {
		return "Restore";
	},
	get group() {
		return "Window";
	},
	get frame() {
		return "Window frame";
	},
	get frameOwn() {
		return "Built in";
	},
	get frameSystem() {
		return "System";
	},
	get frameHelp() {
		return "Built in puts the title bar inside Upkeep's own header. System uses the desktop's.";
	},
	get buttons() {
		return "Window buttons";
	},
	get buttonsAuto() {
		return "Follow the desktop";
	},
	get buttonsLeft() {
		return "Left";
	},
	get buttonsRight() {
		return "Right";
	},
	get corners() {
		return "Window corners";
	},
	get cornersRounded() {
		return "Rounded";
	},
	get cornersSquare() {
		return "Square";
	},
	get cornersHelp() {
		return "A rounded window has no shadow from the desktop.";
	},
	get about() {
		return "About";
	},
	get word() {
		return "UPKEEP";
	},
	get tagline() {
		return "Keeps the apps your package manager misses up to date.";
	},
} as const;

/** The System group: the system's own pending updates, shown read-only. Flatpak anywhere; packages from Update Manager on Linux Mint, else apt, dnf, pacman or zypper. */
export const SYS = {
	get extras() {
		return "Extras";
	},
	get setting() {
		return "Show system updates";
	},
	get settingHelp() {
		return "Lists your system's own pending updates: Flatpak apps and runtimes, and the packages your package manager would install (Update Manager on Linux Mint, else apt, dnf, pacman or zypper). Not counted in the tray number.";
	},
	get group() {
		return "System";
	},
	get open() {
		return "Open Update Manager";
	},
	get mintOnly() {
		return "No package list Upkeep can read is installed (Update Manager, apt, dnf, pacman or zypper). Flatpak updates still show here.";
	},
	get noFlatpak() {
		return "Flatpak is not installed, so only package updates are listed.";
	},
	get checking() {
		return "Checking system updates";
	},
	get none() {
		return "No system updates.";
	},
	get newBuild() {
		// @wc-include
		return "new build";
	},
	get restartNote() {
		return "Needs a restart after it installs.";
	},
	type: {
		get security() {
			return "Security";
		},
		get package() {
			return "Package";
		},
		get kernel() {
			return "Kernel";
		},
		get driver() {
			return "Driver";
		},
		get app() {
			return "Flatpak app";
		},
		get runtime() {
			return "Flatpak runtime";
		},
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

/** Who answered the System group's package rows, as the subline names it; Flatpak alone when no package list did. */
export const PACKAGES_FROM = {
	get mint() {
		return "Update Manager";
	},
	get apt() {
		return "apt";
	},
	get dnf() {
		return "dnf";
	},
	get pacman() {
		return "pacman";
	},
	get zypper() {
		return "zypper";
	},
} satisfies Record<NonNullable<SystemState["packages"]>, string>;

/** Sentence for a System list problem. A missing tool says so; a failed read names the source and appends the detail when there is one. */
export function systemProblem(problem: NonNullable<SystemState["problem"]>): string {
	if (problem.code === "missing") return `${problem.command} is not installed, so this part of the list is empty.`;
	const tool = problem.command.split(" ")[0] ?? "";
	const source =
		tool === "flatpak"
			? "Flatpak"
			: tool === "apt" || tool === "dnf" || tool === "zypper"
				? tool
				: tool === "checkupdates" || tool === "pacman"
					? "pacman"
					: PACKAGES_FROM.mint;
	return problem.detail ? `Could not read the ${source} list: ${problem.detail}` : `Could not read the ${source} list.`;
}

/** The NVIDIA runtime warning; the version is the one the driver needs. */
export const glLine = (version: string) =>
	`Flatpak apps cannot use the GPU until the NVIDIA ${version} runtime is installed. A Flatpak update installs it.`;

/** The "Check for updates" choices, in the order Settings lists them. */
export const CHECK_EVERY = [
	{
		v: "6h",
		get label() {
			return "Every 6 hours";
		},
	},
	{
		v: "daily",
		get label() {
			return "Once a day";
		},
	},
	{
		v: "ask",
		get label() {
			return "Only when I ask";
		},
	},
] as const satisfies readonly { v: Settings["checkEvery"]; label: string }[];
