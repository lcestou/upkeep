import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cutTable, ensureManifest, loadManifest, tomlTable } from "./manifest";
import { paths } from "./paths";

const SEED = join(import.meta.dir, "../../manifest/apps.toml");
let dir = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "upkeep-manifest-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

test("every seeded asset pattern compiles, and rtk and rustdesk are anchored", () => {
	const { apps } = loadManifest(SEED);
	for (const a of apps) if (a.asset) expect(() => new RegExp(a.asset ?? "")).not.toThrow();
	const asset = (key: string) => apps.find((a) => a.key === key)?.asset;
	expect(asset("rtk")).toBe("^rtk-oss-x86_64-unknown-linux-musl\\.tar\\.gz$");
	expect(asset("rustdesk")).toBe("^rustdesk-[0-9.]+-x86_64\\.deb$");
	expect(apps.find((a) => a.key === "lrcget")?.meta_path).toBe("usr/share/metainfo/lrcget.metainfo.xml");
});

test("the seed manifest loads 32 apps with no errors", () => {
	const { apps, errors } = loadManifest(SEED);
	expect(errors).toEqual([]);
	expect(apps.length).toBe(32);
	const counts: Record<string, number> = {};
	for (const a of apps) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
	expect(counts).toEqual({ appimage: 3, archive: 9, file: 1, deb: 2, source: 7, command: 5, legacy: 5 });
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
			'legacy_key = "leg"',
			"[apps.legv]",
			'name = "Leg v"',
			'kind = "legacy"',
			'legacy_key = "legv"',
			"versionless = true",
			"[apps.man]",
			'name = "Man"',
			'kind = "manual"',
			'legacy_name = "man"',
		].join("\n"),
	);
	const { apps, errors } = loadManifest(file);
	expect(apps.map((a) => a.key)).toEqual(["good", "legv"]);
	expect(errors).toEqual([
		"noasset: asset is required for kind appimage",
		"nobins: bins is required for kind archive",
		"cmd: update is required for kind command",
		"leg: legacy_name is required for kind legacy",
		"man: run is required for kind manual",
	]);
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
