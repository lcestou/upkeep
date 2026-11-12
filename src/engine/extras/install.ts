import { MESSAGES } from "../../shared/messages";
import type { SystemOutcome, SystemRow, SystemState } from "../../shared/types";
import type { ProcessResult, Run } from "../run";
import { MINT_LIST, parseMintList, type SystemCheck } from "./system";

// The install half of the System group. Every command here is a literal argv; the view shows the ones that change
// something before any of them runs, and a background run never calls this module.

/**
 * Update Manager's own source names for kernels and the NVIDIA driver, always passed to -i whether ticked or not.
 * mintupdate-cli matches them against the real source name, so a kernel flavour outside these globs (linux-oem-*)
 * would slip through: the trial run below is what catches that.
 */
export const KERNEL_AND_DRIVER_IGNORE = [
	"linux",
	"linux-signed*",
	"linux-meta*",
	"linux-hwe*",
	"nvidia-graphics-drivers-*",
];
/** sudo without a password, or nothing that needs root runs. */
export const SUDO_CHECK = ["sudo", "-n", "true"];
/** Who holds dpkg's locks. fuser exits 1 and prints nothing when nobody does; root is needed to see root's files. */
export const DPKG_LOCK_CHECK = ["sudo", "-n", "fuser", "/var/lib/dpkg/lock-frontend", "/var/lib/dpkg/lock"];

/** A command that did not exit 0 in time. */
const bad = (r: ProcessResult) => r.code !== 0 || r.timedOut;

/** The tool whose list a source's rows come from, as a check's problem names it. */
const LIST_TOOL = {
	apt: "mintupdate-cli",
	dnf: "dnf",
	pacman: "pacman",
	zypper: "zypper",
	flatpak: "flatpak",
	cinnamon: "cinnamon-spice-updater",
	snap: "snap",
} satisfies Record<SystemRow["source"], string>;

/** A binary package a trial run may not touch: a kernel's image, headers, modules or meta package, or anything NVIDIA. */
const RESTART_PACKAGE = /^(linux-(image|headers|modules|signed|meta|hwe|generic|lowlatency|oem)|.*nvidia)/;

/** One command of a System install and the rows it answers for. */
export type Step = {
	kind: "apt" | "flatpak" | "snap" | "cinnamon";
	argv: string[];
	ids: string[];
	timeoutMs: number;
};

export type InstallCtx = {
	run: Run;
	/** Upkeep's own pid, which pkcheck asks about. */
	pid: number;
	/** One line of the run log. */
	log: (line: string) => void;
	/** The pid of the command now running, so a quit can end its process group. */
	onStart?: (pid: number) => void;
};

/**
 * Upkeep installs Update Manager's packages, Flatpak refs, Snaps and Cinnamon spices. Never a kernel or a driver,
 * and never a row from apt, dnf, pacman or zypper without Update Manager: those stay with the system's own tool,
 * since only mintupdate-cli brings Mint's dist-upgrade, blacklist and kernel grouping rules along.
 */
export function installable(row: SystemRow, packages: SystemState["packages"]): boolean {
	if (row.note === "update-manager-only" || row.type === "kernel" || row.type === "driver") return false;
	if (row.source === "apt") return packages === "mint";
	return row.source === "flatpak" || row.source === "snap" || row.source === "cinnamon";
}

/**
 * -i for mintupdate-cli: the kernel and driver globs, then every apt row this run does not install, by its source
 * name. A ticked kernel or driver row is not installed, so it is named here as well as matched by the globs.
 */
export function aptIgnore(rows: SystemRow[], installing: Set<string>): string {
	const unticked = rows.filter((r) => r.source === "apt" && !installing.has(r.id)).map((r) => r.name);
	return [...KERNEL_AND_DRIVER_IGNORE, ...unticked].join(",");
}

/**
 * The root install. --keep-configuration always: without it -y means dpkg's --force-confnew, which writes the
 * package's config over a file the person edited.
 */
export const aptArgv = (ignore: string) => [
	"sudo",
	"-n",
	"mintupdate-cli",
	"upgrade",
	"-y",
	"--keep-configuration",
	"-i",
	ignore,
];

/** The same upgrade as a dry run (apt-get --simulate), with no root: it prints what would be installed and changes nothing. */
export const trialArgv = (ignore: string) => [
	"mintupdate-cli",
	"upgrade",
	"-d",
	"-y",
	"--keep-configuration",
	"-i",
	ignore,
];

/**
 * The commands for the ticked rows, in the order they run: apt first, since a new NVIDIA userspace from apt would need
 * its runtime from Flatpak, then Flatpak, Snap and Cinnamon. Rows Upkeep does not install are dropped, ticked or not.
 * Cinnamon's updater updates a whole spice type at once, so a ticked spice brings every spice of its type along.
 */
export function planSteps(rows: SystemRow[], ids: string[], packages: SystemState["packages"]): Step[] {
	const ticked = new Set(ids);
	// mintupdate-cli adds Update Manager's own priority updates before it reads -i, so with any apt row ticked they
	// install whatever was ticked: they are counted in, so the plan says what will really run.
	if (rows.some((r) => ticked.has(r.id) && r.source === "apt" && installable(r, packages)))
		for (const r of rows) if (r.source === "apt" && PRIORITY_SOURCES.has(r.name)) ticked.add(r.id);
	const picked = rows.filter((r) => ticked.has(r.id) && installable(r, packages));
	const of = (source: SystemRow["source"]) => picked.filter((r) => r.source === source);
	const steps: Step[] = [];
	const apt = of("apt");
	if (apt.length > 0)
		steps.push({
			kind: "apt",
			argv: aptArgv(aptIgnore(rows, new Set(apt.map((r) => r.id)))),
			ids: apt.map((r) => r.id),
			timeoutMs: 3_600_000,
		});
	const flatpak = of("flatpak");
	if (flatpak.length > 0)
		steps.push({
			kind: "flatpak",
			argv: ["flatpak", "update", "-y", "--noninteractive", ...flatpak.map((r) => r.id.slice("flatpak:".length))],
			ids: flatpak.map((r) => r.id),
			timeoutMs: 1_800_000,
		});
	const snap = of("snap");
	if (snap.length > 0)
		steps.push({
			kind: "snap",
			argv: ["sudo", "-n", "snap", "refresh", ...snap.map((r) => r.id.slice("snap:".length))],
			ids: snap.map((r) => r.id),
			timeoutMs: 1_800_000,
		});
	for (const type of new Set(of("cinnamon").map((r) => r.type)))
		steps.push({
			kind: "cinnamon",
			argv: ["cinnamon-spice-updater", "--update", type],
			ids: of("cinnamon")
				.filter((r) => r.type === type)
				.map((r) => r.id),
			timeoutMs: 600_000,
		});
	return steps;
}

/** Update Manager's own updates, which mintupdate-cli installs before it applies -i (mintupdate-cli.py, checkAPT.py). */
const PRIORITY_SOURCES = new Set(["mintupdate", "mint-upgrade-info"]);

/** The first non-empty line a command wrote, stderr first; its exit code when it wrote nothing. */
function firstLine(r: ProcessResult): string {
	const text = `${r.stderr}\n${r.stdout}`.split("\n").find((l) => l.trim() !== "");
	return text?.trim() ?? String(r.code);
}

/** Packages apt-get --simulate would install or remove: its "Inst <pkg>" and "Remv <pkg>" lines. */
export function trialPackages(stdout: string): string[] {
	return stdout
		.split("\n")
		.map((l) => /^(?:Inst|Remv) (\S+)/.exec(l)?.[1])
		.filter((p): p is string => p !== undefined);
}

/** A ticked Flatpak row's polkit actions: updating an app and updating a runtime are separate permissions. */
function polkitActions(rows: SystemRow[], step: Step): string[] {
	const types = new Set(rows.filter((r) => step.ids.includes(r.id)).map((r) => r.type));
	const actions: string[] = [];
	if (types.has("app")) actions.push("org.freedesktop.Flatpak.app-update");
	if (types.has("runtime")) actions.push("org.freedesktop.Flatpak.runtime-update");
	return actions;
}

/**
 * Everything checked before a step runs, read-only, in order: sudo without a password when a step needs root, nobody
 * on dpkg's lock, polkit letting Flatpak update without a dialog, Update Manager's list unchanged since the rows were
 * read, and a dry run that names no kernel or NVIDIA package. The dry run matters because mintupdate-cli throws away
 * apt's exit code, so the -i globs are the only other guard. Returns the refusal, or null when all pass.
 */
export async function preflight(steps: Step[], rows: SystemRow[], ctx: InstallCtx): Promise<string | null> {
	const opts = { timeoutMs: 60_000 };
	if (steps.some((s) => s.argv[0] === "sudo") && bad(await ctx.run(SUDO_CHECK, opts))) return MESSAGES.systemSudo();
	const apt = steps.find((s) => s.kind === "apt");
	if (apt) {
		const lock = await ctx.run(DPKG_LOCK_CHECK, opts);
		// A sudoers rule can allow true and not fuser: that is sudo asking, not the package system being busy.
		if (/password is required/i.test(lock.stderr)) return MESSAGES.systemSudo();
		if (lock.code !== 1 || lock.timedOut || lock.stderr.trim() !== "") return MESSAGES.systemAptBusy();
	}
	const flatpak = steps.find((s) => s.kind === "flatpak");
	for (const action of flatpak ? polkitActions(rows, flatpak) : []) {
		// pkcheck without --allow-user-interaction never shows a dialog; it only answers.
		// oxlint-disable-next-line no-await-in-loop -- the first refusal ends the checks
		const r = await ctx.run(["pkcheck", "--action-id", action, "--process", String(ctx.pid)], opts);
		if (bad(r)) return MESSAGES.systemPolkit();
	}
	if (!apt) return null;
	const list = await ctx.run(MINT_LIST, opts);
	if (bad(list)) return MESSAGES.systemTrialFailed(firstLine(list));
	const fresh = new Set(parseMintList(list.stdout).map((u) => u.source));
	const shown = new Set(rows.filter((r) => r.source === "apt").map((r) => r.name));
	if (fresh.size !== shown.size || [...fresh].some((s) => !shown.has(s))) return MESSAGES.systemListChanged();
	const ignore = apt.argv.at(-1) ?? "";
	const trial = await ctx.run(trialArgv(ignore), { timeoutMs: 600_000 });
	if (bad(trial)) return MESSAGES.systemTrialFailed(firstLine(trial));
	// mintupdate-cli exits 0 even when apt-get failed: an E: line, or no Inst line at all, means nothing was checked.
	const error = `${trial.stderr}\n${trial.stdout}`.split("\n").find((l) => l.startsWith("E:"));
	if (error) return MESSAGES.systemTrialFailed(error);
	if (!/^Inst /m.test(trial.stdout)) return MESSAGES.systemTrialFailed(firstLine(trial));
	const named = trialPackages(trial.stdout).filter((p) => RESTART_PACKAGE.test(p));
	if (named.length > 0) return MESSAGES.systemTrialNamesRestart(named.join(", "));
	// An update that makes apt remove a package is Update Manager's to confirm, not a ticked row's.
	const removed = [...trial.stdout.matchAll(/^Remv (\S+)/gm)].map((m) => m[1] ?? "");
	if (removed.length > 0) return MESSAGES.systemTrialRemoves(removed.join(", "));
	return null;
}

/**
 * Runs each step in turn, each as its own process group so a timeout ends whatever it started, and streams its
 * output to the log. A failed step does not stop the next: each row is judged by the list afterwards. Returns the
 * failure sentence for each row whose step failed.
 */
export async function runSteps(
	steps: Step[],
	ctx: InstallCtx,
	onStep: (step: Step) => void,
): Promise<Map<string, string>> {
	const failed = new Map<string, string>();
	for (const step of steps) {
		onStep(step);
		const command = step.argv.join(" ");
		ctx.log(`Running ${command}`);
		// oxlint-disable-next-line no-await-in-loop -- apt before Flatpak is the point, and two package tools never run at once
		const r = await ctx.run(step.argv, {
			timeoutMs: step.timeoutMs,
			group: true,
			onLine: ctx.log,
			onStart: ctx.onStart,
		});
		const why = r.timedOut
			? MESSAGES.systemTimedOut(command)
			: r.code !== 0
				? MESSAGES.commandExited(command, r.code)
				: null;
		ctx.log(why ?? `${step.argv[0] === "sudo" ? step.argv[2] : step.argv[0]} finished`);
		if (why) for (const id of step.ids) failed.set(id, why);
	}
	return failed;
}

/**
 * Each ticked row's result, judged against the list read again afterwards: gone from it is done, still in it is
 * failed. A row whose step failed keeps that step's sentence. When its source's list could not be read again, a row
 * missing from it is not known to be done, so it is failed with the read's problem rather than counted. snap's list
 * reports no problem when it fails, so a Snap row is judged by its own refresh's exit code and the list alone.
 */
export function outcomesAfter(picked: SystemRow[], failed: Map<string, string>, after: SystemCheck): SystemOutcome[] {
	const still = new Set(after.rows.map((r) => r.id));
	const unread = after.problem?.code === "failed" ? after.problem : null;
	return picked.map((row) => {
		const base = { id: row.id, name: row.name, from: row.installed, to: row.latest };
		const why = failed.get(row.id);
		if (why) return { ...base, status: "failed", detail: why };
		if (still.has(row.id)) return { ...base, status: "failed", detail: MESSAGES.systemStillPending() };
		if (unread && unread.command.startsWith(LIST_TOOL[row.source]))
			return { ...base, status: "failed", detail: MESSAGES.systemNotRechecked(unread.detail) };
		return row.running ? { ...base, status: "done", detail: MESSAGES.systemRestartApp() } : { ...base, status: "done" };
	});
}
