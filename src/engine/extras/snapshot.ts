import { MESSAGES } from "../../shared/messages";
import type { SnapshotSetup } from "../../shared/types";
import { isRecord } from "../manifest";
import { asRoot, type ProcessResult, type Run, sudoNeedsPassword } from "../run";

// The snapshot tools Upkeep drives before a System install, named here and nowhere else: Timeshift (its command line
// and its config file) and Snapper (its root config), with cat and test to read whether each is set up. Every command
// that takes, lists or deletes a snapshot runs as root through sudo -n, the same root path System's packages use.

/** History's key for the snapshot before a System install; the row has no versions, and its detail names the snapshot. */
export const SNAPSHOT_KEY = "system:snapshot";
/** The comment on every snapshot Upkeep takes. Pruning deletes only Timeshift snapshots whose comment is exactly this. */
export const SNAPSHOT_COMMENT = "Upkeep before system updates";
/** How many of Upkeep's own Timeshift snapshots are kept; older ones are deleted after a new one is taken. */
export const KEEP = 3;
/** A Timeshift snapshot younger than this (of any kind, the daily one too) counts, and none is taken. */
export const FRESH_MS = 6 * 3_600_000;

export const TIMESHIFT_CONFIG = "/etc/timeshift/timeshift.json";
export const SNAPPER_ROOT_CONFIG = "/etc/snapper/configs/root";
/** The read-only questions that find a snapshot tool set up; none needs root. */
export const TIMESHIFT_VERSION = ["timeshift", "--version"];
export const TIMESHIFT_READ_CONFIG = ["cat", TIMESHIFT_CONFIG];
export const SNAPPER_VERSION = ["snapper", "--version"];
export const SNAPPER_HAS_ROOT = ["test", "-e", SNAPPER_ROOT_CONFIG];
export const SNAPSHOT_PROBES = [TIMESHIFT_VERSION, TIMESHIFT_READ_CONFIG, SNAPPER_VERSION, SNAPPER_HAS_ROOT];

/** Timeshift's list. --scripted never asks; listing needs root, as Timeshift mounts its backup device for it. */
export const TIMESHIFT_LIST = asRoot(["timeshift", "--list", "--scripted"], true);
/** An on-demand (O) Timeshift snapshot with Upkeep's comment. */
export const TIMESHIFT_CREATE = asRoot(
	["timeshift", "--create", "--comments", SNAPSHOT_COMMENT, "--tags", "O", "--scripted"],
	true,
);
/** Deletes one Timeshift snapshot by its name (its time stamp). */
export const timeshiftDelete = (name: string) =>
	asRoot(["timeshift", "--delete", "--snapshot", name, "--scripted"], true);
/**
 * Snapper's half before the steps: a pre snapshot of the root config that prints its number. Snapper's own number
 * cleanup prunes it later, so Upkeep deletes nothing there.
 */
export const SNAPPER_PRE = asRoot(
	[
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
		SNAPSHOT_COMMENT,
	],
	true,
);
/** Snapper's half after the steps, paired with the pre snapshot's number so snapper status can show what changed. */
export const snapperPost = (pre: number) =>
	asRoot(
		[
			"snapper",
			"-c",
			"root",
			"create",
			"--type",
			"post",
			"--pre-number",
			String(pre),
			"--print-number",
			"--cleanup-algorithm",
			"number",
			"--description",
			SNAPSHOT_COMMENT,
		],
		true,
	);

/**
 * The snapshot tool set up here, or null: Timeshift when its command answers and its config names a backup device
 * (a Timeshift never set up has none), else Snapper when its command answers and it has a root config. Timeshift's
 * btrfs_mode comes from the same config. Snapper snapshots are btrfs ones.
 */
export async function detectSnapshot(run: Run): Promise<SnapshotSetup | null> {
	const opts = { timeoutMs: 10_000 };
	const [tsVersion, tsConfig, spVersion, spRoot] = await Promise.all(SNAPSHOT_PROBES.map((argv) => run(argv, opts)));
	if (tsVersion?.code === 0 && tsConfig?.code === 0) {
		const config = timeshiftConfig(tsConfig.stdout);
		if (config) return { tool: "timeshift", btrfs: config.btrfs };
	}
	if (spVersion?.code === 0 && spRoot?.code === 0) return { tool: "snapper", btrfs: true };
	return null;
}

/** Timeshift's config, when it names a backup device: whether it is in btrfs mode. Null for anything else. */
export function timeshiftConfig(text: string): { btrfs: boolean } | null {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(data) || typeof data.backup_device_uuid !== "string" || !data.backup_device_uuid) return null;
	// Timeshift writes its booleans as the strings "true" and "false".
	return { btrfs: data.btrfs_mode === "true" || data.btrfs_mode === true };
}

/** One snapshot in Timeshift's list: its name (the local time it was taken), its tag letters and its comment. */
export type TimeshiftSnapshot = { name: string; tags: string; comment: string };

/**
 * timeshift --list: after a dashed rule, "<num> > <name> <tags> <comment>" per snapshot, where the name is the local
 * time YYYY-MM-DD_HH-MM-SS and tags are letters from O, B, H, D, W and M. The ">" may be absent, and so may the
 * comment. The device lines above the rule are not snapshots.
 */
export function parseTimeshiftList(stdout: string): TimeshiftSnapshot[] {
	const out: TimeshiftSnapshot[] = [];
	for (const l of stdout.split("\n")) {
		const m = /^\s*\d+\s+(?:>\s+)?(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})(?:\s+([OBHDWM]+)(?=\s|$))?\s*(.*?)\s*$/.exec(l);
		if (m) out.push({ name: m[1] ?? "", tags: m[2] ?? "", comment: m[3] ?? "" });
	}
	return out;
}

/** The local time a Timeshift snapshot's name stands for, in ms. */
export function snapshotTime(name: string): number {
	const [y = 0, mo = 1, d = 1, h = 0, mi = 0, s = 0] = name.split(/[-_]/).map(Number);
	return new Date(y, mo - 1, d, h, mi, s).getTime();
}

/** The newest snapshot of any kind, when it is under FRESH_MS old at now: then none is taken. Null otherwise. */
export function freshSnapshot(list: TimeshiftSnapshot[], now: Date): string | null {
	const newest = list
		.map((s) => s.name)
		.toSorted()
		.at(-1);
	if (!newest) return null;
	const age = now.getTime() - snapshotTime(newest);
	return age >= 0 && age < FRESH_MS ? newest : null;
}

/** Upkeep's own snapshots past the newest KEEP, oldest last: only a comment exactly Upkeep's counts as Upkeep's. */
export function toPrune(list: TimeshiftSnapshot[]): string[] {
	return list
		.filter((s) => s.comment === SNAPSHOT_COMMENT)
		.map((s) => s.name)
		.toSorted()
		.toReversed()
		.slice(KEEP);
}

/** The snapshot before a System install: taken (with Snapper's pre number to pair), skipped with why, or failed with why. */
export type SnapshotResult =
	| { status: "taken"; tool: SnapshotSetup["tool"]; name: string | null; pre?: number }
	| { status: "skipped"; tool: SnapshotSetup["tool"]; name: string }
	| { status: "failed"; tool: SnapshotSetup["tool"]; reason: string };

export type SnapshotCtx = {
	run: Run;
	now: () => Date;
	/** One line of the run log, in English. */
	log: (line: string) => void;
	/** The pid of the command now running, so a quit can end its process group. */
	onStart?: (pid: number) => void;
};

/** The tool's name as people write it, for the log and History. */
export const TOOL_NAME = { timeshift: "Timeshift", snapper: "Snapper" } satisfies Record<SnapshotSetup["tool"], string>;

/** Why a snapshot command failed, as a MESSAGES sentence: sudo wanting a password, or the command's first line. */
function failure(argv: string[], r: ProcessResult): string {
	if (sudoNeedsPassword(r)) return MESSAGES.snapshotFailed(MESSAGES.snapshotNoRoot());
	if (r.timedOut) return MESSAGES.snapshotFailed(MESSAGES.systemTimedOut(argv.join(" ")));
	const line = `${r.stderr}\n${r.stdout}`.split("\n").find((l) => l.trim() !== "");
	return MESSAGES.snapshotFailed(line?.trim() ?? MESSAGES.commandExited(argv.join(" "), r.code));
}

/**
 * Takes the snapshot before a System install. Timeshift: the list is read first, and when its newest snapshot (the
 * daily one too) is under 6 hours old none is taken, except in btrfs mode, where a snapshot costs next to nothing;
 * after a new one, Upkeep's own past the newest 3 are deleted and nothing else is touched. A delete that fails is
 * logged and does not fail the snapshot. Snapper: a pre snapshot, always, whose number the caller pairs with a post
 * one after the steps (finishSnapshot). A failed list or create is a failure with its reason; nothing throws.
 */
export async function takeSnapshot(setup: SnapshotSetup, ctx: SnapshotCtx): Promise<SnapshotResult> {
	const { tool } = setup;
	ctx.log(`Taking a ${TOOL_NAME[tool]} snapshot before the system updates`);
	const stream = { group: true, onLine: ctx.log, onStart: ctx.onStart };
	if (tool === "snapper") {
		const r = await ctx.run(SNAPPER_PRE, { timeoutMs: 600_000, ...stream });
		const pre = Number.parseInt(r.stdout.trim().split("\n").at(-1) ?? "", 10);
		if (r.code !== 0 || r.timedOut || !Number.isInteger(pre))
			return { status: "failed", tool, reason: failure(SNAPPER_PRE, r) };
		ctx.log(`Snapper pre snapshot ${pre} taken`);
		return { status: "taken", tool, name: String(pre), pre };
	}
	const listed = await ctx.run(TIMESHIFT_LIST, { timeoutMs: 120_000 });
	if (listed.code !== 0 || listed.timedOut) return { status: "failed", tool, reason: failure(TIMESHIFT_LIST, listed) };
	const fresh = setup.btrfs ? null : freshSnapshot(parseTimeshiftList(listed.stdout), ctx.now());
	if (fresh) {
		ctx.log(`No snapshot taken: the newest, ${fresh}, is under 6 hours old`);
		return { status: "skipped", tool, name: fresh };
	}
	const made = await ctx.run(TIMESHIFT_CREATE, { timeoutMs: 7_200_000, ...stream });
	if (made.code !== 0 || made.timedOut) return { status: "failed", tool, reason: failure(TIMESHIFT_CREATE, made) };
	const after = await ctx.run(TIMESHIFT_LIST, { timeoutMs: 120_000 });
	const list = after.code === 0 && !after.timedOut ? parseTimeshiftList(after.stdout) : [];
	const name =
		list
			.filter((s) => s.comment === SNAPSHOT_COMMENT)
			.map((s) => s.name)
			.toSorted()
			.at(-1) ?? null;
	ctx.log(`Timeshift snapshot taken${name ? `: ${name}` : ""}`);
	for (const old of toPrune(list)) {
		ctx.log(`Deleting Upkeep's older Timeshift snapshot ${old}`);
		// oxlint-disable-next-line no-await-in-loop -- Timeshift deletes one snapshot at a time
		const r = await ctx.run(timeshiftDelete(old), { timeoutMs: 600_000, ...stream });
		if (r.code !== 0 || r.timedOut) ctx.log(`Could not delete ${old}; it stays`);
	}
	return { status: "taken", tool, name };
}

/** Snapper's post snapshot after the steps, paired with the pre one, whether the steps worked or not. Others do nothing. */
export async function finishSnapshot(result: SnapshotResult | null, ctx: SnapshotCtx): Promise<void> {
	if (result?.status !== "taken" || result.pre === undefined) return;
	const r = await ctx.run(snapperPost(result.pre), { timeoutMs: 600_000, group: true, onStart: ctx.onStart });
	ctx.log(
		r.code === 0 && !r.timedOut
			? `Snapper post snapshot ${r.stdout.trim()} taken, paired with ${result.pre}`
			: `Snapper post snapshot failed; pre snapshot ${result.pre} stays unpaired`,
	);
}
