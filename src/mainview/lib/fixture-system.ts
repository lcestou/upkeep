// The fixture's half of the System group: rows shaped like the engine's checkSystem output on the owner's machine.
import type { SystemRow, SystemState } from "../../shared/types";

export type SystemVariant = "off" | "show" | "checking" | "empty" | "missing" | "failed" | "gl";

const apt = (
	name: string,
	type: SystemRow["type"],
	installed: string | null,
	latest: string,
	note?: SystemRow["note"],
): SystemRow => ({ id: `apt:${name}`, source: "apt", name, type, installed, latest, running: false, note });

const flatpak = (
	name: string,
	type: "app" | "runtime",
	installed: string | null,
	latest: string,
	running = false,
): SystemRow => ({ id: `flatpak:${name}`, source: "flatpak", name, type, installed, latest, running });

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
	flatpak("com.discordapp.Discord", "app", "1.0.168", "1.0.169", true),
	flatpak("org.gimp.GIMP", "app", "3.2.8", "3.2.8"),
	flatpak("org.gnome.Platform", "runtime", null, "51"),
];

export function systemFor(variant: SystemVariant, checkedAt: string): SystemState {
	const base: SystemState = {
		mode: "show",
		phase: "idle",
		rows: [...APT_ROWS, ...FLATPAK_ROWS],
		checkedAt,
		problem: null,
		glMissing: null,
	};
	switch (variant) {
		case "off":
			return { ...base, mode: "off", phase: "off", rows: [], checkedAt: null };
		case "show":
			return base;
		case "checking":
			return { ...base, phase: "checking", rows: [], checkedAt: null };
		case "empty":
			return { ...base, rows: [] };
		case "missing":
			return { ...base, rows: [...FLATPAK_ROWS], problem: { code: "missing", command: "mintupdate-cli list" } };
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
