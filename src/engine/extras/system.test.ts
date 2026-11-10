import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Call, ok, strictRun, tempHome } from "../testkit";
import type { RunResult } from "../run";
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

const missing: RunResult = { code: 127, stdout: "", stderr: "Executable not found in $PATH", timedOut: false };

/** Answers the seven commands from the fixtures, with overrides by argv; anything else throws. */
function box(over: Map<string, RunResult | Promise<RunResult>> = new Map()) {
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
			name: "com.discordapp.Discord",
			type: "app",
			installed: "1.0.168",
			latest: "1.0.169",
			running: false,
		},
		{
			id: "flatpak:app/org.gimp.GIMP/x86_64/stable",
			source: "flatpak",
			name: "org.gimp.GIMP",
			type: "app",
			installed: "3.2.8",
			latest: "3.2.8",
			running: false,
		},
		{
			id: "flatpak:runtime/org.gnome.Platform/x86_64/51",
			source: "flatpak",
			name: "org.gnome.Platform",
			type: "runtime",
			installed: null,
			latest: "51",
			running: false,
		},
	]);
	// Only "ii" driver lines count, and this box has the runtime for its driver.
	expect(glMissing(fx("dpkg-gl.txt"), fx("flatpak-runtimes.txt"))).toBeNull();
	expect(glMissing("un \t\nii \t590.44.01-0ubuntu1\n", fx("flatpak-runtimes.txt"))).toBe("590.44.01");
	expect(glMissing("un \t\nrc \t570.1-1\n", "")).toBeNull();
	expect(parseFlatpakUpdates("app/us.zoom.Zoom/x86_64/stable\t7.0\n", "", "us.zoom.Zoom\n")[0]?.running).toBe(true);
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
		["flatpak:runtime/org.gnome.Platform/x86_64/51", "runtime", null, "51"],
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
	const noMint = await checkSystem(box(new Map([[MINT_LIST.join(" "), missing]])));
	expect(noMint.problem).toEqual({ code: "missing", command: "mintupdate-cli list" });
	expect(noMint.rows.map((x) => x.source)).toEqual(["flatpak", "flatpak", "flatpak"]);
});

test("a timeout or a failing command is a failed problem with the first line of stderr", async () => {
	const timedOut: RunResult = { code: 137, stdout: "", stderr: "", timedOut: true };
	const offline: RunResult = {
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
		system: { mode: "off", phase: "off", rows: [], checkedAt: null, problem: null, glMissing: null },
	});
	expect(x.checkSystem()).toEqual({ started: false });
	await x.idle();
	expect(calls).toEqual([] as Call[]);
});

test("shown: it checks at start, again when asked, never twice at once, and turning off clears the rows", async () => {
	updateExtras(t.paths, { system: "show" });
	let release: (() => void) | undefined;
	const gate = new Promise<RunResult>((r) => {
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
	});
	expect(loadExtras(t.paths)).toEqual({ system: "off" });
});

test("a strict runner refuses any argv it was not told about", async () => {
	const { run } = strictRun(() => undefined);
	await expect(run(["sudo", "true"])).rejects.toThrow("strictRun: no answer for sudo true");
});
