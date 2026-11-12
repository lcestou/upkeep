import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSpec } from "../shared/types";
import { isRecord } from "./manifest";
import type { Run } from "./run";

/**
 * The one place that names the tool managers Upkeep reads: uv, pipx, npm and cargo. Each lists what it installed;
 * a listed tool becomes a "command" table that checks, finds the latest and updates through that same manager.
 * The scan only reads these lists. It never runs a tool a manager installed.
 */

/** A tool manager. */
export type Manager = "uv" | "pipx" | "npm" | "cargo";

/** One tool a manager installed, as the manager's own record names it. */
export type Tool = {
	manager: Manager;
	name: string;
	/** The version the manager reported. */
	version: string;
	/** uv: the requirement's extras written as "[github]", or empty. */
	extras: string;
	/** uv: the Python the tool was installed with, when it was pinned. */
	python: string | null;
	/** uv: the GitHub repo "owner/name" a tool was installed from, or null for a package index. */
	repo: string | null;
};

/**
 * A name safe to hand to a shell script and an argv: it starts with a letter, a digit or "@", holds only letters,
 * digits and ". _ @ / -", and has no "..". Names come from a manager's own records; one that fails is dropped.
 */
export function safeName(name: string): boolean {
	return /^[A-Za-z0-9@][A-Za-z0-9._@/-]*$/.test(name) && !name.includes("..");
}

/** How a manager's tools are listed. Names are passed to the shell scripts as arguments, never spliced into them. */
const UV_LIST = ["uv", "tool", "list"];
const PIPX_LIST = ["pipx", "list", "--json"];
const NPM_LIST = ["npm", "ls", "-g", "--json", "--depth=0"];

/** Prints the version uv lists for the tool named $1. */
const UV_CHECK = `v=$(uv tool list 2>/dev/null | awk -v n="$1" '$1==n{print $2}' | sed 's/^v//' | head -1); [ -n "$v" ] || exit 127; echo "$v"`;
/** Prints the git tag a uv tool was installed at, without a leading v; falls back to what uv lists. Exits 127 when the tool is gone. */
const UV_REV_CHECK =
	`f="$HOME/.local/share/uv/tools/$1/uv-receipt.toml"; [ -f "$f" ] || exit 127; ` +
	`v=$(grep -oP 'rev=v?\\K[^"]+' "$f" | head -1); ` +
	`[ -n "$v" ] || v=$(uv tool list 2>/dev/null | awk -v n="$1" '$1==n{print $2}' | sed 's/^v//'); ` +
	`[ -n "$v" ] || exit 127; echo "$v"`;
/** Prints the version pipx lists for the venv named $1. */
const PIPX_CHECK = `v=$(pipx list --short 2>/dev/null | awk -v n="$1" '$1==n{print $2}' | head -1); [ -n "$v" ] || exit 127; echo "$v"`;
/** Prints the version in the package.json of the global npm package named $1. */
const NPM_CHECK = `f="$(npm root -g 2>/dev/null)/$1/package.json"; [ -f "$f" ] || exit 127; grep -m1 -oP '"version":\\s*"\\K[^"]+' "$f"`;
/** Prints the version cargo lists for the crate named $1; its program lines are indented and skipped. */
const CARGO_CHECK = `v=$(cargo install --list 2>/dev/null | awk -v n="$1" '/^[^ ]/ && $1==n{v=$2; sub(/^v/,"",v); sub(/:$/,"",v); print v; exit}'); [ -n "$v" ] || exit 127; echo "$v"`;

/** A check argv that runs script with the tool name as its $1. */
const shCheck = (script: string, name: string) => ["sh", "-c", script, "sh", name];

/** The names a requirement and a tool share, with case and "-", "_" and "." treated as one. */
const norm = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

/** The tools "uv tool list" prints: "name vX.Y.Z" lines. Entrypoint lines ("- name") and anything else are skipped. */
export function parseUvList(text: string): { name: string; version: string }[] {
	const out: { name: string; version: string }[] = [];
	for (const line of text.split("\n")) {
		const m = /^(\S+) v(\S+)$/.exec(line.trim());
		if (m?.[1] && m[2] && !line.startsWith("-") && safeName(m[1])) out.push({ name: m[1], version: m[2] });
	}
	return out;
}

/** The GitHub "owner/name" a git URL points at, or null for any other host, a different shape, or a non-https URL. */
function githubRepo(url: string): string | null {
	const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[?#].*)?$/.exec(url);
	return m?.[1] && m[2] ? `${m[1]}/${m[2]}` : null;
}

/**
 * What a uv receipt says about how the tool called name was installed: its extras, its pinned Python, and the GitHub
 * repo of a git install (null for a package index). Null when the receipt is not TOML, holds no requirement for the
 * tool, or installs from a path, a URL or a git host other than GitHub, which Upkeep cannot update by name.
 */
export function parseUvReceipt(text: string, name: string): Pick<Tool, "extras" | "python" | "repo"> | null {
	let doc: unknown;
	try {
		doc = Bun.TOML.parse(text);
	} catch {
		return null;
	}
	const tool = isRecord(doc) ? doc.tool : null;
	if (!isRecord(tool) || !Array.isArray(tool.requirements)) return null;
	const req = tool.requirements.find((r) => isRecord(r) && typeof r.name === "string" && norm(r.name) === norm(name));
	if (!isRecord(req)) return null;
	// A package in a repo's subfolder cannot be installed again from the repo's root, so it is left out.
	if (["path", "directory", "url", "editable", "subdirectory"].some((k) => req[k] !== undefined)) return null;
	if (typeof req.git === "string" && req.git.includes("subdirectory")) return null;
	let repo: string | null = null;
	if (typeof req.git === "string") {
		repo = githubRepo(req.git);
		if (!repo) return null;
	}
	const extras = Array.isArray(req.extras)
		? req.extras.filter((e) => typeof e === "string" && /^[A-Za-z0-9._-]+$/.test(e))
		: [];
	const python = typeof tool.python === "string" && /^[0-9][0-9.a-z+-]*$/.test(tool.python) ? tool.python : null;
	return { extras: extras.length > 0 ? `[${extras.join(",")}]` : "", python, repo };
}

/** The venvs "pipx list --json" holds whose main package came from the index: the venv name and the version. */
export function parsePipxList(text: string): { name: string; version: string }[] {
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch {
		return [];
	}
	const venvs = isRecord(doc) ? doc.venvs : null;
	if (!isRecord(venvs)) return [];
	const out: { name: string; version: string }[] = [];
	for (const venv of Object.values(venvs)) {
		const main = isRecord(venv) && isRecord(venv.metadata) ? venv.metadata.main_package : null;
		if (!isRecord(main) || typeof main.package !== "string" || typeof main.package_version !== "string") continue;
		// package_or_url is the package's own name for an index install and a URL or path for any other.
		if (main.package_or_url !== undefined && main.package_or_url !== main.package) continue;
		if (safeName(main.package) && main.package_version) out.push({ name: main.package, version: main.package_version });
	}
	return out;
}

/** The global packages "npm ls -g --json --depth=0" lists, without npm itself and corepack, which ship with Node. */
export function parseNpmList(text: string): { name: string; version: string }[] {
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch {
		return [];
	}
	const deps = isRecord(doc) ? doc.dependencies : null;
	if (!isRecord(deps)) return [];
	const out: { name: string; version: string }[] = [];
	for (const [name, dep] of Object.entries(deps)) {
		if (name === "npm" || name === "corepack" || !isRecord(dep) || typeof dep.version !== "string") continue;
		if (safeName(name) && dep.version) out.push({ name, version: dep.version });
	}
	return out;
}

/** The crates from crates.io that cargo installed, read from .crates2.json. A crate from git, a path or another registry is skipped. */
export function parseCrates(text: string): { name: string; version: string }[] {
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch {
		return [];
	}
	const installs = isRecord(doc) ? doc.installs : null;
	if (!isRecord(installs)) return [];
	const out: { name: string; version: string }[] = [];
	for (const id of Object.keys(installs)) {
		// "ripgrep 14.1.0 (registry+https://github.com/rust-lang/crates.io-index)"
		const m =
			/^(\S+) (\S+) \((registry\+https:\/\/github\.com\/rust-lang\/crates\.io-index|sparse\+https:\/\/index\.crates\.io\/)\)$/.exec(
				id,
			);
		if (m?.[1] && m[2] && safeName(m[1])) out.push({ name: m[1], version: m[2] });
	}
	return out;
}

/**
 * The "command" table that updates one managed tool through its own manager. Null when the name is not safe to put
 * in a script. The key is the caller's, so it follows the same rule as every other suggestion.
 */
export function toolSpec(tool: Tool, key: string): AppSpec | null {
	const { name, manager } = tool;
	if (!safeName(name)) return null;
	const base = { key, name, kind: "command" } as const;
	if (manager === "uv") {
		const req = `${name}${tool.extras}`;
		const py = tool.python ? ["--python", tool.python] : [];
		const install = ["uv", "tool", "install", "--reinstall", ...py];
		if (tool.repo) {
			const argv = [...install, `${req} @ git+https://github.com/${tool.repo}@{tag}`];
			return {
				...base,
				check: shCheck(UV_REV_CHECK, name),
				latest: `github:${tool.repo}`,
				update: argv,
				restore: argv,
			};
		}
		const argv = [...install, `${req}=={version}`];
		return { ...base, check: shCheck(UV_CHECK, name), latest: `pypi:${name}`, update: argv, restore: argv };
	}
	if (manager === "pipx") {
		const argv = ["pipx", "install", "--force", `${name}=={version}`];
		return { ...base, check: shCheck(PIPX_CHECK, name), latest: `pypi:${name}`, update: argv, restore: argv };
	}
	if (manager === "npm") {
		const argv = ["npm", "install", "-g", `${name}@{version}`];
		return { ...base, check: shCheck(NPM_CHECK, name), latest: `npm:${name}`, update: argv, restore: argv };
	}
	const argv = ["cargo", "install", "--locked", `${name}@{version}`];
	return { ...base, check: shCheck(CARGO_CHECK, name), latest: `crates:${name}`, update: argv, restore: argv };
}

/**
 * What a manager's list printed; empty when the manager is missing (127) or times out. Any other exit keeps the output,
 * since npm ls exits 1 on a peer or extraneous warning and still prints the full list; a parser reads what it can.
 */
async function listed(run: Run, argv: string[]): Promise<string> {
	const r = await run(argv, { timeoutMs: 10_000 });
	return r.code === 127 || r.timedOut ? "" : r.stdout;
}

/** A file's text, or empty when it cannot be read. */
function read(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/** Tools of a manager whose records carry nothing beyond a name and a version. */
const bare = (manager: Manager, tools: { name: string; version: string }[]): Tool[] =>
	tools.map((t) => ({ manager, ...t, extras: "", python: null, repo: null }));

/**
 * The command table for every tool the managers report, keyed as the scan keys them (a scoped npm name drops its @).
 * The engine writes a command table from the window only when it equals one of these, so a caller cannot slip in
 * commands of its own.
 */
export async function managedSpecs(run: Run, home: string): Promise<AppSpec[]> {
	return (await listTools(run, home)).flatMap((t) => toolSpec(t, toolKey(t.name)) ?? []);
}

/** A tool's key in apps.toml, as the scan makes it: lower case, a scoped npm name without its @, the rest dashes. */
export const toolKey = (name: string) =>
	name
		.replace(/^@/, "")
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-");

/**
 * Every tool the four managers report, in uv, pipx, npm, cargo order. A manager that is missing or fails gives
 * nothing. A uv tool needs its receipt, which tells where it came from; one with no usable receipt is left out.
 */
export async function listTools(run: Run, home: string): Promise<Tool[]> {
	const [uv, pipx, npm] = await Promise.all([listed(run, UV_LIST), listed(run, PIPX_LIST), listed(run, NPM_LIST)]);
	const tools: Tool[] = [];
	for (const t of parseUvList(uv)) {
		const how = parseUvReceipt(read(join(home, ".local/share/uv/tools", t.name, "uv-receipt.toml")), t.name);
		if (how) tools.push({ manager: "uv", ...t, ...how });
	}
	tools.push(...bare("pipx", parsePipxList(pipx)), ...bare("npm", parseNpmList(npm)));
	tools.push(...bare("cargo", parseCrates(read(join(home, ".cargo/.crates2.json")))));
	return tools;
}
