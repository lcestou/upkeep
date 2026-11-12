import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtrasSettings, Settings } from "../shared/types";
import { loadExtras, updateExtras } from "./extras/state";
import { ensureManifest, isRecord, parseManifest, replaceManifest } from "./manifest";
import type { Paths } from "./paths";
import { loadState, updateState } from "./store";

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
 * Replaces the setup with the one in an exported file's text, or changes nothing and names every problem. The file
 * is read whole before anything is written: it must be this format's version, and its app list must load with no
 * error, so a broken file never replaces a working list. apps.toml is kept as apps.toml.bak and state.json as
 * state.json.bak. Skips, holds and automatic installs are kept only for apps the new list has; settings and extras
 * go through the same checks as the files they land in, so an out-of-range value reads as its default.
 */
export function importSetup(
	paths: Paths,
	seedFile: string,
	text: string,
): { ok: true; apps: number } | { ok: false; problems: string[] } {
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch (err) {
		return { ok: false, problems: [`not JSON: ${err instanceof Error ? err.message : String(err)}`] };
	}
	if (!isRecord(doc)) return { ok: false, problems: ["not an Upkeep export: the file is not an object"] };
	if (doc.upkeep !== 1) return { ok: false, problems: ['not an Upkeep export this version reads: no "upkeep": 1'] };
	if (typeof doc.apps !== "string") return { ok: false, problems: ['the export has no "apps" text'] };
	const list = parseManifest(doc.apps, "apps");
	if (list.errors.length > 0) return { ok: false, problems: list.errors };
	const keys = new Set(list.apps.map((a) => a.key));
	const mine = <T>(table: Record<string, T>) => Object.fromEntries(Object.entries(table).filter(([k]) => keys.has(k)));

	const manifest = ensureManifest(paths, seedFile);
	replaceManifest(manifest, doc.apps);
	const state = join(paths.state, "state.json");
	if (existsSync(state)) copyFileSync(state, `${state}.bak`);
	mkdirSync(paths.state, { recursive: true });
	const settings = isRecord(doc.settings) ? doc.settings : {};
	updateState(paths, (s) => {
		// SAFETY: the next loadState clamps every field of settings, so a wrong value reads as its default, never as this.
		s.settings = { ...s.settings, ...(settings as Partial<Settings>) };
		s.skip = mine(only(doc.skip, (x): x is string => typeof x === "string"));
		s.hold = mine(only(doc.hold, (x): x is true => x === true));
		s.auto = mine(only(doc.auto, (x): x is boolean => typeof x === "boolean"));
	});
	if (isRecord(doc.extras)) {
		// SAFETY: updateExtras clamps every field, so a wrong value reads as its default.
		updateExtras(paths, doc.extras as Partial<ExtrasSettings>);
	}
	return { ok: true, apps: list.apps.length };
}
