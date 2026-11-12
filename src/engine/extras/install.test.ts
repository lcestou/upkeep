import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MESSAGES } from "../../shared/messages";
import type { SystemRow } from "../../shared/types";
import type { ProcessResult, RunOpts } from "../run";
import { claimLock, readHistory, releaseLock } from "../store";
import { ok, strictRun, tempHome } from "../testkit";
import { createExtras } from "./extras";
import {
	aptArgv,
	DPKG_LOCK_CHECK,
	installable,
	KERNEL_AND_DRIVER_IGNORE,
	planSteps,
	SUDO_CHECK,
	trialArgv,
	trialPackages,
} from "./install";
import { updateExtras } from "./state";
import {
	DRIVER_GL,
	FLATPAK_INSTALLED,
	FLATPAK_RUNNING,
	FLATPAK_RUNTIMES,
	FLATPAK_UPDATES,
	MINT_LIST,
	SOURCE_VERSIONS,
} from "./system";

const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const GLOBS = KERNEL_AND_DRIVER_IGNORE.join(",");
const DISCORD = "flatpak:app/com.discordapp.Discord/x86_64/stable";
const PLATFORM = "flatpak:runtime/org.gnome.Platform/x86_64/51";

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("sysinstall");
});
afterEach(() => t.cleanup());

const missing: ProcessResult = { code: 127, stdout: "", stderr: "Executable not found in $PATH", timedOut: false };
const exit = (code: number, stdout = "", stderr = ""): ProcessResult => ({ code, stdout, stderr, timedOut: false });

/** A row as the check builds it; only what the install reads is given. */
const row = (
	id: string,
	source: SystemRow["source"],
	type: SystemRow["type"],
	name = id.split(":").at(-1) ?? id,
): SystemRow => ({
	id,
	source,
	name,
	type,
	installed: "1",
	latest: "2",
	running: false,
});

/** The trial run with the ticked perl only, as the box below sees it. */
const PERL_IGNORE = `${GLOBS},google-chrome-stable,libgphoto2,libnfs,libsoup3,openjdk-21,openjdk-8`;

/**
 * This box, faked: the check reads the saved outputs; the pre-checks pass; the trial run lists perl only; every
 * install command exits 0. A list read after an install command ran lacks what it installed. over replaces any
 * answer by argv. Anything else throws, so nothing unplanned can reach a real process.
 */
function box(over: Map<string, ProcessResult> = new Map()) {
	let installed = false;
	return strictRun((argv: string[], opts: RunOpts) => {
		const key = argv.join(" ");
		const o = over.get(key);
		if (o) return o;
		if (argv[0] === "cinnamon-spice-updater" || argv[0] === "snap") return missing;
		if (key === SUDO_CHECK.join(" ")) return ok();
		if (key === DPKG_LOCK_CHECK.join(" ")) return exit(1);
		if (argv[0] === "pkcheck") return ok();
		if (key === MINT_LIST.join(" "))
			return ok(installed ? fx("mint-list.txt").replace(/^security\s+perl\s.*$/m, "") : fx("mint-list.txt"));
		if (key === trialArgv(PERL_IGNORE).join(" "))
			return ok("Inst perl [5.38.2-3.2ubuntu0.6] (5.38.2-3.2ubuntu0.7 Ubuntu:24.04/noble-updates [amd64])\n");
		if (key === FLATPAK_UPDATES.join(" "))
			return ok(
				installed ? fx("flatpak-updates.txt").replace(/^app\/com\.discordapp.*\n/m, "") : fx("flatpak-updates.txt"),
			);
		if (key === FLATPAK_RUNNING.join(" ")) return ok("com.discordapp.Discord\n");
		const saved: [string[], string][] = [
			[SOURCE_VERSIONS, "dpkg-sources.txt"],
			[FLATPAK_INSTALLED, "flatpak-list.txt"],
			[DRIVER_GL, "dpkg-gl.txt"],
			[FLATPAK_RUNTIMES, "flatpak-runtimes.txt"],
		];
		const hit = saved.find(([a]) => a.join(" ") === key);
		if (hit) return ok(fx(hit[1]));
		if (key === aptArgv(PERL_IGNORE).join(" ") || argv.slice(0, 2).join(" ") === "flatpak update") {
			opts.onLine?.("installing");
			installed = true;
			return ok();
		}
		return undefined;
	});
}

/** Extras with the list shown and installing switched on, checked once. */
async function shown(run: ReturnType<typeof box>["run"]) {
	updateExtras(t.paths, { system: "show", systemInstall: true });
	const x = createExtras({ paths: t.paths, run, now: () => new Date("2026-11-12T10:00:00Z") });
	await x.idle();
	return x;
}

/** The command a System install would run for these rows, as the person is shown it. */
const plan = (x: Awaited<ReturnType<typeof shown>>, ids: string[]) => x.planSystem(ids).commands;
const isRootInstall = (argv: string[]) => argv[0] === "sudo" && argv[2] === "mintupdate-cli";

test("apt runs through mintupdate-cli as root, always with --keep-configuration and the kernel and driver globs in -i", () => {
	const rows = [
		row("apt:perl", "apt", "security"),
		row("apt:libsoup3", "apt", "security"),
		{ ...row("apt:linux-6.8.0-150", "apt", "kernel"), note: "update-manager-only" as const },
		{ ...row("apt:nvidia-graphics-drivers-580", "apt", "driver"), note: "update-manager-only" as const },
	];
	// Ticking the kernel and the driver changes nothing: they are not installable and stay in -i.
	const steps = planSteps(rows, ["apt:perl", "apt:linux-6.8.0-150", "apt:nvidia-graphics-drivers-580"], "mint");
	expect(steps).toHaveLength(1);
	expect(steps[0]?.ids).toEqual(["apt:perl"]);
	expect(steps[0]?.argv).toEqual([
		"sudo",
		"-n",
		"mintupdate-cli",
		"upgrade",
		"-y",
		"--keep-configuration",
		"-i",
		"linux,linux-signed*,linux-meta*,linux-hwe*,nvidia-graphics-drivers-*,libsoup3,linux-6.8.0-150,nvidia-graphics-drivers-580",
	]);
	expect(trialArgv("x")).toEqual(["mintupdate-cli", "upgrade", "-d", "-y", "--keep-configuration", "-i", "x"]);
	// Every apt row ticked: -i still carries the globs.
	expect(planSteps(rows.slice(0, 2), ["apt:perl", "apt:libsoup3"], "mint")[0]?.argv.at(-1)).toBe(GLOBS);
});

test("Upkeep installs Update Manager's packages, Flatpak, Snap and Cinnamon, never a kernel, a driver or another package list's row", () => {
	expect(installable(row("apt:perl", "apt", "security"), "mint")).toBe(true);
	expect(installable(row("apt:perl.amd64", "apt", "security"), "apt")).toBe(false);
	expect(installable(row("dnf:bash.x86_64", "dnf", "package"), "dnf")).toBe(false);
	expect(installable(row("pacman:bash", "pacman", "package"), "pacman")).toBe(false);
	expect(installable(row("zypper:bash.x86_64", "zypper", "package"), "zypper")).toBe(false);
	expect(installable(row("apt:linux", "apt", "kernel"), "mint")).toBe(false);
	expect(installable(row("apt:nvidia-graphics-drivers-580", "apt", "driver"), "mint")).toBe(false);
	expect(installable(row(DISCORD, "flatpak", "app"), null)).toBe(true);
	expect(installable(row("snap:firefox", "snap", "snap"), null)).toBe(true);
	expect(installable(row("cinnamon:applet:a@b", "cinnamon", "applet"), null)).toBe(true);
	// Order: apt, Flatpak, Snap, then one Cinnamon update per spice type.
	const rows = [
		row("cinnamon:applet:a@b", "cinnamon", "applet"),
		row("cinnamon:applet:c@d", "cinnamon", "applet"),
		row("snap:firefox", "snap", "snap"),
		row(DISCORD, "flatpak", "app"),
		row("apt:perl", "apt", "security"),
	];
	expect(
		planSteps(
			rows,
			rows.map((r) => r.id),
			"mint",
		).map((s) => s.argv),
	).toEqual([
		aptArgv(GLOBS),
		["flatpak", "update", "-y", "--noninteractive", "app/com.discordapp.Discord/x86_64/stable"],
		["sudo", "-n", "snap", "refresh", "firefox"],
		["cinnamon-spice-updater", "--update", "applet"],
	]);
	expect(trialPackages("NOTE: simulation\nInst perl [1] (2)\nConf perl (2)\nRemv old [1]\n")).toEqual(["perl", "old"]);
});

test("a finished install runs apt before Flatpak in their own process groups, checks again, and writes history", async () => {
	const { run, calls } = box();
	const x = await shown(run);
	expect(x.snapshot().system.installable).toEqual([
		"apt:google-chrome-stable",
		"apt:libgphoto2",
		"apt:libnfs",
		"apt:libsoup3",
		"apt:openjdk-21",
		"apt:openjdk-8",
		"apt:perl",
		DISCORD,
		"flatpak:app/org.gimp.GIMP/x86_64/stable",
		PLATFORM,
	]);
	const ids = ["apt:perl", DISCORD];
	const commands = plan(x, ids);
	expect(commands).toEqual([
		aptArgv(PERL_IGNORE),
		["flatpak", "update", "-y", "--noninteractive", "app/com.discordapp.Discord/x86_64/stable"],
	]);
	expect(x.installSystem(ids, commands)).toEqual({ started: true });
	expect(x.installing()).toBe(true);
	await x.idle();
	expect(x.installing()).toBe(false);
	const ran = calls.map((c) => c.argv.join(" "));
	const apt = ran.indexOf(aptArgv(PERL_IGNORE).join(" "));
	const flatpak = ran.findIndex((c) => c.startsWith("flatpak update"));
	expect(apt).toBeGreaterThan(ran.indexOf(trialArgv(PERL_IGNORE).join(" ")));
	expect(flatpak).toBeGreaterThan(apt);
	for (const c of calls.filter((c) => c.argv[0] === "sudo" && c.argv[2] !== "true" && c.argv[2] !== "fuser"))
		expect(c.opts).toMatchObject({ group: true, timeoutMs: 3_600_000 });
	expect(calls.find((c) => c.argv[1] === "update")?.opts.group).toBe(true);
	const install = x.snapshot().system.install;
	expect(install?.refused).toBeNull();
	expect(install?.outcomes).toEqual([
		{ id: "apt:perl", name: "perl", from: "5.38.2-3.2ubuntu0.6", to: "5.38.2-3.2ubuntu0.7", status: "done" },
		{
			id: DISCORD,
			name: "Discord",
			from: "1.0.168",
			to: "1.0.169",
			status: "done",
			detail: MESSAGES.systemRestartApp(),
		},
	]);
	// The list was read again: the installed rows are gone.
	expect(x.snapshot().system.rows.map((r) => r.id)).not.toContain("apt:perl");
	expect(x.snapshot().system.rows.map((r) => r.id)).not.toContain(DISCORD);
	const history = readHistory(t.paths, 10);
	// Newest first, as History lists them.
	expect(history.map((h) => [h.key, h.result])).toEqual([
		[`system:${DISCORD}`, "updated"],
		["system:apt:perl", "updated"],
	]);
	expect(history[0]?.runId).toMatch(/-system$/);
	const log = readFileSync(join(t.paths.state, "logs", `${history[0]?.runId}.log`), "utf8");
	expect(log).toContain(`Running ${aptArgv(PERL_IGNORE).join(" ")}`);
	expect(log).toContain("installing");
	// Its own lock is given back.
	expect(existsSync(join(t.paths.state, "run.lock"))).toBe(false);
});

test("a row still listed after its step ran is failed, and a timed-out step names its command", async () => {
	const ignore = `${GLOBS},google-chrome-stable,libgphoto2,libnfs,openjdk-21,openjdk-8,perl`;
	const { run, calls } = box(
		new Map([
			[
				"snap refresh --list",
				ok("Name     Version  Rev  Size  Publisher  Notes\nfirefox  150.0    1    1MB   mozilla**  -\n"),
			],
			["snap list", ok("Name     Version\nfirefox  149.0\n")],
			["sudo -n snap refresh firefox", { code: 137, stdout: "", stderr: "", timedOut: true }],
			[trialArgv(ignore).join(" "), ok("Inst libsoup-3.0-0 [1] (2)\n")],
			// It exits 0 whatever apt did: mintupdate-cli throws apt's exit code away.
			[aptArgv(ignore).join(" "), ok()],
		]),
	);
	const x = await shown(run);
	const ids = ["snap:firefox", "apt:libsoup3"];
	expect(x.installSystem(ids, plan(x, ids))).toEqual({ started: true });
	await x.idle();
	expect(x.snapshot().system.install?.outcomes.map((o) => [o.id, o.status, o.detail])).toEqual([
		["apt:libsoup3", "failed", MESSAGES.systemStillPending()],
		["snap:firefox", "failed", MESSAGES.systemTimedOut("sudo -n snap refresh firefox")],
	]);
	expect(calls.find((c) => c.argv.join(" ") === "sudo -n snap refresh firefox")?.opts).toMatchObject({
		group: true,
		timeoutMs: 1_800_000,
	});
	expect(readHistory(t.paths, 10).map((h) => h.result)).toEqual(["failed", "failed"]);
});

test("the trial run refuses a kernel or NVIDIA package, and the root install never starts", async () => {
	const trial = ok(
		"Inst perl [1] (2)\nInst linux-image-6.8.0-150-generic (6.8.0-150.150 Ubuntu:24.04/noble-updates [amd64])\nInst libnvidia-gl-580 [580.178] (580.182)\n",
	);
	const { run, calls } = box(new Map([[trialArgv(PERL_IGNORE).join(" "), trial]]));
	const x = await shown(run);
	expect(x.installSystem(["apt:perl"], plan(x, ["apt:perl"]))).toEqual({ started: true });
	await x.idle();
	expect(x.snapshot().system.install).toMatchObject({
		refused: MESSAGES.systemTrialNamesRestart("linux-image-6.8.0-150-generic, libnvidia-gl-580"),
		outcomes: [],
	});
	expect(calls.some((c) => isRootInstall(c.argv))).toBe(false);
	expect(readHistory(t.paths, 10)).toEqual([]);
	expect(existsSync(join(t.paths.state, "run.lock"))).toBe(false);
});

test("pre-checks refuse with a sentence and run nothing: sudo, the dpkg lock, polkit, a changed list", async () => {
	const cases: [Map<string, ProcessResult>, string[], string][] = [
		[
			new Map([[SUDO_CHECK.join(" "), exit(1, "", "sudo: a password is required")]]),
			["apt:perl"],
			MESSAGES.systemSudo(),
		],
		[
			new Map([[DPKG_LOCK_CHECK.join(" "), exit(0, "", "/var/lib/dpkg/lock-frontend: 4242")]]),
			["apt:perl"],
			MESSAGES.systemAptBusy(),
		],
		[
			new Map([[DPKG_LOCK_CHECK.join(" "), exit(1, "", "sudo: fuser: command not found")]]),
			["apt:perl"],
			MESSAGES.systemAptBusy(),
		],
		[
			new Map([[`pkcheck --action-id org.freedesktop.Flatpak.runtime-update --process ${process.pid}`, exit(1)]]),
			[DISCORD, PLATFORM],
			MESSAGES.systemPolkit(),
		],
	];
	for (const [over, ids, reason] of cases) {
		const { run, calls } = box(over);
		// oxlint-disable-next-line no-await-in-loop -- each case gets its own extras, one after another
		const x = await shown(run);
		expect(x.installSystem(ids, plan(x, ids))).toEqual({ started: true });
		// oxlint-disable-next-line no-await-in-loop -- as above
		await x.idle();
		expect(x.snapshot().system.install?.refused).toBe(reason);
		expect(calls.some((c) => isRootInstall(c.argv) || c.argv.slice(0, 2).join(" ") === "flatpak update")).toBe(false);
	}
	// What runs must be what was shown.
	const { run } = box();
	const x = await shown(run);
	expect(x.installSystem(["apt:perl"], [["sudo", "-n", "mintupdate-cli", "upgrade", "-y"]])).toEqual({
		started: false,
		reason: MESSAGES.systemListChanged(),
	});
	expect(x.installSystem(["apt:linux"], [])).toEqual({ started: false, reason: MESSAGES.systemNothing() });
});

test("installing is off unless switched on, and a lock another run holds is never released by a refused System install", async () => {
	const { run } = box();
	updateExtras(t.paths, { system: "show" });
	const off = createExtras({ paths: t.paths, run, now: () => new Date() });
	await off.idle();
	expect(off.snapshot().system.installable).toBeUndefined();
	expect(off.planSystem(["apt:perl"])).toEqual({ commands: [], reason: MESSAGES.systemNothing() });
	expect(off.installSystem(["apt:perl"], [])).toEqual({ started: false, reason: MESSAGES.systemNothing() });

	const x = await shown(run);
	// The engine's own lock, under the same pid.
	expect(claimLock(t.paths)).toBe(true);
	const lock = join(t.paths.state, "run.lock");
	const held = readFileSync(lock, "utf8");
	expect(x.installSystem(["apt:perl"], plan(x, ["apt:perl"]))).toEqual({
		started: false,
		reason: MESSAGES.reasonBusy(),
	});
	expect(readFileSync(lock, "utf8")).toBe(held);
	// Released under another owner, it stays; only its own owner frees it.
	releaseLock(t.paths, process.pid, "system");
	expect(readFileSync(lock, "utf8")).toBe(held);
	releaseLock(t.paths);
	expect(existsSync(lock)).toBe(false);
	// While a System install holds it, the engine cannot claim it.
	expect(x.installSystem(["apt:perl"], plan(x, ["apt:perl"]))).toEqual({ started: true });
	expect(claimLock(t.paths)).toBe(false);
	releaseLock(t.paths);
	expect(existsSync(lock)).toBe(true);
	await x.idle();
	expect(existsSync(lock)).toBe(false);
});

test("Update Manager's own priority updates come with any apt install, since mintupdate-cli ignores -i for them", () => {
	const rows = [
		row("apt:perl", "apt", "security"),
		row("apt:mintupdate", "apt", "package"),
		row("apt:mint-upgrade-info", "apt", "package"),
	];
	const steps = planSteps(rows, ["apt:perl"], "mint");
	expect(steps[0]?.ids.toSorted()).toEqual(["apt:mint-upgrade-info", "apt:mintupdate", "apt:perl"]);
	expect(steps[0]?.argv.at(-1)).toBe(GLOBS);
	// Nothing apt ticked: they do not come along.
	expect(planSteps(rows, [], "mint")).toEqual([]);
});

test("a trial run that failed, checked nothing, or removes a package refuses; a sudoers rule refusing fuser is sudo", async () => {
	const cases: [Map<string, ProcessResult>, string][] = [
		[
			new Map([[trialArgv(PERL_IGNORE).join(" "), exit(0, "Inst perl [1] (2)\n", "E: Could not get lock /var/lib/dpkg/lock-frontend")]]),
			MESSAGES.systemTrialFailed("E: Could not get lock /var/lib/dpkg/lock-frontend"),
		],
		[
			new Map([[trialArgv(PERL_IGNORE).join(" "), ok("NOTE: This is only a simulation!\n")]]),
			MESSAGES.systemTrialFailed("NOTE: This is only a simulation!"),
		],
		[
			new Map([[trialArgv(PERL_IGNORE).join(" "), ok("Inst perl [1] (2)\nRemv libfoo1 [1]\n")]]),
			MESSAGES.systemTrialRemoves("libfoo1"),
		],
		[new Map([[DPKG_LOCK_CHECK.join(" "), exit(1, "", "sudo: a password is required")]]), MESSAGES.systemSudo()],
	];
	for (const [over, refused] of cases) {
		rmSync(join(t.paths.state), { recursive: true, force: true });
		const { run, calls } = box(over);
		// oxlint-disable-next-line no-await-in-loop -- each case is its own install
		const x = await shown(run);
		expect(x.installSystem(["apt:perl"], plan(x, ["apt:perl"]))).toEqual({ started: true });
		// oxlint-disable-next-line no-await-in-loop -- each case is its own install
		await x.idle();
		expect(x.snapshot().system.install?.refused).toBe(refused);
		expect(calls.some((c) => isRootInstall(c.argv))).toBe(false);
	}
});

test("while an install runs, the group and its switch cannot be turned off, and it counts as installing to the end", async () => {
	let release: (() => void) | undefined;
	const slow = new Promise<ProcessResult>((r) => {
		release = () => r(ok());
	});
	const { run } = box(new Map([[aptArgv(PERL_IGNORE).join(" "), slow]]));
	const x = await shown(run);
	expect(x.installSystem(["apt:perl"], plan(x, ["apt:perl"]))).toEqual({ started: true });
	await Bun.sleep(20);
	expect(x.installing()).toBe(true);
	expect(x.setSettings({ system: "off" }).system).toBe("show");
	expect(x.setSettings({ systemInstall: false }).systemInstall).toBe(true);
	expect(x.snapshot().system.phase).toBe("installing");
	release?.();
	await x.idle();
	expect(x.installing()).toBe(false);
	expect(x.setSettings({ system: "off" }).system).toBe("off");
});
