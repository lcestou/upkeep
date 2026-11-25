import type { AppState, AppStatus } from "../../shared/types";

export type GlyphName = "dot" | "wait" | "bud" | "drop" | "leaf" | "hand" | "pause" | "bang" | "cross";

/** The care band's token and glyph for each status (plan F4b). */
export const CARE = {
	checking: { band: "var(--line)", glyph: "dot" },
	ready: { band: "var(--sun)", glyph: "bud" },
	queued: { band: "var(--sun)", glyph: "wait" },
	working: { band: "var(--water)", glyph: "drop" },
	done: { band: "var(--leaf)", glyph: "leaf" },
	fresh: { band: "var(--leaf)", glyph: "leaf" },
	manual: { band: "var(--bloom)", glyph: "hand" },
	held: { band: "var(--frost)", glyph: "pause" },
	problem: { band: "var(--rust)", glyph: "bang" },
	failed: { band: "var(--fail)", glyph: "cross" },
	rolled_back: { band: "var(--fail)", glyph: "cross" },
	stopped: { band: "var(--frost)", glyph: "pause" },
} satisfies Record<AppStatus, { band: string; glyph: GlyphName }>;

/** The glyph's colour. Checking draws its dot in --dot because the --line band is too faint for a glyph. */
export function glyphColor(status: AppStatus): string {
	return status === "checking" ? "var(--dot)" : CARE[status].band;
}

/** A pending row carries the full apparatus; a fresh one is a quiet line. */
export function isQuiet(app: Pick<AppState, "status">): boolean {
	return app.status === "fresh" || app.status === "checking";
}

/** True when the title is crossed out: a failure, or a hold the person set by skipping a version. A plain hold is not struck. */
export function isStruck(app: Pick<AppState, "status" | "skipped">): boolean {
	return (
		app.status === "failed" || app.status === "rolled_back" || (app.status === "held" && app.skipped !== undefined)
	);
}

/** The app's progress through its own stages, 0 to 1, weighting each stage by its measured share. */
export function progressOf(app: AppState): number {
	if (app.status === "done") return 1;
	if (app.status !== "working") return 0;
	let sum = 0;
	for (const { id, weight } of app.stages) {
		if (id === app.stage) return (sum + (weight * (app.stagePct ?? 50)) / 100) / 100;
		sum += weight;
	}
	return sum / 100;
}

/** The version of the newest restore point, or null when there is none to go back to. */
export function restoreText(app: AppState): string | null {
	return app.restorePoints[0]?.version ?? null;
}
