import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AppSpec } from "../../shared/types";
import type { FetchLike } from "../github";
import type { Run } from "../run";
import { ok, recordingRun, script, tempHome } from "../testkit";
import { type KindCtx, nonInteractive } from "./context";
import { checkSource, installSource } from "./source";

let t: ReturnType<typeof tempHome>;
let lines: string[] = [];
beforeEach(() => {
	t = tempHome("source");
	lines = [];
});
afterEach(() => t.cleanup());

const fakeFetch: FetchLike = async () =>
	Response.json({ tag_name: "3.6a", html_url: "", published_at: "", body: "", assets: [] });

function ctx(run: Run): KindCtx {
	return {
		paths: t.paths,
		run,
		fetch: fakeFetch,
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
			waitUnmetered: false,
		},
		log: (l) => lines.push(l),
		stage: () => {},
		procRoot: join(t.dir, "proc"),
	};
}

const tmux = (dest: string, build: string[]): AppSpec => ({
	key: "tmux",
	name: "tmux",
	kind: "source",
	repo: "tmux/tmux",
	dest,
	version_args: ["-V"],
	build,
	sudo: true,
});

function cloneFake(t2: typeof t) {
	return recordingRun(t2.paths, (argv) => {
		if (argv[0] !== "git") return undefined;
		mkdirSync(argv.at(-1) ?? "", { recursive: true });
		return ok();
	});
}

test("a broken build is offered as a rebuild at the current tag", async () => {
	const dest = script(
		join(t.dir, "tmux"),
		'echo "tmux: error while loading shared libraries: libtinfow.so.6" >&2; exit 127',
	);
	const { run } = cloneFake(t);
	expect(await checkSource(tmux(dest, []), ctx(run))).toMatchObject({
		status: "ready",
		installed: "3.6a",
		latest: "3.6a",
		detail: "Will not start. A rebuild against the current libraries fixes it.",
		target: { tag: "3.6a", version: "3.6a" },
	});
});

test("install clones the tag, runs each step in the clone, and verifies", async () => {
	const dest = script(join(t.dir, "tmux"), 'echo "tmux 3.6"');
	const { run, calls } = cloneFake(t);
	const c = ctx(run);
	const checked = await checkSource(
		tmux(dest, [`printf '#!/bin/bash\\necho tmux 3.6a\\n' > ${dest}`, "pwd > built-here"]),
		c,
	);
	expect(checked?.status).toBe("ready");
	if (!checked?.target) throw new Error("no target");
	const outcome = await installSource(
		tmux(dest, [`printf '#!/bin/bash\\necho tmux 3.6a\\n' > ${dest}`]),
		checked.target,
		c,
	);
	expect(outcome).toMatchObject({ result: "done", installed: "3.6a" });
	const dir = join(t.paths.cache, "build/tmux");
	expect(calls[1]?.argv).toEqual([
		"git",
		"clone",
		"--branch",
		"3.6a",
		"--depth",
		"1",
		"https://github.com/tmux/tmux.git",
		dir,
	]);
	expect(calls[2]?.opts.cwd).toBe(dir);
	expect(Object.keys(outcome.stages)).toEqual(["download", "install", "verify"]);
});

test("a failing step stops the build, and sudo in a step never prompts", async () => {
	const dest = script(join(t.dir, "tmux"), 'echo "tmux 3.6"');
	const { run, calls } = recordingRun(t.paths, (argv) => {
		if (argv[0] === "git") {
			mkdirSync(argv.at(-1) ?? "", { recursive: true });
			return ok();
		}
		if (argv[2] === "sudo -n make install")
			return { code: 1, stdout: "", stderr: "sudo: a password is required", timedOut: false };
		return undefined;
	});
	const target = { from: "3.6", version: "3.6a", tag: "3.6a" };
	expect(await installSource(tmux(dest, ["exit 3", "true"]), target, ctx(run))).toMatchObject({
		result: "failed",
		detail: "Build step failed: exit 3",
	});
	expect(await installSource(tmux(dest, ["true", "sudo make install"]), target, ctx(run))).toMatchObject({
		result: "failed",
		detail: "sudo needs a password here. Run the update from a terminal.",
	});
	expect(calls.some((x) => x.argv[2] === "sudo -n make install")).toBe(true);
});

test("nonInteractive adds -n to every sudo", () => {
	expect(nonInteractive("sudo make install")).toBe("sudo -n make install");
	expect(nonInteractive("make && sudo make install")).toBe("make && sudo -n make install");
	expect(nonInteractive("sudo -n true")).toBe("sudo -n true");
	expect(nonInteractive("./configure")).toBe("./configure");
	expect(nonInteractive("make\n  sudo make install")).toBe("make\n  sudo -n make install");
	expect(nonInteractive("if true; then sudo make install; fi")).toBe("if true; then sudo -n make install; fi");
	expect(nonInteractive("v=$(sudo cat f) `sudo id`")).toBe("v=$(sudo -n cat f) `sudo -n id`");
	expect(nonInteractive("for u in a; do sudo systemctl stop $u; done")).toBe(
		"for u in a; do sudo -n systemctl stop $u; done",
	);
	expect(nonInteractive("echo pseudo sudo-ish")).toBe("echo pseudo sudo-ish");
});

test("a tag with shell syntax or a leading dash is refused before any command, for a clone and for a checkout", async () => {
	const { run, calls } = recordingRun(t.paths, () => ok());
	const spec = tmux(join(t.dir, "tmux"), ["make"]);
	for (const tag of ["v1$(touch x)", "v1`id`", "1;rm -rf x", "-oops", "v1 2", "v'1"])
		for (const s of [spec, { ...spec, dir: "~/tmux" }]) {
			// oxlint-disable-next-line no-await-in-loop -- one tag at a time
			const o = await installSource(s, { from: "3.6", version: "3.7", tag }, ctx(run));
			expect(o).toMatchObject({
				result: "failed",
				detail: `Refused ${tag}: not a plain version name. Nothing was changed.`,
			});
		}
	expect(calls).toEqual([]);
	expect(
		await installSource(spec, { from: "3.6", version: "3.7", tag: "v3.7-rc.1+build_2" }, ctx(run)),
	).not.toMatchObject({
		detail: expect.stringContaining("not a plain version name"),
	});
});

test("a build step that runs past its limit is reported as timed out", async () => {
	const dest = script(join(t.dir, "tmux"), 'echo "tmux 3.6"');
	const { run, calls } = recordingRun(t.paths, (argv) => {
		if (argv[0] === "git") {
			mkdirSync(argv.at(-1) ?? "", { recursive: true });
			return ok();
		}
		if (argv[0] === "bash") return { code: 137, stdout: "", stderr: "", timedOut: true };
		return undefined;
	});
	const target = { from: "3.6", version: "3.6a", tag: "3.6a" };
	expect(await installSource(tmux(dest, ["make -j"]), target, ctx(run))).toMatchObject({
		result: "failed",
		detail: "Build step timed out: make -j",
	});
	expect(calls.find((x) => x.argv[0] === "bash")?.opts.timeoutMs).toBe(30 * 60_000);
});

test("a build that leaves the app unable to start is a failure that keeps the old version", async () => {
	const dest = script(join(t.dir, "tmux"), 'echo "tmux 3.6"');
	const fake = cloneFake(t);
	const run: Run = async (argv, opts) => {
		opts?.onLine?.(`ran ${argv[0]}`);
		return fake.run(argv, opts);
	};
	const target = { from: "3.6", version: "3.6a", tag: "3.6a" };
	expect(await installSource(tmux(dest, [`printf 'exit 3' > ${dest}`]), target, ctx(run))).toMatchObject({
		result: "failed",
		installed: "3.6",
		detail: "Would not start after the update. No restore point for this kind.",
	});
	expect(lines).toContain("ran git");
});

test("a clone that fails stops before any build step runs", async () => {
	const dest = script(join(t.dir, "tmux"), 'echo "tmux 3.6"');
	const { run, calls } = recordingRun(t.paths, (argv) =>
		argv[0] === "git" ? { code: 128, stdout: "", stderr: "fatal", timedOut: false } : undefined,
	);
	const target = { from: "3.6", version: "3.6a", tag: "3.6a" };
	expect(await installSource(tmux(dest, ["true"]), target, ctx(run))).toMatchObject({
		result: "failed",
		detail: "Could not clone tmux/tmux at 3.6a.",
	});
	expect(calls.some((x) => x.argv[0] === "bash")).toBe(false);
});
