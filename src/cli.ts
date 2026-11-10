import { join } from "node:path";
import type { AppState, EngineEvent } from "./shared/types";
import { listBackups } from "./engine/backup";
import { createEngine, type Engine, type EngineDeps } from "./engine/engine";
import { paths } from "./engine/paths";
import { createRunner } from "./engine/run";
import { formatLogLine } from "./engine/store";

export const USAGE = "Usage: upkeep check|install|restore|history";

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

function eventLine(e: EngineEvent): string | null {
	if (e.type === "log") return formatLogLine(e.line);
	if (e.type === "app" && ["queued", "working", "done", "failed", "rolled_back"].includes(e.app.status)) {
		if (e.app.status === "working") return null;
		const to = e.app.status === "done" ? ` ${e.app.installed ?? ""}` : "";
		return `[${e.app.key}] ${e.app.status}${to}${e.app.detail ? ` ${e.app.detail}` : ""}`;
	}
	return null;
}

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

const RESULT_TEXT = { updated: "Updated", failed: "Failed", rolled_back: "Rolled back" } as const;

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
	out(USAGE);
	return 2;
}

/** The real box: XDG directories, the owner's PATH, the old script where it lives. */
export function realDeps(env: Record<string, string | undefined>): EngineDeps {
	const p = paths(env);
	return {
		paths: p,
		seedManifest: join(import.meta.dir, "../manifest/apps.toml"),
		fetch: (url, init) => fetch(url, init),
		run: createRunner(p.home, join(p.cache, "tmp"), env.PATH ?? "/usr/local/bin:/usr/bin:/bin"),
		now: () => new Date(),
		oldScript: join(p.home, ".local/bin/lutechi-updater"),
		oldLock: "/tmp/lutechi-updater.lock",
		oldLog: join(p.home, ".local/share/lutechi-updater.log"),
	};
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), realDeps(process.env)));
