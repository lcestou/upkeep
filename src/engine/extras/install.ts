import { MESSAGES } from "../../shared/messages";
import type { SystemOutcome, SystemRow, SystemState } from "../../shared/types";
import { onBattery } from "../power";
import type { ProcessResult, Run } from "../run";
import { fwupdArgv } from "./firmware";
import {
	APT_LIST,
	DNF_LIST,
	MINT_LIST,
	parseAptList,
	parseDnfList,
	parseMintList,
	parseZypperList,
	type SystemCheck,
	ZYPPER_LIST,
} from "./system";

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
	firmware: "fwupdmgr",
} satisfies Record<SystemRow["source"], string>;

/** A binary package a trial run may not touch: a kernel's image, headers, modules or meta package, or anything NVIDIA. */
const RESTART_PACKAGE = /^(linux-(image|headers|modules|signed|meta|hwe|generic|lowlatency|oem)|.*nvidia)/;
/** The same for an rpm system: every kernel* package (kernel-tools too, to be safe) and anything NVIDIA. */
const RPM_RESTART_PACKAGE = /^(kernel|.*nvidia)/;
/** dnf's own guard, on every dnf upgrade and its trial: neither can pull a kernel or NVIDIA package in as a dependency. */
const DNF_EXCLUDES = ["--exclude=kernel*", "--exclude=*nvidia*"];

/** One command of a System install and the rows it answers for. */
export type Step = {
	/** apt is Update Manager's mintupdate-cli; apt-get is plain apt where there is no Update Manager. */
	kind: "apt" | "apt-get" | "dnf" | "zypper" | "flatpak" | "snap" | "cinnamon" | "firmware";
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
 * Upkeep installs Update Manager's packages, plain apt's (Ubuntu, Debian), dnf's (Fedora), zypper's (openSUSE),
 * Flatpak refs, Snaps, Cinnamon spices and fwupd's firmware. Never a kernel or a driver, by type or by package name. pacman rows stay
 * with pacman: Arch supports no partial upgrade, and a whole -Syu would bring the kernel and driver along.
 */
export function installable(row: SystemRow, packages: SystemState["packages"]): boolean {
	if (row.note === "update-manager-only" || row.type === "kernel" || row.type === "driver") return false;
	if (row.source === "apt") return packages === "mint" || (packages === "apt" && !RESTART_PACKAGE.test(row.name));
	if (row.source === "dnf" || row.source === "zypper")
		return packages === row.source && !RPM_RESTART_PACKAGE.test(row.name);
	return row.source === "flatpak" || row.source === "snap" || row.source === "cinnamon" || row.source === "firmware";
}

/** apt-get's name for a plain apt row: the package, with the arch its id carries unless it is "all" (libc6:i386). */
function aptSpec(row: SystemRow): string {
	const arch = row.id.slice(row.id.lastIndexOf(".") + 1);
	return arch && arch !== "all" && row.id.includes(".") ? `${row.name}:${arch}` : row.name;
}

/**
 * Plain apt's root install of exactly the ticked packages: --only-upgrade never installs one that is not there, and
 * confold keeps a config file the person edited, as --keep-configuration does for mintupdate-cli.
 */
export const aptGetArgv = (specs: string[]) => [
	"sudo",
	"-n",
	"env",
	"DEBIAN_FRONTEND=noninteractive",
	"apt-get",
	"install",
	"--only-upgrade",
	"-y",
	"-o",
	"Dpkg::Options::=--force-confdef",
	"-o",
	"Dpkg::Options::=--force-confold",
	...specs,
];

/** The same install as apt-get's simulation, which needs no root and changes nothing. */
export const aptGetTrialArgv = (specs: string[]) => ["apt-get", "install", "--only-upgrade", "--simulate", ...specs];

/** dnf's root upgrade of exactly the ticked packages (name.arch), never a kernel or NVIDIA package. */
export const dnfArgv = (specs: string[]) => ["sudo", "-n", "dnf", "upgrade", "-y", ...DNF_EXCLUDES, ...specs];

/**
 * The same upgrade, answered no: dnf resolves and prints the transaction, then exits 1 having changed nothing. In the C
 * locale, since its headings are read; sudo keeps the person's LANG and LC_* and dnf would print them translated.
 */
export const dnfTrialArgv = (specs: string[]) => [
	"sudo",
	"-n",
	"env",
	"LC_ALL=C",
	"dnf",
	"upgrade",
	"--assumeno",
	...DNF_EXCLUDES,
	...specs,
];

/**
 * zypper's root update of exactly the ticked packages, as name.arch so another arch of the same package is not
 * updated with it, without the recommends a plain update would add.
 */
export const zypperArgv = (names: string[]) => [
	"sudo",
	"-n",
	"zypper",
	"--non-interactive",
	"update",
	"--no-recommends",
	...names,
];

/** The same update as zypper's dry run, which prints the transaction and installs nothing; in the C locale, as dnf's. */
export const zypperTrialArgv = (names: string[]) => [
	"sudo",
	"-n",
	"env",
	"LC_ALL=C",
	...zypperArgv([]).slice(2),
	"--dry-run",
	...names,
];

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
 * The commands for the ticked rows, in the order they run: the package tool first (apt, dnf or zypper; a system has
 * one), since a new NVIDIA userspace from it would need its runtime from Flatpak, then Flatpak, Snap and Cinnamon, and
 * firmware last, one device per step, as fwupdmgr update takes one. Rows Upkeep does not install are dropped, ticked
 * or not. Cinnamon's updater updates a whole spice type at once, so a ticked spice brings every spice of its type along.
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
	if (apt.length > 0 && packages === "apt")
		steps.push({
			kind: "apt-get",
			argv: aptGetArgv(apt.map(aptSpec)),
			ids: apt.map((r) => r.id),
			timeoutMs: 3_600_000,
		});
	else if (apt.length > 0)
		steps.push({
			kind: "apt",
			argv: aptArgv(aptIgnore(rows, new Set(apt.map((r) => r.id)))),
			ids: apt.map((r) => r.id),
			timeoutMs: 3_600_000,
		});
	const dnf = of("dnf");
	if (dnf.length > 0)
		steps.push({
			kind: "dnf",
			argv: dnfArgv(dnf.map((r) => r.id.slice("dnf:".length))),
			ids: dnf.map((r) => r.id),
			timeoutMs: 3_600_000,
		});
	const zypper = of("zypper");
	if (zypper.length > 0)
		steps.push({
			kind: "zypper",
			argv: zypperArgv(zypper.map((r) => r.id.slice("zypper:".length))),
			ids: zypper.map((r) => r.id),
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
	for (const r of of("firmware"))
		steps.push({
			kind: "firmware",
			argv: fwupdArgv(r.id.slice("firmware:".length)),
			ids: [r.id],
			timeoutMs: 1_800_000,
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
 * Everything checked before a step runs, read-only, in order: mains power when firmware is flashed (UPower's
 * OnBattery; no UPower reads as mains), sudo without a password when a step needs root, nobody
 * on dpkg's lock, polkit letting Flatpak update without a dialog, Update Manager's list unchanged since the rows were
 * read, and a dry run that names no kernel or NVIDIA package. The dry run matters because mintupdate-cli throws away
 * apt's exit code, so the -i globs are the only other guard. Returns the refusal, or null when all pass.
 */
export async function preflight(steps: Step[], rows: SystemRow[], ctx: InstallCtx): Promise<string | null> {
	const opts = { timeoutMs: 60_000 };
	// A flash that loses power halfway can leave a device that does not start; fwupd checks some devices itself, not all.
	if (steps.some((s) => s.kind === "firmware") && (await onBattery(ctx.run).catch(() => false)))
		return MESSAGES.firmwareBattery();
	if (steps.some((s) => s.argv[0] === "sudo") && bad(await ctx.run(SUDO_CHECK, opts))) return MESSAGES.systemSudo();
	const apt = steps.find((s) => s.kind === "apt");
	const aptGet = steps.find((s) => s.kind === "apt-get");
	if (apt || aptGet) {
		const lock = await ctx.run(DPKG_LOCK_CHECK, opts);
		// A sudoers rule can allow true and not fuser: that is sudo asking, not the package system being busy.
		if (/password is required/i.test(lock.stderr)) return MESSAGES.systemSudo();
		// No fuser (psmisc is left out of minimal installs) on plain apt: nothing to ask, and apt-get refuses a held
		// lock itself, with an exit code, before it changes anything. mintupdate-cli throws that code away, so Mint
		// still needs the answer.
		const noFuser = !apt && /fuser: (command )?not found/i.test(lock.stderr);
		if (!noFuser && (lock.code !== 1 || lock.timedOut || lock.stderr.trim() !== "")) return MESSAGES.systemAptBusy();
	}
	const flatpak = steps.find((s) => s.kind === "flatpak");
	for (const action of flatpak ? polkitActions(rows, flatpak) : []) {
		// pkcheck without --allow-user-interaction never shows a dialog; it only answers.
		// oxlint-disable-next-line no-await-in-loop -- the first refusal ends the checks
		const r = await ctx.run(["pkcheck", "--action-id", action, "--process", String(ctx.pid)], opts);
		if (bad(r)) return MESSAGES.systemPolkit();
	}
	const rpm = steps.find((s) => s.kind === "dnf" || s.kind === "zypper");
	if (rpm) return rpmPreflight(rpm, rows, ctx);
	if (aptGet) return aptGetPreflight(aptGet, rows, ctx);
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
 * Plain apt's half of the preflight, after sudo and the lock: the list read again names the same packages, and
 * apt-get's simulation of the install fails on nothing, names no kernel or NVIDIA package and removes nothing.
 */
async function aptGetPreflight(step: Step, rows: SystemRow[], ctx: InstallCtx): Promise<string | null> {
	const list = await ctx.run(APT_LIST, { timeoutMs: 60_000 });
	if (bad(list)) return MESSAGES.systemTrialFailed(firstLine(list));
	const fresh = new Set(parseAptList(list.stdout).map((r) => r.id));
	const shown = new Set(rows.filter((r) => r.source === "apt").map((r) => r.id));
	if (fresh.size !== shown.size || [...fresh].some((id) => !shown.has(id))) return MESSAGES.systemListChanged();
	const specs = step.argv.slice(aptGetArgv([]).length);
	const trial = await ctx.run(aptGetTrialArgv(specs), { timeoutMs: 600_000 });
	const error = `${trial.stderr}\n${trial.stdout}`.split("\n").find((l) => l.startsWith("E:"));
	if (error) return MESSAGES.systemTrialFailed(error);
	if (bad(trial)) return MESSAGES.systemTrialFailed(firstLine(trial));
	const named = trialPackages(trial.stdout).filter((p) => RESTART_PACKAGE.test(p));
	if (named.length > 0) return MESSAGES.systemTrialNamesRestart(named.join(", "));
	const removed = [...trial.stdout.matchAll(/^Remv (\S+)/gm)].map((m) => m[1] ?? "");
	if (removed.length > 0) return MESSAGES.systemTrialRemoves(removed.join(", "));
	return null;
}

/**
 * The package names under each of zypper's "The following ... going to be <what>:" headings whose heading matches
 * what, from its indented lines up to the next blank one. Reads the C locale's English, which zypperTrialArgv asks for.
 */
export function zypperNames(stdout: string, what: RegExp): string[] {
	const names: string[] = [];
	let inside = false;
	for (const l of stdout.split("\n")) {
		if (/^The following .* going to be /.test(l)) inside = what.test(l);
		else if (!l.trim()) inside = false;
		else if (inside && /^\s/.test(l)) names.push(...l.trim().split(/\s+/));
	}
	return names;
}

/**
 * The package names under dnf's transaction headings that match what ("Removing:"), up to the next heading. Reads
 * the C locale's English, which dnfTrialArgv asks for.
 */
export function dnfNames(stdout: string, what: RegExp): string[] {
	const names: string[] = [];
	let inside = false;
	for (const l of stdout.split("\n")) {
		if (/^\S.*:$/.test(l)) inside = what.test(l);
		else if (!l.trim()) inside = false;
		// A package line is one space in; dnf5's "replacing" lines under it are three.
		else if (inside && /^ \S/.test(l)) names.push(l.trim().split(/\s+/)[0] ?? "");
	}
	return names;
}

/**
 * What a dnf transaction takes away besides plain removals: a "replacing" line under a package that names another
 * package is that one obsoleted, and removed. A replacing line under an upgrade names the package's own old version.
 */
export function dnfReplaced(stdout: string): string[] {
	const gone: string[] = [];
	let parent = "";
	for (const l of stdout.split("\n")) {
		// A name too long for its column stands alone on its line, its version on the next.
		const pkg = /^ (\S+)(\s|$)/.exec(l);
		if (pkg) parent = pkg[1] ?? "";
		const replaced = /^\s+replacing\s+(\S+)/.exec(l)?.[1];
		if (replaced && replaced !== parent) gone.push(replaced);
	}
	return gone;
}

/**
 * dnf's and zypper's half of the preflight, after sudo: the list read again names the same packages, and the tool's
 * own trial of the install (dnf answered no, zypper's dry run) fails on nothing, names no kernel or NVIDIA package
 * and removes nothing.
 */
async function rpmPreflight(step: Step, rows: SystemRow[], ctx: InstallCtx): Promise<string | null> {
	const dnf = step.kind === "dnf";
	const list = await ctx.run(dnf ? DNF_LIST : ZYPPER_LIST, { timeoutMs: 60_000 });
	// dnf check-update exits 100 when there are updates; zypper 106 when a repository could not be read.
	if (list.timedOut || ![0, dnf ? 100 : 106].includes(list.code)) return MESSAGES.systemTrialFailed(firstLine(list));
	const fresh = new Set((dnf ? parseDnfList(list.stdout, new Map()) : parseZypperList(list.stdout)).map((r) => r.id));
	const shown = new Set(rows.filter((r) => r.source === step.kind).map((r) => r.id));
	if (fresh.size !== shown.size || [...fresh].some((id) => !shown.has(id))) return MESSAGES.systemListChanged();
	const specs = step.argv.slice((dnf ? dnfArgv([]) : zypperArgv([])).length);
	const trial = await ctx.run(dnf ? dnfTrialArgv(specs) : zypperTrialArgv(specs), { timeoutMs: 600_000 });
	const text = `${trial.stdout}\n${trial.stderr}`;
	const error = text.split("\n").find((l) => /^(Error|Problem)\b/.test(l));
	if (error) return MESSAGES.systemTrialFailed(error);
	// dnf answered no exits 1 after printing its transaction; anything else that is not 0 is a failure.
	if (trial.timedOut || ![0, dnf ? 1 : 0].includes(trial.code)) return MESSAGES.systemTrialFailed(firstLine(trial));
	if (dnf && !/^Upgrading:/m.test(trial.stdout)) return MESSAGES.systemTrialFailed(firstLine(trial));
	const names = (re: RegExp) => (dnf ? dnfNames(trial.stdout, re) : zypperNames(trial.stdout, re));
	const named = names(/./).filter((p) => RPM_RESTART_PACKAGE.test(p));
	if (named.length > 0) return MESSAGES.systemTrialNamesRestart(named.join(", "));
	const removed = [...names(dnf ? /^Removing/ : /REMOVED/), ...(dnf ? dnfReplaced(trial.stdout) : [])];
	if (removed.length > 0) return MESSAGES.systemTrialRemoves(removed.join(", "));
	return null;
}

/** The program a step's argv runs, past sudo, its flags and env's assignments, for the log line after it ends. */
function programOf(argv: string[]): string {
	if (argv[0] !== "sudo") return argv[0] ?? "";
	return argv.slice(1).find((a) => !a.startsWith("-") && a !== "env" && !a.includes("=")) ?? "sudo";
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
		ctx.log(why ?? `${programOf(step.argv)} finished`);
		if (why) for (const id of step.ids) failed.set(id, why);
	}
	return failed;
}

/**
 * Each ticked row's result, judged against the list read again afterwards: gone from it is done, still in it is
 * failed. A row whose step failed keeps that step's sentence. When its source's list could not be read again, a row
 * missing from it is not known to be done, so it is failed with the read's problem rather than counted. snap's list
 * reports no problem when it fails, so a Snap row is judged by its own refresh's exit code and the list alone. A
 * firmware row is judged by its step alone: a flash that waits for the restart can still be listed until then. One
 * that needs the restart says so.
 */
export function outcomesAfter(picked: SystemRow[], failed: Map<string, string>, after: SystemCheck): SystemOutcome[] {
	const still = new Set(after.rows.map((r) => r.id));
	const unread = after.problem?.code === "failed" ? after.problem : null;
	return picked.map((row) => {
		const base = { id: row.id, name: row.name, from: row.installed, to: row.latest };
		const why = failed.get(row.id);
		if (why) return { ...base, status: "failed", detail: why };
		if (row.source === "firmware")
			return row.note === "restart-needed"
				? { ...base, status: "done", detail: MESSAGES.firmwareRestart() }
				: { ...base, status: "done" };
		if (still.has(row.id)) return { ...base, status: "failed", detail: MESSAGES.systemStillPending() };
		// Plain apt's list is "apt list", not Update Manager's.
		const tool = row.source === "apt" && !unread?.command.startsWith(LIST_TOOL.apt) ? "apt " : LIST_TOOL[row.source];
		if (unread && unread.command.startsWith(tool))
			return { ...base, status: "failed", detail: MESSAGES.systemNotRechecked(unread.detail) };
		return row.running ? { ...base, status: "done", detail: MESSAGES.systemRestartApp() } : { ...base, status: "done" };
	});
}
