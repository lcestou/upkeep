import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MESSAGES } from "../shared/messages";
import type { AppSpec, ExtrasSettings, ImportAsk, Service, Settings, Test } from "../shared/types";
import { loadExtras, updateExtras } from "./extras/state";
import { ensureManifest, isRecord, loadManifest, parseManifest } from "./manifest";
import type { Paths } from "./paths";
import { loadState, updateState, withStateLock, writeAtomic } from "./store";

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

/** One argument as a shell would need it typed: plain words bare, anything else in single quotes. */
function shellWord(a: string): string {
	return /^[\w@%+=:,./~{}-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`;
}

/**
 * Every command an app's table makes Upkeep run, one line each, led by the field it comes from: argv fields quoted
 * as a shell would need them, shell steps (build, undo, check_built) as written. A source build's writes outside its
 * checkout (place, config) and a hard reset of an existing checkout are listed too, since they matter as much as the
 * steps. A release kind's version_args run dest, so they show as dest plus its arguments, except one plain token such
 * as ["version"] or ["-V"] on a dest under home: that asks the app's own release file its version, the same trust as
 * the default --version probe, which is not listed either. A lone token on a dest outside home is listed, since
 * ["--force"] on /usr/bin/reboot is not a version probe. A manual app's run is only shown to the person, never run,
 * and claude-plugins runs Claude Code's own CLI, so neither is listed. When anything is listed, the first line names
 * where the code comes from (repo, or latest for a command app), since that is the payload the steps run. Empty
 * means the table runs nothing but what its releases ship.
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
		for (const t of v ?? []) argv(field, t.run);
	};
	const services = (field: string, v: Service[] | undefined) => {
		for (const s of v ?? []) {
			argv(`${field} ${s.name} active`, s.active);
			argv(`${field} ${s.name} stop`, s.stop);
			argv(`${field} ${s.name} start`, s.start);
			argv(`${field} ${s.name} since`, s.since);
		}
	};
	argv("check", spec.check);
	argv("update", spec.update);
	argv("restore", spec.restore);
	const args = spec.version_args;
	const probe = args?.length === 1 && /^-{0,2}[A-Za-z][\w-]*$/.test(args[0] ?? "") && spec.dest?.startsWith("~/");
	if (args && spec.dest && !probe) argv("version_args", [spec.dest, ...args]);
	argv("restart", spec.restart);
	argv("commit", spec.commit);
	argv("needs", spec.needs);
	if (spec.dir && spec.move === "reset") out.push(`move: reset ${spec.dir}`);
	steps("build", spec.build);
	steps("check_built", spec.check_built);
	steps("undo", spec.undo);
	for (const r of spec.record ?? []) argv("record", r.run);
	for (const b of spec.busy ?? []) argv("busy", b.run);
	services("pause", spec.pause);
	services("serve", spec.serve);
	for (const s of spec.serve ?? []) tests("serve test", s.test);
	tests("test", spec.test);
	for (const p of spec.place ?? []) out.push(`place: ${p.from} -> ${p.to}`);
	for (const c of spec.config ?? []) out.push(`config: ${c.file} ${c.key ?? `${c.array} ${c.flag}`}`);
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

/**
 * Replaces the setup with the one in an exported file's text, or changes nothing and names every problem. The file
 * is read whole before anything is written: it must be this format's version, and its app list must load with no
 * error, so a broken file never replaces a working list. A list with any app whose table runs commands (commandsOf)
 * is not written until the caller passes sure, after showing the person the ask; a file from someone else could
 * otherwise run anything at the next check. Automatic installs come in off, whatever the file says, for every app
 * that is not on this machine's list with the same table (sameness), release kinds too: a release table's repo is
 * the file writer's choice, and with auto and install_if_missing it would install unseen. An app that matches the
 * local one keeps the file's pick, so moving one's own list back and forth loses nothing. autoOff names the apps
 * the file wanted on that came in off. apps.toml, state.json and extras.json are each
 * kept beside themselves as <file>.pre-import-<time> first, and a write that fails midway puts them back and removes
 * any the import created. Skips, holds and the other automatic installs are kept only for apps the new list has;
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
	if (running.length > 0 && !sure)
		return { ok: false, ask: { apps: running, plain: list.apps.length - running.length } };

	const here = join(paths.config, "apps.toml");
	const local = new Map((existsSync(here) ? loadManifest(here).apps : []).map((a) => [a.key, sameness(a)] as const));
	const changed = list.apps.filter((a) => local.get(a.key) !== sameness(a));
	const wanted = only(doc.auto, (x): x is boolean => typeof x === "boolean");
	const autoOff = changed.filter((a) => wanted[a.key] ?? a.auto ?? false).map((a) => a.key);

	const stamp = now.toISOString().replace(/[:.]/g, "-");
	const files = [ensureManifest(paths, seedFile), join(paths.state, "state.json"), join(paths.state, "extras.json")];
	// Each file that exists is kept as <file>.pre-import-<time>, so every import's starting point survives; one that
	// does not exist yet is noted, so a rollback removes what the import created.
	const kept: [string, string][] = [];
	const absent: string[] = [];
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
		const settings = isRecord(doc.settings) ? doc.settings : {};
		updateState(paths, (s) => {
			// SAFETY: the next loadState clamps every field of settings, so a wrong value reads as its default, never as this.
			s.settings = { ...s.settings, ...(settings as Partial<Settings>) };
			s.skip = mine(only(doc.skip, (x): x is string => typeof x === "string"));
			s.hold = mine(only(doc.hold, (x): x is true => x === true));
			s.auto = mine(wanted);
			// false, not a missing entry: it also outweighs an auto = true written in the app's own table.
			for (const a of changed) s.auto[a.key] = false;
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
