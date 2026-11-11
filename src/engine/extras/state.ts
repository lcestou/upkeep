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

const file = (paths: Paths) => join(paths.state, "extras.json");

/** Any value other than "show" is off, so a file from a later version with more modes reads as off, never as on. */
function clamp(raw: unknown): ExtrasSettings {
	const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	return { system: r.system === "show" ? "show" : DEFAULT_EXTRAS.system };
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
