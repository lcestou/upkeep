import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../store";
import { recordingRun, tempHome } from "../testkit";
import type { KindCtx } from "./context";
import { checkClaudePlugins, installClaudePlugins } from "./plugins";

let t: ReturnType<typeof tempHome>;
let lines: string[] = [];
beforeEach(() => {
	t = tempHome("plugins");
	lines = [];
});
afterEach(() => t.cleanup());

const ok = (stdout: string, code = 0) => ({ code, stdout, stderr: "", timedOut: false });

/** Writes Claude Code's registry with these plugins and their installs. */
function registry(plugins: Record<string, { scope?: string; projectPath?: string }[]>): void {
	const dir = join(t.paths.home, ".claude/plugins");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "installed_plugins.json"), JSON.stringify({ version: 2, plugins }));
}

function ctx(run: KindCtx["run"]): KindCtx {
	return {
		paths: t.paths,
		run,
		fetch: async () => new Response(""),
		token: null,
		settings: DEFAULT_SETTINGS,
		log: (l) => lines.push(l),
		stage: () => {},
	};
}

test("no registry leaves the row out; one makes it a fresh row with nothing to compare", () => {
	const { run } = recordingRun(t.paths, () => ok(""));
	expect(checkClaudePlugins(ctx(run))).toBeNull();
	expect(lines[0]).toStartWith("Claude Code plugins: no registry at ");
	registry({});
	expect(checkClaudePlugins(ctx(run))).toEqual({
		installed: null,
		latest: null,
		status: "fresh",
		target: { from: null, version: "", tag: "" },
	});
});

test("each install is updated in its own scope and folder, never with -y; one bad answer fails the row by name", async () => {
	registry({
		"a@m": [{ scope: "user" }],
		"b@m": [{}],
		"c@m": [{ scope: "local", projectPath: "/work/proj" }],
		"d@m": [{ scope: "user" }],
		"e@m": [{ scope: "user" }],
	});
	const answers: Record<string, string> = {
		"a@m": 'noise\n{"updateOutcome":"up_to_date"}\n',
		"b@m": '{"updateOutcome":"updated","message":"b@m updated to 2.0"}',
		"c@m": '{"updateOutcome":"up_to_date"}',
		"d@m": "not json at all",
		"e@m": "",
	};
	// The marketplace refresh fails, and the updates still run.
	const { run, calls } = recordingRun(t.paths, (argv) =>
		argv[2] === "marketplace" ? ok("", 1) : ok(answers[argv[3] ?? ""] ?? ""),
	);
	const out = await installClaudePlugins(ctx(run));
	expect(out).toMatchObject({ result: "failed", detail: "Could not update d@m, e@m. See the log." });
	expect(calls.every((c) => !c.argv.includes("-y"))).toBe(true);
	expect(calls.map((c) => [c.argv.slice(3).join(" "), c.opts.cwd])).toEqual([
		["update", t.paths.home],
		["a@m --scope user --json", t.paths.home],
		["b@m --scope user --json", t.paths.home],
		["c@m --scope local --json", "/work/proj"],
		["d@m --scope user --json", t.paths.home],
		["e@m --scope user --json", t.paths.home],
	]);
	expect(lines).toContain("Marketplace refresh failed.");
	expect(lines).toContain("a@m is up to date");
	expect(lines).toContain("b@m updated to 2.0");
	expect(lines).toContain("d@m update failed: not json at all");
	expect(lines).toContain("e@m update failed: no output");
});

test("every plugin up to date or updated is done, saying how many changed", async () => {
	registry({ "a@m": [{}], "b@m": [{}] });
	const { run } = recordingRun(t.paths, (argv) =>
		ok(argv[3] === "a@m" ? '{"updateOutcome":"updated"}' : '{"updateOutcome":"up_to_date"}'),
	);
	expect(await installClaudePlugins(ctx(run))).toMatchObject({
		result: "done",
		installed: null,
		detail: "Updated 1. New sessions pick them up.",
	});
	expect(lines).toContain("a@m updated");
	const quiet = recordingRun(t.paths, () => ok('{"updateOutcome":"up_to_date"}'));
	expect((await installClaudePlugins(ctx(quiet.run))).detail).toBeUndefined();
	// A registry that is not JSON has nothing to update.
	writeFileSync(join(t.paths.home, ".claude/plugins/installed_plugins.json"), "{");
	expect(await installClaudePlugins(ctx(quiet.run))).toMatchObject({ result: "done" });
});
