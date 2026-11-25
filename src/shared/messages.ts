/**
 * Every sentence the engine writes that the window can show, one template each. The engine builds its English through
 * these, so the command line, the history file and the window's English are the same text as before. The window
 * reads an engine sentence back against these templates (src/mainview/lib/engine-text.ts) and words the matching one
 * in the language shown, from the catalogs; text that matches none, such as a tool's own output, is shown as it is.
 *
 * A template's values are names, versions, paths and raw tool output; a value may itself be a sentence from here,
 * which the window translates too. Log lines are not here: they stay English. Keep a template's wording and its
 * twin in engine-text.ts together; a test holds them to the same English.
 */

/** A value a template puts in its sentence. */
export type Value = string | number;

export const MESSAGES = {
	/** backup.ts. {0} version, JSON-quoted (JSON.stringify) */
	pointNameRefused: (v0: Value) => `${v0} cannot name a restore point`,
	/** backup.ts. {0} version */
	noRestorePoint: (v0: Value) => `No restore point ${v0}.`,
	/** backup.ts. {0} the restore argv joined with spaces; {1} exit code */
	commandExited: (v0: Value, v1: Value) => `${v0} exited ${v1}.`,
	/** backup.ts. {0} package tool (dpkg or rpm, never translated); {1} version */
	packageCouldNotPutBack: (v0: Value, v1: Value) => `${v0} could not put ${v1} back. See the log.`,
	/** backup.ts. {0} file name in the restore point; {1} raw stderr or stdout of install/mv, trimmed (can be run.ts:279 'size differs after copy') */
	couldNotRestoreFile: (v0: Value, v1: Value) => `Could not restore ${v0}: ${v1}`,
	/** backup.ts. {0} version of the restore point; {1} what tar said */
	couldNotUnpackPoint: (v0: Value, v1: Value) => `Could not unpack the ${v0} restore point: ${v1}`,
	/** discover.ts */
	badInput: () =>
		`Give an app's name, a repo like owner/name or gitlab.com/group/name, a GitHub, GitLab or Codeberg link, or a file path.`,
	/** discover.ts */
	catalogueOnlineWhy: () => `From Upkeep's catalogue online: a table added after this version of Upkeep came out.`,
	/** discover.ts */
	catalogueWhy: () => `From Upkeep's catalogue of tested apps.`,
	/** discover.ts. {0} repo owner/name */
	noPublishedRelease: (v0: Value) => `${v0} has no published release.`,
	/** discover.ts. {0} release tag */
	latestNotComparable: (v0: Value) => `The latest tag ${v0} is not a version Upkeep can compare.`,
	/** discover.ts. {0} repo owner/name */
	noAssetForMachine: (v0: Value) => `No asset of ${v0}'s latest release runs on this machine.`,
	/** discover.ts. {0} noAssetForMachine sentence */
	unopenedArchives: (v0: Value) => `${v0} Its Linux builds are .7z archives, which Upkeep cannot open yet.`,
	/** discover.ts. {0} the path, with ~ for home */
	otherProgramAtDest: (v0: Value) =>
		`${v0} is already there and is not this app's program (a script, or another tool with the same name). Adding would replace it; remove or rename it first.`,
	/** discover.ts. {0} program names joined with ', ' (358) or the single bin name (370) */
	itInstalls: (v0: Value) => `It installs ${v0}.`,
	/** discover.ts. {0} count of programs found (always more than 6); {1} MAX_BINS (6) */
	archiveHoldsMore: (v0: Value, v1: Value) => ` The archive holds ${v0} programs; only the first ${v1} are listed.`,
	/** discover.ts. {0} release asset name */
	matchedAsset: (v0: Value) => `Matched ${v0} for this machine.`,
	/** discover.ts. {0} path of the system copy; {1} dest, ~-shortened */
	systemCopyKept: (v0: Value, v1: Value) =>
		`A copy at ${v0} comes from the system's packages, so Upkeep will keep its own at ${v1}, which comes first on your PATH.`,
	/** discover.ts. {0} dest, ~-shortened */
	foundInstalledAt: (v0: Value) => `Found it installed at ${v0}.`,
	/** discover.ts. {0} dest, ~-shortened */
	nothingInstalledAt: (v0: Value) => `Nothing is installed at ${v0} yet, so Install will put it there.`,
	/** discover.ts */
	patternNeedsWidening: () => `The pattern is this release's exact asset name and will need widening.`,
	/** discover.ts */
	couldNotReadVersion: () => `Could not read the installed version with --version.`,
	/** discover.ts. {0} a tool manager: uv, pipx, npm or cargo */
	installedWith: (v0: Value) => `Installed with ${v0}. Upkeep updates it the same way.`,
	/** discover.ts. {0} app name */
	alreadyInList: (v0: Value) => `${v0} is already in the list.`,
	/** discover.ts. {0} app name; {1} Flatpak app id */
	alsoFlatpak: (v0: Value, v1: Value) =>
		`${v0} is also installed as a Flatpak (${v1}), which updates on its own: two copies, each with its own menu entry.`,
	/** discover.ts. {0} app name; {1} snap name */
	alsoSnap: (v0: Value, v1: Value) => `${v0} is also installed as a Snap (${v1}), which updates on its own.`,
	/** discover.ts. {0} package name */
	alsoAptRepo: (v0: Value) => `${v0} also comes from an apt repository, so the system's own updates install it too.`,
	/** discover.ts. {0} name of the app already in the list */
	alsoSameRepo: (v0: Value) => `${v0} in the list already follows the same project.`,
	/** discover.ts. {0} the tool's name; {1} the other manager: uv, pipx, npm or cargo */
	alsoOtherManager: (v0: Value, v1: Value) =>
		`${v1} has installed ${v0} too: two copies, each updated by its own manager. Remove one of them to keep one.`,
	/** discover.ts. {0} name of the app already in the list */
	alsoSameDest: (v0: Value) =>
		`${v0} in the list already installs to the same place, so the two would overwrite each other.`,
	/** discover.ts. {0} app name */
	notInstalledYet: (v0: Value) => `It is not installed here yet: Upkeep keeps ${v0} up to date once it is.`,
	/** bun/index.ts */
	uninstallInstalledOnly: () => `Only an installed Upkeep can uninstall itself.`,
	/** bun/index.ts */
	uninstallWaitRun: () => `Upkeep is installing something. Uninstall once it is done.`,
	/** bun/index.ts. {0} the install folder */
	uninstallRefused: (v0: Value) =>
		`Upkeep is not installed where an uninstall expects it (${v0}), so nothing was removed.`,
	/** discover.ts. {0} asset (archive) name */
	noProgramInArchive: (v0: Value) => `${v0} holds no program Upkeep can install.`,
	/** discover.ts. {0} fetch error message (raw) */
	couldNotReachGithubSearch: (v0: Value) => `Could not reach GitHub: ${v0}`,
	/** discover.ts */
	rateLimitSearch: () => `GitHub's request limit is used up. Try again after it resets.`,
	/** discover.ts. {0} HTTP status; {1} searched name (bare file name), not a repo */
	githubAnsweredSearch: (v0: Value, v1: Value) => `GitHub answered ${v0} for ${v1}.`,
	/** discover.ts. {0} file base name */
	unknownSource: (v0: Value) => `Could not tell where ${v0} comes from. Paste its repo or link to add it.`,
	/** discover.ts. {0} input as typed (558) or the expanded path (568) */
	noFileAt: (v0: Value) => `There is no file at ${v0}.`,
	/** discover.ts. {0} file base name */
	notTrackable: (v0: Value) => `${v0} is not a program Upkeep can track (it is not a compiled binary or an AppImage).`,
	/** discover.ts */
	appImageNamesSource: () => `The AppImage names its own release source.`,
	/** discover.ts. {0} repo owner/name */
	guessedFromFileName: (v0: Value) => `Guessed from the file name. Check that ${v0} is the right project.`,
	/** download.ts. {0} HTTP status */
	downloadHttpFailed: (v0: Value) => `Download failed: the server answered ${v0}.`,
	/** download.ts */
	downloadStalled: () => `Download stalled.`,
	/** download.ts. {0} bytes received; {1} asset size */
	downloadSizeMismatch: (v0: Value, v1: Value) => `Download is ${v0} bytes, expected ${v1}.`,
	/** download.ts. {0} bytes received */
	downloadTooSmall: (v0: Value) => `Download is ${v0} bytes, too small to be a release.`,
	/** download.ts */
	checksumMismatch: () => `Checksum does not match the release.`,
	/** download.ts. {0} the checksum file's name in the release (SHA256SUMS, checksums.txt, latest-linux.yml) */
	checksumFileMismatch: (v0: Value) =>
		`Checksum does not match ${v0} in the release, so nothing was installed. You can skip this version.`,
	/** download.ts */
	downloadLeftHttps: () => `The download was sent on to an address that is not https, so it was refused.`,
	/** engine.ts. {0} the release's tag */
	releaseChanged: (v0: Value) =>
		`The file behind ${v0} changed after Upkeep first saw it. Check the release page before you release the hold.`,
	/** engine.ts */
	reasonChecking: () => `A check is running.`,
	/** engine.ts */
	/** engine.ts. {0} app name: a command-line tool updated while a copy of it ran */
	oldCopyRuns: (v0: Value) =>
		`Updated. A copy of ${v0} that was running keeps the old version until it exits; new runs use the new one.`,
	reasonBusy: () => `A run is already in progress.`,
	/** engine.ts */
	reasonNothing: () => `Nothing to install.`,
	/** engine.ts */
	reasonStopping: () => `The run stops after the current app, so nothing more can join it.`,
	/** engine.ts. {0} restore point version */
	interruptedRestoreFromRow: (v0: Value) => `An update was interrupted. Restore ${v0} from this row.`,
	/** engine.ts. {0} app name (or key when the app left the list) */
	interruptedCheckStarts: (v0: Value) => `An update was interrupted. Check that ${v0} still starts.`,
	/** engine.ts. {0} app name */
	noUpdateToInstall: (v0: Value) => `${v0} has no update to install. Check again.`,
	/** engine.ts. {0} app name */
	cannotInstallHere: (v0: Value) => `${v0} cannot be installed here.`,
	/** engine.ts. {0} error message of the crash (raw) */
	runStopped: (v0: Value) => `The run stopped: ${v0}`,
	/** engine.ts and kinds, after Stop now. {0} version put back, or the one still in place */
	stoppedPutBack: (v0: Value) => `Stopped. ${v0} is back in place.`,
	/** kinds/command.ts, after Stop now cut an update with no restore command. {0} app name; {1} version it reports */
	stoppedStillAt: (v0: Value, v1: Value) => `Stopped. ${v0} still reports ${v1}.`,
	/** kinds/command.ts, after Stop now cut an update with no restore command. {0} app name; {1} why it will not start (raw or a probe sentence) */
	stoppedWontStart: (v0: Value, v1: Value) => `Stopped. ${v0} does not start now: ${v1}`,
	/** engine.ts, at Stop now during a step that is never cut. {0} the step, as the log names it (dpkg, git); {1} version */
	waitingThenPutBack: (v0: Value, v1: Value) => `Waiting for ${v0} to finish, then putting ${v1} back.`,
	/** engine.ts, at Stop now during a step that is never cut, with no restore point. {0} the step, as the log names it */
	waitingFor: (v0: Value) => `Waiting for ${v0} to finish.`,
	/** engine.ts. {0} app key */
	noApp: (v0: Value) => `No app ${v0}.`,
	/** engine.ts. {0} app name */
	alreadyRestarting: (v0: Value) => `${v0} is already restarting.`,
	/** engine.ts. {0} app key */
	noAppInList: (v0: Value) => `No app ${v0} in the list.`,
	/** engine.ts. {0} app name; {1} restore point version (empty when none) */
	interruptedPutBack: (v0: Value, v1: Value) => `An update was interrupted. ${v0} ${v1} was put back.`,
	/** engine.ts. {0} app key */
	kindNotAddable: (v0: Value) => `${v0}: kind is not one of appimage, archive, file, deb, rpm`,
	/** engine.ts. {0} dest as written (may start with ~); {1} other app's name */
	destBelongsTo: (v0: Value, v1: Value) => `${v0} already belongs to ${v1}.`,
	/** engine.ts. {0} app name */
	couldNotWriteAppsToml: (v0: Value) => `Could not write ${v0} to apps.toml.`,
	/** engine.ts. {0} the row's previous failure detail */
	lastTryFailed: (v0: Value) => `Last try failed. ${v0}`,
	/** github.ts. {0} API path, e.g. /repos/o/n/compare/a...b?per_page=1 */
	githubNotJson: (v0: Value) => `GitHub sent an answer for ${v0} that is not JSON.`,
	/** github.ts. {0} base commit sha or tag; {1} repo owner/name */
	githubUnknownRef: (v0: Value, v1: Value) => `GitHub does not know ${v0} in ${v1}.`,
	/** github.ts. {0} repo owner/name */
	githubNoComparison: (v0: Value) => `GitHub sent no comparison for ${v0}.`,
	/** github.ts. {0} repo owner/name */
	githubReleaseNotJson: (v0: Value) => `GitHub sent a release for ${v0} that is not JSON.`,
	/** github.ts. {0} repo owner/name */
	githubNoReleaseTag: (v0: Value) => `GitHub sent no release tag for ${v0}.`,
	/** github.ts. {0} URL; {1} fetch error message (raw) */
	couldNotReachUrl: (v0: Value, v1: Value) => `Could not reach ${v0}: ${v1}`,
	/** github.ts. {0} URL; {1} HTTP status */
	urlAnswered: (v0: Value, v1: Value) => `${v0} answered ${v1}.`,
	/** github.ts. {0} URL */
	urlSentNoVersion: (v0: Value) => `${v0} sent no version.`,
	/** github.ts. {0} repo owner/name from a github: source */
	noTrackedVersionTag: (v0: Value) => `${v0} has no tracked version tag.`,
	/** forge.ts. {0} host such as gitlab.com; {1} project path on it */
	forgeSentNoRelease: (v0: Value, v1: Value) => `${v0} sent no release for ${v1}.`,
	/** forge.ts. {0} host such as gitlab.com */
	forgeRateLimit: (v0: Value) => `${v0}'s request limit is used up. Try again after it resets.`,
	/** forge.ts. {0} host such as gitlab.com; {1} HTTP status; {2} project path on it */
	forgeAnswered: (v0: Value, v1: Value, v2: Value) => `${v0} answered ${v1} for ${v2}.`,
	/** forge.ts. {0} page URL; {1} the table's asset pattern */
	linksNoMatch: (v0: Value, v1: Value) => `${v0} lists no download matching ${v1}.`,
	/** forge.ts. {0} address of a .zsync file */
	zsyncUnreadable: (v0: Value) => `${v0} is not a zsync file that names its download.`,
	/** github.ts. {0} installed version */
	noVersionAtOrAbove: (v0: Value) => `No published version at or above ${v0}.`,
	/** github.ts. {0} the latest source string as written */
	unknownVersionSource: (v0: Value) => `Unknown version source ${v0}.`,
	/** kinds/built.ts */
	sudoRefused: () => `sudo needs a password here, so nothing was stopped or changed.`,
	/** kinds/built.ts. {0} resolved place target path */
	placeTargetInHome: (v0: Value) => `Refused ${v0}: a place target cannot be a folder directly in the home directory`,
	/** kinds/built.ts. {0} refusal from tree.ts safePath/realOf or built.ts:226 placeFromTo (no stop of its own) */
	refusedNothingChanged: (v0: Value) => `${v0}. Nothing was changed.`,
	/** kinds/built.ts. {0} busy entry's say text from apps.toml (written by the table's author) */
	busySayNothingChanged: (v0: Value) => `${v0} Nothing was changed.`,
	/** kinds/built.ts. {0} unit name from the table */
	couldNotStopUnit: (v0: Value) => `Could not stop ${v0}. Nothing was changed.`,
	/** kinds/built.ts. {0} dir as written in the table */
	localChanges: (v0: Value) => `${v0} has local changes. Nothing was changed.`,
	/** kinds/built.ts. {0} dir as written */
	commitsNotOnGithub: (v0: Value) => `${v0} has commits that are not on GitHub. Nothing was changed.`,
	/** kinds/built.ts. {0} release tag; {1} dir as written */
	couldNotFetchTag: (v0: Value, v1: Value) => `Could not fetch ${v0} into ${v1}. Nothing was changed.`,
	/** kinds/built.ts. {0} error from takeTree: tree.ts refusals, tree.ts:171/188, backup.ts:57, or raw 'cp x: output' / 'git rev-parse: output' */
	couldNotTakePoint: (v0: Value) => `Could not take a restore point: ${v0}. Nothing was changed.`,
	/** kinds/built.ts. {0} hold path as written */
	holdStepFailed: (v0: Value) => `Build step failed: hold ${v0}. Nothing was changed.`,
	/** kinds/built.ts. {0} dir as written; {1} release tag */
	cannotMoveWithoutMerge: (v0: Value, v1: Value) => `${v0} cannot move to ${v1} without a merge. Nothing was changed.`,
	/** kinds/built.ts. {0} the shell step as written in the table */
	buildStepFailed: (v0: Value) => `Build step failed: ${v0}. Nothing was changed.`,
	/** kinds/built.ts */
	checkFailedConfig: () => `The build did not pass its check: config. Nothing was changed.`,
	/** kinds/built.ts. {0} check_built shell step as written */
	checkFailedStep: (v0: Value) => `The build did not pass its check: ${v0}. Nothing was changed.`,
	/** kinds/built.ts */
	versionCheckLabel: () => `the version check`,
	/** kinds/built.ts */
	aTestLabel: () => `a test`,
	/** kinds/built.ts */
	oldVersionLabel: () => `the old version`,
	/** kinds/built.ts. {0} unit name; {1} previous version or 'the old version' */
	couldNotStopToPutBack: (v0: Value, v1: Value) => `Could not stop ${v0} to put ${v1} back. See the log.`,
	/** kinds/built.ts. {0} previous version or 'the old version'; {1} unit name, or the app name when the put-back threw */
	putBackFailedNoAnswer: (v0: Value, v1: Value) =>
		`Would not start after the update, and putting ${v0} back failed: ${v1} did not answer. See the log.`,
	/** kinds/built.ts. {0} previous version or 'the old version' */
	couldNotPlaceFiles: (v0: Value) => `Could not put the new files in place. Restored ${v0}.`,
	/** kinds/built.ts. {0} previous version (or 'the old version' here) */
	wouldNotStartRestored: (v0: Value) => `Would not start after the update. Restored ${v0}.`,
	/** kinds/built.ts. {0} test name, url, first argv word, 'a test', or 'the version check' (719); {1} previous version or 'the old version' */
	failedTest: (v0: Value, v1: Value) => `Failed its test after the update: ${v0}. Restored ${v1}.`,
	/** kinds/built.ts */
	updatedWithoutRestart: () => `Updated without a restart: none of its services was running.`,
	/** kinds/built.ts. {0} unit name */
	noAnswerAfterRestore: (v0: Value) => `${v0} did not answer after the restore. See the log.`,
	/** kinds/command.ts. {0} restore point version */
	wouldNotStartPutBackFailed: (v0: Value) =>
		`Would not start after the update, and putting ${v0} back failed. See the log.`,
	/** kinds/command.ts */
	wouldNotStartNoVersionKnown: () =>
		`Would not start after the update. No restore point: the installed version was not known.`,
	/** kinds/command.ts */
	wouldNotStartNoRestoreCommand: () => `Would not start after the update. Its table has no restore command.`,
	/** kinds/command.ts. {0} version */
	stillAtAfterCommand: (v0: Value) => `Still at ${v0} after the update command.`,
	/** kinds/command.ts. {0} version the app reports after the update */
	reportsVersion: (v0: Value) => `Reports ${v0}.`,
	/** kinds/context.ts */
	reasonUnrecovered: () => `An update was interrupted and could not be put back. Restore it from its row first.`,
	/** kinds/context.ts. {0} app name; {1} dest path or the check argv's first word */
	willNotStart: (v0: Value, v1: Value) => `${v0} will not start (${v1}).`,
	/** kinds/context.ts. {0} app name; {1} dest path; {2} the first line the program printed as it failed */
	willNotStartBecause: (v0: Value, v1: Value, v2: Value) => `${v0} will not start (${v1}): ${v2}`,
	/** kinds/context.ts. {0} probe detail: raw first line of the program's output, or a probe.ts sentence (versionProbePrintedNothing, neverReportedMount, metaMissing, metaNoVersion) or a raw error */
	versionProbeFailedWithDetail: (v0: Value) => `Version probe failed: ${v0}`,
	/** kinds/context.ts */
	versionProbeFailed: () => `Version probe failed.`,
	/** kinds/plugins.ts. {0} plugin ids joined with ', ' */
	couldNotUpdatePlugins: (v0: Value) => `Could not update ${v0}. See the log.`,
	/** kinds/plugins.ts. {0} count of plugins updated */
	pluginsUpdated: (v0: Value) => `Updated ${v0}. New sessions pick them up.`,
	/** kinds/plugins.ts. {0} plugin names joined with ', ' */
	pluginsWaiting: (v0: Value) => `New versions in their marketplaces: ${v0}.`,
	/** kinds/release.ts. {0} latest source string, e.g. npm:pkg */
	sourceGivesNoDownload: (v0: Value) => `${v0} gives a version but no download.`,
	/** kinds/release.ts. {0} release tag */
	latestTagNotTracked: (v0: Value) => `The latest tag ${v0} is not a tracked version.`,
	/** kinds/release.ts */
	rebuildFixes: () => `Will not start. A rebuild against the current libraries fixes it.`,
	/** kinds/release.ts. {0} app name */
	versionNotRecorded: (v0: Value) =>
		`${v0} does not report its version, and this copy was not installed by Upkeep. Installing the latest lets Upkeep keep track of it.`,
	/** kinds/release.ts, discover.ts. {0} app name; {1} the machine's architecture, x86_64 or aarch64 */
	noAssetForArch: (v0: Value, v1: Value) => `The table for ${v0} names no release file for ${v1} machines.`,
	/** kinds/release.ts. {0} asset pattern (regex) */
	noAssetMatches: (v0: Value) => `No release asset matches ${v0}.`,
	/** kinds/release.ts. {0} asset pattern; {1} matching asset names joined with ', ' */
	severalAssetsMatch: (v0: Value, v1: Value) =>
		`More than one release asset matches ${v0}: ${v1}. Narrow the pattern in apps.toml.`,
	/** kinds/release.ts. {0} app name */
	noReleaseAssetFor: (v0: Value) => `No release asset for ${v0}.`,
	/** kinds/release.ts. {0} dest base name */
	couldNotInstallFile: (v0: Value) => `Could not install ${v0}.`,
	/** kinds/release.ts. {0} asset name */
	couldNotExtract: (v0: Value) => `Could not extract ${v0}.`,
	/** kinds/release.ts. {0} the folder's path */
	folderNotOurs: (v0: Value) =>
		`${v0} is already there and Upkeep did not make it, so it is left alone. Move it, or point the table's folder somewhere new.`,
	/** kinds/release.ts, discover.ts. {0} archive file name; {1} the program tar needed: xz, bzip2 or zstd */
	archiveNeedsTool: (v0: Value, v1: Value) =>
		`Opening ${v0} needs the ${v1} program, which is not installed. Install ${v1} from the system's packages, then try again.`,
	/** kinds/release.ts. {0} program (bin) name; {1} restore point version */
	couldNotInstallRestored: (v0: Value, v1: Value) => `Could not install ${v0}. Restored ${v1}.`,
	/** kinds/release.ts. {0} program (bin) name; {1} restoreBackup detail (backup.ts sentences or run.ts SUDO_PASSWORD) */
	couldNotInstallRestoreFailed: (v0: Value, v1: Value) => `Could not install ${v0}. Restore failed: ${v1}`,
	/** kinds/release.ts. {0} program (bin) name */
	couldNotInstallNoPoint: (v0: Value) => `Could not install ${v0}. No restore point was taken.`,
	/** kinds/release.ts. {0} package tool (dpkg or rpm, never translated); {1} asset name; {2} restore point version */
	packageRestored: (v0: Value, v1: Value, v2: Value) => `${v0} could not install ${v1}. Restored ${v2}.`,
	/** kinds/release.ts. {0} package tool (dpkg or rpm, never translated); {1} asset name */
	packageSeeLog: (v0: Value, v1: Value) => `${v0} could not install ${v1}. See the log.`,
	/** kinds/release.ts. {0} package tool (dpkg or rpm, never translated); {1} asset name; {2} restore point version */
	packagePutBackFailed: (v0: Value, v1: Value, v2: Value) =>
		`${v0} could not install ${v1}, and putting ${v2} back failed. See the log.`,
	/** kinds/release.ts. {0} version */
	stillAtAfterUpdate: (v0: Value) => `Still at ${v0} after the update.`,
	/** kinds/release.ts */
	wouldNotStartNoPointTaken: () => `Would not start after the update. No restore point was taken.`,
	/** kinds/release.ts */
	wouldNotStartNoPointKind: () => `Would not start after the update. No restore point for this kind.`,
	/** kinds/source.ts */
	couldNotReadCommit: () => `Could not read the commit the installed copy was built from.`,
	/** kinds/source.ts */
	divergedCommit: () => `Built from a commit that is not on the release's history.`,
	/** kinds/source.ts. {0} release tag or version */
	refusedTag: (v0: Value) => `Refused ${v0}: not a plain version name. Nothing was changed.`,
	/** kinds/source.ts. {0} repo owner/name; {1} release tag */
	couldNotClone: (v0: Value, v1: Value) => `Could not clone ${v0} at ${v1}.`,
	/** kinds/source.ts. {0} shell step as written */
	buildStepTimedOut: (v0: Value) => `Build step timed out: ${v0}`,
	/** kinds/source.ts. {0} shell step as written */
	buildStepFailedClone: (v0: Value) => `Build step failed: ${v0}`,
	/** kinds/tree.ts. {0} path */
	refusedNotPlain: (v0: Value) => `Refused ${v0}: not a plain absolute path`,
	/** kinds/tree.ts. {0} path */
	refusedHoldsMore: (v0: Value) => `Refused ${v0}: it holds more than this table may change`,
	/** kinds/tree.ts. {0} path */
	refusedOutside: (v0: Value) => `Refused ${v0}: it is outside what this table may change`,
	/** kinds/tree.ts. {0} path */
	refusedLinkOutside: (v0: Value) => `Refused ${v0}: a link inside it leads outside what this table may change`,
	/** kinds/tree.ts. {0} path */
	refusedLinkNowhere: (v0: Value) => `Refused ${v0}: a link in it leads nowhere`,
	/** kinds/tree.ts. {0} record file name */
	recordNotPlainName: (v0: Value) => `record ${v0}: not a plain file name`,
	/** kinds/tree.ts. {0} first line of the needs command's output */
	needsPrintedNothing: (v0: Value) => `needs printed nothing: ${v0}`,
	/** kinds/tree.ts. {0} restore point directory path */
	noRestorePointAt: (v0: Value) => `No restore point at ${v0}.`,
	/** kinds/tree.ts. {0} undo shell step as written */
	undoStepFailed: (v0: Value) => `Undo step failed: ${v0}`,
	/** manifest.ts. {0} app key; {1} all kinds joined with ', ' */
	liftKindNotOneOf: (v0: Value, v1: Value) => `${v0}: kind is not one of ${v1}`,
	/** manifest.ts. {0} app key; {1} field name */
	liftMustBeString: (v0: Value, v1: Value) => `${v0}: ${v1} must be a string`,
	/** manifest.ts. {0} app key; {1} field name */
	liftMustBeList: (v0: Value, v1: Value) => `${v0}: ${v1} must be a list of strings`,
	/** manifest.ts. {0} app key; {1} field name */
	liftMustBeBool: (v0: Value, v1: Value) => `${v0}: ${v1} must be true or false`,
	/** manifest.ts. {0} app key; {1} field name; {2} kind */
	liftRequiredForKind: (v0: Value, v1: Value, v2: Value) => `${v0}: ${v1} is required for kind ${v2}`,
	/** manifest.ts. {0} app key; {1} the field, asset or asset_aarch64 */
	liftAssetNotRegex: (v0: Value, v1: Value) => `${v0}: ${v1} is not a valid regular expression`,
	/** manifest.ts. {0} app key */
	liftVersionlessOnly: (v0: Value) => `${v0}: versionless is only for kind claude-plugins`,
	/** manifest.ts. {0} app key */
	liftAppimageRepoOrLatest: (v0: Value) => `${v0}: repo or latest is required for kind appimage`,
	/** manifest.ts. {0} app key */
	liftProbeReleaseOnly: (v0: Value) => `${v0}: probe = false is only for an app installed from a release file`,
	/** manifest.ts. {0} app key */
	liftFolderPlace: (v0: Value) => `${v0}: folder must be a folder of its own under home, such as ~/.local/share/${v0}`,
	/** manifest.ts. {0} app key */
	liftLatestScheme: (v0: Value) =>
		`${v0}: latest must start with npm:, pypi:, github:, npm-tags:, json:, crates:, text:, links: or zsync:`,
	/** manifest.ts. {0} app key */
	liftJsonOnlyAppimage: (v0: Value) => `${v0}: a json: latest is only for kind appimage`,
	/** manifest.ts. {0} app key */
	liftRepoForm: (v0: Value) =>
		`${v0}: repo must be owner/name on GitHub, or host/owner/name such as gitlab.com/group/name or codeberg.org/owner/name`,
	/** manifest.ts. {0} app key; {1} host such as git.example.org */
	liftForgeNeeded: (v0: Value, v1: Value) => `${v0}: forge must say gitlab or gitea for a repo on ${v1}`,
	/** manifest.ts. {0} app key */
	liftForgeValues: (v0: Value) => `${v0}: forge must be gitlab or gitea`,
	/** manifest.ts. {0} app key */
	liftForgeOnlySelfHosted: (v0: Value) =>
		`${v0}: forge is only for a repo on a host other than github.com, gitlab.com or codeberg.org`,
	/** manifest.ts. {0} app key; {1} kind */
	liftRepoOrLinks: (v0: Value, v1: Value) => `${v0}: repo or a links: latest is required for kind ${v1}`,
	/** manifest.ts. {0} app key */
	liftLinksPage: (v0: Value) => `${v0}: a links: latest needs an https page and an asset pattern`,
	/** manifest.ts. {0} app key */
	liftLinksKinds: (v0: Value) => `${v0}: a links: latest is only for kinds appimage, archive, file, deb and rpm`,
	/** manifest.ts. {0} app key */
	liftZsyncAppimage: (v0: Value) => `${v0}: a zsync: latest is only for kind appimage, with an https address`,
	/** manifest.ts. {0} app key */
	liftRelaunchNeedsDest: (v0: Value) => `${v0}: relaunch needs dest`,
	/** manifest.ts. {0} app key */
	liftConfigDotDot: (v0: Value) => `${v0}: a config file may not contain a .. part`,
	/** requests.ts: Import pressed on an ask the main process no longer holds. */
	importNothingAsked: () => "There is no file waiting to import. Press Import and pick it again.",
	/** manifest.ts. {0} app key */
	liftDestDotDot: (v0: Value) => `${v0}: dest may not contain a .. part`,
	/** manifest.ts. {0} app key */
	liftRelaunchNeedsProcess: (v0: Value) => `${v0}: relaunch needs process`,
	/** manifest.ts. {0} app key; {1} process name */
	liftRelaunchShared: (v0: Value, v1: Value) =>
		`${v0}: relaunch would close every ${v1} process; give process the app's own name`,
	/** manifest.ts. {0} app key; {1} field: keep, hold or prune */
	liftInsideDir: (v0: Value, v1: Value) => `${v0}: ${v1} must stay inside dir`,
	/** manifest.ts. {0} app key */
	liftHoldInKeep: (v0: Value) => `${v0}: every hold path must also be in keep`,
	/** manifest.ts. {0} app key */
	liftPlaceInHome: (v0: Value) => `${v0}: place to cannot be a folder directly in the home directory`,
	/** manifest.ts. {0} app key */
	liftStageUnsafe: (v0: Value) => `${v0}: stage cannot be the home directory or the live copy`,
	/** manifest.ts. {0} app key */
	liftSourceCheckOrDest: (v0: Value) => `${v0}: check or dest is required for kind source`,
	/** manifest.ts. {0} app key */
	liftSourceRepoOrLatest: (v0: Value) => `${v0}: repo or latest is required for kind source`,
	/** manifest.ts. {0} app key */
	liftMoveValues: (v0: Value) => `${v0}: move must be ff, reset or detach`,
	/** manifest.ts. {0} app key */
	liftMoveNeedsDir: (v0: Value) => `${v0}: move needs dir`,
	/** manifest.ts. {0} app key */
	liftCommitNeedsRepo: (v0: Value) => `${v0}: commit needs a GitHub repo`,
	/** manifest.ts. {0} app key; {1} list field (record, config, place, busy, pause, test, serve) */
	liftEntryNotTable: (v0: Value, v1: Value) => `${v0}: ${v1} entry 1 needs to be a table`,
	/** manifest.ts. {0} app key; {1} list field; {2} 1-based entry number */
	liftEntryBadPattern: (v0: Value, v1: Value, v2: Value) => `${v0}: ${v1} entry ${v2} has an invalid pattern`,
	/** manifest.ts. {0} app key; {1} list field; {2} 1-based entry number; {3} what is missing: one of the fragments listed in notes */
	liftEntryNeeds: (v0: Value, v1: Value, v2: Value, v3: Value) => `${v0}: ${v1} entry ${v2} needs ${v3}`,
	/** manifest.ts. {0} app key; {1} 1-based entry number */
	liftBusyWhen: (v0: Value, v1: Value) => `${v0}: busy entry ${v1} when must be stopped`,
	/** manifest.ts. {0} app key; {1} placeholder name; {2} field name */
	liftUnknownPlaceholder: (v0: Value, v1: Value, v2: Value) => `${v0}: unknown placeholder {${v1}} in ${v2}`,
	/** manifest.ts. {0} file label ('apps' for an import) */
	manifestNoAppsTables: (v0: Value) => `${v0}: no [apps.<key>] tables`,
	/** manifest.ts. {0} file label */
	manifestAppsNotTable: (v0: Value) => `${v0}: apps is not a table of [apps.<key>] tables`,
	/** manifest.ts. {0} app key */
	manifestEntryNotTable: (v0: Value) => `${v0}: is not a table`,
	/** probe.ts */
	versionProbePrintedNothing: () => `The version probe printed nothing.`,
	/** probe.ts. {0} AppImage path */
	neverReportedMount: (v0: Value) => `${v0} never reported a mount point.`,
	/** probe.ts. {0} meta_path from the table; {1} AppImage path */
	metaMissing: (v0: Value, v1: Value) => `${v0} is missing inside ${v1}.`,
	/** probe.ts. {0} meta_path from the table */
	metaNoVersion: (v0: Value) => `${v0} names no version.`,
	/** restart.ts */
	nothingToStart: () => `nothing to start`,
	/** restart.ts. {0} app name */
	restartSudoPassword: (v0: Value) => `sudo needs a password here. Restart ${v0} yourself.`,
	/** restart.ts. {0} app name */
	noRestartHow: (v0: Value) => `${v0}'s table does not say how to restart it.`,
	/** restart.ts. {0} app name */
	didNotClose: (v0: Value) => `${v0} did not close. Close it, then open it again.`,
	/** restart.ts. {0} app name; {1} spawn error message (raw) or 'nothing to start' */
	closedNotStarted: (v0: Value, v1: Value) => `${v0} closed, but could not be started again: ${v1}`,
	/** run.ts */
	sudoPassword: () => `sudo needs a password here. Run the update from a terminal.`,
	/** run.ts */
	sizeDiffersAfterCopy: () => `size differs after copy`,
	/** transfer.ts. {0} JSON.parse error message (raw) */
	importNotJson: (v0: Value) => `not JSON: ${v0}`,
	/** transfer.ts */
	importNotObject: () => `not an Upkeep export: the file is not an object`,
	/** transfer.ts */
	importWrongVersion: () => `not an Upkeep export this version reads: no "upkeep": 1`,
	/** transfer.ts */
	importNoApps: () => `the export has no "apps" text`,
	/** transfer.ts. {0} fs error message (raw) */
	importCouldNotWrite: (v0: Value) => `could not write: ${v0}.`,
	/** transfer.ts. {0} importCouldNotWrite sentence */
	importSomeNotPutBack: (v0: Value) => `${v0} Some files could not be put back:`,
	/** transfer.ts. {0} file path; {1} path of the .pre-import copy */
	importCopyFromBefore: (v0: Value, v1: Value) => `${v0}: its copy from before is ${v1}`,
	/** transfer.ts. {0} file path */
	importCreatedNotRemoved: (v0: Value) => `${v0}: written by this import, and could not be removed`,
	/** discover.ts. {0} the build file the steps were drafted from, e.g. Cargo.toml */
	draftedFrom: (v0: Value) =>
		`No file of this release runs on this machine, so Upkeep drafted a source build from its ${v0}. Read the steps before adding it.`,
	/** discover.ts. {0} the program name taken from the repo's name */
	draftNamedAfterRepo: (v0: Value) =>
		`It takes the program to be ${v0}, after the repo; change the path if the build installs another name.`,
	/** discover.ts. {0} the path of a copy in the home folder that PATH finds first */
	draftOtherCopyFirst: (v0: Value) =>
		`A copy at ${v0} runs first on your PATH; remove it once the build is in, or it keeps running instead.`,
	/** discover.ts. {0} the missing build tools, comma-separated */
	draftNeedsTools: (v0: Value) => `Building it needs ${v0}, which is not installed.`,
	/** requests.ts and cli.ts: an import refused because a run holds the lock */
	importDuringRun: () => `An Upkeep run is in progress. Try again when it ends.`,
	/** extras/install.ts: refused before anything ran */
	systemSudo: () =>
		`sudo needs a password here, so nothing was installed. Install these from the system's own updater.`,
	/** extras/install.ts: refused, another process holds the dpkg lock */
	systemAptBusy: () =>
		`Update Manager or another installer is using the package system, so nothing was installed. Try again when it finishes.`,
	/** extras/install.ts: refused, pkcheck says Flatpak would ask */
	systemPolkit: () => `Flatpak would ask for a password here, so nothing was installed.`,
	/** extras/install.ts. {0} kernel or NVIDIA packages the trial run named, comma-separated */
	systemTrialNamesRestart: (v0: Value) =>
		`A trial run would also change ${v0}, which Update Manager installs with a restart, so nothing was installed.`,
	/** extras/install.ts. {0} the trial run's first line of output, or its exit code */
	/** install.ts. {0} the packages the trial run would remove, comma-separated */
	systemTrialRemoves: (v0: Value) =>
		`The trial run would remove ${v0}, so nothing was installed. Update Manager can install this one.`,
	systemTrialFailed: (v0: Value) => `The trial run failed, so nothing was installed: ${v0}`,
	/** extras/install.ts: refused, the list differs from what the person confirmed */
	systemListChanged: () => `The system's list changed since you looked. Look at it again, then install.`,
	/** extras/install.ts: refused, no ticked row is one Upkeep installs */
	systemNothing: () => `None of these is a system update Upkeep installs.`,
	/** extras/install.ts: a ticked row still listed after its step ran */
	systemStillPending: () => `Still pending after the install. See the log.`,
	/** extras/install.ts. {0} the command, argv joined with spaces */
	systemTimedOut: (v0: Value) => `${v0} ran past its time limit and was stopped.`,
	/** extras/install.ts: a Flatpak app that was running during its update */
	/** extras/install.ts. {0} the first line of the failed re-read */
	systemNotRechecked: (v0: Value) => `Could not read the list again to see whether it installed: ${v0}`,
	systemRestartApp: () => `Updated. Restart it to use the new version.`,
	/** extras/cleanup.ts: a part whose size or time differs from what the review showed */
	cleanChanged: () => `Skipped: changed since you reviewed it.`,
	/** extras/cleanup.ts: a root part, and sudo -n true failed */
	cleanSudo: () => `Skipped: sudo needs a password here.`,
	/** extras/cleanup.ts: a Flatpak runtime, and pkcheck says removing it would ask */
	cleanPolkit: () => `Skipped: Flatpak would ask for a password here.`,
	/** extras/cleanup.ts. {0} the word to type (remove, never translated) */
	cleanTypeFirst: (v0: Value) => `Type ${v0} first. Nothing was deleted.`,
	/** extras/cleanup.ts: refused, the commands differ from what the person reviewed */
	cleanListChanged: () => `What Cleanup would do changed since you looked. Look at it again, then delete.`,
	/** extras/cleanup.ts: refused, nothing picked is something Cleanup deletes */
	cleanNothing: () => `Nothing ticked is something Cleanup deletes.`,
	/** extras/cleanup.ts. {0} path; {1} raw fs error message */
	cleanCouldNotDelete: (v0: Value, v1: Value) => `Could not delete ${v0}: ${v1}`,
	/** extras/cleanup.ts. {0} path that is a link, outside the folder, or on another file system */
	cleanRefusedPath: (v0: Value) => `Left ${v0} alone: it is not inside the folder being cleaned.`,
	/** bun/self-update.ts: the pre-flight found too little room for the download, the test copy and the kept copy */
	selfNoSpace: () => `Not enough free space to update Upkeep.`,
	/** bun/self-update.ts: the start script needs a shell */
	selfNoShell: () => `Cannot update Upkeep here: /bin/sh is missing.`,
	/** bun/self-update.ts: the framework could not download or verify the new version */
	selfDownload: () => `Could not download the update. Nothing was changed.`,
	/** bun/self-update.ts: refused while a run, a check, a system install, a cleanup or a restore is going */
	selfBusy: () => `Finish what is running first.`,
	/** bun/self-update.ts. {0} the new version, which did not come up when started as a test before the swap */
	selfTestFailed: (v0: Value) => `Upkeep ${v0} failed its start test, so nothing was changed.`,
	/** bun/self-update.ts. {0} the new version, whose swap did not happen */
	selfNotApplied: (v0: Value) => `The update to Upkeep ${v0} was not applied. Nothing was changed.`,
} satisfies Record<string, (...values: Value[]) => string>;

export type MessageId = keyof typeof MESSAGES;
