import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtrasSettings } from "../../shared/types";
import type { Paths } from "../paths";
import { writeAtomic } from "../store";

/**
 * Kept apart from state.json so Settings and its tests stay as they are. Resetting state.json leaves these as
 * they were; deleting extras.json turns every extra off.
 */
export const DEFAULT_EXTRAS: ExtrasSettings = { system: "off" };

/** extras.json, in the state directory beside state.json but never inside it. */
const file = (paths: Paths) => join(paths.state, "extras.json");

/**
 * Any value other than "show" is off, so a file from a later version with more modes reads as off, never as on.
 * Installing is on only for exactly true and only while the list is shown: turning the list off turns it off too, so
 * turning the list on again never brings installing back unseen. Cleanup is on only for exactly true, and developer
 * caches only while Cleanup is on, for the same reason. A key that is off is absent, never false.
 */
function clamp(raw: unknown): ExtrasSettings {
	// SAFETY: raw is a non-null object, so any key reads as a value or undefined; every key read is compared, not trusted.
	const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const out: ExtrasSettings = r.system === "show" ? { system: "show" } : { system: DEFAULT_EXTRAS.system };
	if (out.system === "show" && r.systemInstall === true) out.systemInstall = true;
	if (r.cleanup === true) {
		out.cleanup = true;
		if (r.devCaches === true) out.devCaches = true;
	}
	return out;
}

/** An absent or unreadable file is the defaults. */
export function loadExtras(paths: Paths): ExtrasSettings {
	try {
		return clamp(JSON.parse(readFileSync(file(paths), "utf8")));
	} catch {
		return { ...DEFAULT_EXTRAS };
	}
}

/** Merges patch into what is on disk, clamps it and writes it by rename. Returns what was written. */
export function updateExtras(paths: Paths, patch: Partial<ExtrasSettings>): ExtrasSettings {
	const next = clamp({ ...loadExtras(paths), ...patch });
	mkdirSync(paths.state, { recursive: true });
	writeAtomic(file(paths), JSON.stringify(next, null, "\t"));
	return next;
}
