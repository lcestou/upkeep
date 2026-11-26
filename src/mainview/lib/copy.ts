// Every string a person reads, pasted from the plan's copy table (F5).
import type {
	AppKind,
	AppState,
	CleanupId,
	CleanupOutcome,
	RunResult,
	RunState,
	Settings,
	Stage,
	SystemRow,
	SystemOutcome,
	SystemState,
} from "../../shared/types";
import { formatBytes, isToday, plural, shortDate, shortTime } from "./format";
import { language } from "./language.svelte";

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
	get rpm() {
		return ".rpm";
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
	get stopNow() {
		return "Stop now";
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
	/** Over the lines of skipped releases' notes that read as a breaking change. */
	get breakingChanges() {
		return "Breaking changes";
	},
	/** Under those lines: they were found by plain word rules, so the notes stay the thing to read. */
	get breakingHint() {
		return "Lines in these notes that mention a breaking change or a migration. Read them before you update.";
	},
	/** Under the notes of skipped releases when the forge's list stops before the installed version. */
	get olderNotListed() {
		return "Older releases are not listed here. The release page has them all.";
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
	get withSettings() {
		// @wc-include
		return "with settings";
	},
	get withSettingsTitle() {
		return "Restoring puts its saved settings back too. The settings it replaces are kept aside.";
	},
	get holdUpdates() {
		return "Hold updates";
	},
	get releaseHold() {
		return "Release hold";
	},
	get pauseFor() {
		return "Pause for…";
	},
	get resumeNow() {
		return "Resume now";
	},
	get openRelease() {
		return "Open release page";
	},
	get installAuto() {
		return "Install automatically";
	},
	get followPrerelease() {
		return "Follow pre-releases";
	},
	get otherVersions() {
		return "Other versions";
	},
	get showVersions() {
		return "Show releases";
	},
	get loadingVersions() {
		return "Asking for the releases…";
	},
	get noVersions() {
		return "No releases listed.";
	},
	/** Under Other versions: what installing an older one does, said before it is pressed. */
	get versionsHint() {
		return "Going back to an older release skips the latest, so the next check offers only a newer one.";
	},
	get prereleaseTag() {
		// @wc-include
		return "pre-release";
	},
	get installedTag() {
		// @wc-include
		return "installed";
	},
	get showInMenu() {
		return "Show in the app menu";
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
	get whySystem() {
		return "Wait for the system updates to finish.";
	},
	get openLog() {
		return "Open log file";
	},
	get logPause() {
		return "Pause";
	},
	get logFollow() {
		return "Follow new lines";
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
	get stoppedByYou() {
		return "Stopped by you";
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
	get upkeepCommand() {
		return "Add the upkeep command";
	},
	get upkeepCommandHint() {
		return "Puts upkeep in ~/.local/bin for the terminal and scripts. A file already there that Upkeep did not write is left alone.";
	},
	get waitUnmetered() {
		return "Wait for an unmetered connection and mains power for automatic app updates";
	},
	get waitUnmeteredHint() {
		return "Automatic app updates hold off on a metered connection or on battery. Checks still run, and Install always works. Upkeep's own update is not held.";
	},
	get keepBackups() {
		return "Restore points to keep";
	},
	get waitDays() {
		return "Wait before offering a new release";
	},
	get waitDaysHint() {
		return "A new release of an app often gets a quick fix in its first days. Counted from when it came out. Upkeep's own updates do not wait.";
	},
	get installNowAnyway() {
		return "Install now anyway";
	},
	get githubToken() {
		return "GitHub token";
	},
	get githubTokenHint() {
		return "Raises GitHub's limit from 60 to 5,000 requests an hour and reaches private repos. Used before gh's own sign-in. Kept on this computer, readable by you alone.";
	},
	get saveToken() {
		return "Save token";
	},
	get removeToken() {
		return "Remove token";
	},
	get tokenRefused() {
		return "That does not look like a GitHub token.";
	},
	get tokenGithubRefused() {
		return "GitHub refused this token. It may have expired or been revoked.";
	},
	get tokenFallbackGh() {
		return "GitHub refused the saved token; using the gh sign-in.";
	},
	get tokenFallbackNone() {
		return "GitHub refused the saved token, and gh is not signed in. Paste a new token.";
	},
	get webhook() {
		return "Send a notice to a web address";
	},
	get webhookHint() {
		return "Upkeep posts a short JSON message there, such as to an ntfy topic or a home server. The address may hold a token: it is kept on this computer, readable by you alone, and never exported.";
	},
	get saveWebhook() {
		return "Save address";
	},
	get removeWebhook() {
		return "Remove address";
	},
	get webhookBadAddress() {
		return "That is not a web address. It starts with https://.";
	},
	get webhookPlain() {
		return "Plain http only goes to this computer or the home network. Use https for anywhere else.";
	},
	get webhookReady() {
		return "When updates are ready";
	},
	get webhookRun() {
		return "After each run, with its result";
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
	get exportSetup() {
		return "Export";
	},
	get importSetup() {
		return "Import";
	},
	get setupHelp() {
		return "Export saves the settings and the app list as one file, for another computer or a script. Import replaces them from such a file.";
	},
	get openManifest() {
		return "Open apps.toml";
	},
} as const;

/** The question before an import whose list has apps that run commands: what they run, read before anything is written. */
export const IMPORT = {
	get ask() {
		return "This file has apps that run these commands on this computer. Import it only if you trust where it came from.";
	},
	get autoOff() {
		return "Automatic installs come in off for every app that is new to this computer or differs from its table here. You can turn them on again for each app.";
	},
	get turnsOn() {
		return "It turns on these settings, which are off on this computer:";
	},
	get waitShorter() {
		return "It shortens the wait before a new release is offered:";
	},
	get turnsOff() {
		return "It turns off these settings, which are on on this computer:";
	},
	get webhook() {
		return "It sends Upkeep's notices, with the app list, to this address:";
	},
	get yes() {
		return "Import";
	},
	get no() {
		return "Cancel";
	},
} as const;
/** Under the commands: the apps in the file that only install their release files, with no command and no root. */
export const importPlain = (n: number) =>
	plural(n, [
		"It also has # app that only installs its release files, without root.",
		"It also has # apps that only install their release files, without root.",
	]);
/** After Import, beside importedNote: apps the file wanted installed automatically that came in off, being new or changed. */
export const importAutoOffNote = (n: number) =>
	plural(n, [
		"Automatic installs came in off for # app that is new here or changed.",
		"Automatic installs came in off for # apps that are new here or changed.",
	]);
/** After Export: the file it wrote. */
export const exportedNote = (file: string) => `Saved ${file}.`;
/** After Import: how many apps the new list holds. */
export const importedNote = (n: number) => plural(n, ["Imported a list of # app.", "Imported a list of # apps."]);
/** Why an Export or Import did nothing; the reason comes from the engine or the system, so it has no final stop. */
export const setupFailed = (reason: string) => `Nothing was changed: ${reason}`;

/** Button text for a restore point; the version is the one it restores to. */
export const restoreLabel = (v: string) => `Restore ${v}`;
/** Button text that skips one version without holding the app. */
export const skipLabel = (v: string) => `Skip ${v}`;
/** Button text that undoes a skip of that version. */
export const stopSkipLabel = (v: string) => `Stop skipping ${v}`;
/** Button text that installs one release from Other versions. */
export const installVersionLabel = (v: string) => `Install ${v}`;
/** The pane's line for a held app: the version it stays at. */
export const heldAt = (v: string) => `Held at ${v}.`;
/** The release line in the pane; relative is already a phrase such as "3 days ago". */
export const releasedLabel = (relative: string) => `Released ${relative}`;
/** Under the notes of skipped releases: how many were left out because the notes shown are already long. */
export const olderNotes = (n: number) => plural(n, ["# older release not shown.", "# older releases not shown."]);
/** The pane's sentence on a release still settling: the day it is offered, or the hour when that is later today. */
export const settlesLine = (version: string, iso: string) =>
	isToday(iso)
		? `${version} is offered at ${shortTime(iso)} today, after the wait set in Settings.`
		: `${version} is offered from ${shortDate(iso)}, after the wait set in Settings.`;
/** The pane's sentence on a paused app: the day its pause ends. */
export const pausedLine = (iso: string) => `Paused until ${shortDate(iso)}, then offered again by itself.`;
/** What Settings shows for a kept GitHub token: only its last four characters. */
export const tokenKeptLine = (last: string) => `A token ending in ${last} is saved.`;
/** The kept notice address, masked past its host. */
export const webhookKeptLine = (masked: string) => `Notices go to ${masked}`;
/** Tooltip over the checked time; relative is already a phrase such as "2 hours ago". */
export const checkedTitle = (relative: string) => `Checked ${relative}`;
/** The note after a restore finishes. It ends with a full stop, unlike the button label. */
export const restoredText = (v: string) => `Restored ${v}.`;
/** Shown on the Stop button once pressed, while the running app finishes. */
export const stoppingLabel = (name: string) => `Stopping after ${name}`;
/** Shown on Stop now once pressed, while the running app is cut or waited out and put back. */
export const stoppingNowLabel = (name: string) => `Stopping ${name}…`;
/** The Retry button when n apps failed; always reads "failed", even for a rolled-back app. */
export const retryLabel = (n: number) => plural(n, ["Retry # failed", "Retry # failed"]);
/** The rate-limit line in Settings. Counts requests, not apps. */
export const rateText = (remaining: number, limit: number) =>
	`GitHub requests left this hour: ${remaining} of ${limit}`;
/** The bar shown while GitHub's hourly budget is used up; time is when it starts over. */
export const rateOutText = (time: string) =>
	`GitHub's hourly limit for this network is used up. Checks resume at ${time}.`;
/** The bar's second sentence, only without a GitHub sign-in: gh's token raises the limit. */
export const RATE = {
	get signIn() {
		return "Paste a GitHub token in Settings, or run gh auth login in a terminal, to raise it to 5,000 an hour.";
	},
	get dismiss() {
		return "Dismiss";
	},
};
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

/** How an install's download was checked, said in the pane after it. */
export const CHECKED = {
	get digest() {
		return "Download checked: SHA-256 matches the forge's record.";
	},
	get sums() {
		return "Download checked: matches the release's checksum file.";
	},
	get size() {
		return "Download checked: size only.";
	},
	get none() {
		return "Download not checked: the release lists no size or checksum.";
	},
};

/** How a download was checked, as the short line under a History row. */
export const CHECKED_SHORT = {
	get digest() {
		return "SHA-256 matches the forge";
	},
	get sums() {
		return "Matches the checksum file";
	},
	get size() {
		return "Size checked only";
	},
	get none() {
		return "Download not checked";
	},
};

/** Why a kind keeps no restore point, said in the pane only. */
export const NO_RESTORE = {
	appimage: undefined,
	archive: undefined,
	file: undefined,
	manual: undefined,
	deb: undefined,
	rpm: undefined,
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

/**
 * The quiet line on a working row: how long it has printed nothing, and when its step's own limit ends it. It states
 * the two facts and never says stuck: many steps (tar, git, a health poll) are silent by design.
 */
export const quietLine = (m: number, n: number | null) =>
	n === null ? `No output for ${m} min.` : `No output for ${m} min. It stops on its own in ${n} min.`;

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
			if (app.paused) return `Paused until ${shortDate(app.paused)}`;
			if (app.skipped) return `Skipping ${app.skipped}`;
			if (!app.settles) return "Held";
			return isToday(app.settles) ? `Offered at ${shortTime(app.settles)}` : `Offered from ${shortDate(app.settles)}`;
		case "problem":
			return "Needs a look";
		case "queued":
			return app.downloaded ? "Downloaded, waits its turn" : "Queued";
		case "working":
			return workingText(app.stage, app.stagePct, app.size);
		case "done":
			return app.restartToApply ? `Restart ${app.name} to finish` : `Updated to ${app.installed ?? app.latest ?? ""}`;
		case "failed":
			return "Failed";
		case "rolled_back":
			return `Rolled back to ${app.installed ?? ""}`;
		case "stopped":
			return "Stopped";
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
		return "App name, repo, link or file";
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
		return "Type an app's name, paste a repo such as sharkdp/fd or a GitHub, GitLab or Codeberg link, or drop a file anywhere on this window.";
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
	get whatsNew() {
		return "What's new";
	},
	get reportBug() {
		return "Report a bug";
	},
	get onGitHub() {
		return "Upkeep on GitHub";
	},
} as const;

/** Uninstall, at the end of Settings, under About. */
export const UNINSTALL = {
	get button() {
		return "Uninstall Upkeep";
	},
	get ask() {
		return "Uninstall Upkeep? Its menu entry, its login entry and the upkeep command go with it. The apps it keeps up to date stay installed.";
	},
	get purge() {
		return "Also delete Upkeep's settings, app list, history and restore points";
	},
	get yes() {
		return "Uninstall";
	},
	get keep() {
		return "Keep Upkeep";
	},
	get closing() {
		return "Uninstalling. Upkeep closes now.";
	},
};

/** Upkeep's own update: the row above the list, and its switch in Settings. */
export const SELF = {
	get available() {
		return "A new version of Upkeep is ready.";
	},
	get preparing() {
		return "Downloading the new version and testing that it starts";
	},
	get ready() {
		return "Restart Upkeep to finish.";
	},
	get restarting() {
		return "Restarting Upkeep";
	},
	get update() {
		return "Update Upkeep";
	},
	get again() {
		return "Try again";
	},
	get restart() {
		return "Restart now";
	},
	get dismiss() {
		return "Dismiss";
	},
	get busy() {
		return "Finish what is running first.";
	},
	get auto() {
		return "Update Upkeep automatically";
	},
	get autoHelp() {
		return "Installs a new version of Upkeep while it sits in the tray, and restarts it. Off: Upkeep tells you and waits.";
	},
} as const;
/** The row's sentence on the first start of a new version. */
export const selfUpdated = (version: string) => `Upkeep was updated to ${version}.`;
/** The row's sentence after the start script put the version before back. */
export const selfRolledBack = (version: string) =>
	`Upkeep ${version} would not start, so the version before it was put back.`;

/** The System group: the system's own pending updates, read-only unless installing is switched on. Flatpak anywhere; packages from Update Manager on Linux Mint, else apt, dnf, pacman or zypper. */
export const SYS = {
	get extras() {
		return "Extras";
	},
	get setting() {
		return "Show system updates";
	},
	get settingHelp() {
		return "Lists your system's own pending updates: Flatpak apps and runtimes, Snaps, Cinnamon's applets, desklets, extensions and themes, and the packages your package manager would install (Update Manager on Linux Mint, else apt, dnf, pacman or zypper). Not counted in the tray number.";
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
	get installSetting() {
		return "Install system updates from Upkeep";
	},
	get installSettingHelp() {
		return "Tick rows in the System group and install them from there. Kernels and the NVIDIA driver stay with the system's own updater, because both need a restart. Packages and Snaps install through sudo, which must not ask for a password.";
	},
	get confirmIntro() {
		return "Upkeep runs these commands, in this order:";
	},
	get confirmRoot() {
		return "The commands that start with sudo need administrator rights and run as root.";
	},
	get confirmYes() {
		return "Install now";
	},
	get confirmNo() {
		return "Not now";
	},
	get dismiss() {
		return "Done";
	},
	/** A ticked row's place in a System install, then its result. */
	state: {
		get queued() {
			return "Waiting";
		},
		get working() {
			return "Installing";
		},
		get done() {
			return "Installed";
		},
		get failed() {
			return "Failed";
		},
	} satisfies Record<SystemOutcome["status"], string>,
	/** Cinnamon's updater updates a whole spice type at once, so a spice row says so. */
	spiceNote: {
		get applet() {
			return "Installs with every Cinnamon applet that has an update.";
		},
		get desklet() {
			return "Installs with every Cinnamon desklet that has an update.";
		},
		get extension() {
			return "Installs with every Cinnamon extension that has an update.";
		},
		get theme() {
			return "Installs with every Cinnamon theme that has an update.";
		},
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
		get applet() {
			return "Cinnamon applet";
		},
		get desklet() {
			return "Cinnamon desklet";
		},
		get extension() {
			return "Cinnamon extension";
		},
		get theme() {
			return "Cinnamon theme";
		},
		get snap() {
			return "Snap";
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

/** The sources the System group read beside the package list, by name, for its subline. */
export const ALSO_FROM = {
	get snap() {
		return "Snap";
	},
	get cinnamon() {
		return "Cinnamon";
	},
};

/**
 * The subline's "From …" names: the package list (or Flatpak when there is none), then Snap and Cinnamon when the
 * group holds their rows, joined the way the language joins a list. On Linux Mint, Update Manager already shows
 * Cinnamon's spices, so it is not named twice.
 */
export function systemSources(packages: SystemState["packages"], rows: { source: string }[]): string {
	const names = [packages ? PACKAGES_FROM[packages] : "Flatpak"];
	if (rows.some((r) => r.source === "snap")) names.push(ALSO_FROM.snap);
	if (packages !== "mint" && rows.some((r) => r.source === "cinnamon")) names.push(ALSO_FROM.cinnamon);
	return new Intl.ListFormat(language.locale, { type: "conjunction" }).format(names);
}

/** Sentence for a System list problem. A missing tool says so; a failed read names the source and appends the detail when there is one. */
export function systemProblem(problem: NonNullable<SystemState["problem"]>): string {
	if (problem.code === "missing") return `${problem.command} is not installed, so this part of the list is empty.`;
	const tool = problem.command.split(" ")[0] ?? "";
	const source =
		tool === "flatpak"
			? "Flatpak"
			: tool === "cinnamon-spice-updater"
				? ALSO_FROM.cinnamon
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

/** The System command sheet's last line when apps are ticked too: they install once the commands finish. */
export function systemThenApps(n: number): string {
	return plural(n, ["Then Upkeep installs the # ticked app.", "Then Upkeep installs the # ticked apps."]);
}

/** The line over a finished System install's results. */
export const systemSummary = (done: number, all: number) => `Installed ${done} of ${all}.`;

/** A row from a package list Upkeep only reads, while installing is on: the system's own tool installs it. */
export const systemToolNote = (tool: string) => `Install it with ${tool}.`;

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

/** The waits Settings offers before a new release is offered, in days. */
export const WAIT_DAYS = [
	{
		v: 0,
		get label() {
			return "Off";
		},
	},
	{
		v: 1,
		get label() {
			// @wc-include
			return "1 day";
		},
	},
	{
		v: 3,
		get label() {
			// @wc-include
			return "3 days";
		},
	},
	{
		v: 7,
		get label() {
			// @wc-include
			return "7 days";
		},
	},
] as const satisfies readonly { v: Settings["waitDays"]; label: string }[];

/** The pauses a row's pane offers, in days. A month is 30 days, so every pause is a plain count. */
export const PAUSE_DAYS = [
	{
		v: 7,
		get label() {
			// @wc-include
			return "1 week";
		},
	},
	{
		v: 14,
		get label() {
			// @wc-include
			return "2 weeks";
		},
	},
	{
		v: 30,
		get label() {
			// @wc-include
			return "1 month";
		},
	},
] as const;

/** The Cleanup tab: a fixed list of caches and leftovers, each deleted only after it is ticked and reviewed. */
export const CLEAN = {
	get tab() {
		return "Cleanup";
	},
	get setting() {
		return "Show Cleanup";
	},
	get settingHelp() {
		return "Adds a Cleanup tab. It measures caches and leftovers, and deletes only what you tick and then confirm.";
	},
	get devSetting() {
		return "Include developer caches";
	},
	get devSettingHelp() {
		return "The uv, bun, npm and pip download caches. They come back as downloads the next time a build needs them.";
	},
	get intro() {
		return "Upkeep deletes only what you tick, after one more look.";
	},
	get measure() {
		return "Measure again";
	},
	get measuring() {
		return "Measuring";
	},
	get notMeasured() {
		return "Not measured yet.";
	},
	get nothing() {
		return "Nothing to clean.";
	},
	get root() {
		return "Needs administrator";
	},
	get newerCopy() {
		return "This copy is newer than the installed file.";
	},
	get tickOne() {
		return "Tick something to clean.";
	},
	get reviewTitle() {
		return "Delete these?";
	},
	get commands() {
		return "Upkeep runs these commands:";
	},
	get back() {
		return "Back";
	},
	get dismiss() {
		return "Done";
	},
	get cleaned() {
		return "Cleaned";
	},
	group: {
		get safe() {
			return "Safe to clear";
		},
		get choice() {
			return "Your call";
		},
		get shown() {
			return "Shown only";
		},
	},
	undo: {
		get regrows() {
			return "Comes back on its own";
		},
		get redownload() {
			return "Downloads again";
		},
		get none() {
			return "Cannot be undone";
		},
	},
	state: {
		get queued() {
			return "Waiting";
		},
		get working() {
			return "Cleaning";
		},
		get done() {
			return "Cleaned";
		},
		get skipped() {
			return "Skipped";
		},
		get failed() {
			return "Failed";
		},
	} satisfies Record<CleanupOutcome["status"], string>,
	name: {
		get thumbnails() {
			return "Thumbnails";
		},
		get trash() {
			return "Trash";
		},
		get leftovers() {
			return "Upkeep's leftover copies";
		},
		get "restore-points"() {
			return "Restore points";
		},
		get "apt-cache"() {
			return "Downloaded packages";
		},
		get "flatpak-gl"() {
			return "Old NVIDIA runtimes for Flatpak";
		},
		get autoremove() {
			return "Packages nothing needs";
		},
		get uv() {
			return "uv cache";
		},
		get bun() {
			return "bun cache";
		},
		get npm() {
			return "npm cache";
		},
		get pip() {
			return "pip cache";
		},
		get tmp() {
			return "Temporary files (/tmp)";
		},
		get journal() {
			return "System logs";
		},
		get kernels() {
			return "Old kernels";
		},
		get timeshift() {
			return "Timeshift snapshots";
		},
		get browser() {
			return "Browser caches";
		},
		get playwright() {
			return "Playwright browsers";
		},
		get "hand-backups"() {
			return "Backup copies beside your apps";
		},
		get "upkeep-cache"() {
			return "Upkeep's own cache";
		},
	} satisfies Record<CleanupId, string>,
	what: {
		get thumbnails() {
			return "Small previews of pictures and videos. The file manager makes them again when it needs them.";
		},
		get trash() {
			return "Files you deleted in the file manager, in your home folder's Trash.";
		},
		get leftovers() {
			return "Copies Upkeep left beside an app when an install was cut off.";
		},
		get "restore-points"() {
			return "Upkeep's copies of replaced app versions. Deleting one means that version can no longer be put back.";
		},
		get "apt-cache"() {
			return "Package files apt keeps after installing them. apt downloads them again if it needs them.";
		},
		get "flatpak-gl"() {
			return "Flatpak GPU runtimes for NVIDIA driver versions no longer installed.";
		},
		get autoremove() {
			return "Packages apt installed as dependencies that nothing uses now.";
		},
		get uv() {
			return "Downloaded and built Python packages. Tools already installed keep working.";
		},
		get bun() {
			return "Downloaded JavaScript packages for bun.";
		},
		get npm() {
			return "Downloaded JavaScript packages for npm.";
		},
		get pip() {
			return "Downloaded Python packages for pip.";
		},
		get tmp() {
			return "Cleared at every restart, and the system removes anything untouched for 30 days.";
		},
		get journal() {
			return "The system keeps these under the size its journald setting allows.";
		},
		get kernels() {
			return "Remove older ones in Update Manager under View, Linux kernels.";
		},
		get timeshift() {
			return "Timeshift and its own schedule manage these. Delete one from Timeshift.";
		},
		get browser() {
			return "Clear these from the browser's own settings. Deleting them while it runs can break it.";
		},
		get playwright() {
			return "Test browsers that projects pin by version.";
		},
		get "hand-backups"() {
			return "Copies made by hand or by another tool. Upkeep leaves them alone.";
		},
		get "upkeep-cache"() {
			return "Saves GitHub lookups. Upkeep clears its downloads at the start of every run.";
		},
	} satisfies Record<CleanupId, string>,
} as const;

/** A shown kernel item's facts: the running kernel, and the newest when it is another. */
export const kernelsLine = (running: string, newest: string) =>
	running === newest ? `Running ${running}.` : `Running ${running}, newest installed ${newest}.`;
/** A shown Timeshift item's facts. */
export const snapshotsLine = (count: number, newest: string) =>
	`${plural(count, ["# snapshot.", "# snapshots."])} ${newestLine(newest)}`;
/** The newest snapshot, after the count. */
const newestLine = (newest: string) => `Newest ${newest}.`;
/** How many hand-made copies a shown item counted. */
export const copiesLine = (count: number) => plural(count, ["# copy.", "# copies."]);
/** When the list was last measured. */
export const measuredLine = (relative: string) => `Measured ${relative}`;
/** The footer button that opens the review: what the ticks free. */
export const reviewLabel = (size: string) => `Review ${size}`;
/** The review sheet's button, naming what it deletes. */
export const deleteLabel = (size: string) => `Delete ${size}`;
/** The review sheet's total line. */
export const totalLine = (size: string) => `${size} in all.`;
/** The review sheet's line naming what cannot come back. */
export const finalLine = (names: string[]) =>
	`Cannot be undone: ${new Intl.ListFormat(language.locale, { type: "conjunction" }).format(names)}.`;
/** The field label for removing packages; word is the literal word to type, never translated. */
export const typeLabel = (word: string) => `Type ${word} to also remove packages`;
/** A finished cleanup's line. */
export const freedLine = (size: string) => `Freed ${size}.`;
/** A History row for a cleanup: what it freed. */
export const freedShort = (size: string) => `${size} freed`;
