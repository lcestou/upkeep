import type { SystemRow } from "../../shared/types";
import { isRecord } from "../manifest";

// fwupd's command line, fwupdmgr, named here and nowhere else. Upkeep reads its pending updates and installs one
// device at a time; it never refreshes fwupd's metadata, which fwupd's own timer does, and never reboots.

/**
 * The pending firmware updates as JSON. Read-only and needs no root. --json turns off every question, and with no
 * update it prints {"Devices": []} and exits 0 (fwupd 2.0); without --json the same answer exits 2, which older
 * versions may give here too, so 2 counts as an empty list.
 */
export const FWUPD_UPDATES = ["fwupdmgr", "get-updates", "--json"];
/** The exit codes of FWUPD_UPDATES that mean it answered: 0, and 2 for nothing to do. */
export const FWUPD_OK = [0, 2];

/**
 * The install of one device's newest release. fwupd's daemon flashes it and asks polkit itself, with the desktop's own
 * password dialog, so there is no sudo. Every flag stops a question that --assume-yes would otherwise answer yes:
 * --no-reboot-check the restart at the end, --no-metadata-check a metadata refresh, --no-remote-check turning on a
 * download remote, --no-unreported-check uploading reports of earlier updates, --no-security-fix changing the
 * firmware's security settings, and --no-device-prompt a device picker.
 */
export const fwupdArgv = (deviceId: string) => [
	"fwupdmgr",
	"update",
	deviceId,
	"--assume-yes",
	"--no-reboot-check",
	"--no-metadata-check",
	"--no-remote-check",
	"--no-unreported-check",
	"--no-security-fix",
	"--no-device-prompt",
];

/** The device flags that mean the new firmware only takes effect after a restart (or a shutdown and start). */
const RESTART_FLAGS = new Set(["needs-reboot", "needs-shutdown"]);

/** A JSON list of strings; anything else reads as empty. */
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * One row per device in fwupdmgr get-updates --json with a release to install: the device's name, its version now and
 * the newest release fwupdmgr update would install (the first one marked is-upgrade, else the first listed; fwupd
 * lists them newest first). A device whose flags say it needs a restart gets the restart-needed note; fwupd puts that
 * on the device, never on a release. Null when the text is not fwupd's JSON, so a broken answer is not an empty list.
 */
export function parseFwupd(stdout: string): SystemRow[] | null {
	let data: unknown;
	try {
		data = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (!isRecord(data) || !Array.isArray(data.Devices)) return null;
	return data.Devices.flatMap((dev: unknown): SystemRow[] => {
		if (!isRecord(dev) || typeof dev.DeviceId !== "string" || !dev.DeviceId || !Array.isArray(dev.Releases)) return [];
		const releases = dev.Releases.filter(isRecord);
		const release = releases.find((r) => strings(r.Flags).includes("is-upgrade")) ?? releases[0];
		if (!release || typeof release.Version !== "string" || !release.Version) return [];
		const row: SystemRow = {
			id: `firmware:${dev.DeviceId}`,
			source: "firmware",
			name: typeof dev.Name === "string" && dev.Name ? dev.Name : dev.DeviceId,
			type: "firmware",
			installed: typeof dev.Version === "string" && dev.Version ? dev.Version : null,
			latest: release.Version,
			running: false,
		};
		if (strings(dev.Flags).some((f) => RESTART_FLAGS.has(f))) row.note = "restart-needed";
		return [row];
	});
}
