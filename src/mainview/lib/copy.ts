// Every string a person reads, pasted from the plan's copy table (F5).
import type { AppKind, AppState, RunResult, RunState, Stage } from "../../shared/types";
import { formatBytes, plural } from "./format";

export const KIND_LABEL: Record<AppKind, string> = {
	appimage: "AppImage",
	archive: "Binary",
	file: "Binary",
	deb: ".deb",
	source: "Source build",
	command: "Self-update",
	legacy: "Old script",
	manual: "By hand",
};

export const STAGE_NAME: Record<Stage, string> = {
	download: "Download",
	backup: "Back up",
	install: "Install",
	verify: "Verify",
};

export type GroupId = "ready" | "manual" | "problem" | "held" | "checking" | "fresh";

export const GROUP_LABEL: Record<GroupId | "installing" | "thisRun", string> = {
	ready: "Ready to install",
	installing: "Installing",
	thisRun: "This run",
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
	running: { text: "Open", title: "Open now. The update applies when you restart it." },
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
	log: "Log",
	openLog: "Open log file",
	noLog: "No log lines yet.",
	noRuns: "No runs yet.",
	updated: "Updated",
	failed: "Failed",
	rolledBack: "Rolled back",
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

export function selectionText(n: number, bytes: number | null): string {
	if (n === 0) return TEXT.nothingSelected;
	return bytes === null ? `${n} selected` : `${n} selected · ${formatBytes(bytes)}`;
}

/** The text in a row's status cell. While working, the stem shows it beside the stem. */
export function statusText(app: AppState): string {
	switch (app.status) {
		case "checking":
			return "Checking";
		case "ready":
			return "Ready";
		case "fresh":
			return app.restartToApply ? "Restart to apply" : "Fresh";
		case "manual":
			return "By hand";
		case "held":
			return app.skipped ? `Skipping ${app.skipped}` : "Held";
		case "problem":
			return "Needs a look";
		case "queued":
			return "Queued";
		case "working":
			return workingText(app.stage, app.stagePct);
		case "done":
			return app.restartToApply ? "Restart to apply" : `Updated to ${app.installed ?? app.latest ?? ""}`;
		case "failed":
			return "Failed";
		case "rolled_back":
			return `Rolled back to ${app.installed ?? ""}`;
	}
}

export function workingText(stage: Stage | undefined, pct: number | null | undefined): string {
	switch (stage) {
		case "backup":
			return "Backing up";
		case "install":
			return "Installing";
		case "verify":
			return "Verifying";
		default:
			return typeof pct === "number" ? `Downloading ${Math.round(pct)}%` : "Downloading";
	}
}

/** "3 updated, 1 failed": the summary sentence, also the heading count of a run in History. */
export function resultCounts(results: readonly { result: RunResult["result"] }[]): string {
	const ok = results.filter((r) => r.result === "updated").length;
	const failed = results.length - ok;
	return failed === 0 ? `${ok} updated` : `${ok} updated, ${failed} failed`;
}

export type SentenceInput = {
	run: RunState;
	ready: number;
	problems: number;
	currentName: string | null;
};

export function stateSentence({ run, ready, problems, currentName }: SentenceInput): string {
	if (run.phase === "checking") return `Checking ${run.index} of ${run.total}`;
	if (run.phase === "installing") return `Installing ${currentName ?? ""}, ${run.index} of ${run.total}`;
	if (run.phase === "summary") return resultCounts(run.results);
	if (ready > 0) return plural(ready, "1 update ready", `${ready} updates ready`);
	if (problems > 0) return plural(problems, "1 needs a look", `${problems} need a look`);
	return "Everything is fresh";
}
