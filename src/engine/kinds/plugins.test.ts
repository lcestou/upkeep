import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../store";
import { recordingRun, tempHome, withCancel } from "../testkit";
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

/** One install as Claude Code's registry records it. */
type Install = { scope?: string; projectPath?: string; version?: string; gitCommitSha?: string };

/** Writes Claude Code's registry with these plugins and their installs. */
function registry(plugins: Record<string, Install[]>): void {
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

/** Writes a marketplace clone at Claude Code's default folder: its marketplace.json and each plugin.json named. */
function market(name: string, plugins: Record<string, unknown>[], manifests: Record<string, string> = {}): string {
	const dir = join(t.paths.home, ".claude/plugins/marketplaces", name);
	mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
	writeFileSync(join(dir, ".claude-plugin/marketplace.json"), JSON.stringify({ name, plugins }));
	for (const [source, version] of Object.entries(manifests)) {
		mkdirSync(join(dir, source, ".claude-plugin"), { recursive: true });
		writeFileSync(join(dir, source, ".claude-plugin/plugin.json"), JSON.stringify({ version }));
	}
	return dir;
}

test("no registry leaves the row out; one refreshes the marketplaces and is fresh with nothing behind", async () => {
	const { run, calls } = recordingRun(t.paths, () => ok(""));
	expect(await checkClaudePlugins(ctx(run))).toBeNull();
	expect(lines[0]).toStartWith("Claude Code plugins: no registry at ");
	expect(calls).toEqual([]);
	registry({});
	expect(await checkClaudePlugins(ctx(run))).toEqual({
		installed: null,
		latest: null,
		status: "fresh",
		target: { from: null, version: "", tag: "" },
	});
	expect(calls.map((c) => c.argv.join(" "))).toEqual(["claude plugin marketplace update"]);
});

test("a plugin whose marketplace holds a newer version, or new commits in its own folder, makes the row ready by name", async () => {
	registry({
		"new@m": [{ version: "1.0.0" }, { scope: "project", projectPath: "/p", version: "1.0.0" }],
		"same@m": [{ version: "2.0.0" }],
		"entry@m": [{ version: "1.0.0" }],
		"remote@m": [{ version: "1.0.0" }],
		"pinned@m": [{ version: "1.0.0" }],
		"nover@m": [{}],
		"gone@m": [{ version: "1.0.0" }],
		"sha@c": [{ version: "abc", gitCommitSha: "abc" }],
		// A commit to another plugin in the same repo moves HEAD but leaves this folder as it was.
		"still@c": [{ version: "abc", gitCommitSha: "abc" }],
		"nosha@c": [{ version: "x" }],
		bare: [{ version: "1.0.0" }],
	});
	market(
		"m",
		[
			// plugin.json's version beats the entry's, as in Claude Code
			{ name: "new", source: "./new", version: "0.1.0" },
			{ name: "same", source: "./same" },
			{ name: "entry", source: "./entry", version: "1.1.0" },
			{ name: "remote", source: { source: "github", repo: "o/r" } },
			{ name: "pinned", source: { source: "github", repo: "o/p" }, version: "1.2.0" },
			{ name: "nover", source: "./nover" },
		],
		{ new: "1.1.0", same: "2.0.0", nover: "9.0.0" },
	);
	const commits = market("c", [
		{ name: "sha", source: "./sha" },
		{ name: "still", source: "./still" },
		{ name: "nosha", source: "./nosha" },
	]);
	// The refresh fails, and what the clones already hold is still compared.
	// git diff --quiet answers 1 when the folder changed and 0 when it did not.
	const { run, calls } = recordingRun(t.paths, (argv) =>
		argv[0] === "git" ? { ...ok(""), code: argv.at(-1) === "./sha" ? 1 : 0 } : { ...ok(""), code: 1 },
	);
	expect(await checkClaudePlugins(ctx(run))).toMatchObject({
		status: "ready",
		installed: null,
		latest: null,
		detail: "New versions in their marketplaces: new, entry, pinned, sha.",
	});
	expect(lines).toContain("Marketplace refresh failed.");
	expect(lines).toContain("new@m: 1.0.0 to 1.1.0 in its marketplace");
	expect(lines).toContain("sha@c: new commits in its marketplace");
	// git is asked only about a plugin versioned by commit that records the commit it came from, and only its folder.
	expect(calls.filter((c) => c.argv[0] === "git").map((c) => c.argv.join(" "))).toEqual([
		`git -C ${commits} diff --quiet abc HEAD -- ./sha`,
		`git -C ${commits} diff --quiet abc HEAD -- ./still`,
	]);
});

test("a clone named in known_marketplaces.json is read there; a git that cannot answer reports nothing", async () => {
	registry({ "a@elsewhere": [{ version: "1.0.0" }], "b@elsewhere": [{ gitCommitSha: "abc" }] });
	const dir = market(
		"moved",
		[
			{ name: "a", source: "./a" },
			{ name: "b", source: "./b" },
		],
		{ a: "1.0.1" },
	);
	writeFileSync(
		join(t.paths.home, ".claude/plugins/known_marketplaces.json"),
		JSON.stringify({ elsewhere: { installLocation: dir } }),
	);
	const { run } = recordingRun(t.paths, (argv) => (argv[0] === "git" ? { ...ok(""), code: 128 } : ok("")));
	expect(await checkClaudePlugins(ctx(run))).toMatchObject({
		status: "ready",
		detail: "New versions in their marketplaces: a.",
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
	const errs: Record<string, string> = { "e@m": "Error: plugin e@m not found in marketplace\n" };
	// The marketplace refresh fails, and the updates still run.
	const { run, calls } = recordingRun(t.paths, (argv) =>
		argv[2] === "marketplace" ? ok("", 1) : { ...ok(answers[argv[3] ?? ""] ?? ""), stderr: errs[argv[3] ?? ""] ?? "" },
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
	expect(lines).toContain("e@m update failed: Error: plugin e@m not found in marketplace");
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

test("an update stopped at its time limit fails, whatever it printed first", async () => {
	registry({ "a@m": [{}] });
	const { run } = recordingRun(t.paths, (argv) =>
		argv[2] === "update" ? { ...ok('{"updateOutcome":"updated"}', 137), timedOut: true } : ok(""),
	);
	expect(await installClaudePlugins(ctx(run))).toMatchObject({
		result: "failed",
		detail: "Could not update a@m. See the log.",
	});
	expect(lines).toContain("a@m update failed: ran past 120 s and was stopped");
});

test("Stop now waits out the plugin being updated and skips the rest", async () => {
	registry({ "a@m": [{ scope: "user" }], "b@m": [{ scope: "user" }] });
	const stop = new AbortController();
	const { run, calls } = recordingRun(t.paths, async (argv) => {
		if (argv[2] === "update" && argv[3] === "a@m") {
			// The press lands while the first plugin updates; that one is never cut.
			stop.abort();
			await Bun.sleep(50);
			return ok('{"updateOutcome":"updated","message":"a@m updated"}');
		}
		return ok("");
	});
	const outcome = await installClaudePlugins({ ...ctx(withCancel(run, stop.signal)), cancel: stop.signal });
	expect(outcome).toMatchObject({ result: "stopped", detail: "Updated 1. New sessions pick them up." });
	expect(calls.map((c) => c.argv.slice(2, 4).join(" "))).toEqual(["marketplace update", "update a@m"]);
	expect(calls.every((c) => c.opts.cuttable !== true)).toBe(true);
});
