import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MESSAGES } from "../shared/messages";
import type {
	AppSpec,
	ExtrasSettings,
	ImportAsk,
	ImportProtection,
	ImportSwitch,
	Service,
	Settings,
	Test,
} from "../shared/types";
import { clampExtras, loadExtras, updateExtras } from "./extras/state";
import { packageInstall } from "./kinds/package";
import { ensureManifest, isRecord, loadManifest, parseManifest } from "./manifest";
import { removeMenuFiles } from "./menu";
import type { Paths } from "./paths";
import { clampSettings, loadState, updateState, withStateLock, writeAtomic } from "./store";

/**
 * Everything a person set up, in one file to carry to another machine or hand to an agent: the app list as written
 * (apps.toml, comments included), the settings, the skips, holds and automatic installs, and the extras' switches.
 * `upkeep` is the format's version; a reader refuses one it does not know. Run state (the notified set, restarts
 * pending, history, restore points) stays behind: it belongs to the machine.
 */
export type Transfer = {
	upkeep: 1;
	exportedAt: string;
	apps: string;
	settings: Settings;
	skip: Record<string, string>;
	hold: Record<string, true>;
	auto: Record<string, boolean>;
	extras: ExtrasSettings;
};

/** The current setup as a Transfer. A missing apps.toml is first seeded, as a check would. */
export function exportSetup(paths: Paths, seedFile: string, now: Date): Transfer {
	const state = loadState(paths);
	return {
		upkeep: 1,
		exportedAt: now.toISOString(),
		apps: readFileSync(ensureManifest(paths, seedFile), "utf8"),
		settings: state.settings,
		skip: state.skip,
		hold: state.hold,
		auto: state.auto,
		extras: loadExtras(paths),
	};
}

/** Only the entries of a table whose value passes `keep`; anything else, such as a hand-edited file, reads as empty. */
function only<T>(v: unknown, keep: (x: unknown) => x is T): Record<string, T> {
	if (!isRecord(v)) return {};
	const out: Record<string, T> = {};
	for (const [k, x] of Object.entries(v)) if (keep(x)) out[k] = x;
	return out;
}

/**
 * One argument as a shell would need it typed so the line shown is the argv that runs: plain words bare, anything
 * else in single quotes. Upkeep runs argv with no shell, so a { } placeholder or a ~ inside a word is passed as
 * written and is quoted here. A leading ~ or ~/ is left bare: the runner expands exactly that (expandHome), as a
 * shell would.
 */
function shellWord(a: string): string {
	const plain = /^[\w@%+=:,./-]+$/;
	if (plain.test(a) || a === "~" || (a.startsWith("~/") && plain.test(a.slice(2)))) return a;
	return `'${a.replaceAll("'", "'\\''")}'`;
}

/**
 * Every command an app's table makes Upkeep run or act on, one line each, led by the field it comes from: argv
 * fields quoted as a shell would need them, shell steps (build, undo, check_built) as written. Also listed: an
 * install that runs as root (every deb and rpm, whose package scripts dpkg or rpm run as root, and any table with
 * sudo), relaunch (it ends the processes named by process and starts dest), an HTTP test or health check, a git
 * move of an existing checkout in dir, a source build's writes outside its checkout (place, config), and the settings
 * paths a restore puts back (keep_with_restore). A release
 * kind's version_args run dest, so they show as dest plus its arguments, except one plain token such as ["version"]
 * or ["-V"] on a dest under home: that asks the app's own release file its version, the same trust as the default
 * --version probe, which is not listed either. The dest is judged with its .. parts (refused at load anyway), so
 * ~/../../usr/bin/x reads as outside home. A manual app's run is only shown to the person, never run, and
 * claude-plugins runs Claude Code's own CLI, so neither is listed. When anything is listed, the first line names
 * where the code comes from (repo, or latest for a command app). Empty means the table only installs its release
 * files, without root.
 */
export function commandsOf(spec: AppSpec): string[] {
	const out: string[] = [];
	const argv = (field: string, v: string[] | undefined) => {
		if (v && v.length > 0) out.push(`${field}: ${v.map(shellWord).join(" ")}`);
	};
	const steps = (field: string, v: string[] | undefined) => {
		for (const step of v ?? []) out.push(`${field}: ${step}`);
	};
	const tests = (field: string, v: Test[] | undefined) => {
		for (const t of v ?? []) {
			argv(field, t.run);
			if (t.url) {
				const body =
					t.body === undefined ? "" : ` ${shellWord(t.body.length > 200 ? `${t.body.slice(0, 200)}…` : t.body)}`;
				out.push(`${field}: POST ${t.url}${body}`);
			}
		}
	};
	const services = (field: string, v: Service[] | undefined) => {
		for (const s of v ?? []) {
			argv(`${field} ${s.name} active`, s.active);
			argv(`${field} ${s.name} stop`, s.stop);
			argv(`${field} ${s.name} start`, s.start);
			argv(`${field} ${s.name} since`, s.since);
		}
	};
	if (spec.kind === "deb" || spec.kind === "rpm")
		out.push(`root: sudo -n ${packageInstall(spec.kind, "<release file>").join(" ")}`);
	else if (spec.sudo) out.push(`root: sudo -n writes ${spec.dest ?? "dest"}`);
	argv("check", spec.check);
	argv("update", spec.update);
	argv("restore", spec.restore);
	const args = spec.version_args;
	const home = spec.dest?.startsWith("~/") && !spec.dest.split("/").includes("..");
	const probe = args?.length === 1 && /^-{0,2}[A-Za-z][\w-]*$/.test(args[0] ?? "") && home;
	if (args && spec.dest && !probe) argv("version_args", [spec.dest, ...args]);
	argv("restart", spec.restart);
	if (spec.relaunch) out.push(`relaunch: ends ${spec.process ?? "?"} and starts ${spec.dest ?? "?"}`);
	argv("commit", spec.commit);
	argv("needs", spec.needs);
	if (spec.dir) out.push(`move: ${spec.move ?? "ff"} ${spec.dir}`);
	steps("build", spec.build);
	steps("check_built", spec.check_built);
	steps("undo", spec.undo);
	for (const r of spec.record ?? []) argv("record", r.run);
	for (const b of spec.busy ?? []) argv("busy", b.run);
	services("pause", spec.pause);
	services("serve", spec.serve);
	for (const s of spec.serve ?? []) {
		if (s.health) out.push(`serve ${s.name} health: GET ${s.health}`);
		tests("serve test", s.test);
	}
	tests("test", spec.test);
	for (const p of spec.place ?? []) out.push(`place: ${p.from} -> ${p.to}`);
	for (const c of spec.config ?? []) out.push(`config: ${c.file} ${c.key ?? `${c.array} ${c.flag}`}`);
	// A restore swaps these folders for the point's copies, so a file naming them chooses what a restore overwrites.
	for (const k of spec.keep_with_restore ?? []) out.push(`keep_with_restore: ${k}`);
	const from = spec.repo ?? spec.latest;
	if (out.length > 0 && from) out.unshift(`source: ${from}`);
	return out;
}

/**
 * What decides whether an imported table is the app this machine already has: every field but the ones that only
 * label it (name, note) or are themselves the choice being judged (auto), with keys sorted so the order a file
 * wrote them in does not count. Nested tables keep their order, so a reordered serve list reads as different, which
 * only costs an auto pick.
 */
function sameness(spec: AppSpec): string {
	const { name: _name, note: _note, auto: _auto, ...rest } = spec;
	return JSON.stringify(Object.entries(rest).toSorted(([a], [b]) => a.localeCompare(b)));
}

const SETTING_SWITCHES = ["notify", "checkAtLogin", "selfAuto", "upkeepCommand"] as const;
const PROTECTIONS = ["waitUnmetered"] as const satisfies readonly ImportProtection[];

/** Each protection the import would turn off that is on here, judged on the values as they would land. */
function protectionsOff(paths: Paths, settings: Record<string, unknown>): ImportProtection[] {
	const now = loadState(paths).settings;
	// SAFETY: clampSettings reads every field by its own checks; a wrong value takes its default.
	const next = clampSettings({ ...now, ...(settings as Partial<Settings>) });
	return PROTECTIONS.filter((k) => now[k] && !next[k]);
}
const EXTRA_SWITCHES = ["system", "systemInstall", "cleanup", "devCaches"] as const;

/**
 * Each setting and extra the import would turn on that is off on this machine, judged on the values as they would
 * land (through the same clamps), so a value the clamp throws away never counts. Turning something off, or changing
 * a neutral choice (language, frame, check interval, restore points to keep), is not listed: it starts nothing.
 */
function switchesOn(
	paths: Paths,
	settings: Record<string, unknown>,
	extras: Record<string, unknown> | null,
): ImportSwitch[] {
	const now = loadState(paths).settings;
	// SAFETY: clampSettings reads every field by its own checks; a wrong value takes its default.
	const next = clampSettings({ ...now, ...(settings as Partial<Settings>) });
	const on: ImportSwitch[] = SETTING_SWITCHES.filter((k) => next[k] && !now[k]);
	if (extras === null) return on;
	const was = loadExtras(paths);
	const will = clampExtras({ ...was, ...extras });
	const flag = (x: ExtrasSettings, k: (typeof EXTRA_SWITCHES)[number]) =>
		k === "system" ? x.system === "show" : x[k] === true;
	return [...on, ...EXTRA_SWITCHES.filter((k) => flag(will, k) && !flag(was, k))];
}

/**
 * Replaces the setup with the one in an exported file's text, or changes nothing and names every problem. The file
 * is read whole before anything is written: it must be this format's version, and its app list must load with no
 * error, so a broken file never replaces a working list. A list with any app whose table runs commands (commandsOf)
 * is not written until the caller passes sure, after showing the person the ask; a file from someone else could
 * otherwise run anything at the next check. A setting or extra the file turns on that is off here (switchesOn) asks
 * the same way, so a file cannot quietly turn on Upkeep's own automatic update, the upkeep command, a login entry or
 * an extra. Automatic installs come in off, whatever the file says, for every app
 * that is not on this machine's list with the same table (sameness), release kinds too: a release table's repo is
 * the file writer's choice, and with auto and install_if_missing it would install unseen. An app that matches the
 * local one keeps this machine's pick, never the file's, so no import can turn an automatic install on: importing
 * the same shared file twice leaves its apps off, and re-importing one's own list here changes nothing. autoOff
 * names the new or changed apps the file wanted on, which came in off. apps.toml, state.json and extras.json are each
 * kept beside themselves as <file>.pre-import-<time> first, and a write that fails midway puts them back and removes
 * any the import created. Skips and holds are kept only for apps the new list has. The file never carries a menu
 * entry: an app it drops or changes has its entry switched off and its files deleted, so no entry points at a dest
 * the new table no longer names;
 * settings and extras go through the same checks as the files they land in, so an out-of-range value reads as its
 * default.
 */
export function importSetup(
	paths: Paths,
	seedFile: string,
	text: string,
	now: Date,
	sure = false,
):
	| { ok: true; apps: number; kept: string[]; autoOff: string[] }
	| { ok: false; problems: string[] }
	| { ok: false; ask: ImportAsk } {
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch (err) {
		return { ok: false, problems: [MESSAGES.importNotJson(err instanceof Error ? err.message : String(err))] };
	}
	if (!isRecord(doc)) return { ok: false, problems: [MESSAGES.importNotObject()] };
	if (doc.upkeep !== 1) return { ok: false, problems: [MESSAGES.importWrongVersion()] };
	if (typeof doc.apps !== "string") return { ok: false, problems: [MESSAGES.importNoApps()] };
	const list = parseManifest(doc.apps, "apps");
	if (list.errors.length > 0) return { ok: false, problems: list.errors };
	const keys = new Set(list.apps.map((a) => a.key));
	const mine = <T>(table: Record<string, T>) => Object.fromEntries(Object.entries(table).filter(([k]) => keys.has(k)));
	const running = list.apps.flatMap((a) => {
		const commands = commandsOf(a);
		return commands.length > 0 ? [{ key: a.key, name: a.name, commands }] : [];
	});
	const settings = isRecord(doc.settings) ? doc.settings : {};
	const turnsOn = switchesOn(paths, settings, isRecord(doc.extras) ? doc.extras : null);
	const turnsOff = protectionsOff(paths, settings);
	if ((running.length > 0 || turnsOn.length > 0 || turnsOff.length > 0) && !sure)
		return { ok: false, ask: { apps: running, plain: list.apps.length - running.length, turnsOn, turnsOff } };

	const here = join(paths.config, "apps.toml");
	const local = new Map((existsSync(here) ? loadManifest(here).apps : []).map((a) => [a.key, a] as const));
	const ours = loadState(paths).auto;
	// This machine's effective pick (its state over its table's auto = true) for a table that matches; off otherwise.
	const picks: Record<string, boolean> = {};
	const changed = new Set<string>();
	for (const a of list.apps) {
		const was = local.get(a.key);
		if (was !== undefined && sameness(was) === sameness(a)) picks[a.key] = ours[a.key] ?? was.auto ?? false;
		else {
			picks[a.key] = false;
			changed.add(a.key);
		}
	}
	const stays = (key: string) => keys.has(key) && !changed.has(key);
	const wanted = only(doc.auto, (x): x is boolean => typeof x === "boolean");
	// Only new or changed apps "came in off"; a matching app whose pick here is off simply kept it.
	const autoOff = list.apps.filter((a) => changed.has(a.key) && (wanted[a.key] ?? a.auto ?? false)).map((a) => a.key);

	const stamp = now.toISOString().replace(/[:.]/g, "-");
	const files = [ensureManifest(paths, seedFile), join(paths.state, "state.json"), join(paths.state, "extras.json")];
	// Each file that exists is kept as <file>.pre-import-<time>, so every import's starting point survives; one that
	// does not exist yet is noted, so a rollback removes what the import created.
	const kept: [string, string][] = [];
	const absent: string[] = [];
	// The menu entries of apps the import drops or changes: their switch goes off, and their files go once it is in.
	let staleMenu: string[] = [];
	try {
		mkdirSync(paths.state, { recursive: true });
		for (const f of files) {
			if (!existsSync(f)) {
				absent.push(f);
				continue;
			}
			let copy = `${f}.pre-import-${stamp}`;
			for (let n = 2; existsSync(copy); n++) copy = `${f}.pre-import-${stamp}-${n}`;
			copyFileSync(f, copy);
			kept.push([f, copy]);
		}
		writeAtomic(files[0] ?? "", doc.apps);
		updateState(paths, (s) => {
			// SAFETY: the next loadState clamps every field of settings, so a wrong value reads as its default, never as this.
			s.settings = { ...s.settings, ...(settings as Partial<Settings>) };
			s.skip = mine(only(doc.skip, (x): x is string => typeof x === "string"));
			s.hold = mine(only(doc.hold, (x): x is true => x === true));
			// Every app gets an entry, so an auto = true written in an imported table never decides.
			s.auto = picks;
			staleMenu = Object.entries(s.menu).flatMap(([k, f]) => (stays(k) ? [] : f));
			s.menu = Object.fromEntries(Object.entries(s.menu).filter(([k]) => stays(k)));
			// What a check remembered of a release goes with an app the import drops or changes, so a changed-release hold
			// never outlives the table it was about.
			s.seen = Object.fromEntries(Object.entries(s.seen).filter(([k]) => stays(k)));
			s.changed = Object.fromEntries(Object.entries(s.changed).filter(([k]) => stays(k)));
		});
		if (isRecord(doc.extras)) {
			// SAFETY: updateExtras clamps every field, so a wrong value reads as its default.
			updateExtras(paths, doc.extras as Partial<ExtrasSettings>);
		}
	} catch (err) {
		const why = MESSAGES.importCouldNotWrite(err instanceof Error ? err.message : String(err));
		const stuck = rollBack(paths, kept, absent);
		return {
			ok: false,
			problems:
				stuck.length === 0 ? [MESSAGES.busySayNothingChanged(why)] : [MESSAGES.importSomeNotPutBack(why), ...stuck],
		};
	}
	removeMenuFiles(staleMenu, paths);
	return { ok: true, apps: list.apps.length, kept: kept.map(([, copy]) => copy), autoOff };
}

/**
 * Half an import is worse than none: writes each kept copy back over its file (atomically, state.json under the
 * state lock so the window's own writes wait) and removes each file the import created. Returns a line for every
 * file it could not put back, naming where its copy is.
 */
function rollBack(paths: Paths, kept: [string, string][], absent: string[]): string[] {
	const stuck: string[] = [];
	const state = join(paths.state, "state.json");
	for (const [f, copy] of kept) {
		try {
			const put = () => writeAtomic(f, readFileSync(copy, "utf8"));
			if (f === state) withStateLock(paths, put);
			else put();
		} catch {
			stuck.push(MESSAGES.importCopyFromBefore(f, copy));
		}
	}
	for (const f of absent) {
		try {
			rmSync(f, { force: true });
		} catch {
			stuck.push(MESSAGES.importCreatedNotRemoved(f));
		}
	}
	return stuck;
}
