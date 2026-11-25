import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { MESSAGES } from "../shared/messages";
import type { AppKind, AppSpec, Serve, Service, Test } from "../shared/types";
import { FORGES, forgeOf, hostKind, hostOf } from "./forge";
import type { Paths } from "./paths";

const KINDS: readonly AppKind[] = [
	"appimage",
	"archive",
	"file",
	"deb",
	"rpm",
	"source",
	"command",
	"claude-plugins",
	"manual",
];

const STRING_FIELDS = [
	"name",
	"repo",
	"asset",
	"asset_aarch64",
	"dest",
	"meta_path",
	"folder",
	"latest",
	"run",
	"process",
	"note",
] as const;
const LIST_FIELDS = ["bins", "version_args", "build", "check", "update", "restore", "restart"] as const;
const BOOL_FIELDS = ["sudo", "versionless", "auto", "install_if_missing", "relaunch", "probe"] as const;
// Process names that many programs share: relaunch closes every process with its name, so it refuses these.
// shortcut: a fixed list of common interpreters; a table naming another shared runtime is the owner's to get right.
const SHARED_NAMES = new Set([
	"sh",
	"bash",
	"zsh",
	"dash",
	"fish",
	"python",
	"python3",
	"node",
	"bun",
	"deno",
	"java",
	"perl",
	"ruby",
	"electron",
]);
// Read only for kind source.
const SOURCE_STRINGS = ["dir", "stage"] as const;
const SOURCE_LISTS = ["commit", "prune", "needs", "keep", "hold", "undo", "check_built"] as const;
const MOVES = ["ff", "reset", "detach"] as const;

type Field = keyof AppSpec;

/** The fields a kind refuses to load without, beyond name. */
function required(kind: AppKind): Field[] {
	switch (kind) {
		case "appimage":
			// repo, or a latest that carries its own download: lift checks that one of the two is there.
			return ["asset", "dest"];
		case "file":
		case "deb":
		case "rpm":
			// repo, or a links: latest: lift checks that one of the two is there.
			return ["asset", "dest"];
		case "archive":
			return ["asset", "dest", "bins"];
		case "source":
			// A checkout row reads its version with check; a clone row probes dest, as tmux and cava do.
			return ["build"];
		case "command":
			return ["check", "latest", "update"];
		case "claude-plugins":
			// Everything it needs is Claude Code's own registry.
			return [];
		case "manual":
			// Tracked only: Upkeep checks it and the owner runs the update.
			return ["check", "latest", "run"];
	}
}

/** Arrays do not count, though typeof calls them objects: a TOML array is never a table. */
export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One [apps.<key>] table checked and lifted into an AppSpec, or the reason it is refused. */
export function lift(key: string, table: Record<string, unknown>): AppSpec | string {
	const kind = KINDS.find((k) => k === table.kind);
	if (kind === undefined) return MESSAGES.liftKindNotOneOf(key, KINDS.join(", "));
	const spec: AppSpec = { key, name: "", kind };
	for (const f of STRING_FIELDS) {
		const v = table[f];
		if (v === undefined) continue;
		if (typeof v !== "string") return MESSAGES.liftMustBeString(key, f);
		spec[f] = v;
	}
	for (const f of LIST_FIELDS) {
		const v = table[f];
		if (v === undefined) continue;
		if (!Array.isArray(v) || !v.every((x): x is string => typeof x === "string"))
			return MESSAGES.liftMustBeList(key, f);
		spec[f] = v;
	}
	for (const f of BOOL_FIELDS) {
		const v = table[f];
		if (v === undefined) continue;
		if (typeof v !== "boolean") return MESSAGES.liftMustBeBool(key, f);
		spec[f] = v;
	}
	const needed: Field[] = ["name", ...required(spec.kind)];
	for (const f of needed) {
		// A pattern for either architecture is enough: the other one's machines are told so at check.
		const v = f === "asset" ? (spec.asset ?? spec.asset_aarch64) : spec[f];
		if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0))
			return MESSAGES.liftRequiredForKind(key, f, spec.kind);
	}
	for (const f of ["asset", "asset_aarch64"] as const) {
		if (!validPattern(spec[f])) return MESSAGES.liftAssetNotRegex(key, f);
	}
	// Only it installs with no version to compare; on any other kind the row would be picked and fail every run.
	if (spec.kind === "claude-plugins") spec.versionless = true;
	else if (spec.versionless) return MESSAGES.liftVersionlessOnly(key);
	if (spec.kind === "appimage" && !spec.repo && !spec.latest) return MESSAGES.liftAppimageRepoOrLatest(key);
	// An install swaps the whole folder out: never home itself, a folder holding others (~/.local/share), one outside
	// home, or one an install as root would write. Under a dot folder it sits three deep (~/.local/share/<app>).
	if (
		spec.folder !== undefined &&
		(spec.sudo ||
			!/^~\/(?:\.[^/]+\/[^/]+\/[^/]+|[^./][^/]*\/[^/]+)/.test(spec.folder) ||
			/(^|\/)\.\.(\/|$)/.test(spec.folder))
	)
		return MESSAGES.liftFolderPlace(key);
	// Only an install Upkeep makes from a release file records the version that probe = false reads back.
	if (spec.probe === false && !["appimage", "archive", "file", "deb", "rpm"].includes(spec.kind))
		return MESSAGES.liftProbeReleaseOnly(key);
	const refused = liftRepo(key, table, spec);
	if (refused) return refused;
	// A source the check cannot read fails here, at load, not later at every check.
	if (spec.latest !== undefined && !/^(npm|pypi|github|npm-tags|json|crates|text|links|zsync):./.test(spec.latest))
		return MESSAGES.liftLatestScheme(key);
	// Only an AppImage installs the download a json: answer names; any other kind would read it as a GitHub repo.
	if (spec.latest?.startsWith("json:") && spec.kind !== "appimage") return MESSAGES.liftJsonOnlyAppimage(key);
	// A .zsync address never changes between versions, so there is no older file to fetch: an AppImage only.
	if (spec.latest?.startsWith("zsync:") && (spec.kind !== "appimage" || !/^zsync:https:\/\/[^/\s]+/.test(spec.latest)))
		return MESSAGES.liftZsyncAppimage(key);
	if (spec.latest?.startsWith("links:")) {
		if (!RELEASE_KINDS.has(spec.kind)) return MESSAGES.liftLinksKinds(key);
		if (!(spec.asset ?? spec.asset_aarch64) || !/^links:https:\/\/[^/\s]+/.test(spec.latest))
			return MESSAGES.liftLinksPage(key);
	}
	if (RELEASE_KINDS.has(spec.kind) && spec.kind !== "appimage" && !spec.repo && !spec.latest?.startsWith("links:"))
		return MESSAGES.liftRepoOrLinks(key, spec.kind);
	// A .. part lets a dest that reads as under home resolve anywhere; no real table needs one.
	if (spec.dest?.split("/").includes("..")) return MESSAGES.liftDestDotDot(key);
	// Relaunch starts dest again and finds what to close by process name: a path match can miss an AppImage or a script.
	if (spec.relaunch && !spec.dest) return MESSAGES.liftRelaunchNeedsDest(key);
	if (spec.relaunch && !spec.process) return MESSAGES.liftRelaunchNeedsProcess(key);
	if (spec.relaunch && SHARED_NAMES.has(spec.process ?? ""))
		return MESSAGES.liftRelaunchShared(key, spec.process ?? "");
	if (spec.kind === "source") {
		const refusedSource = liftSource(key, table, spec);
		if (refusedSource) return refusedSource;
	}
	return spec;
}

/** The kinds that install a release file, and so may take their release from a links: page. */
const RELEASE_KINDS = new Set<AppKind>(["appimage", "archive", "file", "deb", "rpm"]);

/**
 * Checks repo and forge, setting forge on spec; the reason when refused. A repo on a host Upkeep does not know must
 * say its forge, and only such a repo may: on github.com, gitlab.com or codeberg.org the host already says it.
 */
function liftRepo(key: string, table: Record<string, unknown>, spec: AppSpec): string | null {
	if (table.forge !== undefined) {
		const forge = FORGES.find((f) => f === table.forge);
		if (forge === undefined) return MESSAGES.liftForgeValues(key);
		spec.forge = forge;
	}
	const host = spec.repo === undefined ? null : hostOf(spec.repo);
	if (spec.forge && (host === null || hostKind(host) !== undefined)) return MESSAGES.liftForgeOnlySelfHosted(key);
	if (spec.repo === undefined) return null;
	if (host !== null && hostKind(host) === undefined && !spec.forge) return MESSAGES.liftForgeNeeded(key, host);
	const f = forgeOf(spec.repo, spec.forge);
	if (!f) return MESSAGES.liftRepoForm(key);
	// github.com/owner/name is kept as owner/name: every GitHub call builds /repos/<owner>/<name> from it.
	if (f.kind === "github") spec.repo = f.path;
	return null;
}

/** An empty string is false, so a blank field counts as missing. */
const str = (v: unknown): v is string => typeof v === "string" && v !== "";
/** An empty list is false, so it counts as missing. */
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string");
/** An absent pattern is valid; a present one must be a string that compiles as a RegExp. */
const validPattern = (p: unknown) => {
	if (p === undefined) return true;
	if (typeof p !== "string") return false;
	try {
		RegExp(p);
		return true;
	} catch {
		return false;
	}
};

type Entry = Record<string, unknown>;
/** The AppSpec fields that are lists of tables in apps.toml. */
type TableList = "record" | "config" | "place" | "busy" | "pause" | "test" | "serve";
/** One entry of such a list, as the AppSpec holds it. */
type Item<F extends TableList> = NonNullable<AppSpec[F]>[number];
/** One list-of-tables entry: the lifted value, the key it misses, or "pattern" for a bad expect or fail_on. */
type Lifted<T> = T | { missing: string } | "pattern";

/** One test entry: needs run or url; expect and fail_on must be valid patterns. Unknown keys are dropped. */
function liftTest(e: Entry): Lifted<Test> {
	if (!strs(e.run) && !str(e.url)) return { missing: "run or url" };
	if (!validPattern(e.expect) || !validPattern(e.fail_on)) return "pattern";
	const t: Test = {};
	if (str(e.name)) t.name = e.name;
	if (strs(e.run)) t.run = e.run;
	if (str(e.url)) t.url = e.url;
	if (typeof e.body === "string") t.body = e.body;
	if (typeof e.expect === "string") t.expect = e.expect;
	if (typeof e.fail_on === "string") t.fail_on = e.fail_on;
	if (typeof e.timeout_s === "number") t.timeout_s = e.timeout_s;
	if (typeof e.required === "boolean") t.required = e.required;
	return t;
}

/** One pause or serve entry: name, active and stop, plus start for serve. Empty lists count as missing. */
function liftService(e: Entry, needStart: boolean): Lifted<Service> {
	const { name, active, stop, start } = e;
	if (!str(name)) return { missing: "name" };
	if (!strs(active)) return { missing: "active" };
	if (!strs(stop)) return { missing: "stop" };
	if (needStart && !strs(start)) return { missing: "start" };
	const s: Service = { name, active, stop };
	if (strs(start)) s.start = start;
	if (strs(e.since)) s.since = e.since;
	return s;
}

/** The placeholders steps and paths may use. Anything else in braces is a typo, never passed to a shell. */
const PLACEHOLDERS = new Set(["stage", "tag", "version", "needs", "point"]);
const PLACEHOLDER_FIELDS = [
	"stage",
	"build",
	"check_built",
	"undo",
	"prune",
	"keep",
	"hold",
	"record",
	"place",
	"test",
	"serve",
];

/** The first {name} that is not a placeholder, in the fields placeholders are filled in. ${var} is shell's, not ours. */
function unknownPlaceholder(table: Record<string, unknown>): { name: string; field: string } | null {
	const scan = (v: unknown, field: string): { name: string; field: string } | null => {
		if (typeof v === "string") {
			for (const m of v.matchAll(/(?<!\$)\{([a-z_]+)\}/g))
				if (!PLACEHOLDERS.has(m[1] ?? "")) return { name: m[1] ?? "", field };
			return null;
		}
		if (Array.isArray(v)) {
			for (const x of v) {
				const hit = scan(x, field);
				if (hit) return hit;
			}
			return null;
		}
		if (isRecord(v)) {
			// A request body is JSON sent as it is, not a step.
			for (const [k, x] of Object.entries(v)) {
				if (k === "body") continue;
				const hit = scan(x, field);
				if (hit) return hit;
			}
		}
		return null;
	};
	for (const f of PLACEHOLDER_FIELDS) {
		const hit = scan(table[f], f);
		if (hit) return hit;
	}
	return null;
}

/** A table path as written, with no trailing slash and no leading ./, so two can be compared before ~ is known. */
const tidy = (p: string) => p.replace(/\/+$/, "").replace(/^(\.\/)+/, "") || ".";
/** A table path that names its own root (absolute or under ~); any other is taken inside dir. */
const rooted = (p: string) => p.startsWith("/") || p === "~" || p.startsWith("~/");
/** Strictly inside root, as written: root itself is not within root. */
const within = (p: string, root: string) => p.startsWith(`${root}/`);

/**
 * The load-time half of the path checks built.ts and tree.ts repeat where each path is used: keep, hold and prune
 * stay strictly inside dir (inside the stage's parent for a table with no dir), and the stage is never the home
 * directory, dir or a live place target, or above one; a place target is never a folder directly in ~. Compared as written, so an absolute dir with a keep under ~
 * is refused even when it is inside; write both the same way.
 */
function unsafeSourcePath(key: string, spec: AppSpec): string | null {
	const dir = spec.dir === undefined ? null : tidy(spec.dir);
	const stage = spec.stage === undefined ? null : tidy(spec.stage);
	const scope = dir ?? (stage && rooted(stage) ? dirname(stage) : null);
	for (const field of ["keep", "hold", "prune"] as const)
		for (const raw of spec[field] ?? []) {
			const p = tidy(raw);
			const inside = rooted(p) ? scope !== null && within(p, scope) : dir !== null && p !== ".";
			if (!inside || p.split("/").includes("..")) return MESSAGES.liftInsideDir(key, field);
		}
	const kept = new Set((spec.keep ?? []).map(tidy));
	// After a verified update the held copy is deleted; keep is then the only old copy a later restore has.
	if ((spec.hold ?? []).some((h) => !kept.has(tidy(h)))) return MESSAGES.liftHoldInKeep(key);
	if ((spec.place ?? []).some((pl) => dirname(tidy(pl.to)) === "~")) return MESSAGES.liftPlaceInHome(key);
	if (stage !== null) {
		const live = [dir, ...(spec.place ?? []).map((pl) => tidy(pl.to))].filter((x): x is string => x !== null);
		if (
			stage === "~" ||
			stage === "/" ||
			stage === "." ||
			stage.split("/").includes("..") ||
			(!rooted(stage) && dir === null) ||
			live.some((l) => l === stage || within(l, stage))
		)
			return MESSAGES.liftStageUnsafe(key);
	}
	return null;
}

/** The source kind's own fields and rules. Returns the refusal, or null with spec filled in. */
function liftSource(key: string, table: Record<string, unknown>, spec: AppSpec): string | null {
	for (const f of SOURCE_STRINGS) {
		const v = table[f];
		if (v === undefined) continue;
		if (typeof v !== "string") return MESSAGES.liftMustBeString(key, f);
		spec[f] = v;
	}
	for (const f of SOURCE_LISTS) {
		const v = table[f];
		if (v === undefined) continue;
		if (!Array.isArray(v) || !v.every((x): x is string => typeof x === "string"))
			return MESSAGES.liftMustBeList(key, f);
		spec[f] = v;
	}
	if (!spec.check && !spec.dest) return MESSAGES.liftSourceCheckOrDest(key);
	if (!spec.repo && !spec.latest) return MESSAGES.liftSourceRepoOrLatest(key);
	if (table.move !== undefined) {
		const move = MOVES.find((m) => m === table.move);
		if (move === undefined) return MESSAGES.liftMoveValues(key);
		if (spec.dir === undefined) return MESSAGES.liftMoveNeedsDir(key);
		spec.move = move;
	}
	// The commit compare is GitHub's alone.
	if (spec.commit && (!spec.repo || forgeOf(spec.repo, spec.forge)?.kind !== "github"))
		return MESSAGES.liftCommitNeedsRepo(key);

	// Lists of tables: each entry is checked, then lifted with only the keys it may carry.
	const each = <F extends TableList>(
		field: F,
		lift1: (e: Entry) => Lifted<Item<F>>,
	): Item<F>[] | string | undefined => {
		const v = table[field];
		if (v === undefined) return undefined;
		if (!Array.isArray(v)) return MESSAGES.liftEntryNotTable(key, field);
		const out: Item<F>[] = [];
		for (const [i, e] of v.entries()) {
			const r = isRecord(e) ? lift1(e) : { missing: "to be a table" };
			if (r === "pattern") return MESSAGES.liftEntryBadPattern(key, field, i + 1);
			if (typeof r === "object" && r !== null && "missing" in r)
				return MESSAGES.liftEntryNeeds(key, field, i + 1, r.missing);
			// SAFETY: r is neither "pattern" nor a { missing } object, and no lifted entry type has a missing field.
			out.push(r as Item<F>);
		}
		return out;
	};
	const record = each("record", (e) =>
		!str(e.file) ? { missing: "file" } : !strs(e.run) ? { missing: "run" } : { file: e.file, run: e.run },
	);
	const config = each("config", (e) => {
		if (!str(e.file)) return { missing: "file" };
		const value = e.value;
		if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
			return { missing: "value" };
		if (!str(e.key) && !(str(e.array) && str(e.flag))) return { missing: "key or array and flag" };
		const c: Item<"config"> = { file: e.file, value };
		if (str(e.key)) c.key = e.key;
		if (str(e.array)) c.array = e.array;
		if (str(e.flag)) c.flag = e.flag;
		return c;
	});
	const place = each("place", (e) =>
		!str(e.from) ? { missing: "from" } : !str(e.to) ? { missing: "to" } : { from: e.from, to: e.to },
	);
	const busy = each("busy", (e) => {
		if (!str(e.say)) return { missing: "say" };
		if (!str(e.process) && !strs(e.run)) return { missing: "process or run" };
		const b: Item<"busy"> = { say: e.say };
		if (str(e.process)) b.process = e.process;
		if (strs(e.run)) b.run = e.run;
		if (e.when === "stopped") b.when = "stopped";
		return b;
	});
	if (Array.isArray(table.busy)) {
		const i = table.busy.findIndex((e) => isRecord(e) && e.when !== undefined && e.when !== "stopped");
		if (i >= 0 && typeof busy !== "string") return MESSAGES.liftBusyWhen(key, i + 1);
	}
	const pause = each("pause", (e) => liftService(e, false));
	const test = each("test", liftTest);
	const serve = each("serve", (e): Lifted<Serve> => {
		const svc = liftService(e, true);
		if (typeof svc === "string" || "missing" in svc) return svc;
		if (!validPattern(e.expect)) return "pattern";
		// SAFETY: liftService with needStart returned missing unless start is a non-empty list of strings.
		const sv: Serve = { ...svc, start: svc.start as string[] };
		if (str(e.health)) sv.health = e.health;
		if (typeof e.status === "number") sv.status = e.status;
		if (typeof e.expect === "string") sv.expect = e.expect;
		if (typeof e.wait_s === "number") sv.wait_s = e.wait_s;
		if (e.test !== undefined) {
			if (!Array.isArray(e.test)) return { missing: "test as a list of tables" };
			const tests: Test[] = [];
			for (const t of e.test) {
				const r = isRecord(t) ? liftTest(t) : { missing: "test as a list of tables" };
				if (r === "pattern" || "missing" in r) return r;
				tests.push(r);
			}
			sv.test = tests;
		}
		return sv;
	});
	for (const r of [record, config, place, busy, pause, test, serve]) if (typeof r === "string") return r;
	const typo = unknownPlaceholder(table);
	if (typo) return MESSAGES.liftUnknownPlaceholder(key, typo.name, typo.field);
	// The loop above returned every string, so each list is an array or absent.
	if (Array.isArray(record)) spec.record = record;
	if (Array.isArray(config)) spec.config = config;
	// Like dest and folder: a .. part would let a config write land outside the paths the table names.
	if (spec.config?.some((c) => c.file.split("/").includes(".."))) return MESSAGES.liftConfigDotDot(key);
	if (Array.isArray(place)) spec.place = place;
	if (Array.isArray(busy)) spec.busy = busy;
	if (Array.isArray(pause)) spec.pause = pause;
	if (Array.isArray(test)) spec.test = test;
	if (Array.isArray(serve)) spec.serve = serve;
	return unsafeSourcePath(key, spec);
}

/** A spec put back through lift, or the reason lift refuses it. */
export type Relifted = { spec: AppSpec } | { problem: string };

/** A spec built in code checked by the same rules as a table read from apps.toml, so what is written reads back. */
export function relift(s: AppSpec): Relifted {
	const { key, ...fields } = s;
	const lifted = lift(key, fields);
	return typeof lifted === "string" ? { problem: lifted } : { spec: lifted };
}

/** Reads apps.toml. A bad table is left out and named in errors; the rest still load. */
export function loadManifest(file: string): { apps: AppSpec[]; errors: string[] } {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (err) {
		return { apps: [], errors: [`${file}: ${err instanceof Error ? err.message : String(err)}`] };
	}
	return parseManifest(text, file);
}

/** An apps.toml's text read as apps; `label` names it in errors. The same rules as loadManifest, which reads with it. */
export function parseManifest(text: string, label: string): { apps: AppSpec[]; errors: string[] } {
	const file = label;
	let doc: unknown;
	try {
		doc = Bun.TOML.parse(text);
	} catch (err) {
		return { apps: [], errors: [`${file}: ${err instanceof Error ? err.message : String(err)}`] };
	}
	const tables = isRecord(doc) ? doc.apps : undefined;
	// A file with nothing in it but comments is a list with no apps yet, as a new person starts with. A file with
	// other tables and no [apps] is a typo such as [app.fd], and must not read as a wiped list.
	if (tables === undefined)
		return isRecord(doc) && Object.keys(doc).length === 0
			? { apps: [], errors: [] }
			: { apps: [], errors: [MESSAGES.manifestNoAppsTables(file)] };
	if (!isRecord(tables)) return { apps: [], errors: [MESSAGES.manifestAppsNotTable(file)] };
	const apps: AppSpec[] = [];
	const errors: string[] = [];
	for (const [key, table] of Object.entries(tables)) {
		const result = isRecord(table) ? lift(key, table) : MESSAGES.manifestEntryNotTable(key);
		if (typeof result === "string") errors.push(result);
		else apps.push(result);
	}
	return { apps, errors };
}

/**
 * The catalogue: one file per app, each holding the single [apps.<key>] table named like the file. A file that
 * breaks that rule is reported and left out; a missing folder is an empty catalogue.
 */
export function loadCatalogue(dir: string): { apps: AppSpec[]; errors: string[] } {
	let names: string[];
	try {
		names = readdirSync(dir)
			.filter((n) => n.endsWith(".toml"))
			.toSorted();
	} catch {
		return { apps: [], errors: [] };
	}
	const apps: AppSpec[] = [];
	const errors: string[] = [];
	for (const name of names) {
		const key = basename(name, ".toml");
		const r = loadManifest(join(dir, name));
		errors.push(...r.errors.map((e) => `catalogue/${name}: ${e}`));
		if (r.apps.length !== 1 || r.apps[0]?.key !== key)
			errors.push(`catalogue/${name}: must hold exactly one table, [apps.${key}]`);
		else apps.push(r.apps[0]);
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
	"repo",
	"forge",
	...STRING_FIELDS.filter((f) => f !== "name" && f !== "repo"),
	...LIST_FIELDS,
	...BOOL_FIELDS,
];

/** A TOML basic string: backslash, quote and newline escaped. Other control characters pass through unescaped. */
const basic = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;

/** An [apps.<key>] table holding only the fields the spec has. An asset pattern is a literal string when it can be. */
export function tomlTable(spec: AppSpec): string {
	const lines = [`[apps.${spec.key}]`];
	for (const f of ORDER) {
		const v = spec[f];
		if (v === undefined) continue;
		let text: string;
		if (typeof v === "boolean") text = String(v);
		else if (Array.isArray(v)) {
			// SAFETY: ORDER holds only string, list-of-string and boolean fields, so an array here is a list of strings.
			text = `[${(v as string[]).map(basic).join(", ")}]`;
		} else if ((f === "asset" || f === "asset_aarch64") && !v.includes("'") && !v.includes("\n")) text = `'${v}'`;
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
	// The app's own [[apps.<key>.serve]] and other sub-tables go with it; the next app's table ends the cut.
	const own = (l: string) => l.startsWith(`[apps.${key}.`) || l.startsWith(`[[apps.${key}.`);
	while (end < lines.length && (!(lines[end] ?? "").startsWith("[") || own(lines[end] ?? ""))) end++;
	if (end < lines.length) while (end - 1 > start && (lines[end - 1] ?? "").startsWith("#")) end--;
	const before = lines.slice(0, start);
	const after = lines.slice(end);
	// Cutting the last table leaves the file ending in exactly one newline.
	if (after.every((l) => l === "")) return `${before.join("\n").replace(/\n+$/, "")}\n`;
	return [...before, ...after].join("\n");
}
