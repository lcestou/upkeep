import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../manifest";
import { type Checked, type KindCtx, type Outcome, stageClock } from "./context";

// The one place the code names Claude Code: this kind drives its plugin CLI, as release.ts drives dpkg.
const REGISTRY = ".claude/plugins/installed_plugins.json";
const CLAUDE = "claude";
const STEP_MS = 120_000;

/** One installed copy of a plugin: the scope it was installed at, and the project it belongs to for a local one. */
type Entry = { id: string; scope: string; cwd: string };

/**
 * Every (plugin, install) pair in the registry, in its order. A missing scope is "user"; a project or local entry
 * runs in its project's folder, as claude plugin update needs, else in home. An unreadable registry gives none.
 */
function entries(file: string, home: string): Entry[] {
	let reg: unknown;
	try {
		reg = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return [];
	}
	const plugins = isRecord(reg) && isRecord(reg.plugins) ? reg.plugins : {};
	return Object.entries(plugins).flatMap(([id, list]) =>
		(Array.isArray(list) ? list : []).filter(isRecord).map((e) => ({
			id,
			scope: typeof e.scope === "string" && e.scope ? e.scope : "user",
			cwd: typeof e.projectPath === "string" && e.projectPath ? e.projectPath : home,
		})),
	);
}

/** Every plugin in Claude Code's registry, updated with claude plugin update. Versionless: the row is always fresh. Null without a registry. */
export function checkClaudePlugins(ctx: KindCtx): Checked | null {
	const file = join(ctx.paths.home, REGISTRY);
	if (!existsSync(file)) {
		ctx.log(`Claude Code plugins: no registry at ${file}, skipped.`);
		return null;
	}
	return { installed: null, latest: null, status: "fresh", target: { from: null, version: "", tag: "" } };
}

/** What one plugin's update came to, with Claude Code's own message. */
type PluginOutcome = { kind: "up_to_date" | "updated" | "failed"; message: string };

/**
 * The outcome of one claude plugin update --json run, from its last non-empty stdout line: "up_to_date", "updated"
 * with its message, or a failure with the message, the line, stderr's last line, or "no output".
 */
function outcomeOf(stdout: string, stderr: string): PluginOutcome {
	const last = stdout.trim().split("\n").findLast(Boolean) ?? "";
	let o: unknown = null;
	try {
		o = JSON.parse(last);
	} catch {
		// not JSON: a failure, said with the line itself
	}
	const r = isRecord(o) ? o : {};
	const message = typeof r.message === "string" ? r.message : "";
	if (r.updateOutcome === "up_to_date") return { kind: "up_to_date", message };
	if (r.updateOutcome === "updated") return { kind: "updated", message };
	// Claude Code, or a run that could not start, may say why on stderr only.
	const why = stderr.trim().split("\n").findLast(Boolean) ?? "";
	return { kind: "failed", message: message || last || why || "no output" };
}

/**
 * Refreshes the marketplaces, then updates each plugin install one by one. Never passes -y: a marketplace that
 * declares a command must be seen by a person, so such a plugin fails here every run until it is updated by hand.
 * A failed refresh is logged and the updates still run.
 */
export async function installClaudePlugins(ctx: KindCtx): Promise<Outcome> {
	const clock = stageClock(ctx);
	clock.start("install", 0);
	ctx.log(`$ ${CLAUDE} plugin marketplace update`);
	const refresh = await ctx.run([CLAUDE, "plugin", "marketplace", "update"], {
		timeoutMs: STEP_MS,
		cwd: ctx.paths.home,
	});
	if (refresh.code !== 0) ctx.log("Marketplace refresh failed.");
	const list = entries(join(ctx.paths.home, REGISTRY), ctx.paths.home);
	const failed: string[] = [];
	let updated = 0;
	for (const [i, e] of list.entries()) {
		// oxlint-disable-next-line no-await-in-loop -- one plugin at a time, as Claude Code writes one registry
		const r = await ctx.run([CLAUDE, "plugin", "update", e.id, "--scope", e.scope, "--json"], {
			timeoutMs: STEP_MS,
			cwd: e.cwd,
		});
		// A run stopped at its limit is a failure whatever it printed before.
		const out = r.timedOut
			? { kind: "failed", message: `ran past ${STEP_MS / 1000} s and was stopped` }
			: outcomeOf(r.stdout, r.stderr);
		if (out.kind === "up_to_date") ctx.log(`${e.id} is up to date`);
		else if (out.kind === "updated") {
			updated += 1;
			ctx.log(out.message || `${e.id} updated`);
		} else {
			ctx.log(`${e.id} update failed: ${out.message}`);
			failed.push(e.id);
		}
		ctx.stage("install", Math.round(((i + 1) / list.length) * 100));
	}
	const stages = clock.stop();
	if (failed.length > 0)
		return {
			result: "failed",
			installed: null,
			detail: `Could not update ${failed.join(", ")}. See the log.`,
			restartToApply: false,
			stages,
		};
	return {
		result: "done",
		installed: null,
		detail: updated > 0 ? `Updated ${updated}. New sessions pick them up.` : undefined,
		restartToApply: false,
		stages,
	};
}
