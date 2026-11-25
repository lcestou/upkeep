import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MESSAGES } from "../../shared/messages";
import { isRecord } from "../manifest";
import { isNewer } from "../version";
import { type Checked, type KindCtx, type Outcome, stageClock } from "./context";

// The one place the code names Claude Code: this kind drives its plugin CLI, as package.ts drives dpkg and rpm.
const REGISTRY = ".claude/plugins/installed_plugins.json";
const MARKETS = ".claude/plugins/known_marketplaces.json";
const MARKET_DIR = ".claude/plugins/marketplaces";
const CLAUDE = "claude";
const STEP_MS = 120_000;

/** One installed copy of a plugin: its scope, the project a local one belongs to, and what it was installed at. */
type Entry = { id: string; scope: string; cwd: string; version: string; sha: string };

/** A file's JSON, or null when it is missing or is not JSON. */
function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/** A string field, or "" when it is missing or is not a string. */
const str = (r: Record<string, unknown>, k: string): string => (typeof r[k] === "string" ? r[k] : "");

/**
 * Every (plugin, install) pair in the registry, in its order. A missing scope is "user"; a project or local entry
 * runs in its project's folder, as claude plugin update needs, else in home. An unreadable registry gives none.
 */
function entries(file: string, home: string): Entry[] {
	const reg = readJson(file);
	const plugins = isRecord(reg) && isRecord(reg.plugins) ? reg.plugins : {};
	return Object.entries(plugins).flatMap(([id, list]) =>
		(Array.isArray(list) ? list : []).filter(isRecord).map((e) => ({
			id,
			scope: str(e, "scope") || "user",
			cwd: str(e, "projectPath") || home,
			version: str(e, "version"),
			sha: str(e, "gitCommitSha"),
		})),
	);
}

/** Where a marketplace's clone lives: its installLocation in known_marketplaces.json, else Claude Code's default folder. */
function marketDir(home: string, market: string): string {
	const known = readJson(join(home, MARKETS));
	const m = isRecord(known) ? known[market] : null;
	return (isRecord(m) && str(m, "installLocation")) || join(home, MARKET_DIR, market);
}

/**
 * What a marketplace clone offers for a plugin: a version, or the plugin's folder in the clone when it has no version
 * anywhere, so Claude Code versions it by the clone's commit. A plugin.json version beats the marketplace entry's, as
 * in Claude Code. Null when the plugin is not listed, or its source is another repo whose entry names no version:
 * only claude plugin update can answer that one, so such a plugin is never reported as waiting.
 */
function offerOf(dir: string, name: string): { version: string } | { folder: string } | null {
	const mk = readJson(join(dir, ".claude-plugin/marketplace.json"));
	const listed = isRecord(mk) && Array.isArray(mk.plugins) ? mk.plugins.filter(isRecord) : [];
	const p = listed.find((x) => x.name === name);
	if (!p) return null;
	const inClone = typeof p.source === "string";
	const manifest = inClone ? readJson(join(dir, str(p, "source"), ".claude-plugin/plugin.json")) : null;
	const version = (isRecord(manifest) && str(manifest, "version")) || str(p, "version");
	if (version) return { version };
	return inClone ? { folder: str(p, "source") } : null;
}

/**
 * True when the plugin's own folder in the clone changed between the commit it was installed from and the clone's
 * HEAD. Only that folder counts: one marketplace repo holds many plugins, and a commit to another plugin moves HEAD
 * without changing this one. False when git cannot tell (no such commit in a shallow clone, no git).
 */
async function folderChanged(ctx: KindCtx, dir: string, sha: string, folder: string): Promise<boolean> {
	const argv = ["git", "-C", dir, "diff", "--quiet", sha, "HEAD", "--", folder];
	return (await ctx.run(argv, { timeoutMs: STEP_MS, cwd: ctx.paths.home })).code === 1;
}

/** Pulls every marketplace clone, as Claude Code does at its own start. A failure is logged and the old clones stand. */
async function refreshMarkets(ctx: KindCtx): Promise<void> {
	ctx.log(`$ ${CLAUDE} plugin marketplace update`);
	const r = await ctx.run([CLAUDE, "plugin", "marketplace", "update"], { timeoutMs: STEP_MS, cwd: ctx.paths.home });
	if (r.code !== 0) ctx.log("Marketplace refresh failed.");
}

/**
 * Every plugin in Claude Code's registry, after a marketplace refresh: ready, naming each plugin whose marketplace
 * holds a newer version (or, for one versioned by commit, new commits in its own folder), else fresh. An install with no version
 * in the registry, or a plugin from another repo with none in its entry, cannot be compared and counts as current.
 * Null without a registry.
 */
export async function checkClaudePlugins(ctx: KindCtx): Promise<Checked | null> {
	const file = join(ctx.paths.home, REGISTRY);
	if (!existsSync(file)) {
		ctx.log(`Claude Code plugins: no registry at ${file}, skipped.`);
		return null;
	}
	await refreshMarkets(ctx);
	const rows = entries(file, ctx.paths.home).map((e) => {
		const at = e.id.lastIndexOf("@");
		const name = at > 0 ? e.id.slice(0, at) : e.id;
		const dir = marketDir(ctx.paths.home, e.id.slice(at + 1));
		return { e, name, dir, offer: at > 0 ? offerOf(dir, name) : null };
	});
	const flags = await Promise.all(
		rows.map(({ e, dir, offer }) => {
			if (offer === null) return false;
			if ("version" in offer) return isNewer(e.version || null, offer.version);
			return e.sha !== "" && folderChanged(ctx, dir, e.sha, offer.folder);
		}),
	);
	const behind = rows.filter((_, i) => flags[i]);
	for (const { e, offer } of behind)
		ctx.log(
			`${e.id}: ${offer && "version" in offer ? `${e.version} to ${offer.version}` : "new commits"} in its marketplace`,
		);
	const target = { from: null, version: "", tag: "" };
	if (behind.length === 0) return { installed: null, latest: null, status: "fresh", target };
	const names = [...new Set(behind.map((r) => r.name))].join(", ");
	return { installed: null, latest: null, status: "ready", detail: MESSAGES.pluginsWaiting(names), target };
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
	await refreshMarkets(ctx);
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
			detail: MESSAGES.couldNotUpdatePlugins(failed.join(", ")),
			restartToApply: false,
			stages,
		};
	return {
		result: "done",
		installed: null,
		detail: updated > 0 ? MESSAGES.pluginsUpdated(updated) : undefined,
		restartToApply: false,
		stages,
	};
}
