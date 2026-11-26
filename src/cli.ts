import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MESSAGES } from "./shared/messages";
import type {
	AppState,
	DownloadCheck,
	EngineEvent,
	ImportAsk,
	ImportProtection,
	ImportSwitch,
	Suggestion,
} from "./shared/types";
import { listBackups } from "./engine/backup";
import { createEngine, type Engine, type EngineDeps } from "./engine/engine";
import { ensureManifest, loadManifest } from "./engine/manifest";
import { realDeps } from "./engine/real";
import { CATALOGUE_URL } from "./bun/about";
import { SNAPSHOT_KEY } from "./engine/extras/snapshot";
import { heldLine, localDay, metricsText, statusLines, statusOf } from "./engine/status";
import { claimLock, formatLogLine, loadState, lockHeld, readInflight, releaseLock } from "./engine/store";
import { exportSetup, importSetup } from "./engine/transfer";
import pkg from "../package.json";

export const USAGE = [
	"Usage: upkeep <command> [--json]",
	"  check                  check every app; one line each",
	"  status [--metrics]     what the last check found, without checking; --metrics in Prometheus text format",
	"  install <key>...|--all|--auto   an app named here skips the release wait set in Settings",
	"  restore <key> [version]",
	"  history                the last 200 runs",
	"  recover                finish or undo an interrupted built update",
	"  list                   the apps in apps.toml",
	"  add <name|owner/repo|link|file>",
	"  remove <key>           take an app off the list; the app stays installed",
	"  hold <key> on|off      hold an app's updates, or release a hold (also one Upkeep put on a changed release)",
	"  pause <key> <days>|off pause an app's updates for 1 to 365 days, or end the pause now",
	"  export [file]          settings and app list as one JSON file (stdout without a file)",
	"  import <file> [--yes]  replace settings and app list from an export; --yes when its apps run commands",
	"--json prints one JSON value per line instead of text.",
].join("\n");

type Out = (line: string) => void;

/** One line per app, as OK, UPDATE, HELD, BROKEN or SKIP first, so a script or a glance reads the state from the first word. */
export function checkLine(a: AppState): string {
	switch (a.status) {
		case "fresh":
		case "done":
			return a.installed ? `  OK:     ${a.name} ${a.installed}` : `  OK:     ${a.name}`;
		case "ready":
		case "manual":
			// Claude Code's plugins have no one version; their detail names the plugins that wait.
			if (a.versionless) return `  UPDATE: ${a.name}${a.detail ? ` ${a.detail}` : ""}`;
			return `  UPDATE: ${a.name} ${a.installed ?? "unknown"} -> ${a.latest ?? "unknown"}`;
		// install --all passes these by, so they are not offered as updates.
		case "held":
			return heldLine(a);
		default: {
			const detail = a.detail ?? "";
			const broken = `${a.name} will not start`;
			if (detail.startsWith(broken)) return `  BROKEN: ${a.name} ${detail.slice(a.name.length + 1)}`;
			if (detail.startsWith("will not start")) return `  BROKEN: ${a.name} ${detail}`;
			return `  SKIP:   ${a.name} ${detail}`;
		}
	}
}

/** The line `install` prints for an event, or null for events a person has no use for (a working app, for instance). */
function eventLine(e: EngineEvent): string | null {
	if (e.type === "log") return formatLogLine(e.line);
	if (e.type === "app" && ["queued", "working", "done", "failed", "rolled_back", "stopped"].includes(e.app.status)) {
		// A waiting app whose file came early already has its log line ("Downloaded ahead of its turn").
		if (e.app.status === "working" || (e.app.status === "queued" && e.app.downloaded)) return null;
		const to = e.app.status === "done" ? ` ${e.app.installed ?? ""}` : "";
		return `[${e.app.key}] ${e.app.status}${to}${e.app.detail ? ` ${e.app.detail}` : ""}`;
	}
	return null;
}

/** Prints one line per app as its check ends. Problems are lines, not a failed check: it exits 0. */
async function check(engine: Engine, json: boolean, out: Out): Promise<number> {
	const printed = new Set<string>();
	const off = engine.subscribe((e) => {
		if (e.type !== "app" || e.app.status === "checking" || printed.has(e.app.key)) return;
		printed.add(e.app.key);
		out(json ? JSON.stringify(e.app) : checkLine(e.app));
	});
	await engine.check();
	await engine.idle();
	off();
	return 0;
}

/** The signals install turns into Stop now: Ctrl-C, a kill or systemd's stop, and the terminal closing. */
type StopSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

/** Where install hears Ctrl-C, SIGTERM and SIGHUP, and how it quits at once; tests pass a fake that raises them. */
export type Signals = {
	on(name: StopSignal, fn: () => void): void;
	off(name: StopSignal, fn: () => void): void;
	exit(code: number): void;
};

/**
 * Between the check and the run's first app: starting is set while engine.install() recovers an earlier interrupted
 * update and claims the lock; pending records a press that came then, to be turned into Stop now once the run starts.
 */
export type Starting = { starting: boolean; pending: boolean };

/**
 * The first Ctrl-C, SIGTERM or SIGHUP during an install is Stop now: the current app is put back and the rest do not
 * start. A second one ends the step in progress (TERM, then KILL after 5 s) and quits, which can leave that app
 * half-installed; a step that runs as root cannot be ended from here, so it keeps running and the line says so. During
 * the check before the install nothing is being changed, so the first one quits at once. While the install starts (it
 * may be finishing an earlier interrupted update) the first one waits for that, then stops before any app; a second
 * one quits mid-recovery. Returns the function that stops listening.
 */
export function stopOnSignal(
	engine: Pick<Engine, "snapshot" | "stopNow" | "endStep">,
	signals: Signals,
	out: Out,
	gate: Starting,
): () => void {
	let quitting = false;
	const onSignal = () => {
		const run = engine.snapshot().run;
		const name = engine.snapshot().apps.find((a) => a.key === run.currentKey)?.name ?? "the current app";
		if (gate.starting && run.phase !== "installing") {
			if (gate.pending) {
				out("Quit while an earlier interrupted update was being finished or undone. Run upkeep recover.");
				return signals.exit(130);
			}
			gate.pending = true;
			out("Stopping: no app will be installed. Press Ctrl-C again to quit at once.");
			return;
		}
		if (run.phase !== "installing") return signals.exit(130);
		if (run.stoppingNow) {
			// Children run in their own process groups, so the terminal's Ctrl-C never reached the step: end it here.
			if (quitting) return;
			quitting = true;
			void engine.endStep().then((left) => {
				// With no step left to end, the put-back may already have finished: say so rather than assume it did not.
				out(
					left === null
						? `Quit while ${name} was being stopped. Run upkeep recover to make sure it is back in place.`
						: left.root
							? `Quit before ${name} was put back. ${left.step} runs as root and is still running; run upkeep recover once it ends.`
							: `Quit before ${name} was put back. Run upkeep recover.`,
				);
				signals.exit(130);
			});
			return;
		}
		out(`Stopping: putting ${name} back. Press Ctrl-C again to quit at once, which can leave ${name} half-installed.`);
		engine.stopNow();
	};
	const names: StopSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];
	for (const n of names) signals.on(n, onSignal);
	return () => {
		for (const n of names) signals.off(n, onSignal);
	};
}

/**
 * Checks first, then installs the named apps, or all ready ones with `--all`, or the automatic ones with `--auto`. An
 * app named by key skips the release wait, as Install now anyway does in the window; --all and --auto keep it. Exits 0
 * only when every result is "updated".
 */
async function install(engine: Engine, args: string[], json: boolean, out: Out, signals: Signals): Promise<number> {
	const gate: Starting = { starting: false, pending: false };
	const unlisten = stopOnSignal(engine, signals, out, gate);
	try {
		return await installRun(engine, args, json, out, gate);
	} finally {
		unlisten();
	}
}

/** install's body, with Ctrl-C already turned into Stop now; a press while the install starts stops it once started. */
async function installRun(engine: Engine, args: string[], json: boolean, out: Out, gate: Starting): Promise<number> {
	await engine.check();
	await engine.idle();
	const auto = args.includes("--auto");
	// An app named by key skips the release wait; --all and --auto keep it.
	const named = !args.includes("--all") && !auto;
	const keys = args.includes("--all") ? engine.readyKeys(false) : args;
	const off = engine.subscribe((e) => {
		if (json) out(JSON.stringify(e));
		else {
			const line = eventLine(e);
			if (line) out(line);
		}
	});
	gate.starting = true;
	const r: Awaited<ReturnType<Engine["installAuto"]>> = auto
		? await engine.installAuto()
		: await engine.install(keys, named);
	gate.starting = false;
	// Waiting for an unmetered connection or mains power is the setting working, not a failure.
	if (r.wait) {
		off();
		const reason = `Automatic updates wait: ${r.wait === "metered" ? "the connection is metered" : "on battery"}.`;
		out(json ? JSON.stringify({ started: false, wait: r.wait, reason }) : reason);
		return 0;
	}
	// Pressed during the recovery or setup: the run stops before its first app.
	if (r.started && gate.pending) engine.stopNow();
	if (!r.started) {
		off();
		const reason = r.reason ?? "Nothing to install.";
		out(json ? JSON.stringify({ started: false, reason }) : reason);
		return 1;
	}
	await engine.idle();
	off();
	const results = engine.snapshot().run.results;
	return results.length > 0 && results.every((x) => x.result === "updated") ? 0 : 1;
}

/** Puts back a named version, or the newest restore point when none is named. Exits 1 when there is none or the restore fails. */
async function restore(
	engine: Engine,
	deps: EngineDeps,
	key: string,
	version: string | undefined,
	json: boolean,
	out: Out,
): Promise<number> {
	const v = version ?? listBackups(deps.paths, key)[0]?.version;
	if (!v) {
		out(
			json
				? JSON.stringify({ key, ok: false, detail: `No restore point for ${key}.` })
				: `No restore point for ${key}.`,
		);
		return 1;
	}
	const r = await engine.restore(key, v);
	if (json) out(JSON.stringify({ key, version: v, ...r }));
	else out(r.ok ? `Restored ${v}.` : (r.detail ?? "Restore failed."));
	return r.ok ? 0 : 1;
}

const RESULT_TEXT = {
	updated: "Updated",
	failed: "Failed",
	rolled_back: "Rolled back",
	stopped: "Stopped",
	restored: "Restored",
	cleaned: "Cleaned",
	skipped: "Skipped",
} as const;

/**
 * Finishes or undoes a built update an interrupted run left behind, one line per app. Exits 0 when every app was
 * put back or there was nothing to do, 1 when one could not be put back or another Upkeep's run holds the lock.
 */
async function recover(engine: Engine, paths: EngineDeps["paths"], json: boolean, out: Out): Promise<number> {
	const done = await engine.recover();
	if (json) {
		const busy = done.length === 0 && readInflight(paths)?.tree;
		out(JSON.stringify({ busy: Boolean(busy), apps: done }));
		return busy || !done.every((r) => r.ok) ? 1 : 0;
	}
	// recover() answers nothing both when there is nothing to do and when another process's run holds the lock.
	if (done.length === 0 && readInflight(paths)?.tree) {
		out("Another Upkeep run is in progress. Try again when it ends.");
		return 1;
	}
	if (done.length === 0) out("Nothing to recover.");
	for (const r of done)
		out(r.ok ? `${r.name}: put back ${r.version ?? ""}` : `${r.name}: could not be put back. See the log.`);
	return done.every((r) => r.ok) ? 0 : 1;
}

/**
 * What the last check found, read from the rows the engine saved, and whether a run holds the lock: no network, no
 * check, nothing installed. Text, one JSON object with --json, or Prometheus's text format with --metrics. Exits 0,
 * and 1 when no check has run yet, so a script can tell "nothing ready" from "nothing known"; --metrics always exits
 * 0, since its check time of 0 says the same and a collector's file is written with `&&`.
 */
function status(
	engine: Engine,
	paths: EngineDeps["paths"],
	seed: string,
	json: boolean,
	metrics: boolean,
	out: Out,
): number {
	const s = statusOf(engine.snapshot(), lockHeld(paths), loadManifest(ensureManifest(paths, seed)).apps);
	if (metrics) {
		out(metricsText(s).trimEnd());
		return 0;
	}
	if (json) out(JSON.stringify(s));
	else for (const line of statusLines(s)) out(line);
	return s.checkedAt === null ? 1 : 0;
}

/** Prints the last 200 runs, in the order the engine returns them. Always exits 0. */
function history(engine: Engine, json: boolean, out: Out): number {
	const rows = engine.history(200);
	if (json) {
		for (const r of rows) out(JSON.stringify(r));
		return 0;
	}
	if (rows.length === 0) out("No runs yet.");
	for (const r of rows) {
		// A Cleanup row has no versions: what it freed stands in their place, and nothing when that went unmeasured
		// (apt does not say what autoremove freed). The snapshot before a System install has none either, and one
		// taken reads as Taken.
		const snapshot = r.key === SNAPSHOT_KEY;
		const what =
			r.freed !== undefined
				? r.freed > 0
					? ` freed ${r.freed} bytes`
					: ""
				: snapshot
					? ""
					: ` ${r.from ?? "?"} to ${r.to ?? "?"}`;
		const result = snapshot && r.result === "updated" ? "Taken" : RESULT_TEXT[r.result];
		const checked = r.checked ? ` (${CHECKED_TEXT[r.checked]})` : "";
		out(`${r.at} ${r.name}${what} ${result}${r.detail ? ` ${r.detail}` : ""}${checked}`);
	}
	return 0;
}

/** The apps in apps.toml, read without a check: one line each, or one JSON object each. Problems in the file are named. */
function list(deps: EngineDeps, json: boolean, out: Out): number {
	const { apps, errors } = loadManifest(ensureManifest(deps.paths, deps.seedManifest));
	for (const a of apps) out(json ? JSON.stringify(a) : `${a.key}  ${a.name}  ${a.kind}${a.repo ? `  ${a.repo}` : ""}`);
	for (const e of errors) out(json ? JSON.stringify({ problem: e }) : `apps.toml: ${e}`);
	return errors.length > 0 ? 1 : 0;
}

/**
 * The suggestion `add` may write without asking: suggest() answers at most one, and it counts when it is sure (a
 * repo, a link, a file that names its source) or comes from the catalogue. A repo guessed from a file's name is not.
 */
export function pickSure(suggestions: Suggestion[]): Suggestion | null {
	const [found] = suggestions;
	return found && (found.confidence === "sure" || found.source === "catalogue") ? found : null;
}

/**
 * Adds one app the way Add app does, from a catalogue name, a repo, a link or a file. Only a sure match is added: a
 * file whose repo was only guessed from its name is named and not added, so an agent never adds the wrong app. What
 * else already keeps it up to date (a Flatpak, a Snap, another table) is printed after, as a note.
 */
async function add(engine: Engine, input: string, json: boolean, out: Out): Promise<number> {
	const { suggestions, problem } = await engine.suggest(input);
	const pick = pickSure(suggestions);
	if (!pick) {
		const [found] = suggestions;
		const reason =
			problem ??
			(found?.spec.kind === "source"
				? `${input} has no release file for this machine. Upkeep drafted a source build, which is a guess: read its steps (--json shows the table) and add it from the window's Add app.`
				: found
					? `${input} looks like ${found.spec.repo ?? found.spec.name}, but that is a guess; add the repo by name.`
					: `Nothing found for ${input}.`);
		if (json) out(JSON.stringify({ added: [], problem: reason, candidate: found?.spec ?? null }));
		else out(reason);
		return 1;
	}
	// A sure match Add app refuses (a script or another tool at its install path, already in the list) is refused here too.
	if (pick.problem) {
		if (json) out(JSON.stringify({ added: [], problem: pick.problem, candidate: pick.spec }));
		else out(pick.problem);
		return 1;
	}
	const r = await engine.addApps([pick.spec]);
	// What else already keeps the app up to date, as Add app's card says it: a note, never a refusal.
	if (json) out(JSON.stringify(pick.also ? { ...r, also: pick.also } : r));
	else {
		for (const k of r.added) out(`Added ${k}.`);
		for (const line of pick.also ?? []) out(`Note: ${line}`);
		for (const p of r.problems) out(`${p.key}: ${p.detail}`);
	}
	return r.added.length > 0 ? 0 : 1;
}

/** How history's text line says a download was checked. */
const CHECKED_TEXT = {
	digest: "SHA-256 matches the forge",
	sums: "matches the checksum file",
	size: "size checked only",
	none: "download not checked",
} satisfies Record<DownloadCheck, string>;

/** Holds an app's updates or releases its hold, as the window's button does; on or off is required, and an unknown key fails. */
function hold(engine: Engine, key: string, to: string, json: boolean, out: Out): number {
	const ok = engine.setHold(key, to === "on");
	if (json) out(JSON.stringify({ key, held: to === "on", ok }));
	else out(ok ? (to === "on" ? `Holding ${key}.` : `Released the hold on ${key}.`) : MESSAGES.noAppInList(key));
	return ok ? 0 : 1;
}

/**
 * Pauses an app's updates for a whole number of days, or ends the pause with off, as the window's Pause for and
 * Resume now do. Only plain digits from 1 to 365 count (never 0x7, 1e1 or " 7 "); a held app is refused, as a hold
 * wins over a pause. A refusal or an unknown key writes nothing.
 */
function pause(engine: Engine, paths: EngineDeps["paths"], key: string, to: string, json: boolean, out: Out): number {
	const days = to === "off" ? null : /^\d+$/.test(to) ? Number(to) : Number.NaN;
	if (days !== null && !(days >= 1 && days <= 365)) {
		out(json ? JSON.stringify({ key, ok: false }) : "pause takes a number of days from 1 to 365, or off.");
		return 2;
	}
	const ok = engine.setPause(key, days);
	const until = ok && days !== null ? (loadState(paths).pause[key] ?? null) : null;
	if (json) out(JSON.stringify({ key, until, ok }));
	else if (!ok)
		out(engine.isHeld(key) ? `${key} is held. Release the hold first, then pause it.` : MESSAGES.noAppInList(key));
	else out(until ? `Paused ${key} until ${localDay(until)}.` : `Resumed ${key}.`);
	return ok ? 0 : 1;
}

/** Takes an app off the list. The app itself, its files and its restore points stay. */
async function remove(engine: Engine, key: string, json: boolean, out: Out): Promise<number> {
	const r = await engine.removeApp(key);
	if (json) out(JSON.stringify({ key, ...r }));
	else out(r.ok ? `Removed ${key}.` : (r.detail ?? `Could not remove ${key}.`));
	return r.ok ? 0 : 1;
}

/**
 * Writes the setup as one JSON file, or prints it when no file is named: indented for a person, on one line with
 * --json. With a file and --json, the answer is {"ok", "file"} or {"ok": false, "problem"}.
 */
function exportTo(deps: EngineDeps, file: string | undefined, json: boolean, out: Out): number {
	const setup = exportSetup(deps.paths, deps.seedManifest, deps.now());
	if (file === undefined) {
		out(json ? JSON.stringify(setup) : JSON.stringify(setup, null, "\t"));
		return 0;
	}
	try {
		writeFileSync(file, `${JSON.stringify(setup, null, "\t")}\n`);
	} catch (err) {
		const problem = `Could not write ${file}: ${err instanceof Error ? err.message : String(err)}`;
		out(json ? JSON.stringify({ ok: false, problem }) : problem);
		return 1;
	}
	out(json ? JSON.stringify({ ok: true, file }) : `Exported to ${file}.`);
	return 0;
}

/** Says why a command did nothing, as text or as {"ok": false, "problems"} under --json. Always exit code 1. */
function refuse(problem: string, json: boolean, out: Out): number {
	out(json ? JSON.stringify({ ok: false, problems: [problem] }) : problem);
	return 1;
}

/** The window's names for what an import may turn on, in the English the command line prints. */
const SWITCH_NAME = {
	notify: "Notify when updates are ready",
	checkAtLogin: "Start at login",
	selfAuto: "Update Upkeep automatically",
	upkeepCommand: "Add the upkeep command",
	system: "Show system updates",
	systemInstall: "Install system updates from Upkeep",
	snapshotBeforeSystem: "Take a snapshot before system updates",
	cleanup: "Show Cleanup",
	devCaches: "Include developer caches",
} satisfies Record<ImportSwitch, string>;

const PROTECTION_NAME = {
	waitUnmetered: "Wait for an unmetered connection and mains power for automatic app updates",
} satisfies Record<ImportProtection, string>;

/**
 * The ask as text: each app that runs commands with every command it runs, how many plain apps come with it, then
 * each setting the file turns on that is off here, a release wait it shortens, and a notice address it sets. A file that only turns settings on prints no app header.
 */
function printAsk(file: string, ask: ImportAsk, out: Out): void {
	if (ask.apps.length > 0) out(`${file} has apps that run these commands on this computer:`);
	for (const a of ask.apps) {
		out(`  ${a.name} (${a.key})`);
		for (const c of a.commands) out(`    ${c}`);
	}
	if (ask.apps.length > 0 && ask.plain > 0)
		out(
			ask.plain === 1
				? "and 1 app that only installs its release files, without root."
				: `and ${ask.plain} apps that only install their release files, without root.`,
		);
	if (ask.turnsOn.length > 0) out(`${file} turns on these settings on this computer:`);
	for (const k of ask.turnsOn) out(`  ${SWITCH_NAME[k]}`);
	if (ask.turnsOff.length > 0) out(`${file} turns off these settings on this computer:`);
	for (const k of ask.turnsOff) out(`  ${PROTECTION_NAME[k]}`);
	if (ask.waitDays) out(`${file} shortens this setting on this computer:`);
	if (ask.waitDays)
		out(`  Wait before offering a new release: ${waitWords(ask.waitDays.from)} -> ${waitWords(ask.waitDays.to)}`);
	if (ask.webhook) out(`${file} sends Upkeep's notices, with the app list, to this address:`);
	if (ask.webhook) out(`  ${ask.webhook}`);
}

/** A release wait as Settings words it, in English: "Off", "1 day", "3 days". */
const waitWords = (d: number) => (d === 0 ? "Off" : d === 1 ? "1 day" : `${d} days`);

/**
 * Replaces the setup from an export, holding the run lock so no install runs while the files change. A list with apps
 * that run commands writes nothing without sure (--yes): it prints every such app with its commands, or the ask as
 * {"ok": false, "ask"} under --json, and exits 1, so a script that did not read the list never runs what it carries.
 * With --yes the same list is printed before the result, so a log records what came in, and the result names the
 * apps whose automatic installs came in off.
 */
function importFrom(deps: EngineDeps, file: string, sure: boolean, json: boolean, out: Out): number {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (err) {
		return refuse(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`, json, out);
	}
	let mine: boolean;
	try {
		mine = claimLock(deps.paths);
	} catch (err) {
		return refuse(`Could not take the run lock: ${err instanceof Error ? err.message : String(err)}`, json, out);
	}
	if (!mine) return refuse(MESSAGES.importDuringRun(), json, out);
	try {
		let r = importSetup(deps.paths, deps.seedManifest, text, deps.now());
		if ("ask" in r && sure) {
			if (!json) printAsk(file, r.ask, out);
			r = importSetup(deps.paths, deps.seedManifest, text, deps.now(), true);
		}
		if (json) out(JSON.stringify(r));
		else if (r.ok) {
			out(`Imported ${r.apps} apps. The files it replaced are kept beside them as .pre-import-<time>.`);
			if (r.autoOff.length > 0)
				out(
					`Automatic installs came in off for ${r.autoOff.join(", ")}: new here or changed from this computer's table.`,
				);
		} else if ("ask" in r) {
			printAsk(file, r.ask, out);
			out("Nothing was changed. Read the list, then run it again with --yes to import.");
			out("Automatic installs come in off for every app that is new here or differs from this computer's table.");
		} else for (const p of r.problems) out(p);
		return r.ok ? 0 : 1;
	} finally {
		releaseLock(deps.paths);
	}
}

/** Runs one command line. Returns the exit code. */
export async function main(
	argv: string[],
	deps: EngineDeps,
	out: Out = (l) => console.log(l),
	signals: Signals = process,
): Promise<number> {
	const [cmd, ...rest] = argv;
	const json = rest.includes("--json");
	const args = rest.filter((a) => a !== "--json");
	if (cmd === "check" && args.length === 0) return check(createEngine(deps), json, out);
	if (cmd === "install" && args.length > 0) return install(createEngine(deps), args, json, out, signals);
	if (cmd === "restore" && (args.length === 1 || args.length === 2) && args[0])
		return restore(createEngine(deps), deps, args[0], args[1], json, out);
	if (cmd === "status" && args.filter((a) => a !== "--metrics").length === 0)
		return status(createEngine(deps), deps.paths, deps.seedManifest, json, args.includes("--metrics"), out);
	if (cmd === "history" && args.length === 0) return history(createEngine(deps), json, out);
	if (cmd === "recover" && args.length === 0) return recover(createEngine(deps), deps.paths, json, out);
	if (cmd === "list" && args.length === 0) return list(deps, json, out);
	if (cmd === "add" && args.length === 1 && args[0]) return add(createEngine(deps), args[0], json, out);
	if (cmd === "remove" && args.length === 1 && args[0]) return remove(createEngine(deps), args[0], json, out);
	if (cmd === "hold" && args.length === 2 && args[0] && (args[1] === "on" || args[1] === "off"))
		return hold(createEngine(deps), args[0], args[1], json, out);
	if (cmd === "pause" && args.length === 2 && args[0] && args[1])
		return pause(createEngine(deps), deps.paths, args[0], args[1], json, out);
	if (cmd === "export" && args.length <= 1) return exportTo(deps, args[0], json, out);
	if (cmd === "import") {
		const files = args.filter((a) => a !== "--yes");
		if (files.length === 1 && files[0]) return importFrom(deps, files[0], args.includes("--yes"), json, out);
	}
	out(USAGE);
	return 2;
}

if (import.meta.main)
	process.exit(
		await main(process.argv.slice(2), {
			...realDeps(
				process.env,
				join(import.meta.dir, "../manifest/apps.toml"),
				join(import.meta.dir, "../catalogue"),
				CATALOGUE_URL,
			),
			version: pkg.version,
		}),
	);
