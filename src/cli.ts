import { join } from "node:path";
import type { AppState, EngineEvent } from "./shared/types";
import { listBackups } from "./engine/backup";
import { createEngine, type Engine, type EngineDeps } from "./engine/engine";
import { CHECK_INCOMPLETE } from "./engine/kinds/legacy";
import { realDeps } from "./engine/real";
import { formatLogLine, readInflight } from "./engine/store";

export const USAGE = "Usage: upkeep check|install|restore|history|recover";

type Out = (line: string) => void;

/** The old script's --check line shapes, so the two can be compared line for line. */
export function checkLine(a: AppState): string {
	switch (a.status) {
		case "fresh":
		case "done":
			return a.installed ? `  OK:     ${a.name} ${a.installed}` : `  OK:     ${a.name}`;
		case "ready":
		case "manual":
		case "held":
			return `  UPDATE: ${a.name} ${a.installed ?? "unknown"} -> ${a.latest ?? "unknown"}`;
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
		if (e.app.status === "working") return null;
		const to = e.app.status === "done" ? ` ${e.app.installed ?? ""}` : "";
		return `[${e.app.key}] ${e.app.status}${to}${e.app.detail ? ` ${e.app.detail}` : ""}`;
	}
	return null;
}

/** Prints one line per app as its check ends. Exits 1 only when the old updater's check did not finish; problems alone exit 0. */
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
	// The old updater's check not finishing is a failed check, not a list of problems.
	return engine.snapshot().apps.some((a) => a.status === "problem" && a.detail === CHECK_INCOMPLETE) ? 1 : 0;
}

/** Checks first, then installs the named apps, or all ready ones with `--all`, or the automatic ones with `--auto`. Exits 0 only when every result is "updated". */
async function install(engine: Engine, args: string[], json: boolean, out: Out): Promise<number> {
	await engine.check();
	await engine.idle();
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
	const r = await engine.install(keys);
	if (!r.started) {
		off();
		out(r.reason ?? "Nothing to install.");
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
	out: Out,
): Promise<number> {
	const v = version ?? listBackups(deps.paths, key)[0]?.version;
	if (!v) {
		out(`No restore point for ${key}.`);
		return 1;
	}
	const r = await engine.restore(key, v);
	out(r.ok ? `Restored ${v}.` : (r.detail ?? "Restore failed."));
	return r.ok ? 0 : 1;
}

const RESULT_TEXT = { updated: "Updated", failed: "Failed", rolled_back: "Rolled back", restored: "Restored" } as const;

/**
 * Finishes or undoes a built update an interrupted run left behind, one line per app. Exits 0 when every app was
 * put back or there was nothing to do, 1 when one could not be put back or another Upkeep's run holds the lock.
 */
async function recover(engine: Engine, paths: EngineDeps["paths"], out: Out): Promise<number> {
	const done = await engine.recover();
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
function history(engine: Engine, out: Out): number {
	const rows = engine.history(200);
	if (rows.length === 0) out("No runs yet.");
	for (const r of rows)
		out(
			`${r.at} ${r.name} ${r.from ?? "?"} to ${r.to ?? "?"} ${RESULT_TEXT[r.result]}${r.detail ? ` ${r.detail}` : ""}`,
		);
	return 0;
}

/** Runs one command line. Returns the exit code. */
export async function main(argv: string[], deps: EngineDeps, out: Out = (l) => console.log(l)): Promise<number> {
	const [cmd, ...rest] = argv;
	const json = rest.includes("--json");
	const args = rest.filter((a) => a !== "--json");
	if (cmd === "check" && args.length === 0) return check(createEngine(deps), json, out);
	if (cmd === "install" && args.length > 0) return install(createEngine(deps), args, json, out);
	if (cmd === "restore" && (args.length === 1 || args.length === 2) && args[0])
		return restore(createEngine(deps), deps, args[0], args[1], out);
	if (cmd === "history" && args.length === 0) return history(createEngine(deps), out);
	if (cmd === "recover" && args.length === 0) return recover(createEngine(deps), deps.paths, out);
	out(USAGE);
	return 2;
}

if (import.meta.main)
	process.exit(
		await main(
			process.argv.slice(2),
			realDeps(process.env, join(import.meta.dir, "../manifest/apps.toml"), join(import.meta.dir, "../catalogue")),
		),
	);
