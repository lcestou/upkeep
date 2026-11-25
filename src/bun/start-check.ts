import { type Engine, REASON_NOTHING } from "../engine/engine";

/** The waits between checks while a start at login finds no network: a slow Wi-Fi first, then a longer gap. */
const OFFLINE_RETRY_MS = [30_000, 120_000, 300_000];

/**
 * The check a start at login runs. While the network is not up yet it checks again after each wait, keeping the rows
 * as the last check left them; only the last try may show a network failure on a row. Returns once a check got
 * through or the waits ran out.
 */
export async function checkAtStart(
	engine: Pick<Engine, "check" | "offline">,
	wait: (ms: number) => Promise<void> = Bun.sleep,
	delays: number[] = OFFLINE_RETRY_MS,
): Promise<void> {
	await engine.check(undefined, { quietOffline: delays.length > 0 });
	for (const [i, ms] of delays.entries()) {
		if (!engine.offline()) return;
		// oxlint-disable-next-line no-await-in-loop -- each try waits for the one before it
		await wait(ms);
		// oxlint-disable-next-line no-await-in-loop -- each try waits for the one before it
		await engine.check(undefined, { quietOffline: i < delays.length - 1 });
	}
}

/**
 * A scheduled check while the automatic apps wait for an unmetered connection or mains power: checks, then asks the
 * engine to install them again, which holds them again or starts. Returns what they still wait for, undefined once
 * they no longer wait (installed, or none left ready). A check that found no network, or an install refused because
 * the engine was busy, leaves the wait as it was.
 */
export async function checkAndRetry(
	engine: Pick<Engine, "check" | "offline" | "installAuto">,
	held: "metered" | "battery" | undefined,
): Promise<"metered" | "battery" | undefined> {
	await engine.check();
	if (!held || engine.offline()) return held;
	const r = await engine.installAuto();
	if (r.wait) return r.wait;
	// A busy or checking refusal decided nothing: the apps still wait. Only a start, or none left ready, ends it.
	return r.started || r.reason === REASON_NOTHING ? undefined : held;
}
