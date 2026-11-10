import type { Snapshot } from "../shared/types";

export type TrayAction = "open" | "check" | "install" | "quit";
export type TrayItem = { type: "normal"; label: string; action: TrayAction } | { type: "divider" };

/** Names of the apps an Install press would update right now, in list order. */
export function readyNames(snapshot: Snapshot): string[] {
	return snapshot.apps.filter((app) => app.status === "ready").map((app) => app.name);
}

/** The tray menu, top to bottom. Install appears only when something is ready. */
export function trayMenu(snapshot: Snapshot): TrayItem[] {
	const ready = readyNames(snapshot).length;
	const installing = snapshot.run.phase === "installing";
	// During a check the engine would refuse an install, and the ready count is in flux.
	const busy = installing || snapshot.run.phase === "checking";
	const items: TrayItem[] = [
		{ type: "normal", label: "Open Upkeep", action: "open" },
		{ type: "normal", label: "Check now", action: "check" },
	];
	if (ready > 0 && !busy) items.push({ type: "normal", label: `Install ${ready} ready`, action: "install" });
	items.push({ type: "divider" });
	items.push({ type: "normal", label: installing ? "Quit after this run" : "Quit", action: "quit" });
	return items;
}

/**
 * Which tray picture to show. The count is drawn into the icon because an AppIndicator title is
 * the accessible name on Linux and is not painted beside the icon.
 */
export function trayIcon(snapshot: Snapshot): string {
	if (snapshot.run.phase === "installing") return "working";
	if (snapshot.run.phase === "summary" && snapshot.run.results.some((r) => r.result !== "updated")) return "failed";
	const ready = readyNames(snapshot).length;
	if (ready === 0) return "idle";
	return ready > 9 ? "count-9plus" : `count-${ready}`;
}

/** The text a screen reader gets for the tray icon. */
export function trayTitle(snapshot: Snapshot): string {
	const ready = readyNames(snapshot).length;
	if (ready === 0) return "Upkeep";
	return ready === 1 ? "Upkeep, 1 update ready" : `Upkeep, ${ready} updates ready`;
}

/** "a, b, c, d and 3 more". Four names is what fits a notification's second line. */
export function nameList(names: string[]): string {
	if (names.length <= 4) return names.join(", ");
	return `${names.slice(0, 4).join(", ")} and ${names.length - 4} more`;
}

export function readyNotice(names: string[]): string {
	return `${names.length === 1 ? "1 update" : `${names.length} updates`} ready: ${nameList(names)}`;
}

export function updatedNotice(names: string[]): string {
	return `Updated ${nameList(names)}`;
}

export function failedNotice(name: string): string {
	return `${name} failed to update. Open Upkeep for the log.`;
}

/** Identifies a ready set, so the same set is announced once and not after every check. */
export function readyFingerprint(snapshot: Snapshot): string {
	return snapshot.apps
		.filter((app) => app.status === "ready")
		.map((app) => `${app.key}@${app.latest ?? ""}`)
		.toSorted()
		.join(",");
}
