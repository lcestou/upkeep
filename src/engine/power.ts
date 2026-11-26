import type { Run, Started } from "./run";

// The system tools this file drives, named here and nowhere else: logind's systemd-inhibit for the sleep lock,
// coreutils' tail to end that lock with Upkeep, and busctl to ask NetworkManager and UPower over the system bus, and
// logind whether it may suspend or power off, and to do so when a finished run asks for it.

/**
 * Holds sleep off while pid lives. Shutdown is left alone: a person who shuts down mid-install chose to, and a
 * restore point covers them, while a blocked shutdown asks a standard user for an admin password. Closing the lid
 * still suspends under logind's default LidSwitchIgnoreInhibited=yes. tail --pid ends on its own when pid goes, so a crash of Upkeep never
 * leaves the lock behind; systemd-inhibit ends its child when it is stopped itself.
 */
export const inhibitArgv = (pid: number, why: string) => [
	"systemd-inhibit",
	"--what=sleep",
	"--mode=block",
	"--who=Upkeep",
	`--why=${why}`,
	"tail",
	`--pid=${pid}`,
	"-f",
	"/dev/null",
];
export const INHIBIT_PROBE = ["systemd-inhibit", "--version"];
// NetworkManager's metered state of the connection it routes through: 1 yes, 3 guess-yes; 0, 2 and 4 are not metered.
export const NM_METERED = [
	"busctl",
	"get-property",
	"org.freedesktop.NetworkManager",
	"/org/freedesktop/NetworkManager",
	"org.freedesktop.NetworkManager",
	"Metered",
];
export const UPOWER_ON_BATTERY = [
	"busctl",
	"get-property",
	"org.freedesktop.UPower",
	"/org/freedesktop/UPower",
	"org.freedesktop.UPower",
	"OnBattery",
];

/** The run log's lines about the lock, kept here so the tool's name stays in this file. */
export const LOCK_LINES = {
	held: "Asked logind to hold sleep until the run ends",
	missing: "No systemd-inhibit here: sleep is not held during installs",
	failed: (why: string) => `The sleep lock could not start (${why}): sleep is not held during this run`,
};

/** Whether this machine can take the sleep lock: the runner can start a process and systemd-inhibit answers. */
export async function canHoldSleep(run: Run): Promise<boolean> {
	if (!run.start) return false;
	return (await run(INHIBIT_PROBE, { timeoutMs: 5000 })).code === 0;
}

/**
 * Starts the sleep lock and returns its release; null when the runner cannot start a process. Throws when the process
 * could not start at all, or ended within confirmMs: logind refusing the inhibit (no session, a policy) makes
 * systemd-inhibit exit at once, and such a lock holds nothing. A release called twice stops the lock once.
 */
export async function holdSleep(
	run: Run,
	pid: number,
	why: string,
	confirmMs = 300,
): Promise<(() => Promise<void>) | null> {
	if (!run.start) return null;
	const lock: Started = run.start(inhibitArgv(pid, why));
	// A lock that never ran holds nothing; the caller says so instead of saying it is held.
	if (lock.failed) throw new Error("its process did not start");
	await Bun.sleep(confirmMs);
	if (lock.alive && !lock.alive()) {
		await lock.stop();
		throw new Error("it ended at once");
	}
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		await lock.stop();
	};
}

/** True only for NetworkManager's "yes" (1) and "guess-yes" (3). No NetworkManager, or any other answer, is unmetered. */
export async function metered(run: Run): Promise<boolean> {
	const r = await run(NM_METERED, { timeoutMs: 5000 });
	return r.code === 0 && /^u\s+[13]\s*$/.test(r.stdout.trim());
}

/** True only when UPower says the machine runs on its battery. No UPower (a desktop, a VM) reads as mains power. */
export async function onBattery(run: Run): Promise<boolean> {
	const r = await run(UPOWER_ON_BATTERY, { timeoutMs: 5000 });
	return r.code === 0 && r.stdout.trim() === "b true";
}

/** What a finished run may do to the machine: suspend it or power it off, both through logind. */
export type PowerAction = "suspend" | "poweroff";
/** How long a suspend or power-off after a run waits for a Cancel or a Ctrl-C. */
export const COUNTDOWN_MS = 60_000;

// logind on the system bus, over the same busctl: whether this seat may suspend or power off, and the calls themselves.
const LOGIND = ["org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager"];
const LOGIND_METHOD = { suspend: "Suspend", poweroff: "PowerOff" } as const;
/** How long logind may take to answer the call; a password prompt from polkit waits within it. */
const LOGIND_CALL_S = 120;

/** logind's CanSuspend or CanPowerOff, which answers `s "yes"`, `s "challenge"` (a password first), `s "no"` or `s "na"`. */
export const logindCanArgv = (action: PowerAction) => ["busctl", "call", ...LOGIND, `Can${LOGIND_METHOD[action]}`];

/**
 * logind's Suspend or PowerOff with interactive=true, so polkit may ask for a password instead of refusing. The
 * call returns once logind has taken it; the machine goes down after.
 */
export const logindActArgv = (action: PowerAction) => [
	"busctl",
	"--allow-interactive-authorization=yes",
	`--timeout=${LOGIND_CALL_S}`,
	"call",
	...LOGIND,
	LOGIND_METHOD[action],
	"b",
	"true",
];

/** True when logind answers "yes" or "challenge". No logind, a container or any other answer is false. */
export async function canPower(run: Run, action: PowerAction): Promise<boolean> {
	const r = await run(logindCanArgv(action), { timeoutMs: 5000 }).catch(() => null);
	return r !== null && r.code === 0 && /^s\s+"(yes|challenge)"$/.test(r.stdout.trim());
}

/** Asks logind to suspend or power off. Null when it took the call, else what busctl said, or its exit code. */
export async function powerNow(run: Run, action: PowerAction): Promise<string | null> {
	const r = await run(logindActArgv(action), { timeoutMs: (LOGIND_CALL_S + 5) * 1000 }).catch(() => null);
	if (r === null) return "busctl could not start";
	if (r.code === 0) return null;
	return `${r.stdout}\n${r.stderr}`.trim() || `busctl exited ${r.code}`;
}

/** The apps of a finished run as power-after-run reads them: each one's key, and its result once it has one. */
type RunEnd = { results: { key: string; result: string }[]; queue?: string[] };

/**
 * Why a finished run must not suspend or power off the machine, or null when it may. Every app in the run must have
 * updated: one stopped by Stop now, or left unstarted by Stop after this one, is "stopped"; a failed or rolled-back one
 * is "failed"; a failed System step is "system". A run with no results never counts as done.
 */
export function powerBlocker(run: RunEnd, systemFailed: boolean): "failed" | "stopped" | "system" | null {
	if (run.results.some((r) => r.result === "failed" || r.result === "rolled_back")) return "failed";
	const done = new Set(run.results.filter((r) => r.result === "updated").map((r) => r.key));
	const keys = run.queue ?? run.results.map((r) => r.key);
	if (run.results.length === 0 || keys.some((k) => !done.has(k)) || run.results.some((r) => !done.has(r.key)))
		return "stopped";
	return systemFailed ? "system" : null;
}

/**
 * Why automatic work waits now, or null when it may go: a metered connection is named before the battery. A query
 * that throws counts as no answer for that source only, so a broken bus never holds updates back.
 */
export async function waitReason(run: Run): Promise<"metered" | "battery" | null> {
	// Each source on its own: a NetworkManager that throws must not skip the battery question.
	if (await metered(run).catch(() => false)) return "metered";
	if (await onBattery(run).catch(() => false)) return "battery";
	return null;
}
