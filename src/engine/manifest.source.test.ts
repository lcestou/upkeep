import { expect, test } from "bun:test";
import { lift } from "./manifest";

const table = (toml: string, key: string) => {
	const doc = Bun.TOML.parse(toml) as { apps: Record<string, Record<string, unknown>> };
	return lift(key, doc.apps[key] ?? {});
};
const base = { name: "X", kind: "source", build: ["make"], check: ["x", "--version"], repo: "o/x" };
const withField = (extra: Record<string, unknown>) => lift("x", { ...base, ...extra });

test("each source rule refuses its table with its own sentence", () => {
	const { check: _c, ...noCheck } = base;
	expect(lift("x", noCheck)).toBe("x: check or dest is required for kind source");
	const { repo: _r, ...noRepo } = base;
	expect(lift("x", noRepo)).toBe("x: repo or latest is required for kind source");
	expect(withField({ dir: "~/x", move: "rebase" })).toBe("x: move must be ff, reset or detach");
	expect(withField({ move: "ff" })).toBe("x: move needs dir");
	expect(lift("x", { ...noRepo, latest: "npm-tags:x", commit: ["git", "rev-parse", "HEAD"] })).toBe(
		"x: commit needs a GitHub repo",
	);
	expect(withField({ pause: [{ name: "a", active: ["true"] }] })).toBe("x: pause entry 1 needs stop");
	expect(withField({ serve: [{ name: "a", active: ["t"], stop: ["t"] }] })).toBe("x: serve entry 1 needs start");
	expect(withField({ busy: [{ say: "No." }] })).toBe("x: busy entry 1 needs process or run");
	expect(withField({ busy: [{ process: "p" }] })).toBe("x: busy entry 1 needs say");
	expect(withField({ record: [{ file: "f.txt" }] })).toBe("x: record entry 1 needs run");
	expect(withField({ config: [{ file: "c.json", value: 1 }] })).toBe("x: config entry 1 needs key or array and flag");
	expect(withField({ config: [{ file: "c.json", array: "args", value: 1 }] })).toBe(
		"x: config entry 1 needs key or array and flag",
	);
	expect(withField({ place: [{ from: "a" }] })).toBe("x: place entry 1 needs to");
	expect(withField({ test: [{ run: ["t"] }, { name: "no way to run" }] })).toBe("x: test entry 2 needs run or url");
	expect(withField({ test: ["not a table"] })).toBe("x: test entry 1 needs to be a table");
	expect(withField({ test: [{ url: "http://h/", expect: "(" }] })).toBe("x: test entry 1 has an invalid pattern");
	expect(withField({ test: [{ run: ["t"], fail_on: "[" }] })).toBe("x: test entry 1 has an invalid pattern");
	expect(withField({ busy: [{ process: "p", say: "s", when: "start" }] })).toBe("x: busy entry 1 when must be stopped");
});

test("a whisper-shaped and a llama-shaped table lift with every field", () => {
	const whisper = table(
		`[apps.w]
name = "W"
kind = "source"
repo = "o/w"
dir = "~/w"
move = "detach"
check = ["sh", "-c", "git describe --tags"]
keep = ["build"]
build = ["cmake --build build -j 6"]
test = [{ name = "starts", run = ["build/bin/w", "--help"], timeout_s = 30 }]
`,
		"w",
	);
	expect(whisper).toEqual({
		key: "w",
		name: "W",
		kind: "source",
		repo: "o/w",
		dir: "~/w",
		move: "detach",
		check: ["sh", "-c", "git describe --tags"],
		keep: ["build"],
		build: ["cmake --build build -j 6"],
		test: [{ name: "starts", run: ["build/bin/w", "--help"], timeout_s: 30 }],
	});
	const llama = table(
		`[apps.l]
name = "L"
kind = "source"
repo = "o/l"
dir = "~/l"
move = "ff"
check = ["sh", "-c", "v"]
commit = ["sh", "-c", "c"]
stage = "~/l/build-upkeep-{tag}"
needs = ["sh", "-c", "n"]
prune = ["~/l/build-*"]
build = ["cmake -S . -B {stage}", "cmake --build {stage}"]
check_built = ["{stage}/bin/s --version"]
place = [{ from = "{stage}/bin/s", to = "~/bin/s" }]
busy = [{ process = "main.py", say = "A job runs." }, { run = ["sh", "-c", "q"], say = "Queued.", when = "stopped" }]
pause = [{ name = "api", active = ["is-active"], stop = ["stop"], start = ["start"] }, { name = "dog", active = ["a"], stop = ["s"] }]

[[apps.l.serve]]
name = "s"
active = ["a"]
stop = ["sudo", "stop"]
start = ["sudo", "start"]
since = ["show"]
health = "http://127.0.0.1:1/health"
expect = '"loaded": true'
status = 200
wait_s = 120

[[apps.l.serve.test]]
name = "gen"
url = "http://127.0.0.1:1/c"
body = '{"a":1}'
expect = '"n"'
timeout_s = 120
required = false
`,
		"l",
	);
	expect(typeof llama).toBe("object");
	if (typeof llama === "string") throw new Error(llama);
	expect(llama.serve).toEqual([
		{
			name: "s",
			active: ["a"],
			stop: ["sudo", "stop"],
			start: ["sudo", "start"],
			since: ["show"],
			health: "http://127.0.0.1:1/health",
			expect: '"loaded": true',
			status: 200,
			wait_s: 120,
			test: [
				{ name: "gen", url: "http://127.0.0.1:1/c", body: '{"a":1}', expect: '"n"', timeout_s: 120, required: false },
			],
		},
	]);
	expect(llama.pause).toEqual([
		{ name: "api", active: ["is-active"], stop: ["stop"], start: ["start"] },
		{ name: "dog", active: ["a"], stop: ["s"] },
	]);
	expect(llama.busy).toEqual([
		{ process: "main.py", say: "A job runs." },
		{ run: ["sh", "-c", "q"], say: "Queued.", when: "stopped" },
	]);
	expect([llama.stage, llama.needs, llama.prune, llama.check_built, llama.place, llama.commit]).toEqual([
		"~/l/build-upkeep-{tag}",
		["sh", "-c", "n"],
		["~/l/build-*"],
		["{stage}/bin/s --version"],
		[{ from: "{stage}/bin/s", to: "~/bin/s" }],
		["sh", "-c", "c"],
	]);
});

test("paths lift unchanged: expansion happens where they are used", () => {
	expect(withField({ dir: "~/x", move: "ff" })).toMatchObject({ dir: "~/x", move: "ff" });
});

test("a clone-shaped source table still lifts as before, and the fields are ignored for other kinds", () => {
	expect(
		lift("t", { name: "tmux", kind: "source", repo: "tmux/tmux", dest: "/usr/local/bin/tmux", build: ["make"] }),
	).toEqual({
		key: "t",
		name: "tmux",
		kind: "source",
		repo: "tmux/tmux",
		dest: "/usr/local/bin/tmux",
		build: ["make"],
	});
	expect(
		lift("f", { name: "F", kind: "file", repo: "o/f", asset: "f$", dest: "~/f", dir: "~/x", move: "bad" }),
	).toEqual({
		key: "f",
		name: "F",
		kind: "file",
		repo: "o/f",
		asset: "f$",
		dest: "~/f",
	});
});
