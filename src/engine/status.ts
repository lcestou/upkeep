import type { AppState, SecurityFix, Snapshot, Watch } from "../shared/types";

/**
 * How many apps rest in each state, as `upkeep status`, its metrics and a sent notice count them. ready is what
 * Install would take, as the window and the tray count it; manual is an update the person runs by hand, which the
 * window shows in a group of its own. unchecked is an app in apps.toml with no row (added since the last check, or
 * found not installed); apps counts every one of them.
 */
export type Counts = {
	apps: number;
	upToDate: number;
	ready: number;
	manual: number;
	held: number;
	failing: number;
	unchecked: number;
};

/**
 * One app in a status list: its versions, the sentence that says why when the row has one (a failure, a passed-over
 * bad version, a replaced repo), and for a held app what holds it: a pause's end, a skipped version, or the day a
 * release wait ends.
 */
export type StatusApp = {
	key: string;
	name: string;
	installed: string | null;
	latest: string | null;
	detail?: string;
	paused?: string;
	skipped?: string;
	settles?: string;
	/** The waiting update fixes a security problem: its advisory IDs, none when only its release notes say so. */
	security?: SecurityFix;
};

/** What `upkeep status` reports: the last check's rows as the engine keeps them, without a check of its own. */
export type Status = {
	version: string;
	/** When the last check that got through ended; null before the first one. */
	checkedAt: string | null;
	/** A live process holds the run lock: an install, a restore or an import is under way. */
	running: boolean;
	counts: Counts;
	ready: StatusApp[];
	/** Updates the person runs by hand (a manual app), apart from ready as the window keeps them. */
	manual: StatusApp[];
	held: StatusApp[];
	failing: StatusApp[];
	/** Up-to-date apps whose row says something, such as a listed bad version it kept the app clear of. */
	noted: StatusApp[];
	/** Apps in the list the last check left no row for, by key and name. */
	unchecked: { key: string; name: string }[];
	/** Apps on probation with a sign up since Upkeep updated them, whatever bucket they count in. */
	watch: (Pick<StatusApp, "key" | "name" | "installed"> & { watch: Watch })[];
};

/** The bucket a row counts in; a row still checking or in a run counts in none of them, only in apps. */
function bucket(a: AppState): "upToDate" | "ready" | "manual" | "held" | "failing" | null {
	switch (a.status) {
		case "fresh":
		case "done":
			return "upToDate";
		case "ready":
			return "ready";
		case "manual":
			return "manual";
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

/**
 * The counts of a list of rows, with listed (every app in apps.toml) adding the ones that have no row as unchecked.
 * Every row counts in apps, whatever its state. The one count status, its metrics and a notice all use.
 */
export function countsOf(apps: AppState[], listed: { key: string }[] = []): Counts {
	const known = new Set(apps.map((a) => a.key));
	const unchecked = listed.filter((a) => !known.has(a.key)).length;
	const counts: Counts = {
		apps: apps.length + unchecked,
		upToDate: 0,
		ready: 0,
		manual: 0,
		held: 0,
		failing: 0,
		unchecked,
	};
	for (const a of apps) {
		const b = bucket(a);
		if (b) counts[b] += 1;
	}
	return counts;
}

/** A row as a status list names it, with its detail and what holds it only where the row has them. */
function listedApp(a: AppState): StatusApp {
	const out: StatusApp = { key: a.key, name: a.name, installed: a.installed, latest: a.latest };
	if (a.detail) out.detail = a.detail;
	if (a.status === "held" && a.paused) out.paused = a.paused;
	if (a.status === "held" && a.skipped) out.skipped = a.skipped;
	if (a.status === "held" && a.settles) out.settles = a.settles;
	if (a.security) out.security = a.security;
	return out;
}

/** "1.0 -> 1.1", with "unknown" for a version the check could not read. */
const versions = (a: Pick<StatusApp, "installed" | "latest">) =>
	`${a.installed ?? "unknown"} -> ${a.latest ?? "unknown"}`;

/** " (security fix: CVE-…, GHSA-…)" when the waiting update fixes a security problem, " (security fix)" with no ID, else nothing. */
export function securityNote(a: { security?: SecurityFix }): string {
	if (!a.security) return "";
	const ids = a.security.ids.map((i) => i.id).join(", ");
	return ids ? ` (security fix: ${ids})` : " (security fix)";
}

/** The local calendar day of an ISO time as YYYY-MM-DD, the day the window shows, so a script can compare it with `date +%F`. */
export const localDay = (iso: string) => new Date(iso).toLocaleDateString("sv-SE");

/**
 * The HELD line `upkeep check` and `upkeep status` both print: versions, then what holds it (a pause's end, a skipped
 * version, a release wait's end, in that order, only the first that applies), then the row's reason, which says why
 * when Upkeep held it itself (a release whose file changed, a repo replaced under the same name).
 */
export function heldLine(
	a: Pick<StatusApp, "name" | "installed" | "latest" | "detail" | "paused" | "skipped" | "settles" | "security">,
): string {
	const why = a.paused
		? ` (paused until ${localDay(a.paused)})`
		: a.skipped
			? ` (skipping ${a.skipped})`
			: a.settles
				? ` (offered from ${localDay(a.settles)})`
				: "";
	return `  HELD:   ${a.name} ${versions(a)}${why}${securityNote(a)}${a.detail ? ` ${a.detail}` : ""}`;
}

/**
 * The status of a snapshot built from the saved rows, with whether a run holds the lock. listed is every app in
 * apps.toml: one with no row counts as unchecked and in apps, since the rows alone would leave it out of the total.
 * The rows cannot tell an app added since the last check from one that check found not installed.
 */
export function statusOf(snapshot: Snapshot, running: boolean, listed: { key: string; name: string }[] = []): Status {
	const of = (b: ReturnType<typeof bucket>) => snapshot.apps.filter((a) => bucket(a) === b);
	const known = new Set(snapshot.apps.map((a) => a.key));
	const unchecked = listed.filter((a) => !known.has(a.key)).map((a) => ({ key: a.key, name: a.name }));
	return {
		version: snapshot.version,
		checkedAt: snapshot.checkedAt,
		running,
		counts: countsOf(snapshot.apps, listed),
		unchecked,
		ready: of("ready").map(listedApp),
		manual: of("manual").map(listedApp),
		held: of("held").map(listedApp),
		failing: of("failing").map(listedApp),
		noted: of("upToDate")
			.filter((a) => a.detail)
			.map(listedApp),
		watch: snapshot.apps.flatMap((a) =>
			a.watch ? [{ key: a.key, name: a.name, installed: a.installed, watch: a.watch }] : [],
		),
	};
}

/** " <reason>" when the row has one, else nothing. */
const why = (a: StatusApp) => (a.detail ? ` ${a.detail}` : "");

/**
 * The status as English lines for a terminal: the head line first, then one line per ready, by-hand, held and failing app,
 * then an up-to-date app whose row says something. A held line reads as `upkeep check` prints it (heldLine).
 */
export function statusLines(s: Status): string[] {
	const head = `Upkeep ${s.version}${s.running ? ", a run is in progress" : ""}`;
	if (s.checkedAt === null) return [head, "No check has run yet."];
	const c = s.counts;
	const lines = [
		head,
		`Last check: ${s.checkedAt}`,
		`${c.apps} apps: ${c.upToDate} up to date, ${c.ready} ready, ${c.held} held, ${c.failing} failing${c.manual > 0 ? `, ${c.manual} by hand` : ""}${c.unchecked > 0 ? `, ${c.unchecked} not checked yet or not installed` : ""}`,
	];
	for (const a of s.ready) lines.push(`  UPDATE: ${a.name} ${versions(a)}${securityNote(a)}${why(a)}`);
	for (const a of s.manual) lines.push(`  BY HAND: ${a.name} ${versions(a)}${securityNote(a)}${why(a)}`);
	for (const a of s.held) lines.push(heldLine(a));
	for (const a of s.failing) lines.push(`  FAILED: ${a.name}${why(a)}`);
	for (const a of s.noted) lines.push(`  NOTE:   ${a.name} ${a.installed ?? "unknown"}${why(a)}`);
	for (const a of s.watch) lines.push(watchLine(a));
	return lines;
}

/** What each sign says on a WATCH line. */
const SIGN_WORDS = {
	crash: "crashed",
	service: "service failing",
	health: "health address not answering",
} as const;

/**
 * The WATCH line `upkeep check` and `upkeep status` print for an app with a sign since its update: the version now,
 * what was seen (with the crash count), and the version and day of the update it came with.
 */
export function watchLine(a: Pick<StatusApp, "name" | "installed"> & { watch: Watch }): string {
	const w = a.watch;
	const seen =
		w.sign === "crash" && w.crashes ? `crashed ${w.crashes} time${w.crashes === 1 ? "" : "s"}` : SIGN_WORDS[w.sign];
	return `  WATCH:  ${a.name} ${a.installed ?? "unknown"} ${seen} since the update from ${w.from ?? "unknown"} on ${localDay(w.at)}`;
}

/** A Prometheus label value: backslash, double quote and newline escaped, as the text format requires. */
const label = (v: string) => v.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");

/**
 * The status in Prometheus's text format, for node_exporter's textfile collector: the version, the last check's
 * time (0 before the first), whether a run is under way, the count in each state, and one series per ready app with
 * its versions as labels, and how many apps wait for an update that fixes a security problem (ready, by hand or held).
 * Ends with a newline, which the collector needs. A per-app series exists only while the
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
		"# HELP upkeep_apps Apps in the list, by the state the last check left them in; manual is run by hand, unchecked has no row.",
		"# TYPE upkeep_apps gauge",
		`upkeep_apps{state="up_to_date"} ${s.counts.upToDate}`,
		`upkeep_apps{state="ready"} ${s.counts.ready}`,
		`upkeep_apps{state="manual"} ${s.counts.manual}`,
		`upkeep_apps{state="held"} ${s.counts.held}`,
		`upkeep_apps{state="failing"} ${s.counts.failing}`,
		`upkeep_apps{state="unchecked"} ${s.counts.unchecked}`,
		"# HELP upkeep_security_fixes Apps whose waiting update fixes a security problem, ready, by hand or held.",
		"# TYPE upkeep_security_fixes gauge",
		`upkeep_security_fixes ${[...s.ready, ...s.manual, ...s.held].filter((a) => a.security).length}`,
		"# HELP upkeep_update_ready 1 for each app with an update ready, labelled with its versions.",
		"# TYPE upkeep_update_ready gauge",
		...s.ready.map(
			(a) =>
				`upkeep_update_ready{app="${label(a.key)}",installed="${label(a.installed ?? "")}",latest="${label(a.latest ?? "")}"} 1`,
		),
	];
	return `${lines.join("\n")}\n`;
}
