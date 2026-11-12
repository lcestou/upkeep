import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { MESSAGES } from "../../shared/messages";
import type { CleanupItem } from "../../shared/types";
import type { ProcessResult } from "../run";
import { claimLock, readHistory, releaseLock } from "../store";
import { ok, strictRun, tempHome } from "../testkit";
import {
	APT_CACHE_SIZES,
	AUTOREMOVE_SIM,
	clean,
	type CleanupCtx,
	FLATPAK_RUNTIME_SIZES,
	insideRoot,
	JOURNAL_SIZE,
	KERNELS,
	measureCandidates as measure,
	measureTree,
	parseSize,
	removeTree,
	review,
	RUNNING_KERNEL,
	TIMESHIFT_SNAPSHOTS,
	TMP_SIZE,
} from "./cleanup";
import { createExtras } from "./extras";
import { updateExtras } from "./state";
import { DRIVER_GL } from "./system";

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("cleanup");
});
afterEach(() => t.cleanup());

const missing: ProcessResult = { code: 127, stdout: "", stderr: "not found", timedOut: false };
/** The read-only commands a measure runs; every one is missing unless a test answers it. */
const MEASURES = new Set(
	[
		APT_CACHE_SIZES,
		AUTOREMOVE_SIM,
		FLATPAK_RUNTIME_SIZES,
		DRIVER_GL,
		TMP_SIZE,
		JOURNAL_SIZE,
		RUNNING_KERNEL,
		KERNELS,
		TIMESHIFT_SNAPSHOTS,
	].map((a) => a.join(" ")),
);

/**
 * The strict runner: an answered argv gets its answer, a measure's read-only command not answered is missing, and any
 * other argv throws, so no test can reach a real command that changes something.
 */
function box(answers: Record<string, ProcessResult | (() => ProcessResult)> = {}) {
	return strictRun((argv) => {
		const key = argv.join(" ");
		const a = answers[key];
		if (a) return typeof a === "function" ? a() : a;
		return MEASURES.has(key) ? missing : undefined;
	});
}

/** A cleanup context over the temp home, with a stand-in /proc that has no NVIDIA module. */
const ctxOf = (run: ReturnType<typeof box>["run"], over: Partial<CleanupCtx> = {}): CleanupCtx => ({
	run,
	paths: t.paths,
	pid: 4242,
	procRoot: join(t.dir, "proc"),
	devCaches: false,
	leftoverDirs: [],
	log: () => undefined,
	...over,
});

/** Writes a file of n bytes, making its folder. */
function put(path: string, n: number) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "x".repeat(n));
	return path;
}

const thumbs = () => join(t.dir, "cache", "thumbnails");
const itemOf = (items: CleanupItem[], id: CleanupItem["id"]) => items.find((i) => i.id === id);
const pickAll = (items: CleanupItem[]) =>
	items.filter((i) => i.group !== "shown").map((i) => ({ id: i.id, partIds: i.parts.map((p) => p.id) }));

test("sole-link sizes: a hard-linked pair frees nothing, a file with one link counts", async () => {
	const dir = join(t.dir, "cache", "uv");
	put(join(dir, "a"), 100);
	linkSync(join(dir, "a"), join(dir, "b"));
	put(join(dir, "sub", "c"), 50);
	expect((await measureTree(dir)).bytes).toBe(50);
});

test("insideRoot holds a path strictly below the root, by name", () => {
	expect(insideRoot("/r", "/r/a/b")).toBe(true);
	expect(insideRoot("/r", "/r")).toBe(false);
	expect(insideRoot("/r", "/r/../x")).toBe(false);
	expect(insideRoot("/r", "/rx/a")).toBe(false);
	expect(insideRoot("/r", "/r/..a")).toBe(true);
});

test("sizes read the way journalctl and flatpak write them", () => {
	expect(parseSize("40.8M", 1024)).toBe(Math.round(40.8 * 1024 ** 2));
	expect(parseSize("901.9 MB", 1000)).toBe(901_900_000);
	expect(parseSize("163.8 kB", 1000)).toBe(163_800);
	expect(parseSize("nothing", 1000)).toBeNull();
});

test("the symlink canary: a link inside the root is removed itself, and what it points at outside survives", async () => {
	const outside = join(t.dir, "outside");
	const canary = put(join(outside, "keep", "canary.txt"), 7);
	put(join(thumbs(), "normal", "a.png"), 300);
	put(join(thumbs(), "large", "b.png"), 200);
	symlinkSync(join(outside, "keep"), join(thumbs(), "normal", "dirlink"));
	symlinkSync(canary, join(thumbs(), "large", "filelink"));
	// A size folder that is itself a link out is passed by, never emptied.
	symlinkSync(join(outside, "keep"), join(thumbs(), "fail"));
	const { run } = box();
	const ctx = ctxOf(run);
	const m = await measure(ctx);
	expect(itemOf(m.items, "thumbnails")?.bytes).toBe(500);
	const out = await clean(pickAll(m.items), m, ctx, () => undefined);
	expect(out).toEqual([{ id: "thumbnails", status: "done", freed: 500 }]);
	expect(readFileSync(canary, "utf8")).toBe("xxxxxxx");
	expect(existsSync(join(thumbs(), "normal", "dirlink"))).toBe(false);
	expect(existsSync(join(thumbs(), "normal", "a.png"))).toBe(false);
	expect(lstatSync(join(thumbs(), "fail")).isSymbolicLink()).toBe(true);
	expect(existsSync(join(thumbs(), "normal"))).toBe(true);
});

test("the same-device rule: a tree on another device than the root's is left whole", async () => {
	const file = put(join(t.dir, "cache", "thumbnails", "normal", "a.png"), 10);
	const dev = lstatSync(file).dev;
	const err = await removeTree(join(t.dir, "cache", "thumbnails", "normal"), dev + 1).catch((e: Error) => e);
	expect(err).toBeInstanceOf(Error);
	expect(existsSync(file)).toBe(true);
});

test("a part changed after review is skipped with its sentence, and the unchanged part is still deleted", async () => {
	const kept = put(join(thumbs(), "normal", "a.png"), 300);
	put(join(t.dir, "data", "Trash", "files", "old.txt"), 40);
	put(join(t.dir, "data", "Trash", "info", "old.txt.trashinfo"), 60);
	const { run } = box();
	const ctx = ctxOf(run);
	const m = await measure(ctx);
	expect(m.items.map((i) => i.id)).toEqual(["thumbnails", "trash"]);
	// A thumbnail written between the review and the press.
	put(join(thumbs(), "normal", "new.png"), 5);
	const out = await clean(pickAll(m.items), m, ctx, () => undefined);
	expect(out).toEqual([
		{ id: "thumbnails", status: "skipped", freed: 0, detail: MESSAGES.cleanChanged() },
		{ id: "trash", status: "done", freed: 100 },
	]);
	expect(existsSync(kept)).toBe(true);
	expect(existsSync(join(t.dir, "data", "Trash", "files", "old.txt"))).toBe(false);
	expect(existsSync(join(t.dir, "data", "Trash", "files"))).toBe(true);
});

test("the fixed root argv: the review names apt's two commands verbatim, and clean runs exactly those after sudo -n true", async () => {
	const { run, calls } = box({
		[APT_CACHE_SIZES.join(" ")]: ok("1000\n2000\n"),
		[AUTOREMOVE_SIM.join(" ")]: ok("NOTE: simulation\nRemv libfoo1 [1.0]\nRemv libbar2 [2.0]\n"),
		"sudo -n true": ok(),
		"sudo -n apt-get clean": ok(),
		"sudo -n env DEBIAN_FRONTEND=noninteractive apt-get autoremove -y": ok(),
	});
	const ctx = ctxOf(run);
	const m = await measure(ctx);
	expect(itemOf(m.items, "apt-cache")).toMatchObject({ bytes: 3000, root: true, group: "safe" });
	expect(itemOf(m.items, "autoremove")).toMatchObject({
		root: true,
		typeToConfirm: true,
		group: "choice",
		parts: [{ id: "all", label: "libbar2, libfoo1", bytes: 0, ticked: false }],
	});
	const picks = pickAll(m.items);
	expect(review(picks, m).commands).toEqual([
		["sudo", "-n", "apt-get", "clean"],
		["sudo", "-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "autoremove", "-y"],
	]);
	calls.length = 0;
	await clean(picks, m, ctx, () => undefined);
	const changing = calls.map((c) => c.argv.join(" ")).filter((a) => !MEASURES.has(a));
	expect(changing).toEqual([
		"sudo -n true",
		"sudo -n apt-get clean",
		"sudo -n env DEBIAN_FRONTEND=noninteractive apt-get autoremove -y",
	]);
	expect(calls.find((c) => c.argv[2] === "apt-get")?.opts).toMatchObject({ group: true, timeoutMs: 600_000 });
});

test("without sudo, root parts are skipped with their sentence and nothing root runs", async () => {
	const { run, calls } = box({
		[APT_CACHE_SIZES.join(" ")]: ok("1000\n"),
		"sudo -n true": { code: 1, stdout: "", stderr: "sudo: a password is required", timedOut: false },
	});
	const ctx = ctxOf(run);
	const m = await measure(ctx);
	const out = await clean(pickAll(m.items), m, ctx, () => undefined);
	expect(out).toEqual([{ id: "apt-cache", status: "skipped", freed: 0, detail: MESSAGES.cleanSudo() }]);
	expect(calls.some((c) => c.argv.join(" ") === "sudo -n apt-get clean")).toBe(false);
});

test("old NVIDIA GL runtimes: only versions neither dpkg nor the module uses, removed after pkcheck", async () => {
	put(join(t.dir, "proc", "driver", "nvidia", "version"), 0);
	writeFileSync(
		join(t.dir, "proc", "driver", "nvidia", "version"),
		"NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  580.178.04  Release Build\n",
	);
	const list = [
		"org.freedesktop.Platform.GL.nvidia-580-159-03\tx86_64\t1.4\tsystem\t901.9 MB",
		"org.freedesktop.Platform.GL.nvidia-580-178-04\tx86_64\t1.4\tsystem\t903.3 MB",
		"org.freedesktop.Platform.VAAPI.nvidia\tx86_64\t25.08\tsystem\t163.8 kB",
	].join("\n");
	const ref = "org.freedesktop.Platform.GL.nvidia-580-159-03/x86_64/1.4";
	const { run, calls } = box({
		[FLATPAK_RUNTIME_SIZES.join(" ")]: ok(list),
		[DRIVER_GL.join(" ")]: ok("un\t\nii\t580.178.04-0ubuntu0.24.04.1\n"),
		"pkcheck --action-id org.freedesktop.Flatpak.runtime-uninstall --process 4242": ok(),
		[`flatpak uninstall --system -y --noninteractive ${ref}`]: ok(),
	});
	const ctx = ctxOf(run);
	const m = await measure(ctx);
	expect(itemOf(m.items, "flatpak-gl")?.parts).toEqual([{ id: ref, label: ref, bytes: 901_900_000, ticked: true }]);
	await clean(pickAll(m.items), m, ctx, () => undefined);
	const order = calls.map((c) => c.argv[0]).filter((a) => a === "pkcheck" || a === "flatpak");
	expect(order.slice(-3)).toEqual(["pkcheck", "flatpak", "flatpak"]);
	expect(calls.some((c) => c.argv.join(" ") === `flatpak uninstall --system -y --noninteractive ${ref}`)).toBe(true);
});

test("with no NVIDIA driver found, no GL runtime is offered", async () => {
	const { run } = box({
		[FLATPAK_RUNTIME_SIZES.join(" ")]: ok(
			"org.freedesktop.Platform.GL.nvidia-580-159-03\tx86_64\t1.4\tsystem\t901.9 MB",
		),
	});
	expect(itemOf((await measure(ctxOf(run))).items, "flatpak-gl")).toBeUndefined();
});

test("leftovers: listed only beside a live file, ticked only when older than it; restore points start unticked", async () => {
	const bin = join(t.dir, "home", "bin");
	put(join(bin, "fd"), 10);
	put(join(bin, "fd.upkeep-new"), 20);
	put(join(bin, "rg"), 10);
	put(join(bin, "rg.upkeep-tmp"), 30);
	put(join(bin, "gone.upkeep-new"), 40);
	put(join(bin, "tool.bak-20261026"), 5);
	const old = new Date("2026-01-01T00:00:00Z");
	utimesSync(join(bin, "fd.upkeep-new"), old, old);
	const later = new Date(Date.now() + 60_000);
	utimesSync(join(bin, "rg.upkeep-tmp"), later, later);
	put(join(t.dir, "data", "upkeep", "backups", "fd", "10.5.1", "fd"), 70);
	const { run } = box();
	const m = await measure(ctxOf(run, { leftoverDirs: [bin] }));
	expect(itemOf(m.items, "leftovers")?.parts).toEqual([
		{ id: join(bin, "fd.upkeep-new"), label: join(bin, "fd.upkeep-new"), bytes: 20, ticked: true },
		{ id: join(bin, "rg.upkeep-tmp"), label: join(bin, "rg.upkeep-tmp"), bytes: 30, ticked: false, note: "newer-copy" },
	]);
	expect(itemOf(m.items, "restore-points")?.parts).toEqual([
		{ id: "fd/10.5.1", label: "fd 10.5.1", bytes: 70, ticked: false },
	]);
	expect(itemOf(m.items, "hand-backups")).toMatchObject({ group: "shown", bytes: 5, parts: [], info: { count: 1 } });
});

test("shown-only items carry their figures and no parts", async () => {
	const { run } = box({
		[TMP_SIZE.join(" ")]: { code: 1, stdout: "7000\t/tmp\n", stderr: "du: cannot read", timedOut: false },
		[JOURNAL_SIZE.join(" ")]: ok("Archived and active journals take up 40.8M in the file system.\n"),
		[RUNNING_KERNEL.join(" ")]: ok("6.8.0-147-generic\n"),
		[KERNELS.join(" ")]: ok(
			"linux-image-6.8.0-149-generic\nlinux-image-6.8.0-147-generic\nlinux-image-6.8.0-142-generic\n",
		),
		[TIMESHIFT_SNAPSHOTS.join(" ")]: ok("2026-11-12_06-02-40\n2026-11-12_14-11-59\n"),
	});
	const m = await measure(ctxOf(run));
	expect(m.items.map((i) => [i.id, i.group, i.bytes, i.parts.length])).toEqual([
		["tmp", "shown", 7000, 0],
		["journal", "shown", Math.round(40.8 * 1024 ** 2), 0],
		["kernels", "shown", null, 0],
		["timeshift", "shown", null, 0],
	]);
	expect(itemOf(m.items, "kernels")?.info).toEqual({
		running: "6.8.0-147-generic",
		newest: "6.8.0-149-generic",
		count: 3,
	});
	expect(itemOf(m.items, "timeshift")?.info).toEqual({ count: 2, newest: "2026-11-12_14-11-59" });
	// A shown item can never be picked.
	expect(review([{ id: "tmp", partIds: ["all"] }], m)).toEqual({ bytes: 0, commands: [], parts: 0, items: [] });
});

test("developer caches join only behind their switch, and a tool not on PATH leaves its cache out", async () => {
	put(join(t.dir, "cache", "uv", "wheel"), 64);
	put(join(t.dir, "home", ".npm", "_cacache", "x"), 8);
	const { run } = box({
		"uv --version": ok("uv 0.9.0"),
		"npm --version": missing,
		"bun --version": ok("1.3"),
		"pip --version": missing,
	});
	expect(itemOf((await measure(ctxOf(run))).items, "uv")).toBeUndefined();
	const m = await measure(ctxOf(run, { devCaches: true }));
	expect(
		m.items.filter((i) => ["uv", "bun", "npm", "pip"].includes(i.id)).map((i) => [i.id, i.bytes, i.parts[0]?.ticked]),
	).toEqual([["uv", 64, false]]);
	expect(review(pickAll(m.items), m).commands).toEqual([["uv", "cache", "clean"]]);
});

/** Extras with Cleanup on, over the temp home. */
function extrasOn(run: ReturnType<typeof box>["run"]) {
	updateExtras(t.paths, { cleanup: true });
	return createExtras({ paths: t.paths, run, now: () => new Date("2026-11-12T10:00:00Z") });
}

test("the run lock: a cleanup is refused while an install holds it, deletes nothing, and never frees that lock", async () => {
	const file = put(join(thumbs(), "normal", "a.png"), 300);
	const { run } = box();
	const x = extrasOn(run);
	expect(x.measureCleanup()).toEqual({ started: true });
	await x.idle();
	const picks = pickAll(x.snapshot().cleanup.items);
	const { commands } = x.reviewCleanup(picks);
	expect(claimLock(t.paths, process.pid, "/proc")).toBe(true);
	expect(x.runCleanup(picks, commands)).toEqual({ started: false, reason: MESSAGES.reasonBusy() });
	await x.idle();
	expect(existsSync(file)).toBe(true);
	expect(readFileSync(join(t.paths.state, "run.lock"), "utf8").split(" ").length).toBe(2);
	releaseLock(t.paths, process.pid);
	// Free now: it runs, and while it runs the engine cannot claim the lock.
	expect(x.runCleanup(picks, commands)).toEqual({ started: true });
	expect(claimLock(t.paths, process.pid, "/proc")).toBe(false);
	expect(x.installing()).toBe(true);
	await x.idle();
	expect(existsSync(file)).toBe(false);
	expect(existsSync(join(t.paths.state, "run.lock"))).toBe(false);
	const rows = readHistory(t.paths, 10);
	expect(rows.map((r) => [r.key, r.result, r.freed])).toEqual([["cleanup:thumbnails", "cleaned", 300]]);
	expect(x.snapshot().cleanup.last?.outcomes).toEqual([{ id: "thumbnails", status: "done", freed: 300 }]);
});

test("a run whose commands differ from the review, or that removes packages without the word typed, is refused", async () => {
	const { run, calls } = box({
		[AUTOREMOVE_SIM.join(" ")]: ok("Remv libfoo1 [1.0]\n"),
	});
	const x = extrasOn(run);
	x.measureCleanup();
	await x.idle();
	const picks = pickAll(x.snapshot().cleanup.items);
	const { commands } = x.reviewCleanup(picks);
	expect(x.runCleanup(picks, [])).toEqual({ started: false, reason: MESSAGES.cleanListChanged() });
	expect(x.runCleanup(picks, commands, "yes")).toEqual({ started: false, reason: MESSAGES.cleanTypeFirst("remove") });
	expect(x.snapshot().cleanup.last?.refused).toBe(MESSAGES.cleanTypeFirst("remove"));
	expect(calls.some((c) => c.argv[0] === "sudo")).toBe(false);
});

test("Cleanup off measures nothing and answers nothing", async () => {
	const { run, calls } = box();
	const x = createExtras({ paths: t.paths, run, now: () => new Date() });
	expect(x.snapshot().cleanup).toEqual({ phase: "off", items: [], measuredAt: null, last: null });
	expect(x.measureCleanup()).toEqual({ started: false });
	expect(x.reviewCleanup([])).toEqual({ bytes: 0, commands: [], reason: MESSAGES.cleanNothing() });
	expect(x.runCleanup([], [])).toEqual({ started: false, reason: MESSAGES.cleanNothing() });
	await x.idle();
	expect(calls).toEqual([]);
	// Switching it on starts a measure; switching it off drops it.
	x.setSettings({ cleanup: true });
	expect(x.snapshot().cleanup.phase).toBe("measuring");
	x.setSettings({ cleanup: false });
	expect(x.snapshot().cleanup.phase).toBe("off");
	await x.idle();
	expect(x.snapshot().cleanup.items).toEqual([]);
});
