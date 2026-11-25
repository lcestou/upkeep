import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MESSAGES } from "./shared/messages";
import type { AppState, EngineEvent, Suggestion } from "./shared/types";
import { listBackups } from "./engine/backup";
import { createEngine, type Engine, type EngineDeps } from "./engine/engine";
import { ensureManifest, loadManifest } from "./engine/manifest";
import { realDeps } from "./engine/real";
import { CATALOGUE_URL } from "./bun/about";
import { claimLock, formatLogLine, readInflight, releaseLock } from "./engine/store";
import { exportSetup, importSetup } from "./engine/transfer";

export const USAGE = [
	"Usage: upkeep <command> [--json]",
	"  check                  check every app; one line each",
	"  install <key>...|--all|--auto   an app named here skips the release wait set in Settings",
	"  restore <key> [version]",
	"  history                the last 200 runs",
	"  recover                finish or undo an interrupted built update",
	"  list                   the apps in apps.toml",
	"  add <name|owner/repo|link|file>",
	"  remove <key>           take an app off the list; the app stays installed",
	"  export [file]          settings and app list as one JSON file (stdout without a file)",
	"  import <file>          replace settings and app list from an export; the old files are kept as .bak",
	"--json prints one JSON value per line instead of text.",
].join("\n");

type Out = (line: string) => void;

/** The local calendar day of an ISO time as YYYY-MM-DD, the day the window shows, so a script can compare it with `date +%F`. */
const localDay = (iso: string) => new Date(iso).toLocaleDateString("sv-SE");

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
			return `  HELD:   ${a.name} ${a.installed ?? "unknown"} -> ${a.latest ?? "unknown"}${a.skipped ? ` (skipping ${a.skipped})` : a.settles ? ` (offered from ${localDay(a.settles)})` : ""}`;
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
	if (e.type === "app" && ["queued", "working", "done", "failed", "rolled_back"].includes(e.app.status)) {
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

/**
 * Checks first, then installs the named apps, or all ready ones with `--all`, or the automatic ones with `--auto`. An
 * app named by key skips the release wait, as Install now anyway does in the window; --all and --auto keep it. Exits 0
 * only when every result is "updated".
 */
async function install(engine: Engine, args: string[], json: boolean, out: Out): Promise<number> {
	await engine.check();
	await engine.idle();
	const named = !args.includes("--all") && !args.includes("--auto");
	const keys = args.includes("--all")
		? engine.readyKeys(false)
		: args.includes("--auto")
			? engine.readyKeys(true)
			: args;
	const off = engine.subscribe((e) => {
		if (json) out(JSON.stringify(e));
		else {
			const line = eventLine(e);
			if (line) out(line);
		}
	});
	const r = await engine.install(keys, named);
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
		// (apt does not say what autoremove freed).
		const what =
			r.freed === undefined ? ` ${r.from ?? "?"} to ${r.to ?? "?"}` : r.freed > 0 ? ` freed ${r.freed} bytes` : "";
		out(`${r.at} ${r.name}${what} ${RESULT_TEXT[r.result]}${r.detail ? ` ${r.detail}` : ""}`);
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

/** Replaces the setup from an export, holding the run lock so no install runs while the files change. */
function importFrom(deps: EngineDeps, file: string, json: boolean, out: Out): number {
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
		const r = importSetup(deps.paths, deps.seedManifest, text, deps.now());
		if (json) out(JSON.stringify(r));
		else if (r.ok) out(`Imported ${r.apps} apps. The files it replaced are kept beside them as .pre-import-<time>.`);
		else for (const p of r.problems) out(p);
		return r.ok ? 0 : 1;
	} finally {
		releaseLock(deps.paths);
	}
}

/** Runs one command line. Returns the exit code. */
export async function main(argv: string[], deps: EngineDeps, out: Out = (l) => console.log(l)): Promise<number> {
	const [cmd, ...rest] = argv;
	const json = rest.includes("--json");
	const args = rest.filter((a) => a !== "--json");
	if (cmd === "check" && args.length === 0) return check(createEngine(deps), json, out);
	if (cmd === "install" && args.length > 0) return install(createEngine(deps), args, json, out);
	if (cmd === "restore" && (args.length === 1 || args.length === 2) && args[0])
		return restore(createEngine(deps), deps, args[0], args[1], json, out);
	if (cmd === "history" && args.length === 0) return history(createEngine(deps), json, out);
	if (cmd === "recover" && args.length === 0) return recover(createEngine(deps), deps.paths, json, out);
	if (cmd === "list" && args.length === 0) return list(deps, json, out);
	if (cmd === "add" && args.length === 1 && args[0]) return add(createEngine(deps), args[0], json, out);
	if (cmd === "remove" && args.length === 1 && args[0]) return remove(createEngine(deps), args[0], json, out);
	if (cmd === "export" && args.length <= 1) return exportTo(deps, args[0], json, out);
	if (cmd === "import" && args.length === 1 && args[0]) return importFrom(deps, args[0], json, out);
	out(USAGE);
	return 2;
}

if (import.meta.main)
	process.exit(
		await main(
			process.argv.slice(2),
			realDeps(
				process.env,
				join(import.meta.dir, "../manifest/apps.toml"),
				join(import.meta.dir, "../catalogue"),
				CATALOGUE_URL,
			),
		),
	);
