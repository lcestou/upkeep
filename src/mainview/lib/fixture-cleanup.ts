// The fixture's half of the Cleanup tab: items shaped like the engine's measure on a real machine, and a fake
// review and delete. Nothing here touches a file or runs a command.
import type { CleanupId, CleanupItem, CleanupPick } from "../../shared/types";

const MB = 1_000_000;
const NVIDIA_OLD = "org.freedesktop.Platform.GL.nvidia-580-159-03/x86_64/1.4";
const NVIDIA_OLDER = "org.freedesktop.Platform.GL.nvidia-580-173-02/x86_64/1.4";

/** An item whose bytes are its parts' sum, unless bytes is given (null for packages). */
function item(
	id: CleanupId,
	group: CleanupItem["group"],
	parts: CleanupItem["parts"],
	rest: Partial<Omit<CleanupItem, "id" | "group" | "parts">> = {},
): CleanupItem {
	return {
		id,
		group,
		parts,
		bytes: parts.reduce((a, p) => a + p.bytes, 0),
		root: false,
		undo: "none",
		typeToConfirm: false,
		...rest,
	};
}

/** A shown-only item: a figure and maybe facts, no parts. */
const shown = (id: CleanupId, bytes: number | null, info?: CleanupItem["info"]): CleanupItem =>
	info ? { ...item(id, "shown", []), bytes, info } : { ...item(id, "shown", []), bytes };

/** What the fake measure finds, sized from a real machine. devCaches adds the uv cache. */
export function fixtureCleanupItems(devCaches: boolean): CleanupItem[] {
	const dev = devCaches
		? [
				item("uv", "choice", [{ id: "all", label: "/home/you/.cache/uv", bytes: 3958 * MB, ticked: false }], {
					undo: "redownload",
				}),
			]
		: [];
	return [
		item("thumbnails", "safe", [{ id: "all", label: "/home/you/.cache/thumbnails", bytes: 39 * MB, ticked: true }], {
			undo: "regrows",
		}),
		item("leftovers", "safe", [
			{
				id: "/home/you/.local/bin/fd.upkeep-new",
				label: "/home/you/.local/bin/fd.upkeep-new",
				bytes: 4 * MB,
				ticked: true,
			},
			{
				id: "/home/you/.local/bin/rg.upkeep-tmp",
				label: "/home/you/.local/bin/rg.upkeep-tmp",
				bytes: 6 * MB,
				ticked: false,
				note: "newer-copy",
			},
		]),
		item("apt-cache", "safe", [{ id: "all", label: "/var/cache/apt/archives", bytes: 574 * MB, ticked: true }], {
			root: true,
			undo: "redownload",
		}),
		item(
			"flatpak-gl",
			"safe",
			[
				{ id: NVIDIA_OLD, label: NVIDIA_OLD, bytes: 902 * MB, ticked: true },
				{ id: NVIDIA_OLDER, label: NVIDIA_OLDER, bytes: 903 * MB, ticked: true },
			],
			{ undo: "redownload" },
		),
		item("restore-points", "choice", [
			{ id: "fd/10.5.1", label: "fd 10.5.1", bytes: 4 * MB, ticked: false },
			{ id: "lrcget/2.2.1", label: "lrcget 2.2.1", bytes: 148 * MB, ticked: false },
		]),
		item("autoremove", "choice", [{ id: "all", label: "libfoo1, libbar2", bytes: 0, ticked: false }], {
			bytes: null,
			root: true,
			typeToConfirm: true,
		}),
		...dev,
		shown("tmp", 2450 * MB),
		shown("journal", 33 * MB),
		shown("kernels", null, { running: "6.8.0-147-generic", newest: "6.8.0-149-generic", count: 4 }),
		shown("timeshift", null, { count: 3, newest: "2026-11-12_14-11-59" }),
		shown("browser", 2016 * MB),
		shown("playwright", 3559 * MB),
		shown("hand-backups", 356 * MB, { count: 39 }),
		shown("upkeep-cache", 1 * MB),
	];
}

/** The commands a part's delete runs, as the engine's literal argv; none for a delete in-process. */
function commandOf(id: CleanupId, partId: string): string[] | null {
	if (id === "apt-cache") return ["sudo", "-n", "apt-get", "clean"];
	if (id === "autoremove")
		return ["sudo", "-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "autoremove", "-y"];
	if (id === "flatpak-gl") return ["flatpak", "uninstall", "--system", "-y", "--noninteractive", partId];
	if (id === "uv") return ["uv", "cache", "clean"];
	return null;
}

/** The picked parts the items know, in the items' order. */
function pickedParts(items: CleanupItem[], picks: CleanupPick[]) {
	return items.flatMap((it) =>
		it.group === "shown"
			? []
			: it.parts.filter((p) => picks.some((k) => k.id === it.id && k.partIds.includes(p.id))).map((p) => ({ it, p })),
	);
}

/** As the engine's review: the bytes the picks free, the commands they run, and how many parts and which items. */
export function fixtureReview(items: CleanupItem[], picks: CleanupPick[]) {
	const parts = pickedParts(items, picks);
	return {
		bytes: parts.reduce((a, x) => a + x.p.bytes, 0),
		commands: parts.flatMap((x) => {
			const c = commandOf(x.it.id, x.p.id);
			return c ? [c] : [];
		}),
		parts: parts.length,
		items: [...new Set(parts.map((x) => x.it.id))],
	};
}

/** The items after a fake delete: every picked part is gone, and an item left with no parts leaves the list. */
export function afterClean(items: CleanupItem[], picks: CleanupPick[]): CleanupItem[] {
	return items.flatMap((it) => {
		if (it.group === "shown") return [it];
		const gone = new Set(picks.find((k) => k.id === it.id)?.partIds ?? []);
		const parts = it.parts.filter((p) => !gone.has(p.id));
		if (parts.length === 0) return [];
		return [{ ...it, parts, bytes: it.bytes === null ? null : parts.reduce((a, p) => a + p.bytes, 0) }];
	});
}
