import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cutTable, ensureManifest, loadCatalogue, loadManifest, tomlTable } from "./manifest";
import { paths } from "./paths";

const SEED = join(import.meta.dir, "../../manifest/apps.toml");
const CATALOGUE = join(import.meta.dir, "../../catalogue");
const EXAMPLES = join(import.meta.dir, "../../manifest/examples.toml");
let dir = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "upkeep-manifest-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

test("every catalogue asset pattern compiles, and rtk and rustdesk are anchored", () => {
	const { apps } = loadCatalogue(CATALOGUE);
	for (const a of apps) if (a.asset) expect(() => new RegExp(a.asset ?? "")).not.toThrow();
	const asset = (key: string) => apps.find((a) => a.key === key)?.asset;
	expect(asset("rtk")).toBe("^rtk-oss-x86_64-unknown-linux-musl\\.tar\\.gz$");
	expect(asset("rustdesk")).toBe("^rustdesk-[0-9.]+-x86_64\\.deb$");
	expect(apps.find((a) => a.key === "lrcget")?.meta_path).toBe("usr/share/metainfo/lrcget.metainfo.xml");
});

test("the list a new person starts with is empty, and loads with no error; a mistyped header is an error", () => {
	expect(loadManifest(SEED)).toEqual({ apps: [], errors: [] });
	const typo = join(dir, "typo.toml");
	writeFileSync(typo, '[app.fd]\nname = "fd"\n');
	expect(loadManifest(typo)).toEqual({ apps: [], errors: [`${typo}: no [apps.<key>] tables`] });
});

test("the source-build examples load with no errors", () => {
	const { apps, errors } = loadManifest(EXAMPLES);
	expect(errors).toEqual([]);
	expect(apps.map((a) => [a.key, a.kind])).toEqual([
		["whisper", "source"],
		["llama", "source"],
		["comfyui", "source"],
		["dsh", "source"],
		["strata", "source"],
	]);
});

test("the catalogue loads 48 apps, one per file, none of them installing without asking", () => {
	const { apps, errors } = loadCatalogue(CATALOGUE);
	expect(errors).toEqual([]);
	expect(apps.length).toBe(48);
	const counts: Record<string, number> = {};
	for (const a of apps) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
	expect(counts).toEqual({ appimage: 6, archive: 29, file: 4, deb: 2, source: 2, command: 5 });
	expect(apps.filter((a) => a.auto)).toEqual([]);
	const fd = apps.find((a) => a.key === "fd");
	expect(fd).toEqual({
		key: "fd",
		name: "fd",
		kind: "archive",
		repo: "sharkdp/fd",
		asset: "x86_64-unknown-linux-gnu\\.tar\\.gz$",
		dest: "~/.local/bin/fd",
		bins: ["fd"],
	});
});

test("an invalid table is left out and reported, the rest load", () => {
	const file = join(dir, "apps.toml");
	writeFileSync(
		file,
		[
			"[apps.good]",
			'name = "Good"',
			'kind = "file"',
			'repo = "a/b"',
			'asset = "x$"',
			'dest = "~/x"',
			"[apps.noasset]",
			'name = "No asset"',
			'kind = "appimage"',
			'repo = "a/b"',
			'dest = "~/y"',
			"[apps.nobins]",
			'name = "No bins"',
			'kind = "archive"',
			'repo = "a/b"',
			'asset = "x"',
			'dest = "~/z"',
			"[apps.cmd]",
			'name = "Cmd"',
			'kind = "command"',
			'check = ["x", "--version"]',
			'latest = "npm:x"',
			"[apps.leg]",
			'name = "Leg"',
			'kind = "legacy"',
			"[apps.cc]",
			'name = "Plugins"',
			'kind = "claude-plugins"',
			"[apps.man]",
			'name = "Man"',
			'kind = "manual"',
			'check = ["man", "--version"]',
			'latest = "npm:man"',
		].join("\n"),
	);
	const { apps, errors } = loadManifest(file);
	expect(apps.map((a) => a.key)).toEqual(["good", "cc"]);
	expect(errors).toEqual([
		"noasset: asset is required for kind appimage",
		"nobins: bins is required for kind archive",
		"cmd: update is required for kind command",
		"leg: kind is not one of appimage, archive, file, deb, rpm, source, command, claude-plugins, manual",
		"man: run is required for kind manual",
	]);
});

test("relaunch needs dest, and an AppImage's needs process too; restart is a list", () => {
	const file = join(dir, "apps.toml");
	writeFileSync(
		file,
		[
			"[apps.nodest]",
			'name = "No dest"',
			'kind = "command"',
			'check = ["x", "--version"]',
			'latest = "npm:x"',
			'update = ["x", "up"]',
			"relaunch = true",
			"[apps.noproc]",
			'name = "No proc"',
			'kind = "appimage"',
			'repo = "a/b"',
			'asset = "x"',
			'dest = "~/x.AppImage"',
			"relaunch = true",
			"[apps.svc]",
			'name = "Svc"',
			'kind = "deb"',
			'repo = "a/b"',
			'asset = "x"',
			'dest = "/usr/bin/svc"',
			'restart = ["systemctl", "restart", "svc"]',
			"[apps.zen]",
			'name = "Zen"',
			'kind = "appimage"',
			'repo = "a/b"',
			'asset = "x"',
			'dest = "~/zen.AppImage"',
			'process = "zen"',
			"relaunch = true",
			"[apps.py]",
			'name = "Py"',
			'kind = "file"',
			'repo = "a/b"',
			'asset = "x"',
			'dest = "~/py"',
			'process = "python3"',
			"relaunch = true",
		].join("\n"),
	);
	const { apps, errors } = loadManifest(file);
	expect(errors).toEqual([
		"nodest: relaunch needs dest",
		"noproc: relaunch needs process",
		"py: relaunch would close every python3 process; give process the app's own name",
	]);
	expect(apps.map((a) => [a.key, a.restart ?? a.relaunch])).toEqual([
		["svc", ["systemctl", "restart", "svc"]],
		["zen", true],
	]);
});

test("an AppImage needs repo, or a latest that carries its download", () => {
	const file = join(dir, "apps.toml");
	writeFileSync(
		file,
		[
			"[apps.none]",
			'name = "None"',
			'kind = "appimage"',
			'asset = "x"',
			'dest = "~/n.AppImage"',
			"[apps.cursor]",
			'name = "Cursor"',
			'kind = "appimage"',
			'latest = "json:https://api.test/x"',
			'asset = "x"',
			'dest = "~/c.AppImage"',
		].join("\n"),
	);
	writeFileSync(
		file,
		`${readFileSync(file, "utf8")}\n[apps.src]\nname = "Src"\nkind = "source"\nlatest = "json:https://api.test/y"\nbuild = ["make"]\n`,
	);
	const { apps, errors } = loadManifest(file);
	expect(errors).toEqual([
		"none: repo or latest is required for kind appimage",
		"src: a json: latest is only for kind appimage",
	]);
	expect(apps.map((a) => a.key)).toEqual(["cursor"]);
});

test("versionless is for Claude Code's plugins only, and the plugins row always is", () => {
	const file = join(dir, "apps.toml");
	writeFileSync(
		file,
		[
			"[apps.man]",
			'name = "Man"',
			'kind = "manual"',
			'check = ["man", "--version"]',
			'latest = "npm:man"',
			'run = "man-up"',
			"versionless = true",
			"[apps.cc]",
			'name = "Claude Code plugins"',
			'kind = "claude-plugins"',
		].join("\n"),
	);
	const { apps, errors } = loadManifest(file);
	expect(errors).toEqual(["man: versionless is only for kind claude-plugins"]);
	expect(apps).toEqual([{ key: "cc", name: "Claude Code plugins", kind: "claude-plugins", versionless: true }]);
});

test("a latest whose source the check cannot read is refused at load", () => {
	const file = join(dir, "apps.toml");
	writeFileSync(
		file,
		[
			"[apps.x]",
			'name = "X"',
			'kind = "command"',
			'check = ["x", "--version"]',
			'latest = "gitlab:o/x"',
			'update = ["x", "up"]',
		].join("\n"),
	);
	expect(loadManifest(file).errors).toEqual(["x: latest must start with npm:, pypi:, github:, npm-tags: or json:"]);
});

test("a file that is not TOML is one error and no apps", () => {
	const file = join(dir, "apps.toml");
	writeFileSync(file, "[apps.x\nname = ");
	const { apps, errors } = loadManifest(file);
	expect(apps).toEqual([]);
	expect(errors.length).toBe(1);
});

test("ensureManifest copies the seed once and never overwrites", () => {
	const p = paths({ HOME: dir, XDG_CONFIG_HOME: join(dir, "c") });
	const target = ensureManifest(p, SEED);
	expect(target).toBe(join(dir, "c/upkeep/apps.toml"));
	expect(readFileSync(target, "utf8")).toBe(readFileSync(SEED, "utf8"));
	writeFileSync(target, "# mine\n");
	ensureManifest(p, SEED);
	expect(readFileSync(target, "utf8")).toBe("# mine\n");
});

test("cutting a table removes exactly that table from a file with comments and three tables", () => {
	const text = `# My apps
# keep this header

[apps.a]
name = "A" # inline
kind = "file"

# b is the one going
[apps.b]
name = "B"
kind = "file"
# b's own note

[apps.c]
name = "C"
kind = "file"
`;
	expect(cutTable(text, "b")).toBe(`# My apps
# keep this header

[apps.a]
name = "A" # inline
kind = "file"

# b is the one going
[apps.c]
name = "C"
kind = "file"
`);
	expect(cutTable(text, "c")).toBe(`# My apps
# keep this header

[apps.a]
name = "A" # inline
kind = "file"

# b is the one going
[apps.b]
name = "B"
kind = "file"
# b's own note
`);
	expect(cutTable(text, "a")).toBe(`# My apps
# keep this header

# b is the one going
[apps.b]
name = "B"
kind = "file"
# b's own note

[apps.c]
name = "C"
kind = "file"
`);
	expect(cutTable(text, "zz")).toBeNull();
	// The last table, with no blank line before it, still leaves a file that ends in one newline.
	expect(cutTable('[apps.a]\nname = "A"\n[apps.b]\nname = "B"\n\n', "b")).toBe('[apps.a]\nname = "A"\n');
});

test("a written table holds only the spec's fields and parses back to the same spec", () => {
	const spec = {
		key: "x",
		name: 'Tab\t"q" \\',
		kind: "archive" as const,
		repo: "o/x",
		asset: "^x-.*\\.tar\\.gz$",
		dest: "~/.local/bin/x",
		bins: ["x", 'a"b'],
		sudo: false,
		install_if_missing: true,
	};
	writeFileSync(join(dir, "m.toml"), tomlTable(spec));
	expect(loadManifest(join(dir, "m.toml")).apps).toEqual([spec]);
	expect(tomlTable({ key: "y", name: "Y", kind: "file", asset: "it's" })).toBe(`[apps.y]
name = "Y"
kind = "file"
asset = "it's"
`);
});

test("cutting an app takes its own sub-tables with it and leaves the next app whole", () => {
	const text = `[apps.a]
name = "A"
kind = "source"

[[apps.a.serve]]
name = "a-web"

[[apps.a.serve.test]]
name = "answers"

[apps.b]
name = "B"
kind = "file"
`;
	expect(cutTable(text, "a")).toBe(`[apps.b]
name = "B"
kind = "file"
`);
	expect(cutTable(text, "b")).toBe(`[apps.a]
name = "A"
kind = "source"

[[apps.a.serve]]
name = "a-web"

[[apps.a.serve.test]]
name = "answers"
`);
});

test("a catalogue file must hold one table named like the file; a broken one is reported and left out", () => {
	writeFileSync(
		join(dir, "good.toml"),
		'[apps.good]\nname = "Good"\nkind = "file"\nrepo = "a/b"\nasset = "x$"\ndest = "~/x"\n',
	);
	writeFileSync(
		join(dir, "wrong.toml"),
		'[apps.other]\nname = "Other"\nkind = "file"\nrepo = "a/b"\nasset = "x$"\ndest = "~/y"\n',
	);
	writeFileSync(join(dir, "notes.txt"), "not a table");
	const { apps, errors } = loadCatalogue(dir);
	expect(apps.map((a) => a.key)).toEqual(["good"]);
	expect(errors).toEqual(["catalogue/wrong.toml: must hold exactly one table, [apps.wrong]"]);
	expect(loadCatalogue(join(dir, "missing"))).toEqual({ apps: [], errors: [] });
});

test("an rpm table loads with repo, asset and dest, and is refused without an asset as a deb is", () => {
	const file = join(dir, "apps.toml");
	const row = (key: string, kind: string, asset: boolean) =>
		[
			`[apps.${key}]`,
			`name = "${key}"`,
			`kind = "${kind}"`,
			'repo = "a/b"',
			...(asset ? ['asset = "x"'] : []),
			`dest = "/usr/bin/${key}"`,
		].join("\n");
	writeFileSync(file, [row("good", "rpm", true), row("bad", "rpm", false), row("old", "deb", false)].join("\n"));
	const { apps, errors } = loadManifest(file);
	expect(apps.map((a) => a.key)).toEqual(["good"]);
	expect(errors).toEqual(["bad: asset is required for kind rpm", "old: asset is required for kind deb"]);
});
