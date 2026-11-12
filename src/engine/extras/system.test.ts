import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Call, ok, strictRun, tempHome } from "../testkit";
import type { ProcessResult } from "../run";
import { createExtras } from "./extras";
import { DEFAULT_EXTRAS, loadExtras, updateExtras } from "./state";
import {
	checkSystem,
	DRIVER_GL,
	FLATPAK_INSTALLED,
	FLATPAK_RUNNING,
	FLATPAK_RUNTIMES,
	FLATPAK_UPDATES,
	glMissing,
	MINT_LIST,
	APT_LIST,
	DNF_LIST,
	PACMAN_CHECK,
	PACMAN_LIST,
	ZYPPER_LIST,
	RPM_VERSIONS,
	parseAptList,
	parseDnfList,
	parsePacmanList,
	parseFlatpakUpdates,
	parseMintList,
	parseSourceVersions,
	SOURCE_VERSIONS,
} from "./system";

const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const FIXTURES: [string[], string][] = [
	[MINT_LIST, "mint-list.txt"],
	[SOURCE_VERSIONS, "dpkg-sources.txt"],
	[FLATPAK_UPDATES, "flatpak-updates.txt"],
	[FLATPAK_INSTALLED, "flatpak-list.txt"],
	[FLATPAK_RUNNING, "flatpak-ps.txt"],
	[DRIVER_GL, "dpkg-gl.txt"],
	[FLATPAK_RUNTIMES, "flatpak-runtimes.txt"],
];

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("extras");
});
afterEach(() => t.cleanup());

const missing: ProcessResult = { code: 127, stdout: "", stderr: "Executable not found in $PATH", timedOut: false };

/** Answers the seven commands from the fixtures, with overrides by argv; anything else throws. */
function box(over: Map<string, ProcessResult | Promise<ProcessResult>> = new Map()) {
	return strictRun((argv) => {
		const key = argv.join(" ");
		const o = over.get(key);
		if (o) return o;
		const hit = FIXTURES.find(([a]) => a.join(" ") === key);
		return hit ? ok(fx(hit[1])) : undefined;
	});
}

test("parsers read the real output saved from this box", () => {
	expect(parseMintList(fx("mint-list.txt"))).toEqual([
		{ type: "package", source: "google-chrome-stable", version: "157.0.8103.50-1" },
		{ type: "security", source: "libgphoto2", version: "2.5.31-2.1ubuntu1.2" },
		{ type: "security", source: "libnfs", version: "5.0.2-1ubuntu0.24.04.2" },
		{ type: "security", source: "libsoup3", version: "3.4.4-5ubuntu0.11" },
		{ type: "security", source: "openjdk-21", version: "21.0.13.0.3+1-1~24.04.1" },
		{ type: "security", source: "openjdk-8", version: "8u512-b09~us1-0ubuntu1~24.04.1" },
		{ type: "security", source: "perl", version: "5.38.2-3.2ubuntu0.7" },
	]);
	expect(parseSourceVersions(fx("dpkg-sources.txt")).get("perl")).toBe("5.38.2-3.2ubuntu0.6");
	expect(parseFlatpakUpdates(fx("flatpak-updates.txt"), fx("flatpak-list.txt"), fx("flatpak-ps.txt"))).toEqual([
		{
			id: "flatpak:app/com.discordapp.Discord/x86_64/stable",
			source: "flatpak",
			name: "Discord",
			type: "app",
			installed: "1.0.168",
			latest: "1.0.169",
			running: false,
		},
		{
			id: "flatpak:app/org.gimp.GIMP/x86_64/stable",
			source: "flatpak",
			name: "GNU Image Manipulation Program",
			type: "app",
			installed: "3.2.8",
			latest: "3.2.8",
			running: false,
		},
		{
			id: "flatpak:runtime/org.gnome.Platform/x86_64/51",
			source: "flatpak",
			name: "GNOME Application Platform",
			type: "runtime",
			installed: "51",
			latest: "51",
			running: false,
		},
	]);
	// Only "ii" driver lines count, and this box has the runtime for its driver.
	expect(glMissing(fx("dpkg-gl.txt"), fx("flatpak-runtimes.txt"))).toBeNull();
	expect(glMissing("un \t\nii \t590.44.01-0ubuntu1\n", fx("flatpak-runtimes.txt"))).toBe("590.44.01");
	expect(glMissing("un \t\nrc \t570.1-1\n", "")).toBeNull();
	expect(parseFlatpakUpdates("app/us.zoom.Zoom/x86_64/stable\tZoom\t7.0\n", "", "us.zoom.Zoom\n")[0]?.running).toBe(
		true,
	);
	// No name from Flatpak: the last segment of the id, never the whole id. A runtime not installed stays null.
	const bare = parseFlatpakUpdates(
		"app/org.gimp.GIMP/x86_64/stable\t\t3.2.9\nruntime/org.kde.Platform/x86_64/6.9\tKDE Application Platform 6.9\n",
		"",
		"",
	);
	expect(bare.map((r) => [r.name, r.installed, r.latest])).toEqual([
		["GIMP", null, "3.2.9"],
		["KDE Application Platform", null, "6.9"],
	]);
});

test("a check lists Update Manager's rows and Flatpak's, with installed versions", async () => {
	const { run } = box();
	const r = await checkSystem({ run });
	expect(r.problem).toBeNull();
	expect(r.rows.map((x) => [x.id, x.type, x.installed, x.latest])).toEqual([
		["apt:google-chrome-stable", "package", "157.0.8103.38-1", "157.0.8103.50-1"],
		["apt:libgphoto2", "security", "2.5.31-2.1ubuntu1.1", "2.5.31-2.1ubuntu1.2"],
		["apt:libnfs", "security", "5.0.2-1ubuntu0.24.04.1", "5.0.2-1ubuntu0.24.04.2"],
		["apt:libsoup3", "security", "3.4.4-5ubuntu0.10", "3.4.4-5ubuntu0.11"],
		["apt:openjdk-21", "security", "21.0.12.1+1-1~24.04.4", "21.0.13.0.3+1-1~24.04.1"],
		["apt:openjdk-8", "security", "8u504-ga-1ubuntu1~24.04.3", "8u512-b09~us1-0ubuntu1~24.04.1"],
		["apt:perl", "security", "5.38.2-3.2ubuntu0.6", "5.38.2-3.2ubuntu0.7"],
		["flatpak:app/com.discordapp.Discord/x86_64/stable", "app", "1.0.168", "1.0.169"],
		["flatpak:app/org.gimp.GIMP/x86_64/stable", "app", "3.2.8", "3.2.8"],
		["flatpak:runtime/org.gnome.Platform/x86_64/51", "runtime", "51", "51"],
	]);
	expect(r.glMissing).toBeNull();
});

test("kernel and driver rows carry the Update Manager note; rows come only from Update Manager's own list", async () => {
	const list =
		"kernel          linux-6.8.0-90                                6.8.0-90.91\n" +
		"package         nvidia-graphics-drivers-580                   580.200.01-0ubuntu1\n" +
		"security        perl                                          5.38.2-3.2ubuntu0.7\n";
	// A phased or held package is not in mintupdate-cli's output, so it is simply absent: nothing else is read for apt.
	const { run, calls } = box(new Map([[MINT_LIST.join(" "), ok(list)]]));
	const r = await checkSystem({ run });
	expect(r.rows.filter((x) => x.source === "apt").map((x) => [x.name, x.type, x.note ?? null])).toEqual([
		["linux-6.8.0-90", "kernel", "update-manager-only"],
		["nvidia-graphics-drivers-580", "driver", "update-manager-only"],
		["perl", "security", null],
	]);
	expect(calls.map((c) => c.argv.join(" ")).toSorted()).toEqual(FIXTURES.map(([a]) => a.join(" ")).toSorted());
	expect(calls.every((c) => c.opts.timeoutMs === 60_000)).toBe(true);
});

test("one source missing names the command; the other still lists", async () => {
	const { run } = box(new Map([[FLATPAK_UPDATES.join(" "), missing]]));
	const r = await checkSystem({ run });
	expect(r.problem).toEqual({ code: "missing", command: FLATPAK_UPDATES.join(" ") });
	expect(r.rows.every((x) => x.source === "apt")).toBe(true);
	expect(r.rows).toHaveLength(7);
	// No package list at all: Update Manager's missing command stands for them, said quietly by the view.
	const none = new Map(
		[MINT_LIST, APT_LIST, DNF_LIST, PACMAN_CHECK, PACMAN_LIST, ZYPPER_LIST].map((c) => [c.join(" "), missing]),
	);
	const noMint = await checkSystem(box(none));
	expect(noMint.problem).toEqual({ code: "missing", command: "mintupdate-cli list" });
	expect(noMint.packages).toBeNull();
	expect(noMint.rows.map((x) => x.source)).toEqual(["flatpak", "flatpak", "flatpak"]);
});

test("without Update Manager the first package list installed answers: apt, then dnf, then pacman, then zypper", async () => {
	const without = (...gone: string[][]) => new Map(gone.map((c) => [c.join(" "), missing]));
	const apt = await checkSystem(box(new Map([...without(MINT_LIST), [APT_LIST.join(" "), ok(fx("apt-list.txt"))]])));
	expect(apt.packages).toBe("apt");
	expect(apt.problem).toBeNull();
	expect(
		apt.rows.filter((r) => r.source === "apt").map((r) => [r.name, r.type, r.installed, r.latest, r.note]),
	).toEqual([
		["distro-info", "package", "1.7build1", "1.7ubuntu0.1", undefined],
		["libsoup-3.0-0", "security", "3.4.4-5ubuntu0.10", "3.4.4-5ubuntu0.11", undefined],
		["linux-image-generic", "kernel", "6.8.0-147.147", "6.8.0-149.149", "update-manager-only"],
		["nvidia-driver-580", "driver", "580.178.04-0ubuntu1", "580.182.02-0ubuntu1", "update-manager-only"],
	]);
	// dnf check-update exits 100 when it lists updates; rpm gives the installed versions.
	const dnf = await checkSystem(
		box(
			new Map([
				...without(MINT_LIST, APT_LIST),
				[DNF_LIST.join(" "), { code: 100, stdout: fx("dnf-list.txt"), stderr: "", timedOut: false }],
				[
					RPM_VERSIONS.join(" "),
					ok("firefox.x86_64\t145.0-2.fc43\nglibc.i686\t2.42-1.fc43\nglibc.x86_64\t2.42-1.fc43.1\n"),
				],
			]),
		),
	);
	expect(dnf.packages).toBe("dnf");
	expect(dnf.rows.filter((r) => r.source === "dnf").map((r) => [r.id, r.type, r.installed, r.latest])).toEqual([
		["dnf:firefox.x86_64", "package", "145.0-2.fc43", "146.0-1.fc43"],
		["dnf:glibc.x86_64", "package", "2.42-1.fc43.1", "2.42-2.fc43"],
		["dnf:glibc.i686", "package", "2.42-1.fc43", "2.42-2.fc43"],
		["dnf:python3-some-really-long-package-name-for-testing.noarch", "package", null, "3.13.1-1.fc43"],
		["dnf:kernel-core.x86_64", "kernel", null, "6.17.8-300.fc43"],
		["dnf:akmod-nvidia.x86_64", "driver", null, "3:580.105.08-1.fc43"],
		["dnf:nvidia-settings.x86_64", "package", null, "3:580.105.08-1.fc43"],
	]);
	// No checkupdates: pacman -Qu, which exits 1 when there is nothing.
	const pac = await checkSystem(
		box(
			new Map([
				...without(MINT_LIST, APT_LIST, DNF_LIST, PACMAN_CHECK),
				[PACMAN_LIST.join(" "), ok(fx("pacman-list.txt"))],
			]),
		),
	);
	expect(pac.packages).toBe("pacman");
	// The ignored package is left out; linux-firmware and nvidia-settings are plain packages.
	expect(pac.rows.filter((r) => r.source === "pacman").map((r) => [r.name, r.type, r.installed, r.latest])).toEqual([
		["firefox", "package", "145.0-1", "146.0-1"],
		["linux", "kernel", "6.17.7.arch1-1", "6.17.8.arch1-1"],
		["linux-firmware", "package", "20251021-1", "20251111-1"],
		["nvidia-utils", "driver", "580.95.05-1", "580.105.08-1"],
		["nvidia-settings", "package", "580.95.05-1", "580.105.08-1"],
	]);
	// checkupdates installed without fakeroot fails; pacman -Qu still lists.
	const noFakeroot = await checkSystem(
		box(
			new Map([
				...without(MINT_LIST, APT_LIST, DNF_LIST),
				[
					PACMAN_CHECK.join(" "),
					{ code: 1, stdout: "", stderr: "==> ERROR: Cannot find the fakeroot binary", timedOut: false },
				],
				[PACMAN_LIST.join(" "), ok(fx("pacman-list.txt"))],
			]),
		),
	);
	expect([noFakeroot.packages, noFakeroot.rows.filter((r) => r.source === "pacman").length]).toEqual(["pacman", 5]);
	expect(noFakeroot.problem).toBeNull();
	// openSUSE: zypper's table, read from Leap 16.0; kernel-default and the G06 GL driver need a restart.
	const zypper = await checkSystem(
		box(
			new Map([
				...without(MINT_LIST, APT_LIST, DNF_LIST, PACMAN_CHECK, PACMAN_LIST),
				[ZYPPER_LIST.join(" "), ok(fx("zypper-list.txt"))],
			]),
		),
	);
	expect(zypper.packages).toBe("zypper");
	expect(zypper.rows.filter((r) => r.source === "zypper").map((r) => [r.id, r.type, r.installed, r.latest])).toEqual([
		["zypper:curl.x86_64", "package", "8.14.1-160000.2.2", "8.14.1-160000.9.1"],
		["zypper:glibc.x86_64", "package", "2.40-160000.2.2", "2.40-160000.7.1"],
		["zypper:kernel-default.x86_64", "kernel", "6.12.0-160000.5.1", "6.12.0-160000.9.1"],
		["zypper:nvidia-gl-G06.x86_64", "driver", "580.95.05-1.1", "580.105.08-1.1"],
		["zypper:libcurl4.x86_64", "package", "8.14.1-160000.2.2", "8.14.1-160000.9.1"],
	]);
	const quiet = await checkSystem(
		box(
			new Map([
				...without(MINT_LIST, APT_LIST, DNF_LIST),
				[PACMAN_CHECK.join(" "), { code: 2, stdout: "", stderr: "", timedOut: false }],
			]),
		),
	);
	expect([quiet.packages, quiet.problem, quiet.rows.filter((r) => r.source === "pacman")]).toEqual([
		"pacman",
		null,
		[],
	]);
	// A list that is there but fails is a failed problem named by its own command, and lists nothing.
	const broken = await checkSystem(
		box(
			new Map([
				...without(MINT_LIST),
				[APT_LIST.join(" "), { code: 100, stdout: "", stderr: "E: lock", timedOut: false }],
			]),
		),
	);
	expect(broken.problem).toEqual({ code: "failed", command: "apt list --upgradable", detail: "E: lock" });
	expect(broken.rows.filter((r) => r.source === "apt")).toEqual([]);
	expect(parseAptList("Listing...\n")).toEqual([]);
	expect(parseDnfList("", new Map())).toEqual([]);
	expect(parsePacmanList("error: no database\n")).toEqual([]);
});

test("a timeout or a failing command is a failed problem with the first line of stderr", async () => {
	const timedOut: ProcessResult = { code: 137, stdout: "", stderr: "", timedOut: true };
	const offline: ProcessResult = {
		code: 1,
		stdout: "",
		stderr: "error: Couldn't resolve host name\nmore\n",
		timedOut: false,
	};
	const r = await checkSystem(
		box(
			new Map([
				[MINT_LIST.join(" "), timedOut],
				[FLATPAK_UPDATES.join(" "), offline],
			]),
		),
	);
	expect(r.problem).toEqual({ code: "failed", command: "mintupdate-cli list", detail: "" });
	expect(r.rows).toEqual([]);
	const f = await checkSystem(box(new Map([[FLATPAK_UPDATES.join(" "), offline]])));
	expect(f.problem).toEqual({
		code: "failed",
		command: FLATPAK_UPDATES.join(" "),
		detail: "error: Couldn't resolve host name",
	});
});

test("settings: defaults when absent or unreadable, clamped, written by rename", () => {
	expect(loadExtras(t.paths)).toEqual(DEFAULT_EXTRAS);
	expect(updateExtras(t.paths, { system: "show" })).toEqual({ system: "show" });
	expect(loadExtras(t.paths)).toEqual({ system: "show" });
	writeFileSync(join(t.paths.state, "extras.json"), '{"system":"install"}');
	expect(loadExtras(t.paths)).toEqual({ system: "off" });
	writeFileSync(join(t.paths.state, "extras.json"), "{bad");
	expect(loadExtras(t.paths)).toEqual({ system: "off" });
});

const deps = (run: ReturnType<typeof box>["run"]) => ({
	paths: t.paths,
	run,
	now: () => new Date("2026-11-10T20:00:00Z"),
});

test("mode off runs nothing at all", async () => {
	const { run, calls } = box();
	const x = createExtras(deps(run));
	expect(x.snapshot()).toEqual({
		settings: { system: "off" },
		system: { mode: "off", phase: "off", rows: [], checkedAt: null, problem: null, glMissing: null, packages: null },
	});
	expect(x.checkSystem()).toEqual({ started: false });
	await x.idle();
	expect(calls).toEqual([] as Call[]);
});

test("shown: it checks at start, again when asked, never twice at once, and turning off clears the rows", async () => {
	updateExtras(t.paths, { system: "show" });
	let release: (() => void) | undefined;
	const gate = new Promise<ProcessResult>((r) => {
		release = () => r(ok(fx("mint-list.txt")));
	});
	const { run, calls } = box(new Map([[MINT_LIST.join(" "), gate]]));
	const events: string[] = [];
	const x = createExtras(deps(run));
	x.subscribe((e) => {
		if (e.type === "extras") events.push(e.extras.system.phase);
	});
	expect(x.snapshot().system.phase).toBe("checking");
	expect(x.checkSystem()).toEqual({ started: false });
	release?.();
	await x.idle();
	expect(calls.filter((c) => c.argv[0] === "mintupdate-cli")).toHaveLength(1);
	expect(x.snapshot().system).toMatchObject({ mode: "show", phase: "idle", checkedAt: "2026-11-10T20:00:00.000Z" });
	expect(x.snapshot().system.rows).toHaveLength(10);
	expect(events).toEqual(["idle"]);
	expect(x.checkSystem()).toEqual({ started: true });
	await x.idle();
	expect(calls.filter((c) => c.argv[0] === "mintupdate-cli")).toHaveLength(2);
	x.setSettings({ system: "off" });
	expect(x.snapshot().system).toEqual({
		mode: "off",
		phase: "off",
		rows: [],
		checkedAt: null,
		problem: null,
		glMissing: null,
		packages: null,
	});
	expect(loadExtras(t.paths)).toEqual({ system: "off" });
});

test("a strict runner refuses any argv it was not told about", async () => {
	const { run } = strictRun(() => undefined);
	await expect(run(["sudo", "true"])).rejects.toThrow("strictRun: no answer for sudo true");
});

test("turning the area on checks at once, and a listener that throws does not stop the others", async () => {
	const { run, calls } = box();
	const x = createExtras(deps(run));
	const seen: string[] = [];
	x.subscribe(() => {
		throw new Error("listener broke");
	});
	const unsubscribe = x.subscribe((e) => {
		if (e.type === "extras") seen.push(e.extras.system.phase);
	});
	expect(x.setSettings({ system: "show" })).toEqual({ system: "show" });
	expect(x.snapshot().system.phase).toBe("checking");
	await x.idle();
	expect(seen).toEqual(["idle", "checking", "idle"]);
	expect(calls.filter((c) => c.argv[0] === "mintupdate-cli")).toHaveLength(1);
	unsubscribe();
	x.checkSystem();
	await x.idle();
	expect(seen).toHaveLength(3);
});

test("a check that throws is a failed problem with its message, and the area goes back to idle", async () => {
	updateExtras(t.paths, { system: "show" });
	const { run } = strictRun((argv) => {
		if (argv[0] === "mintupdate-cli") throw new Error("runner died");
		const hit = FIXTURES.find(([a]) => a.join(" ") === argv.join(" "));
		return hit ? ok(fx(hit[1])) : undefined;
	});
	const x = createExtras(deps(run));
	await x.idle();
	expect(x.snapshot().system).toMatchObject({
		mode: "show",
		phase: "idle",
		rows: [],
		problem: { code: "failed", command: "", detail: "runner died" },
	});
});

test("apt rows carry the arch in their id, and only kernels and the driver itself get the restart note", () => {
	const multi = parseAptList(
		"libc6/noble-updates 2.39-1 amd64 [upgradable from: 2.38]\nlibc6/noble-updates 2.39-1 i386 [upgradable from: 2.38]\n",
	);
	expect(multi.map((r) => r.id)).toEqual(["apt:libc6.amd64", "apt:libc6.i386"]);
	const typed = (names: string[]) =>
		Object.fromEntries(parsePacmanList(names.map((n) => `${n} 1 -> 2`).join("\n")).map((r) => [r.name, r.type]));
	expect(
		typed([
			"linux-cachyos",
			"linux-rt-lts",
			"linux-zen-headers",
			"kernel-devel",
			"linux-firmware",
			"linux-api-headers",
		]),
	).toEqual({
		"linux-cachyos": "kernel",
		"linux-rt-lts": "kernel",
		"linux-zen-headers": "kernel",
		"kernel-devel": "kernel",
		"linux-firmware": "package",
		"linux-api-headers": "package",
	});
	expect(
		typed([
			"nvidia-open-dkms",
			"libnvidia-gl-580",
			"lib32-nvidia-utils",
			"nvidia-cuda-toolkit",
			"xorg-x11-drv-nvidia-libs",
		]),
	).toEqual({
		"nvidia-open-dkms": "driver",
		"libnvidia-gl-580": "driver",
		"lib32-nvidia-utils": "driver",
		"nvidia-cuda-toolkit": "package",
		"xorg-x11-drv-nvidia-libs": "package",
	});
});

test("turned off and on during a check, only the newer check's answer lands", async () => {
	updateExtras(t.paths, { system: "show" });
	// The first check's Mint list waits on a gate and comes back empty; the second answers at once from the fixture.
	let releaseFirst: (() => void) | undefined;
	let first = true;
	const { run } = strictRun((argv) => {
		const key = argv.join(" ");
		if (key === MINT_LIST.join(" ") && first) {
			first = false;
			return new Promise<ProcessResult>((r) => {
				releaseFirst = () => r(ok(""));
			});
		}
		const hit = FIXTURES.find(([a]) => a.join(" ") === key);
		return hit ? ok(fx(hit[1])) : undefined;
	});
	const x = createExtras(deps(run));
	expect(x.snapshot().system.phase).toBe("checking");
	x.setSettings({ system: "off" });
	x.setSettings({ system: "show" });
	await Bun.sleep(20);
	// The second check has answered; the first, released now, must not replace its rows or its phase.
	expect(x.snapshot().system.rows.filter((r) => r.source === "apt").length).toBeGreaterThan(0);
	releaseFirst?.();
	await x.idle();
	// The overtaken check is no longer the one idle() waits on: give it time to settle.
	await Bun.sleep(20);
	expect(x.snapshot().system.phase).toBe("idle");
	expect(x.snapshot().system.rows.filter((r) => r.source === "apt").length).toBeGreaterThan(0);
});
