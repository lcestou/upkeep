import type { Run, Started } from "./run";

// The system tools this file drives, named here and nowhere else: logind's systemd-inhibit for the sleep lock,
// coreutils' tail to end that lock with Upkeep, and busctl to ask NetworkManager and UPower over the system bus.

/**
 * Holds sleep and shutdown off while pid lives. tail --pid ends on its own when pid goes, so a crash of Upkeep never
 * leaves the lock behind; systemd-inhibit ends its child when it is stopped itself.
 */
export const inhibitArgv = (pid: number, why: string) => [
	"systemd-inhibit",
	"--what=sleep:shutdown",
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

/**
 * Starts the sleep lock and returns its release. Null when the machine has no systemd-inhibit or the runner cannot
 * start a process: the run goes on as it would without the lock. A release called twice stops the lock once.
 */
export async function holdSleep(run: Run, pid: number, why: string): Promise<(() => Promise<void>) | null> {
	if (!run.start) return null;
	const probe = await run(INHIBIT_PROBE, { timeoutMs: 5000 });
	if (probe.code !== 0) return null;
	const lock: Started = run.start(inhibitArgv(pid, why));
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

/**
 * Why automatic work waits now, or null when it may go: a metered connection is named before the battery. A runner
 * that throws counts as no answer, so a broken bus never holds updates back.
 */
export async function waitReason(run: Run): Promise<"metered" | "battery" | null> {
	try {
		if (await metered(run)) return "metered";
		if (await onBattery(run)) return "battery";
	} catch {
		// no answer is the same as no NetworkManager or UPower
	}
	return null;
}
