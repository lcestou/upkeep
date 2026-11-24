import type { Engine } from "../engine/engine";
import { waitReason } from "../engine/power";
import type { Run } from "../engine/run";

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
 * Installs the apps marked automatic after a start at login, unless the person asked automatic updates to wait for
 * an unmetered connection and mains power and either is missing now. Returns why it waited, or null when it did not.
 */
export async function autoInstall(
	engine: Pick<Engine, "readyKeys" | "install" | "snapshot">,
	power: Run | undefined,
): Promise<"metered" | "battery" | null> {
	const auto = engine.readyKeys(true);
	if (auto.length === 0) return null;
	const wait = power && engine.snapshot().settings.waitUnmetered ? await waitReason(power) : null;
	if (!wait) await engine.install(auto);
	return wait;
}
