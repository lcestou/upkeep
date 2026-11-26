import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MESSAGES } from "../../shared/messages";
import type { ProcessResult } from "../run";
import { ok, strictRun } from "../testkit";
import {
	detectSnapshot,
	finishSnapshot,
	freshSnapshot,
	parseTimeshiftList,
	readOwned,
	SNAPPER_HAS_ROOT,
	SNAPPER_PRE,
	SNAPPER_VERSION,
	snapperPost,
	SNAPSHOT_COMMENT,
	snapshotTime,
	TIMESHIFT_CREATE,
	TIMESHIFT_LIST,
	TIMESHIFT_READ_CONFIG,
	TIMESHIFT_VERSION,
	timeshiftConfig,
	timeshiftDelete,
	takeSnapshot,
	toPrune,
} from "./snapshot";

const exit = (code: number, stdout = "", stderr = ""): ProcessResult => ({ code, stdout, stderr, timedOut: false });
const key = (argv: string[]) => argv.join(" ");

/**
 * timeshift --list --scripted as Timeshift's AppConsole.vala prints it: print_status's device lines, then print_grid of
 * Num, an empty column holding ">", Name, Tags and Description, every cell padded to its column's widest plus two
 * spaces (the last column too), a rule of 78 dashes under the header, and a blank line after the rows.
 */
function listing(rows: [string, string, string][]): string {
	const grid = [["Num", "", "Name", "Tags", "Description"], ...rows.map(([n, t, c], i) => [String(i), ">", n, t, c])];
	const widths = [0, 1, 2, 3, 4].map((c) => Math.max(...grid.map((r) => (r[c] ?? "").length)));
	const line = (r: string[]) => r.map((cell, c) => `${cell.padEnd(widths[c] ?? 0)}  `).join("");
	const [head = [], ...body] = grid;
	return [
		"Mounted '/dev/sda2' at '/run/timeshift/1234/backup'",
		"Device : /dev/sda2",
		"Mode   : RSYNC",
		"Status : OK",
		`${rows.length} snapshots, 120.4 GB free`,
		"",
		line(head),
		"-".repeat(78),
		...body.map(line),
		"",
		"",
	].join("\n");
}
/** The list as a successful run's answer. */
const listed = (rows: [string, string, string][]) => ok(listing(rows));
/** What Timeshift answers with no snapshot at all: the status lines, then "No snapshots found", exit 1. */
const EMPTY = exit(1, "Device : /dev/sda2\nStatus : OK\n0 snapshots, 120.4 GB free\n\nNo snapshots found\n");

// The owner's own snapshots (daily, a weekly, one with their own comment) and four of Upkeep's, mixed.
const MIXED: [string, string, string][] = [
	["2026-11-01_06-00-01", "W", ""],
	["2026-11-20_09-00-00", "O", SNAPSHOT_COMMENT],
	["2026-11-21_09-00-00", "O", "before the GPU driver"],
	["2026-11-22_09-00-00", "O", SNAPSHOT_COMMENT],
	["2026-11-23_09-00-00", "O", `${SNAPSHOT_COMMENT} (mine)`],
	["2026-11-24_09-00-00", "O", SNAPSHOT_COMMENT],
	["2026-11-25_06-00-01", "D", ""],
	["2026-11-25_09-00-00", "O", SNAPSHOT_COMMENT],
];

test("detectSnapshot: Timeshift with a backup device, else Snapper with a root config, else none", async () => {
	const machine = (answers: Map<string, ProcessResult>) => strictRun((argv) => answers.get(key(argv)) ?? exit(127)).run;
	const tsConfig = (body: Record<string, string>) => ok(JSON.stringify(body));
	const ts = new Map([
		[key(TIMESHIFT_VERSION), ok("Timeshift 25.12.4\n")],
		[key(TIMESHIFT_READ_CONFIG), tsConfig({ backup_device_uuid: "u", btrfs_mode: "false" })],
	]);
	expect(await detectSnapshot(machine(ts))).toEqual({ tool: "timeshift", btrfs: false });
	ts.set(key(TIMESHIFT_READ_CONFIG), tsConfig({ backup_device_uuid: "u", btrfs_mode: "true" }));
	expect(await detectSnapshot(machine(ts))).toEqual({ tool: "timeshift", btrfs: true });
	// Installed but never set up: no backup device, or no config at all.
	ts.set(key(TIMESHIFT_READ_CONFIG), tsConfig({ backup_device_uuid: "", btrfs_mode: "false" }));
	expect(await detectSnapshot(machine(ts))).toBeNull();
	ts.set(key(TIMESHIFT_READ_CONFIG), exit(1, "", "cat: /etc/timeshift/timeshift.json: No such file or directory"));
	expect(await detectSnapshot(machine(ts))).toBeNull();
	const sp = new Map([
		[key(SNAPPER_VERSION), ok("snapper 0.11.0\n")],
		[key(SNAPPER_HAS_ROOT), ok()],
	]);
	expect(await detectSnapshot(machine(sp))).toEqual({ tool: "snapper", btrfs: true });
	sp.set(key(SNAPPER_HAS_ROOT), exit(1));
	expect(await detectSnapshot(machine(sp))).toBeNull();
	expect(await detectSnapshot(machine(new Map()))).toBeNull();
	expect(timeshiftConfig("not json")).toBeNull();
});

test("parseTimeshiftList reads names, tags and comments by the header's columns", () => {
	const list = parseTimeshiftList(listed(MIXED));
	expect(list).toHaveLength(8);
	expect(list?.[0]).toEqual({ name: "2026-11-01_06-00-01", tags: "W", comment: "" });
	expect(list?.[1]).toEqual({ name: "2026-11-20_09-00-00", tags: "O", comment: SNAPSHOT_COMMENT });
	expect(list?.[4]?.comment).toBe(`${SNAPSHOT_COMMENT} (mine)`);
	// A tagless snapshot whose comment starts with a tag letter keeps that letter in its comment.
	const tagless = parseTimeshiftList(listed([["2026-01-02_03-04-05", "", `O ${SNAPSHOT_COMMENT}`]]));
	expect(tagless).toEqual([{ name: "2026-01-02_03-04-05", tags: "", comment: `O ${SNAPSHOT_COMMENT}` }]);
	// Several tags, and a comment with spaces inside it.
	expect(parseTimeshiftList(listed([["2026-01-02_03-04-05", "DW", "a  b"]]))?.[0]).toEqual({
		name: "2026-01-02_03-04-05",
		tags: "DW",
		comment: "a  b",
	});
	expect(snapshotTime("2026-01-02_03-04-05")).toBe(new Date(2026, 0, 2, 3, 4, 5).getTime());
});

test("parseTimeshiftList tells no snapshots from a list it cannot read", () => {
	expect(parseTimeshiftList(EMPTY)).toEqual([]);
	// Translated headings, no rule, a row that is not a snapshot, a failure or a time-out: none is a list.
	for (const r of [
		ok(listing(MIXED).replace("Description", "Beschreibung")),
		ok(listing(MIXED).replace("-".repeat(78), "")),
		ok(listing(MIXED).replace("2026-11-01_06-00-01", "yesterday at six")),
		ok("Device : /dev/sda2\n"),
		exit(1, "", "E: Failed to mount device"),
		{ ...listed(MIXED), timedOut: true },
	])
		expect(parseTimeshiftList(r)).toBeNull();
});

test("the 6-hour rule: the newest snapshot of any kind under 6 hours old counts", () => {
	const list = parseTimeshiftList(listed(MIXED)) ?? [];
	// The newest is Upkeep's at 09:00; at 14:59 it is 5 h 59 min old.
	expect(freshSnapshot(list, new Date(2026, 10, 25, 14, 59))).toBe("2026-11-25_09-00-00");
	expect(freshSnapshot(list, new Date(2026, 10, 25, 15, 0))).toBeNull();
	// The owner's daily one counts as much as Upkeep's.
	const daily = parseTimeshiftList(listed([["2026-11-26_06-00-01", "D", ""]])) ?? [];
	expect(freshSnapshot(daily, new Date(2026, 10, 26, 10, 0))).toBe("2026-11-26_06-00-01");
	expect(freshSnapshot([], new Date())).toBeNull();
	// A clock behind the snapshot's time is not trusted to say it is fresh.
	expect(freshSnapshot(daily, new Date(2026, 10, 26, 5, 0))).toBeNull();
});

// The names of the four snapshots in MIXED that Upkeep took and recorded.
const OWNED = ["2026-11-20_09-00-00", "2026-11-22_09-00-00", "2026-11-24_09-00-00", "2026-11-25_09-00-00"];

test("prune deletes only snapshots Upkeep recorded, with its exact comment, past the newest 3", () => {
	const list = parseTimeshiftList(listed(MIXED)) ?? [];
	expect(toPrune(list, OWNED)).toEqual(["2026-11-20_09-00-00"]);
	// Unrecorded, even with Upkeep's exact comment (or what pads to it, a trailing space): never.
	expect(toPrune(list, [])).toEqual([]);
	const padded = parseTimeshiftList(
		listed([
			...MIXED,
			["2026-11-19_09-00-00", "O", `${SNAPSHOT_COMMENT} `],
			["2026-11-18_09-00-00", "", `O ${SNAPSHOT_COMMENT}`],
			["2026-11-17_09-00-00", "O", "Upkeep before system updates, mine"],
		]),
	);
	expect(toPrune(padded ?? [], OWNED)).toEqual(["2026-11-20_09-00-00"]);
	// Recorded, but its comment no longer Upkeep's (the owner changed it, or the row starts with a tag letter): kept.
	const changed = [...OWNED, "2026-11-18_09-00-00", "2026-11-17_09-00-00", "2026-11-23_09-00-00"];
	expect(toPrune(padded ?? [], changed)).toEqual(["2026-11-20_09-00-00"]);
	expect(toPrune(list, OWNED.slice(0, 3))).toEqual([]);
});

test("the argv of every snapshot command, each through sudo -n", () => {
	expect(TIMESHIFT_LIST).toEqual(["sudo", "-n", "env", "LC_ALL=C", "timeshift", "--list", "--scripted"]);
	expect(TIMESHIFT_CREATE).toEqual([
		"sudo",
		"-n",
		"timeshift",
		"--create",
		"--comments",
		"Upkeep before system updates",
		"--tags",
		"O",
		"--scripted",
	]);
	expect(timeshiftDelete("2026-11-20_09-00-00")).toEqual([
		"sudo",
		"-n",
		"timeshift",
		"--delete",
		"--snapshot",
		"2026-11-20_09-00-00",
		"--scripted",
	]);
	expect(SNAPPER_PRE).toEqual([
		"sudo",
		"-n",
		"snapper",
		"-c",
		"root",
		"create",
		"--type",
		"pre",
		"--print-number",
		"--cleanup-algorithm",
		"number",
		"--description",
		"Upkeep before system updates",
	]);
	expect(snapperPost(42)).toEqual([
		"sudo",
		"-n",
		"snapper",
		"-c",
		"root",
		"create",
		"--type",
		"post",
		"--pre-number",
		"42",
		"--print-number",
		"--cleanup-algorithm",
		"number",
		"--description",
		"Upkeep before system updates",
	]);
});

/** A Timeshift machine: the list before and after a create, which succeeds unless told otherwise. */
function timeshift(before: ProcessResult, after: ProcessResult, over: Map<string, ProcessResult> = new Map()) {
	let made = false;
	return strictRun((argv) => {
		const k = key(argv);
		const o = over.get(k);
		if (o) return o;
		if (k === key(TIMESHIFT_LIST)) return made ? after : before;
		if (k === key(TIMESHIFT_CREATE)) {
			made = true;
			return ok("Tagged snapshot '2026-11-26_10-00-00': ondemand\n");
		}
		if (argv[2] === "timeshift" && argv[3] === "--delete") return ok();
		return undefined;
	});
}
const lines: string[] = [];
let state = "";
beforeEach(() => {
	state = mkdtempSync(join(tmpdir(), "upkeep-snapshot-"));
});
afterEach(() => rmSync(state, { recursive: true, force: true }));
const ctxOf = (run: ReturnType<typeof strictRun>["run"], at = new Date(2026, 10, 26, 10, 0)) => ({
	run,
	now: () => at,
	log: (l: string) => {
		lines.push(l);
	},
	state,
});
/** Records names as Upkeep's own Timeshift snapshots, as an earlier run would have. */
const own = (names: string[]) => writeFileSync(join(state, "timeshift-snapshots.json"), JSON.stringify(names));
const NEW: [string, string, string] = ["2026-11-26_10-00-00", "O", SNAPSHOT_COMMENT];

test("Timeshift: takes one with Upkeep's comment, then deletes only Upkeep's own past the newest 3, newest first", async () => {
	own(OWNED);
	const box = timeshift(listed(MIXED), listed([...MIXED, NEW]));
	const r = await takeSnapshot({ tool: "timeshift", btrfs: false }, ctxOf(box.run));
	expect(r).toEqual({ status: "taken", tool: "timeshift", name: "2026-11-26_10-00-00" });
	expect(box.calls.map((c) => key(c.argv))).toEqual([
		key(TIMESHIFT_LIST),
		key(TIMESHIFT_CREATE),
		key(TIMESHIFT_LIST),
		key(timeshiftDelete("2026-11-22_09-00-00")),
		key(timeshiftDelete("2026-11-20_09-00-00")),
	]);
	// The create streams its lines into the log and leads its own process group, as a System step does.
	expect(box.calls[1]?.opts.group).toBe(true);
	expect(box.calls[1]?.opts.onLine).toBeDefined();
	// The new one is recorded, the deleted ones leave the record.
	expect(readOwned(state)).toEqual(["2026-11-24_09-00-00", "2026-11-25_09-00-00", "2026-11-26_10-00-00"]);
});

test("Timeshift: a new snapshot that cannot be told apart is not recorded, and an unread list prunes nothing", async () => {
	own(OWNED);
	// Two new ones with Upkeep's comment (another Upkeep ran too): neither is named or recorded.
	const two = timeshift(listed(MIXED), listed([...MIXED, NEW, ["2026-11-26_10-00-05", "O", SNAPSHOT_COMMENT]]));
	expect(await takeSnapshot({ tool: "timeshift", btrfs: false }, ctxOf(two.run))).toEqual({
		status: "taken",
		tool: "timeshift",
		name: null,
	});
	expect(readOwned(state)).not.toContain("2026-11-26_10-00-00");
	// A list after the create that cannot be read: taken, unnamed, nothing deleted, the record untouched.
	own(OWNED);
	const blind = timeshift(listed(MIXED), ok("garbage\n"));
	expect(await takeSnapshot({ tool: "timeshift", btrfs: false }, ctxOf(blind.run))).toEqual({
		status: "taken",
		tool: "timeshift",
		name: null,
	});
	expect(blind.calls.some((c) => c.argv.includes("--delete"))).toBe(false);
	expect(readOwned(state)).toEqual(OWNED);
	// No record yet (a first run): the new one is recorded, and nothing of the owner's is deleted.
	rmSync(join(state, "timeshift-snapshots.json"));
	const first = timeshift(EMPTY, listed([NEW]));
	expect((await takeSnapshot({ tool: "timeshift", btrfs: false }, ctxOf(first.run))).status).toBe("taken");
	expect(readOwned(state)).toEqual(["2026-11-26_10-00-00"]);
	writeFileSync(join(state, "timeshift-snapshots.json"), "{broken");
	expect(readOwned(state)).toEqual([]);
});

test("Timeshift: skips when the newest is under 6 hours old, but never in btrfs mode", async () => {
	const daily = listed([["2026-11-26_06-00-01", "D", ""]]);
	const box = timeshift(daily, daily);
	expect(await takeSnapshot({ tool: "timeshift", btrfs: false }, ctxOf(box.run))).toEqual({
		status: "skipped",
		tool: "timeshift",
		name: "2026-11-26_06-00-01",
	});
	expect(box.calls.map((c) => key(c.argv))).toEqual([key(TIMESHIFT_LIST)]);
	const btrfs = timeshift(daily, listed([["2026-11-26_06-00-01", "D", ""], NEW]));
	expect((await takeSnapshot({ tool: "timeshift", btrfs: true }, ctxOf(btrfs.run))).status).toBe("taken");
});

test("Timeshift: a failed list or create is a failure with its reason; a failed delete is not", async () => {
	const noRoot = exit(1, "", "sudo: a password is required");
	const r1 = await takeSnapshot(
		{ tool: "timeshift", btrfs: false },
		ctxOf(timeshift(EMPTY, EMPTY, new Map([[key(TIMESHIFT_LIST), noRoot]])).run),
	);
	expect(r1).toEqual({
		status: "failed",
		tool: "timeshift",
		reason: MESSAGES.snapshotFailed(MESSAGES.snapshotNoRoot()),
	});
	// A list that answers but cannot be read takes no snapshot.
	const odd = timeshift(ok("Num  Nom\n"), EMPTY);
	expect(await takeSnapshot({ tool: "timeshift", btrfs: false }, ctxOf(odd.run))).toEqual({
		status: "failed",
		tool: "timeshift",
		reason: MESSAGES.snapshotFailed(MESSAGES.snapshotListUnread()),
	});
	expect(odd.calls.some((c) => c.argv.includes("--create"))).toBe(false);
	const full = exit(1, "", "E: Not enough disk space on the backup device\n");
	const r2 = await takeSnapshot(
		{ tool: "timeshift", btrfs: false },
		ctxOf(timeshift(EMPTY, EMPTY, new Map([[key(TIMESHIFT_CREATE), full]])).run),
	);
	expect(r2).toEqual({
		status: "failed",
		tool: "timeshift",
		reason: MESSAGES.snapshotFailed("E: Not enough disk space on the backup device"),
	});
	const slow = { ...exit(137), timedOut: true };
	const r3 = await takeSnapshot(
		{ tool: "timeshift", btrfs: false },
		ctxOf(timeshift(EMPTY, EMPTY, new Map([[key(TIMESHIFT_CREATE), slow]])).run),
	);
	expect(r3.status === "failed" && r3.reason).toBe(
		MESSAGES.snapshotFailed(MESSAGES.systemTimedOut(key(TIMESHIFT_CREATE))),
	);
	const silent = exit(3);
	const r4 = await takeSnapshot(
		{ tool: "timeshift", btrfs: false },
		ctxOf(timeshift(EMPTY, EMPTY, new Map([[key(TIMESHIFT_CREATE), silent]])).run),
	);
	expect(r4.status === "failed" && r4.reason).toBe(
		MESSAGES.snapshotFailed(MESSAGES.commandExited(key(TIMESHIFT_CREATE), 3)),
	);
	// A delete that fails is logged and stays recorded; the snapshot still counts.
	own(OWNED);
	const stuck = timeshift(
		listed(MIXED),
		listed([...MIXED, NEW]),
		new Map([[key(timeshiftDelete("2026-11-20_09-00-00")), exit(1)]]),
	);
	expect((await takeSnapshot({ tool: "timeshift", btrfs: false }, ctxOf(stuck.run))).status).toBe("taken");
	expect(lines).toContain("Could not delete 2026-11-20_09-00-00; it stays");
	expect(readOwned(state)).toContain("2026-11-20_09-00-00");
});

test("Snapper: a pre snapshot before, a post one paired with it after, and no prune or 6-hour skip", async () => {
	const box = strictRun((argv) => {
		if (key(argv) === key(SNAPPER_PRE)) return ok("41\n");
		if (key(argv) === key(snapperPost(41))) return ok("42\n");
		return undefined;
	});
	const ctx = ctxOf(box.run);
	const r = await takeSnapshot({ tool: "snapper", btrfs: true }, ctx);
	expect(r).toEqual({ status: "taken", tool: "snapper", name: "41", pre: 41 });
	await finishSnapshot(r, ctx);
	expect(box.calls.map((c) => key(c.argv))).toEqual([key(SNAPPER_PRE), key(snapperPost(41))]);
	expect(lines).toContain("Snapper post snapshot 42 taken, paired with 41");
	// A post that fails is logged; nothing throws.
	const bad = strictRun((argv) => (key(argv) === key(snapperPost(7)) ? exit(1) : undefined));
	await finishSnapshot({ status: "taken", tool: "snapper", name: "7", pre: 7 }, ctxOf(bad.run));
	expect(lines).toContain("Snapper post snapshot failed; pre snapshot 7 stays unpaired");
	// Nothing to pair: Timeshift, a skip, a failure, or no snapshot at all.
	const none = strictRun(() => undefined);
	for (const res of [
		{ status: "taken", tool: "timeshift", name: "x" },
		{ status: "skipped", tool: "timeshift", name: "x" },
		{ status: "failed", tool: "snapper", reason: "r" },
		null,
	] as const)
		// oxlint-disable-next-line no-await-in-loop -- each result on its own
		await finishSnapshot(res, ctxOf(none.run));
	expect(none.calls).toEqual([]);
	// A pre that prints no number is taken, unnamed, and nothing pairs with it.
	const mute = strictRun((argv) => (key(argv) === key(SNAPPER_PRE) ? ok("") : undefined));
	const unnamed = await takeSnapshot({ tool: "snapper", btrfs: true }, ctxOf(mute.run));
	expect(unnamed).toEqual({ status: "taken", tool: "snapper", name: null });
	await finishSnapshot(unnamed, ctxOf(mute.run));
	expect(mute.calls).toHaveLength(1);
	// A pre that fails is a failure.
	const refused = strictRun((argv) => (key(argv) === key(SNAPPER_PRE) ? exit(1, "", "Failed to create") : undefined));
	expect((await takeSnapshot({ tool: "snapper", btrfs: true }, ctxOf(refused.run))).status).toBe("failed");
});
