import type { Settings, WindowButton, WindowChrome } from "../shared/types";

const KNOWN: WindowButton[] = ["close", "minimize", "maximize"];

export type SystemLayout = { side: "left" | "right"; order: WindowButton[] };

const DEFAULT_LAYOUT: SystemLayout = { side: "right", order: ["minimize", "maximize", "close"] };

/** Keeps only the button names the app knows, in the order given; anything else (such as `appmenu`) is dropped. */
function pick(part: string): WindowButton[] {
	return part
		.split(",")
		.map((p) => p.trim())
		.filter((p): p is WindowButton => KNOWN.some((k) => k === p));
}

/**
 * Reads a desktop button-layout value such as `close,maximize,minimize:` or `:minimize,maximize,close`.
 * The side that holds the close button is the side the owner reaches for, so that side wins.
 */
export function parseButtonLayout(raw: string): SystemLayout {
	const text = raw.trim().replace(/^'|'$/g, "");
	if (!text.includes(":")) return DEFAULT_LAYOUT;
	const [left = "", right = ""] = text.split(":");
	const l = pick(left);
	const r = pick(right);
	if (l.includes("close")) return { side: "left", order: l };
	if (r.includes("close")) return { side: "right", order: r };
	if (l.length > 0) return { side: "left", order: l };
	if (r.length > 0) return { side: "right", order: r };
	return DEFAULT_LAYOUT;
}

// KWin's title-bar letters for the buttons Upkeep draws; the others (menu, on all desktops, help, keep above...) drop.
const KDE_BUTTONS = new Map<string, WindowButton>([
	["I", "minimize"],
	["A", "maximize"],
	["X", "close"],
]);

/** The button names for a run of KWin's letters, in their order, joined as gsettings joins them. */
const kdeNames = (letters: string) =>
	[...letters]
		.map((c) => KDE_BUTTONS.get(c))
		.filter((b) => b !== undefined)
		.join(",");

/**
 * KWin's ButtonsOnLeft and ButtonsOnRight (kwinrc, group org.kde.kdecoration2) as the "left:right" layout
 * parseButtonLayout reads. Unset, each is KWin's own default: "MS" on the left, "HIAX" on the right.
 */
export function kdeButtonLayout(left: string | null, right: string | null): string {
	return `${kdeNames(left ?? "MS")}:${kdeNames(right ?? "HIAX")}`;
}

/** The same buttons mirrored for the other side: close stays nearest the window's edge. */
function mirrored(order: WindowButton[]): WindowButton[] {
	return order.toReversed();
}

/** Resolves the settings against the desktop's layout. `own` is false for the system frame, so the view draws no buttons of its own then. */
export function windowChrome(settings: Settings, system: SystemLayout, maximized: boolean): WindowChrome {
	const side = settings.buttons === "auto" ? system.side : settings.buttons;
	const order = side === system.side ? system.order : mirrored(system.order);
	const own = settings.frame === "own";
	return { own, side, order, maximized, rounded: own && settings.corners === "rounded" };
}
