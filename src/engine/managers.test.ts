import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	safeName,
	listTools,
	parseCrates,
	parseNpmList,
	parsePipxList,
	parseUvList,
	parseUvReceipt,
	toolSpec,
} from "./managers";
import type { Tool } from "./managers";
import { ok, realRun, script, strictRun, tempHome } from "./testkit";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("managers");
});
afterEach(() => t.cleanup());

test("uv tool list is read from the real output, entrypoint lines skipped", () => {
	expect(parseUvList(fixture("uv-tool-list.txt")).map((x) => `${x.name} ${x.version}`)).toEqual([
		"fastanime 3.1.0",
		"git-filter-repo 2.47.0",
		"headroom-ai 0.44.0",
		"iopaint 1.6.0",
		"pr-agent 0.49.0",
		"subliminal 2.7.1",
		"trafilatura 2.2.0",
		"yt-dlp 2026.8.19",
	]);
});

test("a uv receipt gives extras and a pinned Python, and a GitHub git install its repo", () => {
	expect(parseUvReceipt(fixture("uv-receipt-pr-agent.toml"), "pr-agent")).toEqual({
		extras: "[github]",
		python: "3.12",
		repo: "The-PR-Agent/pr-agent",
	});
	expect(parseUvReceipt(fixture("uv-receipt-headroom-ai.toml"), "headroom-ai")).toEqual({
		extras: "[proxy]",
		python: null,
		repo: null,
	});
});

test("a uv receipt for a path, a URL, another git host, another name or bad TOML gives nothing", () => {
	const one = (req: string) => `[tool]\nrequirements = [${req}]\n`;
	expect(parseUvReceipt(one(`{ name = "x", directory = "/src/x" }`), "x")).toBeNull();
	expect(parseUvReceipt(one(`{ name = "x", editable = "/src/x" }`), "x")).toBeNull();
	expect(parseUvReceipt(one(`{ name = "x", url = "https://e.com/x.whl" }`), "x")).toBeNull();
	expect(parseUvReceipt(one(`{ name = "x", git = "https://gitlab.com/o/x" }`), "x")).toBeNull();
	expect(parseUvReceipt(one(`{ name = "y" }`), "x")).toBeNull();
	expect(parseUvReceipt("not = [toml", "x")).toBeNull();
	expect(parseUvReceipt(one(`{ name = "Foo_Bar" }`), "foo-bar")).toEqual({ extras: "", python: null, repo: null });
});

test("pipx list --json gives index installs only", () => {
	const venv = (package_or_url: string) => ({
		metadata: { main_package: { package: "black", package_version: "24.8.0", package_or_url } },
	});
	const json = JSON.stringify({
		venvs: {
			black: venv("black"),
			local: { metadata: { main_package: { package: "local", package_version: "1.0", package_or_url: "/src/local" } } },
			broken: { metadata: {} },
		},
	});
	expect(parsePipxList(json)).toEqual([{ name: "black", version: "24.8.0" }]);
	expect(parsePipxList("nope")).toEqual([]);
});

test("npm ls -g gives global packages without npm and corepack", () => {
	const json = JSON.stringify({
		name: "lib",
		dependencies: {
			corepack: { version: "0.36.0" },
			npm: { version: "11.19.1" },
			wrangler: { version: "4.1.0" },
			"@oh-my-pi/pi-coding-agent": { version: "2.0.1" },
			linked: {},
		},
	});
	expect(parseNpmList(json)).toEqual([
		{ name: "wrangler", version: "4.1.0" },
		{ name: "@oh-my-pi/pi-coding-agent", version: "2.0.1" },
	]);
});

test("cargo's .crates2.json gives crates.io installs only", () => {
	const json = JSON.stringify({
		installs: {
			"ripgrep 14.1.0 (registry+https://github.com/rust-lang/crates.io-index)": { bins: ["rg"] },
			"fd-find 10.2.0 (sparse+https://index.crates.io/)": { bins: ["fd"] },
			"mine 0.1.0 (path+file:///src/mine)": { bins: ["mine"] },
			"tool 1.0.0 (git+https://github.com/o/tool#abc)": { bins: ["tool"] },
			"other 1.0.0 (registry+https://my.registry/index)": { bins: ["other"] },
		},
	});
	expect(parseCrates(json)).toEqual([
		{ name: "ripgrep", version: "14.1.0" },
		{ name: "fd-find", version: "10.2.0" },
	]);
});

test("names with a shell character, a leading dash or a dot-dot are refused", () => {
	for (const bad of ["a b", "a;rm", "$(x)", "`x`", "-rf", ".hidden", "a/../b", "a'b", ""])
		expect(safeName(bad)).toBe(false);
	for (const good of ["yt-dlp", "@oh-my-pi/pi-coding-agent", "foo_bar.baz"]) expect(safeName(good)).toBe(true);
	const tool: Tool = { manager: "npm", name: "x;y", version: "1", extras: "", python: null, repo: null };
	expect(toolSpec(tool, "x-y")).toBeNull();
	expect(parseUvList("evil;name v1.0\n")).toEqual([]);
});

const base = { extras: "", python: null, repo: null };

test("each manager's tool becomes a command table that updates through that manager", () => {
	const spec = (tool: Tool) => toolSpec(tool, "k");
	const uvPypi = spec({ manager: "uv", name: "headroom-ai", version: "0.44.0", ...base, extras: "[proxy]" });
	expect(uvPypi).toEqual({
		key: "k",
		name: "headroom-ai",
		kind: "command",
		check: expect.arrayContaining(["sh", "-c", "headroom-ai"]),
		latest: "pypi:headroom-ai",
		update: ["uv", "tool", "install", "--reinstall", "headroom-ai[proxy]=={version}"],
		restore: ["uv", "tool", "install", "--reinstall", "headroom-ai[proxy]=={version}"],
	});
	const git = spec({
		manager: "uv",
		name: "pr-agent",
		version: "0.49.0",
		extras: "[github]",
		python: "3.12",
		repo: "The-PR-Agent/pr-agent",
	});
	const gitInstall = [
		"uv",
		"tool",
		"install",
		"--reinstall",
		"--python",
		"3.12",
		"pr-agent[github] @ git+https://github.com/The-PR-Agent/pr-agent@{tag}",
	];
	expect(git).toEqual({
		key: "k",
		name: "pr-agent",
		kind: "command",
		check: expect.arrayContaining(["pr-agent"]),
		latest: "github:The-PR-Agent/pr-agent",
		update: gitInstall,
		restore: gitInstall,
	});
	expect(git?.check?.[2]).toContain("uv-receipt.toml");
	const pipx = spec({ manager: "pipx", name: "black", version: "24.8.0", ...base });
	expect(pipx?.update).toEqual(["pipx", "install", "--force", "black=={version}"]);
	expect(pipx?.latest).toBe("pypi:black");
	const npm = spec({ manager: "npm", name: "@scope/pkg", version: "1.0.0", ...base });
	expect(npm?.update).toEqual(["npm", "install", "-g", "@scope/pkg@{version}"]);
	expect(npm?.restore).toEqual(npm?.update);
	expect(npm?.latest).toBe("npm:@scope/pkg");
	expect(npm?.check?.slice(3)).toEqual(["sh", "@scope/pkg"]);
	const cargo = spec({ manager: "cargo", name: "ripgrep", version: "14.1.0", ...base });
	expect(cargo?.update).toEqual(["cargo", "install", "--locked", "ripgrep@{version}"]);
	expect(cargo?.latest).toBe("crates:ripgrep");
});

test("the check scripts print the installed version when run against fake managers", async () => {
	const dir = join(t.dir, "bin");
	script(join(dir, "uv"), `printf 'yt-dlp v2026.8.19\\n- yt-dlp\\npr-agent v0.49.0\\n'`);
	script(join(dir, "pipx"), `printf 'black 24.8.0\\n'`);
	script(join(dir, "cargo"), `printf 'ripgrep v14.1.0:\\n    rg\\nrg v9.9.9:\\n    other\\n'`);
	const root = join(t.dir, "npmroot");
	script(join(dir, "npm"), `echo ${root}`);
	await Bun.write(join(root, "wrangler/package.json"), `{\n  "name": "wrangler",\n  "version": "4.1.0"\n}`);
	const exec = realRun(t.paths, `${dir}:/usr/bin:/bin`);
	const out = async (tool: Tool) => (await exec(toolSpec(tool, "k")?.check ?? [])).stdout.trim();
	expect(await out({ manager: "uv", name: "yt-dlp", version: "", ...base })).toBe("2026.8.19");
	expect(await out({ manager: "pipx", name: "black", version: "", ...base })).toBe("24.8.0");
	expect(await out({ manager: "cargo", name: "ripgrep", version: "", ...base })).toBe("14.1.0");
	expect(await out({ manager: "cargo", name: "other", version: "", ...base })).toBe("");
	expect(await out({ manager: "npm", name: "wrangler", version: "", ...base })).toBe("4.1.0");
	const uvDir = join(t.paths.home, ".local/share/uv/tools/pr-agent");
	await Bun.write(join(uvDir, "uv-receipt.toml"), fixture("uv-receipt-pr-agent.toml"));
	const git: Tool = { manager: "uv", name: "pr-agent", version: "", ...base, repo: "The-PR-Agent/pr-agent" };
	expect(await out(git)).toBe("0.50.0");
	expect((await exec(toolSpec({ ...git, name: "gone" }, "k")?.check ?? [])).code).toBe(127);
});

test("listTools asks each manager, reads uv receipts and cargo's file; a missing manager gives nothing, and npm's list counts even when npm ls exits 1 on a peer warning", async () => {
	const uvDir = join(t.paths.home, ".local/share/uv/tools");
	await Bun.write(join(uvDir, "pr-agent/uv-receipt.toml"), fixture("uv-receipt-pr-agent.toml"));
	await Bun.write(join(uvDir, "yt-dlp/uv-receipt.toml"), `[tool]\nrequirements = [{ name = "yt-dlp" }]\n`);
	await Bun.write(
		join(t.paths.home, ".cargo/.crates2.json"),
		JSON.stringify({
			installs: { "ripgrep 14.1.0 (registry+https://github.com/rust-lang/crates.io-index)": { bins: ["rg"] } },
		}),
	);
	const { run, calls } = strictRun((argv) => {
		if (argv[0] === "uv") return ok("yt-dlp v2026.8.19\n- yt-dlp\npr-agent v0.49.0\n- pr-agent\nnoreceipt v1.0\n");
		if (argv[0] === "pipx") return { code: 127, stdout: "", stderr: "", timedOut: false };
		if (argv[0] === "npm")
			return { code: 1, stdout: '{"dependencies":{"x":{"version":"1"}}}', stderr: "", timedOut: false };
		return undefined;
	});
	const tools = await listTools(run, t.paths.home);
	expect(tools.map((x) => `${x.manager}:${x.name}:${x.version}`)).toEqual([
		"uv:yt-dlp:2026.8.19",
		"uv:pr-agent:0.49.0",
		"npm:x:1",
		"cargo:ripgrep:14.1.0",
	]);
	expect(calls.map((c) => c.argv)).toEqual([
		["uv", "tool", "list"],
		["pipx", "list", "--json"],
		["npm", "ls", "-g", "--json", "--depth=0"],
	]);
	expect(calls.every((c) => c.opts.timeoutMs === 10_000)).toBe(true);
});

test("a uv tool from a subfolder of a GitHub repo is left out, since its root does not install it", () => {
	const r = (extra: string) =>
		parseUvReceipt(`[tool]\nrequirements = [{ name = "x", git = "https://github.com/o/r"${extra} }]\n`, "x");
	expect(r("")?.repo).toBe("o/r");
	expect(r(', subdirectory = "pkg"')).toBeNull();
	expect(
		parseUvReceipt(`[tool]\nrequirements = [{ name = "x", git = "https://github.com/o/r?subdirectory=pkg" }]\n`, "x"),
	).toBeNull();
});
