import { expect, test } from "bun:test";
import type { AppState, RunResult, RunState } from "../../shared/types";
import {
	CLEAN,
	copiesLine,
	deleteLabel,
	finalLine,
	freedLine,
	freedShort,
	kernelsLine,
	measuredLine,
	reviewLabel,
	snapshotsLine,
	totalLine,
	typeLabel,
	aboutManifest,
	ADD,
	addApps,
	addedMany,
	addedOne,
	allFreshLine,
	byHandLine,
	CHECK_EVERY,
	checkedTitle,
	CHIP,
	COLUMN,
	commitsHeading,
	failedPart,
	foundApps,
	glLine,
	GROUP_LABEL,
	installedText,
	installLabel,
	KIND_LABEL,
	lastTryFailed,
	moreCommits,
	NO_RESTORE,
	noMatch,
	noMint,
	notInstalledLine,
	PACKAGES_FROM,
	rateText,
	releasedLabel,
	removeAsk,
	removedNote,
	RESTART,
	restartAllLabel,
	restartAsk,
	restartedNote,
	restartLine,
	restoredText,
	restoreLabel,
	resultCounts,
	retryLabel,
	RUN_TEXT,
	runSentence,
	selectionText,
	skipLabel,
	STAGE_NAME,
	stateSentence,
	statusText,
	stoppingLabel,
	stopSkipLabel,
	SYS,
	systemAbsent,
	systemChecked,
	systemProblem,
	systemSources,
	TEXT,
	tomlWriteFailed,
	versionText,
	WIN,
	workingText,
} from "./copy";

const run = (patch: Partial<RunState>): RunState => ({
	id: null,
	phase: "idle",
	index: 0,
	total: 0,
	currentKey: null,
	stopping: false,
	retry: false,
	results: [],
	...patch,
});

const sentence = (p: Partial<RunState>, ready = 0, problems = 0, currentName: string | null = null) =>
	stateSentence({ run: run(p), ready, problems, currentName });

const result = (r: RunResult["result"]): RunResult => ({ key: "k", name: "n", from: null, to: null, result: r, ms: 1 });

const app = (patch: Partial<AppState>): AppState => ({
	key: "fd",
	name: "fd",
	kind: "archive",
	installed: "10.5.1",
	latest: "10.5.2",
	status: "ready",
	running: false,
	restartToApply: false,
	restorePoints: [],
	canRestore: true,
	auto: false,
	sudo: false,
	versionless: false,
	stages: [],
	held: false,
	...patch,
});

test("state sentence", () => {
	expect(sentence({ phase: "checking", index: 20, total: 32 })).toBe("Checking 20 of 32");
	expect(sentence({}, 1)).toBe("1 update ready");
	expect(sentence({}, 7)).toBe("7 updates ready");
	expect(sentence({})).toBe("Everything is fresh");
	expect(sentence({}, 0, 3)).toBe("3 need a look");
	expect(sentence({}, 0, 1)).toBe("1 needs a look");
	expect(sentence({ phase: "installing", index: 2, total: 4 }, 0, 0, "Zen Browser")).toBe(
		"Installing Zen Browser, 2 of 4",
	);
	expect(sentence({ phase: "summary", results: [result("updated"), result("updated")] })).toBe("2 updated");
	expect(sentence({ phase: "summary", results: [result("updated"), result("failed"), result("rolled_back")] })).toBe(
		"1 updated, 2 failed",
	);
});

test("install and selection labels", () => {
	expect(installLabel(0)).toBe("Install updates");
	expect(installLabel(1)).toBe("Install 1 update");
	expect(installLabel(4)).toBe("Install 4 updates");
	expect(selectionText(0, null)).toBe("Nothing selected");
	expect(selectionText(2, null)).toBe("2 selected");
	expect(selectionText(4, 110_143_744)).toBe("4 selected · 110 MB");
	expect(selectionText(4, 110_143_744, true, 1)).toBe("4 selected · at least 110 MB · 1 hidden");
});

test("status text", () => {
	expect(statusText(app({ status: "working", stage: "download", stagePct: 41.6 }))).toBe("Downloading 42%");
	expect(statusText(app({ status: "working", stage: "download", stagePct: 40, size: 30_000_000 }))).toBe(
		"Downloading 12.0 of 30 MB",
	);
	expect(statusText(app({ status: "working", stage: "backup" }))).toBe("Backing up");
	expect(statusText(app({ status: "working", stage: "verify" }))).toBe("Verifying");
	expect(statusText(app({ status: "done", installed: "10.5.2" }))).toBe("Updated to 10.5.2");
	expect(statusText(app({ status: "done", restartToApply: true }))).toBe("Restart fd to finish");
	expect(statusText(app({ status: "rolled_back", installed: "10.5.1" }))).toBe("Rolled back to 10.5.1");
	expect(statusText(app({ status: "held", skipped: "10.5.2" }))).toBe("Skipping 10.5.2");
	expect(statusText(app({ status: "held" }))).toBe("Held");
});

test("the System group's problem lines name the source and end cleanly without a detail", () => {
	expect(systemProblem({ code: "missing", command: "dpkg-query -W" })).toBe(
		"dpkg-query -W is not installed, so this part of the list is empty.",
	);
	expect(systemProblem({ code: "failed", command: "mintupdate-cli list", detail: "E: lock" })).toBe(
		"Could not read the Update Manager list: E: lock",
	);
	expect(systemProblem({ code: "failed", command: "flatpak remote-ls --updates", detail: "" })).toBe(
		"Could not read the Flatpak list.",
	);
	expect(systemChecked("2 minutes ago", false)).toBe("From Update Manager, checked 2 minutes ago");
	expect(systemChecked(null, true)).toBe("From Update Manager, checking");
	expect(systemChecked(null, false)).toBe("From Update Manager");
	expect(systemChecked("just now", false, "Flatpak")).toBe("From Flatpak, checked just now");
	// A tool the system does not have is said quietly; anything else missing is still a problem.
	expect(systemAbsent({ code: "missing", command: "mintupdate-cli list" })).toBe(
		"No package list Upkeep can read is installed (Update Manager, apt, dnf, pacman or zypper). Flatpak updates still show here.",
	);
	expect(systemAbsent({ code: "missing", command: "flatpak remote-ls --updates --columns=ref,name,version" })).toBe(
		"Flatpak is not installed, so only package updates are listed.",
	);
	expect(systemAbsent({ code: "missing", command: "dpkg-query -W" })).toBeNull();
	expect(systemAbsent({ code: "failed", command: "mintupdate-cli list", detail: "x" })).toBeNull();
});

test("the build stage is named Build and reads Building while it runs", () => {
	expect(STAGE_NAME.build).toBe("Build");
	expect(workingText("build", null)).toBe("Building");
});

test("short labels carry the value they are given", () => {
	expect(restoreLabel("1.2.3")).toBe("Restore 1.2.3");
	expect(skipLabel("1.2.3")).toBe("Skip 1.2.3");
	expect(stopSkipLabel("1.2.3")).toBe("Stop skipping 1.2.3");
	expect(releasedLabel("3 days ago")).toBe("Released 3 days ago");
	expect(checkedTitle("just now")).toBe("Checked just now");
	expect(restoredText("1.2.3")).toBe("Restored 1.2.3.");
	expect(stoppingLabel("fd")).toBe("Stopping after fd");
	expect(retryLabel(2)).toBe("Retry 2 failed");
	expect(rateText(40, 60)).toBe("GitHub requests left this hour: 40 of 60");
	expect(versionText("0.1.0")).toBe("Version 0.1.0");
	expect(notInstalledLine("2.0")).toBe("Not installed. 2.0 is the latest.");
	expect(installedText("2.0")).toBe("Installed 2.0");
	expect(lastTryFailed("Timed out.")).toBe("Last try failed. Timed out.");
});

test("list lines name what is left and quote the filter as typed", () => {
	expect(commitsHeading(1, "abc123")).toBe("1 commit since abc123");
	expect(commitsHeading(3, null)).toBe("3 commits since the installed build");
	expect(moreCommits(30, 20)).toBe("All 30 on GitHub (10 not shown)");
	expect(restartLine(["Zen", "Cursor"])).toBe("Restart Zen, Cursor to finish.");
	expect(byHandLine(3)).toBe("3 more by hand");
	expect(allFreshLine(5)).toBe("All 5 apps are up to date.");
	expect(noMatch("fd")).toBe('No app matches "fd".');
});

test("the add pane says one app or many", () => {
	expect(ADD.button).toBe("Add app");
	expect(addedOne("fd")).toBe("Added fd.");
	expect(addedMany(1)).toBe("Added 1 app.");
	expect(addedMany(3)).toBe("Added 3 apps.");
	expect(foundApps(1)).toBe("Found 1 app not in the list");
	expect(foundApps(2)).toBe("Found 2 apps not in the list");
	expect(addApps(1)).toBe("Add 1 app");
	expect(addApps(2)).toBe("Add 2 apps");
	expect(removeAsk("fd")).toBe("Remove fd from the list? The app itself stays installed.");
	expect(removedNote("fd")).toBe("Removed fd.");
});

test("a run's sentence counts failures and says when it was a retry", () => {
	expect(resultCounts([{ result: "updated" }, { result: "rolled_back" }, { result: "failed" }])).toBe(
		"1 updated, 2 failed",
	);
	expect(runSentence([{ result: "updated" }])).toBe("1 updated");
	expect(runSentence([{ result: "failed", retry: true }])).toBe("Retry: 0 updated, 1 failed");
});

test("a failed apps.toml write says nothing was changed", () => {
	expect(tomlWriteFailed("disk full")).toBe("Could not write apps.toml: disk full. Nothing was changed.");
});

test("a download shows the received part in the total's own unit, or the percent when the size is unknown", () => {
	expect(workingText(undefined, null)).toBe("Downloading");
	expect(workingText(undefined, 50)).toBe("Downloading 50%");
	expect(workingText("download", 50, 30_000_000)).toBe("Downloading 15.0 of 30 MB");
	expect(workingText("install", 50)).toBe("Installing");
	expect(workingText("verify", null)).toBe("Verifying");
});

test("only a missing Update Manager counts as no Mint", () => {
	expect(noMint({ code: "missing", command: "mintupdate-cli list" })).toBe(true);
	expect(noMint({ code: "missing", command: "flatpak list" })).toBe(false);
	expect(noMint(null)).toBe(false);
});

test("the GPU line names the runtime version", () => {
	expect(glLine("580.1")).toContain("NVIDIA 580.1 runtime");
});

test("restart copy: one app or several, and what closing costs", () => {
	expect(restartAsk(["Zen Browser"])).toBe("Zen Browser will close and reopen. Unsaved work in it is lost.");
	expect(restartAsk(["Zen", "Lutris"])).toBe("Zen, Lutris will close and reopen. Unsaved work in them is lost.");
	expect(restartAllLabel(["RustDesk"])).toBe("Restart RustDesk now");
	expect(restartAllLabel(["RustDesk", "Zen"])).toBe("Restart 2 apps now");
	expect(restartedNote(["RustDesk", "Zen"])).toBe("Restarted RustDesk, Zen.");
});

test("a failed package list is named by its own tool", () => {
	expect(systemProblem({ code: "failed", command: "apt list --upgradable", detail: "E: x" })).toBe(
		"Could not read the apt list: E: x",
	);
	expect(systemProblem({ code: "failed", command: "dnf -q check-update", detail: "" })).toBe(
		"Could not read the dnf list.",
	);
	expect(systemProblem({ code: "failed", command: "checkupdates", detail: "" })).toBe(
		"Could not read the pacman list.",
	);
	expect(PACKAGES_FROM.pacman).toBe("pacman");
	expect(systemProblem({ code: "failed", command: "zypper -n -q --no-refresh list-updates", detail: "" })).toBe(
		"Could not read the zypper list.",
	);
});

test("every label in the copy tables is words, read through its getter", () => {
	// JSON.stringify reads each getter, so every label is drawn the way the window draws it.
	const tables = [
		KIND_LABEL,
		STAGE_NAME,
		GROUP_LABEL,
		COLUMN,
		CHIP,
		TEXT,
		NO_RESTORE,
		RUN_TEXT,
		ADD,
		RESTART,
		WIN,
		SYS,
		PACKAGES_FROM,
		CHECK_EVERY,
	];
	const labels = [...JSON.stringify(tables).matchAll(/:"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? "");
	expect(labels.length).toBeGreaterThan(150);
	expect(labels.filter((l) => !/\p{L}/u.test(l))).toEqual([]);
});

test("Cleanup's labels are words, and its sentences carry their values", () => {
	const labels = [...JSON.stringify(CLEAN).matchAll(/:"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? "");
	expect(labels.length).toBeGreaterThan(60);
	expect(labels.filter((l) => !/\p{L}/u.test(l))).toEqual([]);
	expect(kernelsLine("6.8.0-149", "6.8.0-149")).toBe("Running 6.8.0-149.");
	expect(kernelsLine("6.8.0-147", "6.8.0-149")).toBe("Running 6.8.0-147, newest installed 6.8.0-149.");
	expect(snapshotsLine(1, "2026-11-12")).toBe("1 snapshot. Newest 2026-11-12.");
	expect(copiesLine(39)).toBe("39 copies.");
	expect(measuredLine("2 minutes ago")).toBe("Measured 2 minutes ago");
	expect(reviewLabel("2.4 GB")).toBe("Review 2.4 GB");
	expect(deleteLabel("2.4 GB")).toBe("Delete 2.4 GB");
	expect(totalLine("2.4 GB")).toBe("2.4 GB in all.");
	expect(finalLine(["Trash", "Restore points"])).toBe("Cannot be undone: Trash and Restore points.");
	expect(typeLabel("remove")).toBe("Type remove to also remove packages");
	expect(freedLine("43 MB")).toBe("Freed 43 MB.");
	expect(freedShort("43 MB")).toBe("43 MB freed");
});

test("the summary's failed part and an apps.toml failure are found without matching English words", () => {
	expect(failedPart([{ result: "updated" }, { result: "failed" }, { result: "rolled_back" }])).toBe("2 failed");
	expect(failedPart([{ result: "updated" }])).toBeNull();
	expect(resultCounts([{ result: "updated" }, { result: "failed" }]).split(", ")).toEqual(["1 updated", "1 failed"]);
	expect(failedPart([{ result: "failed" }])).toBe("1 failed");
	// The engine's own message and the window's both name the file, in any language.
	expect(aboutManifest("Could not write fd to apps.toml.")).toBe(true);
	expect(aboutManifest(tomlWriteFailed("permission denied"))).toBe(true);
	expect(aboutManifest("無法寫入 apps.toml")).toBe(true);
	expect(aboutManifest("fd is already in the list.")).toBe(false);
	expect(aboutManifest(null)).toBe(false);
});

test("the System subline names every source it read; Update Manager already covers Cinnamon's spices", () => {
	const snap = { source: "snap" };
	const spice = { source: "cinnamon" };
	expect(systemSources("mint", [{ source: "apt" }, spice])).toBe("Update Manager");
	expect(systemSources("apt", [snap, spice])).toMatch(/^apt, Snap,? and Cinnamon$/);
	expect(systemSources(null, [snap])).toBe("Flatpak and Snap");
	expect(
		systemProblem({ code: "failed", command: "cinnamon-spice-updater --list-json applet", detail: "offline" }),
	).toBe("Could not read the Cinnamon list: offline");
});
