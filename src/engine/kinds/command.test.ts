import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppSpec } from "../../shared/types";
import type { FetchLike } from "../github";
import { listBackups } from "../backup";
import { ok, realRun, recordingRun, script, tempHome, withCancel } from "../testkit";
import type { KindCtx } from "./context";
import { checkCommand, installCommand, tagOf } from "./command";

let t: ReturnType<typeof tempHome>;
let lines: string[] = [];
beforeEach(() => {
	t = tempHome("command");
	lines = [];
});
afterEach(() => t.cleanup());

const npm: FetchLike = async (url) =>
	url === "https://registry.npmjs.org/@anthropic-ai/claude-code/latest"
		? Response.json({ version: "2.1.400" })
		: new Response("", { status: 404 });

function ctx(): KindCtx {
	return {
		paths: t.paths,
		run: realRun(t.paths),
		fetch: npm,
		token: null,
		settings: {
			keepBackups: 1,
			notify: true,
			checkAtLogin: false,
			checkEvery: "6h",
			frame: "own",
			buttons: "auto",
			corners: "rounded",
			language: "system",
			selfAuto: false,
			upkeepCommand: false,
		},
		log: (l) => lines.push(l),
		stage: () => {},
	};
}

const claude = (update: string[]): AppSpec => ({
	key: "claude",
	name: "Claude Code",
	kind: "command",
	check: ["claude", "--version"],
	latest: "npm:@anthropic-ai/claude-code",
	update,
	auto: true,
	note: "Open sessions keep the old version until restarted.",
});

function fakeClaude(version: string): string {
	const state = join(t.dir, "claude-version");
	writeFileSync(state, version);
	script(join(t.paths.home, ".local/bin/claude"), `echo "$(cat ${state}) (Claude Code)"`);
	return state;
}

test("check reads the command's version and npm's latest; a missing command is left out", async () => {
	expect(await checkCommand(claude([]), ctx())).toBeNull();
	expect(lines).toEqual(["Claude Code is not installed at claude, skipped."]);
	fakeClaude("2.1.322");
	expect(await checkCommand(claude([]), ctx())).toMatchObject({
		installed: "2.1.322",
		latest: "2.1.400",
		status: "ready",
	});
	fakeClaude("2.1.400");
	expect((await checkCommand(claude([]), ctx()))?.status).toBe("fresh");
});

test("install runs the update and passes when the version moved, asking a restart only of a table that can", async () => {
	const state = fakeClaude("2.1.322");
	script(join(t.paths.home, ".local/bin/claude-up"), `echo updating; printf 2.1.400 > ${state}`);
	const target = { from: "2.1.322", version: "2.1.400", tag: "2.1.400" };
	// A note alone is no restart: there is nothing to press, and open sessions run on as the note says.
	const outcome = await installCommand(claude(["~/.local/bin/claude-up"]), target, ctx());
	expect(outcome).toMatchObject({ result: "done", installed: "2.1.400", restartToApply: false });
	writeFileSync(state, "2.1.322");
	const { note: _note, ...bare } = claude(["~/.local/bin/claude-up"]);
	const restartable = { ...bare, restart: ["systemctl", "--user", "restart", "claude"] };
	expect((await installCommand(restartable, target, ctx())).restartToApply).toBe(true);
	expect(lines).toContain("updating");
	expect(Object.keys(outcome.stages)).toEqual(["install", "verify"]);
});

test("{tag} and {version} in the update argv are filled with the target's", async () => {
	const state = fakeClaude("2.1.322");
	script(join(t.paths.home, ".local/bin/claude-up"), `echo "got $1 $2"; printf 2.1.400 > ${state}`);
	const target = { from: "2.1.322", version: "2.1.400", tag: "v2.1.400" };
	await installCommand(claude(["~/.local/bin/claude-up", "rev={tag}", "{version}"]), target, ctx());
	expect(lines).toContain("got rev=v2.1.400 2.1.400");
});

test("a version that did not move is a failure", async () => {
	fakeClaude("2.1.322");
	const target = { from: "2.1.322", version: "2.1.400", tag: "2.1.400" };
	expect(await installCommand(claude(["bash", "-c", "true"]), target, ctx())).toMatchObject({
		result: "failed",
		detail: "Still at 2.1.322 after the update command.",
	});
});

test("an update of a current version that leaves it unchanged is still a failure", async () => {
	fakeClaude("2.1.400");
	const target = { from: "2.1.400", version: "2.1.400", tag: "2.1.400" };
	expect(await installCommand(claude(["bash", "-c", "true"]), target, ctx())).toMatchObject({
		result: "failed",
		detail: "Still at 2.1.400 after the update command.",
	});
});

test("a command that runs but prints no version is a problem, not fresh", async () => {
	script(join(t.paths.home, ".local/bin/claude"), "exit 3");
	expect(await checkCommand(claude([]), ctx())).toMatchObject({
		installed: null,
		latest: "2.1.400",
		status: "problem",
	});
});

test("an update that leaves the tool unable to start is a failure that keeps the old version", async () => {
	fakeClaude("2.1.322");
	script(join(t.paths.home, ".local/bin/claude-up"), `printf 'exit 3' > ${join(t.paths.home, ".local/bin/claude")}`);
	const target = { from: "2.1.322", version: "2.1.400", tag: "2.1.400" };
	expect(await installCommand(claude(["~/.local/bin/claude-up"]), target, ctx())).toMatchObject({
		result: "failed",
		installed: "2.1.322",
		restartToApply: false,
	});
});

test("with a restore command the installed version is a point first, and a tool that will not start gets it back", async () => {
	const state = fakeClaude("2.1.322");
	// The update breaks the tool; the restore command puts the version it is given back.
	script(join(t.paths.home, ".local/bin/claude-up"), `printf broken > ${state}`);
	script(join(t.paths.home, ".local/bin/claude-pin"), `printf "%s" "$1" > ${state}`);
	script(
		join(t.paths.home, ".local/bin/claude"),
		`v=$(cat ${state}); [ "$v" = broken ] && exit 1; echo "$v (Claude Code)"`,
	);
	const spec = { ...claude(["~/.local/bin/claude-up"]), restore: ["~/.local/bin/claude-pin", "{version}"] };
	const outcome = await installCommand(spec, { from: "2.1.322", version: "2.1.400", tag: "v2.1.400" }, ctx());
	expect(outcome).toMatchObject({
		result: "rolled_back",
		installed: "2.1.322",
		detail: "Would not start after the update. Restored 2.1.322.",
	});
	expect(Object.keys(outcome.stages)).toEqual(["backup", "install", "verify"]);
	expect(readFileSync(state, "utf8")).toBe("2.1.322");
	expect(listBackups(t.paths, "claude").map((p) => p.version)).toEqual(["2.1.322"]);
});

test("without a restore command a tool that will not start says so, and no point is taken", async () => {
	const state = fakeClaude("2.1.322");
	script(join(t.paths.home, ".local/bin/claude-up"), `printf broken > ${state}`);
	script(
		join(t.paths.home, ".local/bin/claude"),
		`v=$(cat ${state}); [ "$v" = broken ] && exit 1; echo "$v (Claude Code)"`,
	);
	const outcome = await installCommand(
		claude(["~/.local/bin/claude-up"]),
		{ from: "2.1.322", version: "2.1.400", tag: "2.1.400" },
		ctx(),
	);
	expect(outcome).toMatchObject({
		result: "failed",
		detail: "Would not start after the update. Its table has no restore command.",
	});
	expect(listBackups(t.paths, "claude")).toEqual([]);
});

test("tagOf writes a version's tag the way the target's tag is written", () => {
	expect(tagOf({ tag: "v2.1.400", version: "2.1.400" }, "2.1.322")).toBe("v2.1.322");
	expect(tagOf({ tag: "release", version: "2.1.400" }, "2.1.322")).toBe("2.1.322");
	expect(tagOf(undefined, "2.1.322")).toBe("2.1.322");
});

test("a restore command with no known installed version takes no point and says why", async () => {
	const state = fakeClaude("2.1.322");
	script(join(t.paths.home, ".local/bin/claude-up"), `printf broken > ${state}`);
	script(
		join(t.paths.home, ".local/bin/claude"),
		`v=$(cat ${state}); [ "$v" = broken ] && exit 1; echo "$v (Claude Code)"`,
	);
	const spec = { ...claude(["~/.local/bin/claude-up"]), restore: ["~/.local/bin/claude-pin", "{version}"] };
	const outcome = await installCommand(spec, { from: null, version: "2.1.400", tag: "2.1.400" }, ctx());
	expect(outcome).toMatchObject({
		result: "failed",
		detail: "Would not start after the update. No restore point: the installed version was not known.",
	});
	expect(listBackups(t.paths, "claude")).toEqual([]);
});

test("the update runs in the home directory, whatever folder Upkeep was started from", async () => {
	const state = fakeClaude("2.1.322");
	script(join(t.paths.home, ".local/bin/claude-up"), `pwd > "${join(t.dir, "cwd")}"; printf 2.1.400 > ${state}`);
	await installCommand(
		claude(["~/.local/bin/claude-up"]),
		{ from: "2.1.322", version: "2.1.400", tag: "2.1.400" },
		ctx(),
	);
	expect(readFileSync(join(t.dir, "cwd"), "utf8").trim()).toBe(t.paths.home);
});

/** ctx() with Stop now wired in, as the engine passes it. */
function stoppable(stop: AbortController): KindCtx {
	const c = ctx();
	return { ...c, run: withCancel(c.run, stop.signal), cancel: stop.signal };
}

test("Stop now cuts an update with a restore command and puts the installed version back", async () => {
	const state = fakeClaude("2.1.322");
	script(join(t.paths.home, ".local/bin/claude-up"), `printf half > ${state}; sleep 30`);
	script(join(t.paths.home, ".local/bin/claude-back"), `printf "$1" > ${state}`);
	const stop = new AbortController();
	setTimeout(() => stop.abort(), 300);
	const spec = { ...claude(["~/.local/bin/claude-up"]), restore: ["~/.local/bin/claude-back", "{version}"] };
	const started = Date.now();
	const outcome = await installCommand(spec, { from: "2.1.322", version: "2.1.400", tag: "2.1.400" }, stoppable(stop));
	expect(Date.now() - started).toBeLessThan(6000);
	expect(outcome).toMatchObject({
		result: "stopped",
		installed: "2.1.322",
		detail: "Stopped. 2.1.322 is back in place.",
	});
	expect(readFileSync(state, "utf8")).toBe("2.1.322");
	expect(lines).toContain("The update command was stopped.");
}, 15_000);

test("Stop now cuts an update with no restore command and says what the tool reports after", async () => {
	const state = fakeClaude("2.1.322");
	script(join(t.paths.home, ".local/bin/claude-up"), "sleep 30");
	const stop = new AbortController();
	setTimeout(() => stop.abort(), 300);
	const target = { from: "2.1.322", version: "2.1.400", tag: "2.1.400" };
	expect(await installCommand(claude(["~/.local/bin/claude-up"]), target, stoppable(stop))).toMatchObject({
		result: "stopped",
		installed: "2.1.322",
		detail: "Stopped. Claude Code still reports 2.1.322.",
	});
	// A tool the cut left unable to start says so.
	writeFileSync(state, "");
	script(join(t.paths.home, ".local/bin/claude"), "exit 3");
	const again = new AbortController();
	setTimeout(() => again.abort(), 300);
	const broken = await installCommand(claude(["~/.local/bin/claude-up"]), target, stoppable(again));
	expect(broken.result).toBe("stopped");
	expect(broken.detail).toStartWith("Stopped. Claude Code does not start now: ");
}, 15_000);

test("Stop now pressed before the update starts leaves the tool alone", async () => {
	fakeClaude("2.1.322");
	const stop = new AbortController();
	stop.abort();
	const marker = join(t.dir, "ran");
	script(join(t.paths.home, ".local/bin/claude-up"), `touch ${marker}`);
	const target = { from: "2.1.322", version: "2.1.400", tag: "2.1.400" };
	const spec = { ...claude(["~/.local/bin/claude-up"]), restore: ["true"] };
	expect(await installCommand(spec, target, stoppable(stop))).toMatchObject({
		result: "stopped",
		installed: "2.1.322",
	});
	expect(existsSync(marker)).toBe(false);
});

test("Stop now may cut a command app's update and its version probe after, nothing else", async () => {
	const state = fakeClaude("2.1.322");
	script(join(t.paths.home, ".local/bin/claude-up"), `printf 2.1.400 > ${state}`);
	const { run, calls } = recordingRun(t.paths, () => undefined);
	const target = { from: "2.1.322", version: "2.1.400", tag: "2.1.400" };
	const spec = { ...claude(["~/.local/bin/claude-up"]), restore: ["true"] };
	expect(await installCommand(spec, target, { ...ctx(), run })).toMatchObject({ result: "done" });
	expect(calls.map((c) => [c.argv[0], c.opts.cuttable === true])).toEqual([
		["~/.local/bin/claude-up", true],
		["claude", true],
	]);
});

test("Stop now never cuts a command app's update that runs as root", async () => {
	const state = fakeClaude("2.1.322");
	script(join(t.paths.home, ".local/bin/claude-up"), `printf 2.1.400 > ${state}`);
	const target = { from: "2.1.322", version: "2.1.400", tag: "2.1.400" };
	const { run, calls } = recordingRun(t.paths, (argv) => (argv[0] === "sudo" ? ok() : undefined));
	await installCommand({ ...claude(["~/.local/bin/claude-up"]), sudo: true }, target, { ...ctx(), run });
	await installCommand(claude(["sudo", "npm", "i", "-g", "x"]), target, { ...ctx(), run });
	const updates = calls.filter((c) => c.argv[0] === "~/.local/bin/claude-up" || c.argv[0] === "sudo");
	expect(updates.map((c) => c.opts.cuttable)).toEqual([false, false]);
});

test("Stop now's put-back that fails says what the restore said, and keeps the row failed", async () => {
	const state = fakeClaude("2.1.322");
	script(join(t.paths.home, ".local/bin/claude-up"), `printf half > ${state}; sleep 30`);
	script(join(t.paths.home, ".local/bin/claude-back"), "echo nope >&2; exit 4");
	const stop = new AbortController();
	setTimeout(() => stop.abort(), 300);
	const spec = { ...claude(["~/.local/bin/claude-up"]), restore: ["~/.local/bin/claude-back", "{version}"] };
	const outcome = await installCommand(spec, { from: "2.1.322", version: "2.1.400", tag: "2.1.400" }, stoppable(stop));
	expect(outcome.result).toBe("failed");
	expect(outcome.detail).toBe("~/.local/bin/claude-back 2.1.322 exited 4.");
}, 15_000);

test("Stop now during the check after the update puts the settings back with the old version", async () => {
	const state = fakeClaude("2.1.322");
	const cfg = join(t.paths.home, ".claude-test/settings.json");
	mkdirSync(dirname(cfg), { recursive: true });
	writeFileSync(cfg, "old");
	script(join(t.paths.home, ".local/bin/claude-up"), `printf 2.1.400 > ${state}; printf migrated > ${cfg}`);
	script(join(t.paths.home, ".local/bin/claude-back"), `printf "$1" > ${state}`);
	const stop = new AbortController();
	const c = stoppable(stop);
	const run: KindCtx["run"] = (argv, opts) => {
		if (argv[0] === "claude" && readFileSync(state, "utf8") === "2.1.400") stop.abort();
		return c.run(argv, opts);
	};
	const spec = {
		...claude(["~/.local/bin/claude-up"]),
		restore: ["~/.local/bin/claude-back", "{version}"],
		keep_with_restore: ["~/.claude-test"],
	};
	const outcome = await installCommand(spec, { from: "2.1.322", version: "2.1.400", tag: "2.1.400" }, { ...c, run });
	expect(outcome).toMatchObject({ result: "stopped", installed: "2.1.322" });
	expect(readFileSync(cfg, "utf8")).toBe("old");
});
