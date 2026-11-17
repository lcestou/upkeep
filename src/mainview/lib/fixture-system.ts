// The fixture's half of the System group: rows shaped like the engine's checkSystem output on a real machine.
import type { SystemOutcome, SystemRow, SystemState } from "../../shared/types";

/** install: installing is switched on. refuse: the same, and the fake install is refused by its sudo check. */
export type SystemVariant =
	| "off"
	| "show"
	| "checking"
	| "empty"
	| "missing"
	| "failed"
	| "gl"
	| "apt"
	| "dnf"
	| "pacman"
	| "install"
	| "refuse";

/** Builds an apt row. Nothing is running, and the note is only set when the caller passes one. */
const apt = (
	name: string,
	type: SystemRow["type"],
	installed: string | null,
	latest: string,
	note?: SystemRow["note"],
): SystemRow => ({ id: `apt:${name}`, source: "apt", name, type, installed, latest, running: false, note });

/** Builds a Flatpak row whose id is the ref; running defaults to false. */
const flatpak = (
	ref: string,
	name: string,
	type: "app" | "runtime",
	installed: string | null,
	latest: string,
	running = false,
): SystemRow => ({ id: `flatpak:${ref}`, source: "flatpak", name, type, installed, latest, running });

export const APT_ROWS: SystemRow[] = [
	apt("google-chrome-stable", "package", "157.0.8103.38-1", "157.0.8103.50-1"),
	apt("libgphoto2", "security", "2.5.31-2.1ubuntu1.1", "2.5.31-2.1ubuntu1.2"),
	apt("libsoup3", "security", "3.4.4-5ubuntu0.10", "3.4.4-5ubuntu0.11"),
	apt("openjdk-21", "security", "21.0.12.1+1-1~24.04.4", "21.0.13.0.3+1-1~24.04.1"),
	apt("perl", "security", "5.38.2-3.2ubuntu0.6", "5.38.2-3.2ubuntu0.7"),
	apt("linux-generic", "kernel", "6.8.0-147.147", "6.8.0-149.149", "update-manager-only"),
	apt("nvidia-driver-580", "driver", "580.178.04-0ubuntu1", "580.182.02-0ubuntu1", "update-manager-only"),
];

export const FLATPAK_ROWS: SystemRow[] = [
	// Display names, as the engine now sends them; the full ref stays in the id.
	flatpak("com.discordapp.Discord", "Discord", "app", "1.0.168", "1.0.169", true),
	flatpak("org.gimp.GIMP", "GIMP", "app", "3.2.8", "3.2.8"),
	flatpak("org.gnome.Platform", "GNOME Application Platform", "runtime", null, "51"),
];

/** A Cinnamon spice with an update, as the spice updater lists it. */
export const SPICE_ROWS: SystemRow[] = [
	{
		id: "cinnamon:extension:CinnamonBurnMyWindows@klangman",
		source: "cinnamon",
		name: "Burn My Windows",
		type: "extension",
		installed: "2026.11.11",
		latest: "2026.11.12",
		running: false,
	},
];

/** The System group for a variant. The base is a real machine's list with every row; each variant drops rows, sets the phase or adds a problem to match its name. */
export function systemFor(variant: SystemVariant, checkedAt: string): SystemState {
	const base: SystemState = {
		mode: "show",
		phase: "idle",
		rows: [...APT_ROWS, ...FLATPAK_ROWS, ...SPICE_ROWS],
		checkedAt,
		problem: null,
		glMissing: null,
		packages: "mint",
	};
	switch (variant) {
		case "off":
			return { ...base, mode: "off", phase: "off", rows: [], checkedAt: null };
		case "show":
		case "install":
		case "refuse":
			return base;
		case "checking":
			return { ...base, phase: "checking", rows: [], checkedAt: null };
		case "empty":
			return { ...base, rows: [] };
		case "missing":
			return {
				...base,
				rows: [...FLATPAK_ROWS],
				problem: { code: "missing", command: "mintupdate-cli list" },
				packages: null,
			};
		case "apt":
			return { ...base, rows: [...APT_ROWS.map((r) => ({ ...r, note: undefined })), ...FLATPAK_ROWS], packages: "apt" };
		case "dnf":
			return {
				...base,
				rows: [
					...APT_ROWS.map((r): SystemRow => ({ ...r, id: `dnf:${r.name}`, source: "dnf", note: undefined })),
					...FLATPAK_ROWS,
				],
				packages: "dnf",
			};
		case "pacman":
			return {
				...base,
				rows: [
					...APT_ROWS.map((r): SystemRow => ({ ...r, id: `pacman:${r.name}`, source: "pacman", note: undefined })),
					...FLATPAK_ROWS,
				],
				packages: "pacman",
			};
		case "failed":
			return {
				...base,
				rows: [...APT_ROWS],
				problem: {
					code: "failed",
					command: "flatpak remote-ls --updates --columns=ref,version",
					detail: "error: Unable to load summary from remote flathub: Could not resolve host: dl.flathub.org",
				},
			};
		case "gl":
			return { ...base, glMissing: "580.178.04" };
	}
}

/** A kernel or NVIDIA package by name, as the engine's RESTART_PACKAGE reads it. */
const RESTART = /^(linux-(image|headers|modules|signed|meta|hwe|generic|lowlatency|oem)|.*nvidia)/;

/** The same for an rpm system's names, as the engine's install.ts has it. */
const RPM_RESTART = /^(kernel|.*nvidia)/;

/**
 * The engine's rule, faked: never a kernel or driver, packages from Update Manager, plain apt, dnf or zypper (never a
 * kernel or NVIDIA package by name there), never pacman's, and Flatpak, Snap and Cinnamon.
 */
export function fixtureInstallable(state: SystemState): string[] {
	const pkg = (r: SystemRow) =>
		r.source === "apt"
			? state.packages === "mint" || (state.packages === "apt" && !RESTART.test(r.name))
			: state.packages === r.source && !RPM_RESTART.test(r.name);
	return state.rows
		.filter(
			(r) =>
				r.note !== "update-manager-only" &&
				r.type !== "kernel" &&
				r.type !== "driver" &&
				(["apt", "dnf", "zypper"].includes(r.source) ? pkg(r) : ["flatpak", "snap", "cinnamon"].includes(r.source)),
		)
		.map((r) => r.id);
}

/** The commands the engine would show for these rows, built the same way; the fixture never runs any of them. */
export function fixturePlan(state: SystemState, ids: string[]): string[][] {
	const ticked = new Set(ids);
	const can = new Set(fixtureInstallable(state));
	const picked = state.rows.filter((r) => ticked.has(r.id) && can.has(r.id));
	const commands: string[][] = [];
	const aptRows = picked.filter((r) => r.source === "apt");
	if (aptRows.length > 0 && state.packages === "apt")
		commands.push([
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
			...aptRows.map((r) => r.name),
		]);
	else if (aptRows.length > 0) {
		const unticked = state.rows.filter((r) => r.source === "apt" && !picked.includes(r)).map((r) => r.name);
		const ignore = ["linux", "linux-signed*", "linux-meta*", "linux-hwe*", "nvidia-graphics-drivers-*", ...unticked];
		commands.push(["sudo", "-n", "mintupdate-cli", "upgrade", "-y", "--keep-configuration", "-i", ignore.join(",")]);
	}
	const dnf = picked.filter((r) => r.source === "dnf").map((r) => r.id.slice("dnf:".length));
	if (dnf.length > 0)
		commands.push(["sudo", "-n", "dnf", "upgrade", "-y", "--exclude=kernel*", "--exclude=*nvidia*", ...dnf]);
	const zypper = picked.filter((r) => r.source === "zypper").map((r) => r.name);
	if (zypper.length > 0)
		commands.push(["sudo", "-n", "zypper", "--non-interactive", "update", "--no-recommends", ...zypper]);
	const refs = picked.filter((r) => r.source === "flatpak").map((r) => r.id.slice("flatpak:".length));
	if (refs.length > 0) commands.push(["flatpak", "update", "-y", "--noninteractive", ...refs]);
	for (const type of new Set(picked.filter((r) => r.source === "cinnamon").map((r) => r.type)))
		commands.push(["cinnamon-spice-updater", "--update", type]);
	return commands;
}

/** One row's line in a fake install's result; detail is an engine sentence, left out when there is none. */
export function fixtureOutcome(r: SystemRow, status: SystemOutcome["status"], detail?: string): SystemOutcome {
	const o: SystemOutcome = { id: r.id, name: r.name, from: r.installed, to: r.latest, status };
	if (detail) o.detail = detail;
	return o;
}
