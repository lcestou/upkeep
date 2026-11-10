import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppKind, AppSpec } from "../shared/types";
import type { Paths } from "./paths";

const KINDS: readonly AppKind[] = ["appimage", "archive", "file", "deb", "source", "command", "legacy", "manual"];

const STRING_FIELDS = [
	"name",
	"repo",
	"asset",
	"dest",
	"meta_path",
	"latest",
	"legacy_name",
	"legacy_key",
	"run",
	"process",
	"note",
] as const;
const LIST_FIELDS = ["bins", "version_args", "build", "check", "update"] as const;
const BOOL_FIELDS = ["sudo", "versionless", "auto", "install_if_missing"] as const;

type Field = keyof AppSpec;

function required(kind: AppKind, versionless: boolean): Field[] {
	switch (kind) {
		case "appimage":
		case "file":
		case "deb":
			return ["repo", "asset", "dest"];
		case "archive":
			return ["repo", "asset", "dest", "bins"];
		case "source":
			return ["repo", "dest", "build"];
		case "command":
			return ["check", "latest", "update"];
		case "legacy":
			return versionless ? ["legacy_key"] : ["legacy_key", "legacy_name"];
		case "manual":
			return ["legacy_name", "run"];
	}
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One [apps.<key>] table checked and lifted into an AppSpec, or the reason it is refused. */
export function lift(key: string, table: Record<string, unknown>): AppSpec | string {
	const kind = table.kind;
	if (typeof kind !== "string" || !KINDS.includes(kind as AppKind))
		return `${key}: kind is not one of ${KINDS.join(", ")}`;
	const spec: AppSpec = { key, name: "", kind: kind as AppKind };
	for (const f of STRING_FIELDS) {
		const v = table[f];
		if (v === undefined) continue;
		if (typeof v !== "string") return `${key}: ${f} must be a string`;
		spec[f] = v;
	}
	for (const f of LIST_FIELDS) {
		const v = table[f];
		if (v === undefined) continue;
		if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return `${key}: ${f} must be a list of strings`;
		spec[f] = v as string[];
	}
	for (const f of BOOL_FIELDS) {
		const v = table[f];
		if (v === undefined) continue;
		if (typeof v !== "boolean") return `${key}: ${f} must be true or false`;
		spec[f] = v;
	}
	for (const f of ["name", ...required(spec.kind, spec.versionless === true)] as Field[]) {
		const v = spec[f];
		if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0))
			return `${key}: ${f} is required for kind ${spec.kind}`;
	}
	if (spec.asset !== undefined) {
		try {
			RegExp(spec.asset);
		} catch {
			return `${key}: asset is not a valid regular expression`;
		}
	}
	return spec;
}

/** Reads apps.toml. A bad table is left out and named in errors; the rest still load. */
export function loadManifest(file: string): { apps: AppSpec[]; errors: string[] } {
	let doc: unknown;
	try {
		doc = Bun.TOML.parse(readFileSync(file, "utf8"));
	} catch (err) {
		return { apps: [], errors: [`${file}: ${err instanceof Error ? err.message : String(err)}`] };
	}
	const tables = isRecord(doc) ? doc.apps : undefined;
	if (!isRecord(tables)) return { apps: [], errors: [`${file}: no [apps.<key>] tables`] };
	const apps: AppSpec[] = [];
	const errors: string[] = [];
	for (const [key, table] of Object.entries(tables)) {
		const result = isRecord(table) ? lift(key, table) : `${key}: is not a table`;
		if (typeof result === "string") errors.push(result);
		else apps.push(result);
	}
	return { apps, errors };
}

/** Copies the seed list into config/apps.toml when there is none. Never overwrites the owner's file. */
export function ensureManifest(paths: Paths, seedFile: string): string {
	const target = join(paths.config, "apps.toml");
	if (!existsSync(target)) {
		mkdirSync(paths.config, { recursive: true });
		copyFileSync(seedFile, target);
	}
	return target;
}

/** The field order a written table uses; key is the table name and is never a field. */
const ORDER: (keyof AppSpec)[] = [
	"name",
	"kind",
	...STRING_FIELDS.filter((f) => f !== "name"),
	...LIST_FIELDS,
	...BOOL_FIELDS,
];

const basic = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;

/** An [apps.<key>] table holding only the fields the spec has. asset is a literal string when it can be. */
export function tomlTable(spec: AppSpec): string {
	const lines = [`[apps.${spec.key}]`];
	for (const f of ORDER) {
		const v = spec[f];
		if (v === undefined) continue;
		let text: string;
		if (typeof v === "boolean") text = String(v);
		else if (Array.isArray(v)) text = `[${v.map(basic).join(", ")}]`;
		else if (f === "asset" && !v.includes("'") && !v.includes("\n")) text = `'${v}'`;
		else text = basic(String(v));
		lines.push(`${f} = ${text}`);
	}
	return `${lines.join("\n")}\n`;
}

/** Writes text to file through a temp name and a rename, keeping the old file as <file>.bak. */
export function replaceManifest(file: string, text: string): void {
	copyFileSync(file, `${file}.bak`);
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
}

/**
 * The file's text with the [apps.<key>] table cut out, up to the next line that starts with "[", or null when
 * there is none. Comment lines right above the next table belong to it and stay.
 */
export function cutTable(text: string, key: string): string | null {
	const lines = text.split("\n");
	const start = lines.findIndex((l) => l.trim() === `[apps.${key}]`);
	if (start < 0) return null;
	let end = start + 1;
	while (end < lines.length && !(lines[end] ?? "").startsWith("[")) end++;
	if (end < lines.length) while (end - 1 > start && (lines[end - 1] ?? "").startsWith("#")) end--;
	const before = lines.slice(0, start);
	const after = lines.slice(end);
	// Cutting the last table leaves the file ending in exactly one newline.
	if (after.every((l) => l === "")) return `${before.join("\n").replace(/\n+$/, "")}\n`;
	return [...before, ...after].join("\n");
}
