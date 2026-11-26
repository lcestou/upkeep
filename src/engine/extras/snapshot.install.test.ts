import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MESSAGES } from "../../shared/messages";
import type { EngineEvent } from "../../shared/types";
import type { ProcessResult } from "../run";
import { readHistory } from "../store";
import { ok, strictRun, tempHome } from "../testkit";
import { createExtras } from "./extras";
import {
	SNAPSHOT_COMMENT,
	TIMESHIFT_CREATE,
	TIMESHIFT_LIST,
	TIMESHIFT_READ_CONFIG,
	TIMESHIFT_VERSION,
} from "./snapshot";
import { loadExtras, updateExtras } from "./state";
import { FLATPAK_UPDATES } from "./system";

const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const DISCORD = "flatpak:app/com.discordapp.Discord/x86_64/stable";
const NOW = new Date(2026, 10, 26, 10, 0);
const key = (argv: string[]) => argv.join(" ");
// Above any kernel's pid_max (2^22), so a quit that ended this "process" would signal nobody.
const NO_PID = 2_147_483_647;
const exit = (code: number, stdout = "", stderr = ""): ProcessResult => ({ code, stdout, stderr, timedOut: false });

/** Waits until check holds, up to two seconds, then fails. */
async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 400 && !check(); i++)
		// oxlint-disable-next-line no-await-in-loop -- polling waits one turn at a time
		await Bun.sleep(5);
	expect(check()).toBe(true);
}

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("snapshot");
});
afterEach(() => t.cleanup());

/** timeshift --list --scripted's grid, as print_grid pads it: every column to its widest cell plus two spaces. */
function listing(rows: [string, string, string][]): string {
	const grid = [["Num", "", "Name", "Tags", "Description"], ...rows.map(([n, tg, c], i) => [String(i), ">", n, tg, c])];
	const widths = [0, 1, 2, 3, 4].map((c) => Math.max(...grid.map((r) => (r[c] ?? "").length)));
	const line = (r: string[]) => r.map((cell, c) => `${cell.padEnd(widths[c] ?? 0)}  `).join("");
	const [head = [], ...body] = grid;
	return ["Status : OK", "", line(head), "-".repeat(78), ...body.map(line), "", ""].join("\n");
}

/**
 * A machine with Flatpak and Timeshift (rsync mode) and nothing else: the Flatpak update succeeds and drops Discord
 * from the list, or throws when told to; the Timeshift list holds the owner's day-old daily snapshot until a create
 * adds Upkeep's. create replaces the create's answer, and may be one that comes later.
 */
function machine(create: ProcessResult | Promise<ProcessResult> = ok(), updateThrows = false) {
	let installed = false;
	let made = false;
	return strictRun((argv, opts) => {
		const k = key(argv);
		if (k === key(TIMESHIFT_VERSION)) return ok("Timeshift 25.12.4\n");
		if (k === key(TIMESHIFT_READ_CONFIG)) return ok('{"backup_device_uuid": "u", "btrfs_mode": "false"}');
		if (k === key(TIMESHIFT_LIST))
			return ok(
				listing([
					["2026-11-25_06-00-01", "D", ""],
					...(made ? [["2026-11-26_10-00-00", "O", SNAPSHOT_COMMENT] as [string, string, string]] : []),
				]),
			);
		if (k === key(TIMESHIFT_CREATE)) {
			opts.onStart?.(NO_PID);
			return Promise.resolve(create).then((r) => {
				made = r.code === 0;
				return r;
			});
		}
		if (k === key(FLATPAK_UPDATES))
			return ok(
				installed ? fx("flatpak-updates.txt").replace(/^app\/com\.discordapp.*\n/m, "") : fx("flatpak-updates.txt"),
			);
		if (argv[0] === "flatpak" && argv[1] === "update") {
			if (updateThrows) throw new Error("the runner broke");
			opts.onStart?.(NO_PID);
			installed = true;
			return ok();
		}
		if (argv[0] === "flatpak" || argv[0] === "pkcheck" || argv[0] === "dpkg-query") return ok();
		if (argv[0] === "sudo" && argv[2] === "timeshift" && argv[3] === "--delete") return ok();
		return exit(127);
	});
}

/** Extras with installing and the snapshot on, checked once. */
async function ready(box: ReturnType<typeof machine>) {
	updateExtras(t.paths, { system: "show", systemInstall: true, snapshotBeforeSystem: true });
	const x = createExtras({ paths: t.paths, run: box.run, now: () => NOW });
	await x.idle();
	return x;
}

/** Resolves once the extras say the snapshot asks, and records every snapshot phase it passed through. */
function watch(x: Awaited<ReturnType<typeof ready>>) {
	const phases: string[] = [];
	let asked: () => void = () => undefined;
	const asking = new Promise<void>((r) => (asked = r));
	x.subscribe((e: EngineEvent) => {
		if (e.type !== "extras") return;
		const phase = e.extras.system.install?.snapshot?.phase;
		if (phase && phases.at(-1) !== phase) phases.push(phase);
		if (phase === "asking") asked();
	});
	return { phases, asking };
}

test("the check finds Timeshift; the setting stays on only while installing is", async () => {
	const x = await ready(machine());
	expect(x.snapshot().system.snapshotSetup).toEqual({ tool: "timeshift", btrfs: false });
	expect(x.snapshot().settings.snapshotBeforeSystem).toBe(true);
	x.setSettings({ systemInstall: false });
	expect(loadExtras(t.paths).snapshotBeforeSystem).toBeUndefined();
});

test("a snapshot is taken before the first System step, and History names it", async () => {
	const box = machine();
	const x = await ready(box);
	const seen = watch(x);
	const commands = x.planSystem([DISCORD]).commands;
	expect(x.installSystem([DISCORD], commands)).toEqual({ started: true });
	await x.idle();
	const order = box.calls
		.map((c) => key(c.argv))
		.filter((k) => (k.startsWith("sudo -n ") && k.includes(" timeshift --")) || k.startsWith("flatpak update"));
	expect(order).toEqual([key(TIMESHIFT_LIST), key(TIMESHIFT_CREATE), key(TIMESHIFT_LIST), key(commands[0] ?? [])]);
	expect(seen.phases).toEqual(["taking"]);
	expect(x.snapshot().system.install?.snapshot).toBeUndefined();
	const history = readHistory(t.paths, 100);
	const snap = history.find((r) => r.key === "system:snapshot");
	expect(snap).toMatchObject({
		name: "Timeshift",
		result: "updated",
		detail: MESSAGES.snapshotTaken("2026-11-26_10-00-00"),
	});
	expect(history.find((r) => r.key === `system:${DISCORD}`)?.result).toBe("updated");
});

test("no snapshot is taken with the setting off, or for a plan that installs nothing", async () => {
	const box = machine();
	updateExtras(t.paths, { system: "show", systemInstall: true });
	const x = createExtras({ paths: t.paths, run: box.run, now: () => NOW });
	await x.idle();
	x.installSystem([DISCORD], x.planSystem([DISCORD]).commands);
	await x.idle();
	expect(box.calls.some((c) => c.argv.includes("--create"))).toBe(false);
	expect(readHistory(t.paths, 100).some((r) => r.key === "system:snapshot")).toBe(false);
});

test("a failed snapshot asks; Install anyway goes on and History says why there is none", async () => {
	const box = machine(exit(1, "", "sudo: a password is required"));
	const x = await ready(box);
	const seen = watch(x);
	x.installSystem([DISCORD], x.planSystem([DISCORD]).commands);
	await seen.asking;
	expect(x.snapshot().system.install?.snapshot).toEqual({
		phase: "asking",
		reason: MESSAGES.snapshotFailed(MESSAGES.snapshotNoRoot()),
	});
	// Nothing of the System install ran while it asks.
	expect(box.calls.some((c) => c.argv[1] === "update")).toBe(false);
	expect(x.answerSnapshot(true)).toEqual({ ok: true });
	await x.idle();
	expect(box.calls.some((c) => c.argv[0] === "flatpak" && c.argv[1] === "update")).toBe(true);
	expect(seen.phases).toEqual(["taking", "asking"]);
	expect(readHistory(t.paths, 100).find((r) => r.key === "system:snapshot")).toMatchObject({
		result: "failed",
		detail: MESSAGES.snapshotFailed(MESSAGES.snapshotNoRoot()),
	});
	// Nothing asks any more.
	expect(x.answerSnapshot(true)).toEqual({ ok: false });
});

test("Stop after a failed snapshot installs nothing; a quit answers Stop too", async () => {
	for (const how of ["stop", "quit"] as const) {
		t.cleanup();
		t = tempHome("snapshot");
		const box = machine(exit(1, "", "E: Not enough disk space on the backup device"));
		// oxlint-disable-next-line no-await-in-loop -- each way of stopping on its own machine
		const x = await ready(box);
		const seen = watch(x);
		x.installSystem([DISCORD], x.planSystem([DISCORD]).commands);
		// oxlint-disable-next-line no-await-in-loop -- the ask comes before the answer
		await seen.asking;
		if (how === "stop") x.answerSnapshot(false);
		else x.stopSystem();
		// oxlint-disable-next-line no-await-in-loop -- the run ends after the answer
		await x.idle();
		expect(box.calls.some((c) => c.argv[0] === "flatpak" && c.argv[1] === "update")).toBe(false);
		expect(x.snapshot().system.install?.refused).toBe(MESSAGES.snapshotStopped());
		expect(x.snapshot().system.phase).toBe("idle");
		expect(readHistory(t.paths, 100).map((r) => [r.key, r.result])).toEqual([["system:snapshot", "failed"]]);
	}
});

test("a quit while the snapshot is being taken never asks: the snapshot it ended counts as Stop", async () => {
	let finish: (r: ProcessResult) => void = () => undefined;
	const box = machine(new Promise<ProcessResult>((r) => (finish = r)));
	const x = await ready(box);
	const seen = watch(x);
	x.installSystem([DISCORD], x.planSystem([DISCORD]).commands);
	await until(() => seen.phases.includes("taking") && box.calls.some((c) => c.argv.includes("--create")));
	x.stopSystem();
	// The create ends as a stopped command does.
	finish(exit(143, "", "Terminated"));
	await x.idle();
	expect(seen.phases).toEqual(["taking"]);
	expect(x.answerSnapshot(true)).toEqual({ ok: false });
	expect(box.calls.some((c) => c.argv[0] === "flatpak" && c.argv[1] === "update")).toBe(false);
	expect(x.snapshot().system.install?.refused).toBe(MESSAGES.snapshotStopped());
	expect(readHistory(t.paths, 100).map((r) => [r.key, r.result])).toEqual([["system:snapshot", "failed"]]);
});

test("a System run that throws after the snapshot still writes the snapshot's History row", async () => {
	const x = await ready(machine(ok(), true));
	x.installSystem([DISCORD], x.planSystem([DISCORD]).commands);
	await x.idle();
	expect(x.snapshot().system.install?.refused).toBe("the runner broke");
	expect(readHistory(t.paths, 100).find((r) => r.key === "system:snapshot")).toMatchObject({
		result: "updated",
		detail: MESSAGES.snapshotTaken("2026-11-26_10-00-00"),
	});
	expect(x.snapshot().system.phase).toBe("idle");
});
