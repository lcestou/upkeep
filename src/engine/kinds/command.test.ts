import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSpec } from "../../shared/types";
import type { FetchLike } from "../github";
import { realRun, script, tempHome } from "../testkit";
import type { KindCtx } from "./context";
import { checkCommand, installCommand } from "./command";

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
		settings: { keepBackups: 1, notify: true, checkAtLogin: false },
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
