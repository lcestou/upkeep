import type { AppState, Snapshot } from "../shared/types";

/** How many apps rest in each state, as `upkeep status`, its metrics and a sent notice count them. */
export type Counts = { apps: number; upToDate: number; ready: number; held: number; failing: number };

/** One app in a status list: its versions, and for a failing app the sentence that says why. */
export type StatusApp = { key: string; name: string; installed: string | null; latest: string | null; detail?: string };

/** What `upkeep status` reports: the last check's rows as the engine keeps them, without a check of its own. */
export type Status = {
	version: string;
	/** When the last check that got through ended; null before the first one. */
	checkedAt: string | null;
	/** A live process holds the run lock: an install, a restore or an import is under way. */
	running: boolean;
	counts: Counts;
	ready: StatusApp[];
	held: StatusApp[];
	failing: StatusApp[];
};

/** The bucket a row counts in; a row still checking or in a run counts in none of them, only in apps. */
function bucket(a: AppState): "upToDate" | "ready" | "held" | "failing" | null {
	switch (a.status) {
		case "fresh":
		case "done":
			return "upToDate";
		case "ready":
		case "manual":
			return "ready";
		case "held":
			return "held";
		case "problem":
		case "failed":
		case "rolled_back":
		case "stopped":
			return "failing";
		default:
			return null;
	}
}

/** The counts of a list of rows. Every row counts in apps, whatever its state. */
export function countsOf(apps: AppState[]): Counts {
	const counts: Counts = { apps: apps.length, upToDate: 0, ready: 0, held: 0, failing: 0 };
	for (const a of apps) {
		const b = bucket(a);
		if (b) counts[b] += 1;
	}
	return counts;
}

/** A row as a status list names it; the detail only where it says why something failed. */
function listed(a: AppState, why = false): StatusApp {
	const out: StatusApp = { key: a.key, name: a.name, installed: a.installed, latest: a.latest };
	if (why && a.detail) out.detail = a.detail;
	return out;
}

/** "1.0 -> 1.1", with "unknown" for a version the check could not read. */
const versions = (a: StatusApp) => `${a.installed ?? "unknown"} -> ${a.latest ?? "unknown"}`;

/** The status of a snapshot built from the saved rows, with whether a run holds the lock. */
export function statusOf(snapshot: Snapshot, running: boolean): Status {
	const of = (b: ReturnType<typeof bucket>) => snapshot.apps.filter((a) => bucket(a) === b);
	return {
		version: snapshot.version,
		checkedAt: snapshot.checkedAt,
		running,
		counts: countsOf(snapshot.apps),
		ready: of("ready").map((a) => listed(a)),
		held: of("held").map((a) => listed(a)),
		failing: of("failing").map((a) => listed(a, true)),
	};
}

/** The status as English lines for a terminal: the head line first, then one line per ready, held and failing app. */
export function statusLines(s: Status): string[] {
	const head = `Upkeep ${s.version}${s.running ? ", a run is in progress" : ""}`;
	if (s.checkedAt === null) return [head, "No check has run yet."];
	const c = s.counts;
	const lines = [
		head,
		`Last check: ${s.checkedAt}`,
		`${c.apps} apps: ${c.upToDate} up to date, ${c.ready} ready, ${c.held} held, ${c.failing} failing`,
	];
	for (const a of s.ready) lines.push(`  UPDATE: ${a.name} ${versions(a)}`);
	for (const a of s.held) lines.push(`  HELD:   ${a.name} ${versions(a)}`);
	for (const a of s.failing) lines.push(`  FAILED: ${a.name}${a.detail ? ` ${a.detail}` : ""}`);
	return lines;
}

/** A Prometheus label value: backslash, double quote and newline escaped, as the text format requires. */
const label = (v: string) => v.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");

/**
 * The status in Prometheus's text format, for node_exporter's textfile collector: the version, the last check's
 * time (0 before the first), whether a run is under way, the count in each state, and one series per ready app with
 * its versions as labels. Ends with a newline, which the collector needs. A per-app series exists only while the
 * app is ready, so an alert on it clears once the update is in.
 */
export function metricsText(s: Status): string {
	const at = s.checkedAt ? Math.floor(Date.parse(s.checkedAt) / 1000) : 0;
	const lines = [
		"# HELP upkeep_info The running Upkeep's version.",
		"# TYPE upkeep_info gauge",
		`upkeep_info{version="${label(s.version)}"} 1`,
		"# HELP upkeep_last_check_timestamp_seconds When the last check ended, as Unix time; 0 before the first.",
		"# TYPE upkeep_last_check_timestamp_seconds gauge",
		`upkeep_last_check_timestamp_seconds ${Number.isFinite(at) ? at : 0}`,
		"# HELP upkeep_run_in_progress 1 while an install, restore or import holds the run lock.",
		"# TYPE upkeep_run_in_progress gauge",
		`upkeep_run_in_progress ${s.running ? 1 : 0}`,
		"# HELP upkeep_apps Apps in the list, by the state the last check left them in.",
		"# TYPE upkeep_apps gauge",
		`upkeep_apps{state="up_to_date"} ${s.counts.upToDate}`,
		`upkeep_apps{state="ready"} ${s.counts.ready}`,
		`upkeep_apps{state="held"} ${s.counts.held}`,
		`upkeep_apps{state="failing"} ${s.counts.failing}`,
		"# HELP upkeep_update_ready 1 for each app with an update ready, labelled with its versions.",
		"# TYPE upkeep_update_ready gauge",
		...s.ready.map(
			(a) =>
				`upkeep_update_ready{app="${label(a.key)}",installed="${label(a.installed ?? "")}",latest="${label(a.latest ?? "")}"} 1`,
		),
	];
	return `${lines.join("\n")}\n`;
}
