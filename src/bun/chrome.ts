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
