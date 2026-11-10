import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
const BOOL_FIELDS = ["sudo", "versionless", "auto"] as const;

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

function lift(key: string, table: Record<string, unknown>): AppSpec | string {
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
