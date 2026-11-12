import type { LanguageCode } from "../shared/languages";
import type { Snapshot, SystemState } from "../shared/types";
import { count, TRAY_TEXT } from "./tray-text";

export type TrayAction = "open" | "check" | "install" | "quit";
export type TrayItem = { type: "normal"; label: string; action: TrayAction } | { type: "divider" };

/** Names of the apps an Install press would update right now, in list order. */
export function readyNames(snapshot: Snapshot): string[] {
	return snapshot.apps.filter((app) => app.status === "ready").map((app) => app.name);
}

/** The tray menu, top to bottom, in the language shown. Install appears only when something is ready. */
export function trayMenu(snapshot: Snapshot, system?: SystemState, code: LanguageCode = "en"): TrayItem[] {
	const t = TRAY_TEXT[code];
	const ready = readyNames(snapshot).length;
	const installing = snapshot.run.phase === "installing";
	// During a check the engine would refuse an install, and the ready count is in flux.
	const busy = installing || snapshot.run.phase === "checking";
	const items: TrayItem[] = [
		{ type: "normal", label: t.open, action: "open" },
		{ type: "normal", label: t.check, action: "check" },
	];
	if (ready > 0 && !busy) items.push({ type: "normal", label: count(ready, t.installReady, code), action: "install" });
	// System updates are listed, never counted in the icon: they arrive almost daily and would drown the app count.
	if (system && system.mode === "show" && system.rows.length > 0)
		items.push({ type: "normal", label: `${t.systemUpdates}: ${system.rows.length}`, action: "open" });
	items.push({ type: "divider" });
	items.push({ type: "normal", label: installing ? t.quitAfterRun : t.quit, action: "quit" });
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

/** The text a screen reader gets for the tray icon, in the language shown. */
export function trayTitle(snapshot: Snapshot, code: LanguageCode = "en"): string {
	const ready = readyNames(snapshot).length;
	if (ready === 0) return "Upkeep";
	return count(ready, TRAY_TEXT[code].titleReady, code);
}

/** "a, b, c, d and 3 more". Four names is what fits a notification's second line. */
export function nameList(names: string[], code: LanguageCode = "en"): string {
	if (names.length <= 4) return names.join(", ");
	return `${names.slice(0, 4).join(", ")} ${count(names.length - 4, TRAY_TEXT[code].more, code)}`;
}

/** The notification text for a ready set; the count takes the language's plural form ("1 update", "3 updates"). */
export function readyNotice(names: string[], code: LanguageCode = "en"): string {
	const t = TRAY_TEXT[code];
	const head = [count(names.length, t.readyCount, code), t.ready].filter(Boolean).join(" ");
	return `${head}: ${nameList(names, code)}`;
}

/** The notification text after an install, naming at most four apps. */
export function updatedNotice(names: string[], code: LanguageCode = "en"): string {
	return `${TRAY_TEXT[code].updated} ${nameList(names, code)}`;
}

/** The notification text for one failed app; it points at the log, which holds the cause. */
export function failedNotice(name: string, code: LanguageCode = "en"): string {
	return TRAY_TEXT[code].failed.replace("{name}", name);
}

/** Identifies a ready set, so the same set is announced once and not after every check. */
export function readyFingerprint(snapshot: Snapshot): string {
	return snapshot.apps
		.filter((app) => app.status === "ready")
		.map((app) => `${app.key}@${app.latest ?? ""}`)
		.toSorted()
		.join(",");
}
