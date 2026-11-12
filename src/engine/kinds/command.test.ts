import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSpec } from "../../shared/types";
import type { FetchLike } from "../github";
import { listBackups } from "../backup";
import { realRun, script, tempHome } from "../testkit";
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

test("install runs the update and passes when the version moved, marking restart for a noted app", async () => {
	const state = fakeClaude("2.1.322");
	script(join(t.paths.home, ".local/bin/claude-up"), `echo updating; printf 2.1.400 > ${state}`);
	const target = { from: "2.1.322", version: "2.1.400", tag: "2.1.400" };
	const outcome = await installCommand(claude(["~/.local/bin/claude-up"]), target, ctx());
	expect(outcome).toMatchObject({ result: "done", installed: "2.1.400", restartToApply: true });
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
