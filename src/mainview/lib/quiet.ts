import type { AppState } from "../../shared/types";

/** Two minutes: tar, git, a plugin update or a health poll print nothing for shorter than this as a matter of course. */
export const QUIET_MS = 120_000;

/**
 * The quiet line's numbers for a working row: whole minutes since it last wrote a log line or moved its download, and
 * whole minutes left before its step's own limit ends it (null when the step has none). Null while the row is not
 * working or has spoken within QUIET_MS: silence alone is never called stuck, so the line only states the two facts.
 */
export function quietOf(
	app: Pick<AppState, "status" | "activeAt" | "step">,
	lastLine: string | undefined,
	now: number,
): { m: number; n: number | null } | null {
	if (app.status !== "working") return null;
	const last = Math.max(Date.parse(app.activeAt ?? "") || 0, Date.parse(lastLine ?? "") || 0);
	if (last === 0 || now - last < QUIET_MS) return null;
	const step = app.step;
	const n =
		step && step.limitMs !== null ? Math.max(0, Math.ceil((Date.parse(step.at) + step.limitMs - now) / 60_000)) : null;
	return { m: Math.floor((now - last) / 60_000), n };
}
