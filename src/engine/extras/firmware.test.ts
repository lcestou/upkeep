import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MESSAGES } from "../../shared/messages";
import type { SystemRow } from "../../shared/types";
import { UPOWER_ON_BATTERY } from "../power";
import type { ProcessResult } from "../run";
import { ok, strictRun } from "../testkit";
import { FWUPD_UPDATES, fwupdArgv, parseFwupd } from "./firmware";
import { installable, outcomesAfter, planSteps, preflight, SUDO_CHECK } from "./install";
import { checkSystem } from "./system";

// fwupdmgr get-updates --json from a real machine (fwupd 2.0.20), trimmed to the fields Upkeep reads, with the device
// ids replaced and no serial numbers, GUIDs or instance ids.
const SAMPLE = readFileSync(join(import.meta.dir, "fixtures", "fwupd-get-updates.json"), "utf8");
const exit = (code: number, stdout = ""): ProcessResult => ({ code, stdout, stderr: "", timedOut: false });
const DBX = "firmware:0000000000000000000000000000000000000003";

test("parseFwupd reads each device's name, version now and newest release, and its restart flag", () => {
	const rows = parseFwupd(SAMPLE);
	expect(rows?.map((r) => [r.id, r.name, r.installed, r.latest, r.note])).toEqual([
		["firmware:0000000000000000000000000000000000000001", "KEK CA", "2011", "2023", "restart-needed"],
		["firmware:0000000000000000000000000000000000000002", "UEFI CA", "2011", "2023", "restart-needed"],
		// Three dbx releases are listed newest first: the newest is what fwupdmgr update installs.
		[DBX, "UEFI dbx", "20230501", "20260402", "restart-needed"],
	]);
	expect(rows?.every((r) => r.source === "firmware" && r.type === "firmware" && !r.running)).toBe(true);
});

test("parseFwupd: no restart flag, no is-upgrade flag, no name, and what it leaves out", () => {
	const json = JSON.stringify({
		Devices: [
			{
				DeviceId: "dock",
				Name: "USB-C Dock",
				Version: "1.0.12",
				Flags: ["updatable"],
				Releases: [{ Version: "1.0.14", Flags: [] }],
			},
			{ DeviceId: "nameless", Flags: ["needs-shutdown"], Releases: [{ Version: "2" }] },
			// No release, no version, no id, not an object: none is a row.
			{ DeviceId: "empty", Name: "Empty", Releases: [] },
			{ DeviceId: "blank", Name: "Blank", Releases: [{ Version: "" }] },
			{ Name: "No id", Releases: [{ Version: "1" }] },
			"junk",
		],
	});
	expect(parseFwupd(json)).toEqual([
		{
			id: "firmware:dock",
			source: "firmware",
			name: "USB-C Dock",
			type: "firmware",
			installed: "1.0.12",
			latest: "1.0.14",
			running: false,
		},
		{
			id: "firmware:nameless",
			source: "firmware",
			name: "nameless",
			type: "firmware",
			installed: null,
			latest: "2",
			running: false,
			note: "restart-needed",
		},
	]);
	expect(parseFwupd('{"Devices": []}')).toEqual([]);
	expect(parseFwupd("not json")).toBeNull();
	expect(parseFwupd('{"devices": []}')).toBeNull();
});

/** A machine with only fwupd: every other list is missing. */
function onlyFwupd(answer: ProcessResult) {
	return strictRun((argv) => {
		if (argv.join(" ") === FWUPD_UPDATES.join(" ")) return answer;
		return exit(127);
	});
}

test("checkSystem lists firmware after the rest, and nothing at all without fwupdmgr or when it fails", async () => {
	const found = await checkSystem({ run: onlyFwupd(ok(SAMPLE)).run });
	expect(found.rows.map((r) => r.id).at(-1)).toBe(DBX);
	expect(found.rows).toHaveLength(3);
	// Exit 2 is fwupd's "nothing to do", whatever it prints: no rows and no problem of fwupd's.
	for (const r of [exit(2, ""), exit(2, "No updatable devices")]) {
		// oxlint-disable-next-line no-await-in-loop -- each answer is its own machine
		const nothing = await checkSystem({ run: onlyFwupd(r).run });
		expect(nothing.rows).toEqual([]);
		expect(nothing.problem?.command).not.toContain("fwupdmgr");
	}
	// On a Mint machine with Flatpak and nothing pending anywhere, exit 2 leaves the group with no problem at all.
	const quiet = await checkSystem({
		run: strictRun((argv) => {
			if (argv.join(" ") === FWUPD_UPDATES.join(" ")) return exit(2, "No updatable devices");
			return argv[0] === "cinnamon-spice-updater" || argv[0] === "snap" ? exit(127) : ok("");
		}).run,
	});
	expect(quiet).toMatchObject({ rows: [], problem: null });
	for (const r of [exit(127), exit(1, "Failed to connect to daemon"), { ...ok(SAMPLE), timedOut: true }]) {
		// oxlint-disable-next-line no-await-in-loop -- each answer is its own machine
		const check = await checkSystem({ run: onlyFwupd(r).run });
		expect(check.rows).toEqual([]);
		// The problem is Update Manager's missing list, never fwupd's.
		expect(check.problem?.command).toBe("mintupdate-cli list");
	}
	// An answer that is not fwupd's JSON is a failed read of fwupd's list, not an empty one.
	const broken = await checkSystem({ run: onlyFwupd(ok("WARNING: something unexpected\n{")).run });
	expect(broken.rows).toEqual([]);
	expect(broken.problem).toEqual({
		code: "failed",
		command: "fwupdmgr get-updates --json",
		detail: "WARNING: something unexpected",
	});
});

test("firmware installs one device per step, last, with every flag that keeps it from asking or restarting", () => {
	const rows: SystemRow[] = [
		...(parseFwupd(SAMPLE) ?? []),
		{ id: "snap:core", source: "snap", name: "core", type: "snap", installed: "1", latest: "2", running: false },
	];
	expect(rows.every((r) => installable(r, null))).toBe(true);
	const steps = planSteps(rows, [DBX, "snap:core", "firmware:0000000000000000000000000000000000000001"], null);
	expect(steps.map((s) => s.kind)).toEqual(["snap", "firmware", "firmware"]);
	expect(steps[1]?.argv).toEqual([
		"fwupdmgr",
		"update",
		"0000000000000000000000000000000000000001",
		"--assume-yes",
		"--no-reboot-check",
		"--no-metadata-check",
		"--no-remote-check",
		"--no-unreported-check",
		"--no-security-fix",
		"--no-device-prompt",
	]);
	expect(steps[2]?.ids).toEqual([DBX]);
	// No sudo: fwupd's daemon asks polkit itself.
	expect(fwupdArgv("x")[0]).toBe("fwupdmgr");
	expect(fwupdArgv("x")).not.toContain("refresh");
});

test("preflight refuses firmware on battery, and asks UPower only when firmware is ticked", async () => {
	const rows = parseFwupd(SAMPLE) ?? [];
	const steps = planSteps(rows, [DBX], null);
	const ctx = (battery: boolean) =>
		strictRun((argv) =>
			argv.join(" ") === UPOWER_ON_BATTERY.join(" ") ? ok(battery ? "b true\n" : "b false\n") : undefined,
		);
	const log = () => undefined;
	expect(await preflight(steps, rows, { run: ctx(true).run, pid: 1, log })).toBe(MESSAGES.firmwareBattery());
	expect(await preflight(steps, rows, { run: ctx(false).run, pid: 1, log })).toBeNull();
	// No UPower at all (a desktop) reads as mains power.
	const noUpower = strictRun((argv) => (argv[0] === "busctl" ? exit(1) : undefined));
	expect(await preflight(steps, rows, { run: noUpower.run, pid: 1, log })).toBeNull();
	// A Snap alone never asks UPower.
	const snap: SystemRow = {
		id: "snap:a",
		source: "snap",
		name: "a",
		type: "snap",
		installed: "1",
		latest: "2",
		running: false,
	};
	const snapOnly = strictRun((argv) => (argv.join(" ") === SUDO_CHECK.join(" ") ? ok() : undefined));
	expect(await preflight(planSteps([snap], ["snap:a"], null), [snap], { run: snapOnly.run, pid: 1, log })).toBeNull();
	expect(snapOnly.calls.map((c) => c.argv[0])).toEqual(["sudo"]);
});

test("a firmware row is judged by its step: done, saying a restart is needed when its device needs one", () => {
	const dock: SystemRow = {
		id: "firmware:dock",
		source: "firmware",
		name: "Dock",
		type: "firmware",
		installed: "1",
		latest: "2",
		running: false,
	};
	const dbx = (parseFwupd(SAMPLE) ?? []).find((r) => r.id === DBX);
	if (!dbx) throw new Error("no dbx row");
	// Still listed afterwards (a capsule waits for the restart) is not a failure.
	const after = { rows: [dbx, dock], problem: null, glMissing: null, packages: null };
	const failed = new Map([["firmware:dock", MESSAGES.commandExited("fwupdmgr update dock", 1)]]);
	expect(outcomesAfter([dbx, dock], failed, after)).toEqual([
		{ id: DBX, name: "UEFI dbx", from: "20230501", to: "20260402", status: "done", detail: MESSAGES.firmwareRestart() },
		{ id: "firmware:dock", name: "Dock", from: "1", to: "2", status: "failed", detail: failed.get("firmware:dock") },
	]);
	expect(outcomesAfter([dock], new Map(), after)[0]).toEqual({
		id: "firmware:dock",
		name: "Dock",
		from: "1",
		to: "2",
		status: "done",
	});
});
