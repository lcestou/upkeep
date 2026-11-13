import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AppSpec, Stage } from "../../shared/types";
import { listBackups, takeBackup } from "../backup";
import type { FetchLike } from "../github";
import type { Run } from "../run";
import { readInflight } from "../store";
import { ok, realRun, recordingRun, script, tempHome } from "../testkit";
import type { KindCtx, Target } from "./context";
import { checkRelease, installRelease } from "./release";

let t: ReturnType<typeof tempHome>;
let proc = "";
let assets: Record<string, Uint8Array<ArrayBuffer>> = {};
let release: Record<string, unknown> = {};
let lines: string[] = [];
let stages: [Stage, number | null][] = [];

beforeEach(() => {
	t = tempHome("release");
	proc = join(t.dir, "proc");
	mkdirSync(proc);
	assets = {};
	lines = [];
	stages = [];
});
afterEach(() => t.cleanup());

const sha = (b: Uint8Array) => `sha256:${new Bun.CryptoHasher("sha256").update(b).digest("hex")}`;
const bash = (body: string) => new TextEncoder().encode(`#!/bin/bash\n${body}\n`);

function publish(tag: string, files: Record<string, Uint8Array<ArrayBuffer>>, digest = true): void {
	assets = files;
	release = {
		tag_name: tag,
		html_url: `https://github.com/o/r/releases/tag/${tag}`,
		published_at: "2026-11-09T00:00:00Z",
		body: "Notes.",
		assets: Object.entries(files).map(([name, b]) => ({
			name,
			browser_download_url: `https://dl.test/${name}`,
			size: b.length,
			digest: digest ? sha(b) : null,
		})),
	};
}

const limited: FetchLike = async () => new Response('{"message":"API rate limit exceeded"}', { status: 403 });

/** A release by tag answers only when a test published one with publishOld; by default it is GitHub's 404. */
let oldRelease: { tag: string; files: Record<string, Uint8Array<ArrayBuffer>> } | null = null;

const fakeFetch: FetchLike = async (url) => {
	const byTag = /\/releases\/tags\/([^/]+)$/.exec(url);
	if (byTag) {
		if (!oldRelease || decodeURIComponent(byTag[1] ?? "") !== oldRelease.tag)
			return new Response('{"message":"Not Found"}', { status: 404 });
		return Response.json({
			tag_name: oldRelease.tag,
			html_url: "",
			assets: Object.entries(oldRelease.files).map(([name, b]) => ({
				name,
				browser_download_url: `https://dl.test/old/${name}`,
				size: b.length,
				digest: sha(b),
			})),
		});
	}
	const old = url.startsWith("https://dl.test/old/")
		? oldRelease?.files[url.replace("https://dl.test/old/", "")]
		: undefined;
	if (old) return new Response(old);
	if (url.startsWith("https://api.github.com/"))
		return Response.json(release, { headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999" } });
	const name = url.replace("https://dl.test/", "");
	const body = assets[name];
	return body ? new Response(body) : new Response("missing", { status: 404 });
};

function ctx(run: Run = realRun(t.paths)): KindCtx {
	return {
		paths: t.paths,
		run,
		fetch: fakeFetch,
		token: null,
		settings: {
			keepBackups: 1,
			notify: true,
			checkAtLogin: false,
			checkEvery: "6h",
			frame: "own",
			buttons: "auto",
			corners: "rounded",
			language: "system",
			selfAuto: false,
		},
		log: (l) => lines.push(l),
		stage: (s, p) => stages.push([s, p]),
		procRoot: proc,
	};
}

const zen = (): AppSpec => ({
	key: "zen",
	name: "Zen Browser",
	kind: "appimage",
	repo: "zen-browser/desktop",
	asset: "x86_64\\.AppImage$",
	dest: "~/.local/bin/zen-browser.AppImage",
	process: "zen",
});

function installZen(version: string): string {
	const dest = script(join(t.paths.home, ".local/bin/zen-browser.AppImage"), `echo "zen ${version}"`);
	chmodSync(dest, 0o775);
	return dest;
}

async function checkAndTarget(spec: AppSpec, c: KindCtx): Promise<Target> {
	const checked = await checkRelease(spec, c);
	if (!checked?.target) throw new Error(`no target: ${JSON.stringify(checked)}`);
	return checked.target;
}

test("check: absent is left out and logged, fresh and ready are told apart", async () => {
	publish("1.18.0b", { "zen.linux-x86_64.AppImage": bash('echo "zen 1.18.0b"') });
	expect(await checkRelease(zen(), ctx())).toBeNull();
	expect(lines).toEqual([
		`Zen Browser is not installed at ${join(t.paths.home, ".local/bin/zen-browser.AppImage")}, skipped.`,
	]);
	installZen("1.17.9b");
	const ready = await checkRelease(zen(), ctx());
	expect(ready).toMatchObject({
		installed: "1.17.9b",
		latest: "1.18.0b",
		status: "ready",
		releaseUrl: "https://github.com/o/r/releases/tag/1.18.0b",
		publishedAt: "2026-11-09T00:00:00Z",
		notes: "Notes.",
	});
	expect(ready?.size).toBeGreaterThan(0);
	installZen("1.18.0b");
	expect((await checkRelease(zen(), ctx()))?.status).toBe("fresh");
});

test("check: a missing asset, a rate limit, and several matching assets", async () => {
	installZen("1.0.0");
	publish("1.1.0", { "zen.aarch64.tar.gz": bash("") });
	expect(await checkRelease(zen(), ctx())).toMatchObject({
		status: "problem",
		detail: "No release asset matches x86_64\\.AppImage$.",
	});
	publish("1.1.0", { "a-x86_64.AppImage": bash(""), "b-x86_64.AppImage": bash("") });
	expect(await checkRelease(zen(), ctx())).toMatchObject({
		status: "problem",
		detail:
			"More than one release asset matches x86_64\\.AppImage$: a-x86_64.AppImage, b-x86_64.AppImage. Narrow the pattern in apps.toml.",
	});
	const c = { ...ctx(), fetch: limited };
	expect(await checkRelease(zen(), c)).toMatchObject({ status: "problem", installed: "1.0.0", latest: null });
});

test("install: an AppImage is downloaded, backed up, swapped in with its mode, and verified", async () => {
	const dest = installZen("1.17.9b");
	publish("1.18.0b", { "zen.linux-x86_64.AppImage": bash('echo "zen 1.18.0b"') });
	const c = ctx();
	const outcome = await installRelease(zen(), await checkAndTarget(zen(), c), c);
	expect(outcome).toMatchObject({ result: "done", installed: "1.18.0b", restartToApply: false });
	expect(outcome.detail).toBeUndefined();
	expect(Object.keys(outcome.stages)).toEqual(["download", "backup", "install", "verify"]);
	expect(statSync(dest).mode & 0o777).toBe(0o775);
	expect(listBackups(t.paths, "zen").map((p) => p.version)).toEqual(["1.17.9b"]);
	expect(readFileSync(join(t.paths.data, "backups/zen/1.17.9b/zen-browser.AppImage"), "utf8")).toContain("zen 1.17.9b");
	expect(stages.map(([s]) => s)).toContain("verify");
	expect(stages.find(([s, p]) => s === "download" && p === 100)).toBeDefined();
	expect(readInflight(t.paths)).toBeNull();
	expect(readdirSync(join(t.paths.cache, "dl"))).toEqual([]);
	expect(existsSync(`${dest}.upkeep-new`)).toBe(false);
});

test("install: a running app is replaced and marked restart to apply", async () => {
	installZen("1.17.9b");
	mkdirSync(join(proc, "4242"));
	writeFileSync(join(proc, "4242/comm"), "zen\n");
	publish("1.18.0b", { "zen.linux-x86_64.AppImage": bash('echo "zen 1.18.0b"') });
	const c = ctx();
	const outcome = await installRelease(zen(), await checkAndTarget(zen(), c), c);
	expect(outcome).toMatchObject({ result: "done", restartToApply: true });
});

test("install: a new version that will not start is rolled back to the restore point", async () => {
	const dest = installZen("1.17.9b");
	publish("1.18.0b", {
		"zen.linux-x86_64.AppImage": bash('echo "zen: error while loading shared libraries: libgtk-4.so.1" >&2; exit 127'),
	});
	const c = ctx();
	const outcome = await installRelease(zen(), await checkAndTarget(zen(), c), c);
	// The old copy is back in place before anything else is asked.
	expect(readFileSync(dest, "utf8")).toContain('echo "zen 1.17.9b"');
	expect(outcome).toMatchObject({
		result: "rolled_back",
		installed: "1.17.9b",
		detail: "Would not start after the update. Restored 1.17.9b.",
	});
	expect(statSync(dest).mode & 0o777).toBe(0o775);
});

test("install: a checksum that does not match changes nothing", async () => {
	const dest = installZen("1.17.9b");
	publish("1.18.0b", { "zen.linux-x86_64.AppImage": bash('echo "zen 1.18.0b"') });
	const c = ctx();
	const target = await checkAndTarget(zen(), c);
	if (target.asset) target.asset.digest = "sha256:00";
	await expect(installRelease(zen(), target, c)).rejects.toThrow("Checksum does not match the release.");
	expect(readFileSync(dest, "utf8")).toContain("zen 1.17.9b");
	expect(readInflight(t.paths)).toBeNull();
});

async function tarball(files: Record<string, string>): Promise<Uint8Array<ArrayBuffer>> {
	const src = join(t.dir, "tarsrc");
	for (const [name, body] of Object.entries(files)) script(join(src, name), body);
	const out = join(t.dir, "out.tar.gz");
	const r = await realRun(t.paths)(["tar", "czf", out, "-C", src, "."]);
	if (r.code !== 0) throw new Error(r.stderr);
	return new Uint8Array(readFileSync(out));
}

const uv = (bins: string[]): AppSpec => ({
	key: "uv",
	name: "uv",
	kind: "archive",
	repo: "astral-sh/uv",
	asset: "x86_64-unknown-linux-gnu\\.tar\\.gz$",
	dest: "~/.local/bin/uv",
	bins,
});

test("install: an archive installs every bin, finding one by base name when its path is missing", async () => {
	const bin = join(t.paths.home, ".local/bin");
	script(join(bin, "uv"), 'echo "uv 0.9.1"');
	script(join(bin, "uvx"), 'echo "uvx 0.9.1"');
	publish("0.9.2", {
		"uv-x86_64-unknown-linux-gnu.tar.gz": await tarball({
			"uv-x86_64-unknown-linux-gnu/uv": 'echo "uv 0.9.2"',
			"deeper/place/uvx": 'echo "uvx 0.9.2"',
		}),
	});
	const spec = uv(["uv-x86_64-unknown-linux-gnu/uv", "uv-x86_64-unknown-linux-gnu/uvx"]);
	const c = ctx();
	const outcome = await installRelease(spec, await checkAndTarget(spec, c), c);
	expect(outcome).toMatchObject({ result: "done", installed: "0.9.2" });
	expect(readFileSync(join(bin, "uvx"), "utf8")).toContain("uvx 0.9.2");
	expect(statSync(join(bin, "uvx")).mode & 0o777).toBe(0o755);
	expect(readdirSync(join(t.paths.data, "backups/uv/0.9.1")).toSorted()).toEqual(["meta.json", "uv", "uvx"]);
	expect(readdirSync(join(t.paths.cache, "dl"))).toEqual([]);
});

test("install: a top folder named like the program is searched, not installed as the program", async () => {
	// btop's archive: btop/bin/btop beside btop/themes; a bin listed as "btop" points at the folder first.
	const bin = join(t.paths.home, ".local/bin");
	script(join(bin, "uv"), 'echo "uv 0.9.1"');
	publish("0.9.2", {
		"uv-x86_64-unknown-linux-gnu.tar.gz": await tarball({
			"uv/bin/uv": 'echo "uv 0.9.2"',
			"uv/themes/default.theme": "x",
		}),
	});
	const spec = uv(["uv"]);
	const c = ctx();
	const outcome = await installRelease(spec, await checkAndTarget(spec, c), c);
	expect(outcome).toMatchObject({ result: "done", installed: "0.9.2" });
	expect(readFileSync(join(bin, "uv"), "utf8")).toContain("uv 0.9.2");
});

test("install: when one bin cannot be installed every bin is restored", async () => {
	const bin = join(t.paths.home, ".local/bin");
	script(join(bin, "uv"), 'echo "uv 0.9.1"');
	script(join(bin, "uvx"), 'echo "uvx 0.9.1"');
	publish("0.9.2", { "uv-x86_64-unknown-linux-gnu.tar.gz": await tarball({ "d/uv": 'echo "uv 0.9.2"' }) });
	const spec = uv(["d/uv", "d/uvx"]);
	const c = ctx();
	const outcome = await installRelease(spec, await checkAndTarget(spec, c), c);
	expect(outcome).toMatchObject({ result: "failed", detail: "Could not install uvx. Restored 0.9.1." });
	expect(readFileSync(join(bin, "uv"), "utf8")).toContain("uv 0.9.1");
	expect(readInflight(t.paths)).toBeNull();
});

const rustdesk = (dest: string): AppSpec => ({
	key: "rustdesk",
	name: "RustDesk",
	kind: "deb",
	repo: "rustdesk/rustdesk",
	asset: "x86_64\\.deb$",
	dest,
	sudo: true,
});

test("install: a deb goes through sudo -n dpkg -i; with no release of the installed version there is no point", async () => {
	oldRelease = null;
	const dest = script(join(t.dir, "usr/bin/rustdesk"), 'echo "1.4.2"');
	publish("1.4.3", { "rustdesk-1.4.3-x86_64.deb": new Uint8Array([1, 2, 3]) });
	const { run, calls } = recordingRun(t.paths, (argv) => {
		if (argv[2] !== "dpkg") return undefined;
		script(dest, 'echo "1.4.3"');
		return ok("Setting up rustdesk (1.4.3) ...\n");
	});
	const c = ctx(run);
	const outcome = await installRelease(rustdesk(dest), await checkAndTarget(rustdesk(dest), c), c);
	expect(outcome).toMatchObject({ result: "done", installed: "1.4.3" });
	const dpkg = calls.find((x) => x.argv[2] === "dpkg");
	expect(dpkg?.argv).toEqual([
		"sudo",
		"-n",
		"dpkg",
		"-i",
		join(t.paths.cache, "dl/rustdesk-rustdesk-1.4.3-x86_64.deb"),
	]);
	expect(listBackups(t.paths, "rustdesk")).toEqual([]);
	expect(lines.some((l) => l.startsWith("No restore point: 1.4.2: GitHub answered 404"))).toBe(true);
});

test("install: a deb keeps the installed version's package as its point, and a new one that will not start gets it back", async () => {
	const dest = script(join(t.dir, "usr/bin/rustdesk"), 'echo "1.4.2"');
	const oldDebBytes = new Uint8Array([9, 9, 9]);
	oldRelease = { tag: "1.4.2", files: { "rustdesk-1.4.2-x86_64.deb": oldDebBytes } };
	publish("1.4.3", { "rustdesk-1.4.3-x86_64.deb": new Uint8Array([1, 2, 3]) });
	const installed: string[] = [];
	const { run } = recordingRun(t.paths, (argv) => {
		if (argv[2] !== "dpkg") return undefined;
		const file = argv[4] ?? "";
		installed.push(file.split("/").at(-1) ?? "");
		// The new package breaks the program; the old one puts it back.
		script(dest, file.includes("1.4.2") ? 'echo "1.4.2"' : "exit 1");
		return ok();
	});
	const c = ctx(run);
	const outcome = await installRelease(rustdesk(dest), await checkAndTarget(rustdesk(dest), c), c);
	expect(outcome).toMatchObject({ result: "rolled_back", installed: "1.4.2" });
	expect(installed).toEqual(["rustdesk-rustdesk-1.4.3-x86_64.deb", "rustdesk-1.4.2-x86_64.deb"]);
	expect(listBackups(t.paths, "rustdesk").map((p) => p.version)).toEqual(["1.4.2"]);
	oldRelease = null;
});

const rustdeskRpm = (dest: string): AppSpec => ({ ...rustdesk(dest), kind: "rpm", asset: "x86_64\\.rpm$" });

test("install: an rpm goes through sudo -n rpm -U --oldpackage, keeps a point marked rpm, and a refusal restores it", async () => {
	const dest = script(join(t.dir, "usr/bin/rustdesk"), 'echo "1.4.2"');
	oldRelease = { tag: "1.4.2", files: { "rustdesk-1.4.2-x86_64.rpm": new Uint8Array([9, 9, 9]) } };
	publish("1.4.3", { "rustdesk-1.4.3-x86_64.rpm": new Uint8Array([1, 2, 3]) });
	const { run, calls } = recordingRun(t.paths, (argv) => {
		if (argv[2] !== "rpm") return undefined;
		return (argv[5] ?? "").includes("1.4.2") ? ok() : { code: 1, stdout: "", stderr: "rpm: error", timedOut: false };
	});
	const c = ctx(run);
	const outcome = await installRelease(rustdeskRpm(dest), await checkAndTarget(rustdeskRpm(dest), c), c);
	expect(outcome).toMatchObject({
		result: "rolled_back",
		installed: "1.4.2",
		detail: "rpm could not install rustdesk-1.4.3-x86_64.rpm. Restored 1.4.2.",
	});
	const rpms = calls.filter((x) => x.argv[2] === "rpm").map((x) => x.argv);
	expect(rpms[0]).toEqual([
		"sudo",
		"-n",
		"rpm",
		"-U",
		"--oldpackage",
		join(t.paths.cache, "dl/rustdesk-rustdesk-1.4.3-x86_64.rpm"),
	]);
	expect(rpms).toHaveLength(2);
	const meta = JSON.parse(readFileSync(join(t.paths.data, "backups/rustdesk/1.4.2/meta.json"), "utf8"));
	expect(meta.rpm).toBe(true);
	expect(meta.deb).toBeUndefined();
	oldRelease = null;
});

test("install: sudo that wants a password fails plainly", async () => {
	const dest = script(join(t.dir, "usr/bin/rustdesk"), 'echo "1.4.2"');
	publish("1.4.3", { "rustdesk-1.4.3-x86_64.deb": new Uint8Array([1, 2, 3]) });
	const { run } = recordingRun(t.paths, (argv) =>
		argv[0] === "sudo" ? { code: 1, stdout: "", stderr: "sudo: a password is required", timedOut: false } : undefined,
	);
	const c = ctx(run);
	const outcome = await installRelease(rustdesk(dest), await checkAndTarget(rustdesk(dest), c), c);
	expect(outcome).toMatchObject({
		result: "failed",
		detail: "sudo needs a password here. Run the update from a terminal.",
	});
	expect(readInflight(t.paths)).toBeNull();
});

test("install: a deb that dpkg refuses gets the installed version's package back", async () => {
	const dest = script(join(t.dir, "usr/bin/rustdesk"), 'echo "1.4.2"');
	oldRelease = { tag: "1.4.2", files: { "rustdesk-1.4.2-x86_64.deb": new Uint8Array([9, 9, 9]) } };
	publish("1.4.3", { "rustdesk-1.4.3-x86_64.deb": new Uint8Array([1, 2, 3]) });
	const { run } = recordingRun(t.paths, (argv) => {
		if (argv[2] !== "dpkg") return undefined;
		return (argv[4] ?? "").includes("1.4.2") ? ok() : { code: 1, stdout: "", stderr: "dpkg: error", timedOut: false };
	});
	const c = ctx(run);
	const outcome = await installRelease(rustdesk(dest), await checkAndTarget(rustdesk(dest), c), c);
	expect(outcome).toMatchObject({
		result: "rolled_back",
		installed: "1.4.2",
		detail: "dpkg could not install rustdesk-1.4.3-x86_64.deb. Restored 1.4.2.",
	});
	oldRelease = null;
});

test("install: a deb whose point cannot go back says so, and an ambiguous old release keeps no point", async () => {
	const dest = script(join(t.dir, "usr/bin/rustdesk"), 'echo "1.4.2"');
	oldRelease = { tag: "1.4.2", files: { "rustdesk-1.4.2-x86_64.deb": new Uint8Array([9]) } };
	publish("1.4.3", { "rustdesk-1.4.3-x86_64.deb": new Uint8Array([1, 2, 3]) });
	const { run } = recordingRun(t.paths, (argv) => {
		if (argv[2] !== "dpkg") return undefined;
		script(dest, "exit 1");
		return (argv[4] ?? "").includes("1.4.2") ? { code: 1, stdout: "", stderr: "", timedOut: false } : ok();
	});
	const c = ctx(run);
	expect(await installRelease(rustdesk(dest), await checkAndTarget(rustdesk(dest), c), c)).toMatchObject({
		result: "failed",
		// What the disk holds after the failed putting back, as a probe reads it: here the broken copy, no version.
		installed: null,
		detail: "Would not start after the update, and putting 1.4.2 back failed. See the log.",
	});
	script(dest, 'echo "1.4.2"');
	oldRelease = {
		tag: "1.4.2",
		files: {
			"rustdesk-1.4.2-x86_64.deb": new Uint8Array([9]),
			"rustdesk-1.4.2-sciter-x86_64.deb": new Uint8Array([8]),
		},
	};
	rmSync(join(t.paths.data, "backups"), { recursive: true, force: true });
	await installRelease(rustdesk(dest), await checkAndTarget(rustdesk(dest), c), c);
	expect(lines.some((l) => l.startsWith("No restore point: more than one 1.4.2 asset matches"))).toBe(true);
	oldRelease = null;
});

const BIN_UV = () => join(t.paths.home, ".local/bin");
const SUDO = { code: 1, stdout: "", stderr: "sudo: a password is required", timedOut: false };

test("install: the AppImage is renamed in, so a process holding the old file keeps it", async () => {
	const dest = installZen("1.17.9b");
	const held = join(t.dir, "held");
	linkSync(dest, held);
	publish("1.18.0b", { "zen.linux-x86_64.AppImage": bash('echo "zen 1.18.0b"') });
	const c = ctx();
	expect(await installRelease(zen(), await checkAndTarget(zen(), c), c)).toMatchObject({ result: "done" });
	expect(readFileSync(held, "utf8")).toContain("zen 1.17.9b");
	expect(readFileSync(dest, "utf8")).toContain("zen 1.18.0b");
});

test("install: a symlinked dest is updated through the link and stays a link", async () => {
	const real = script(join(t.paths.home, "Apps/zen-real.AppImage"), 'echo "zen 1.17.9b"');
	const dest = join(t.paths.home, ".local/bin/zen-browser.AppImage");
	mkdirSync(join(t.paths.home, ".local/bin"), { recursive: true });
	symlinkSync(real, dest);
	publish("1.18.0b", { "zen.linux-x86_64.AppImage": bash('echo "zen 1.18.0b"') });
	const c = ctx();
	expect(await installRelease(zen(), await checkAndTarget(zen(), c), c)).toMatchObject({ result: "done" });
	expect(lstatSync(dest).isSymbolicLink()).toBe(true);
	expect(readFileSync(real, "utf8")).toContain("zen 1.18.0b");
	expect(readdirSync(join(t.paths.home, "Apps"))).toEqual(["zen-real.AppImage"]);
});

test("install: an unwritable bin directory throws, keeps the old copy and its restore point, and clears inflight", async () => {
	const dest = installZen("1.17.9b");
	publish("1.18.0b", { "zen.linux-x86_64.AppImage": bash('echo "zen 1.18.0b"') });
	const c = ctx();
	const target = await checkAndTarget(zen(), c);
	chmodSync(join(t.paths.home, ".local/bin"), 0o555);
	try {
		await expect(installRelease(zen(), target, c)).rejects.toThrow("EACCES");
	} finally {
		chmodSync(join(t.paths.home, ".local/bin"), 0o755);
	}
	expect(readFileSync(dest, "utf8")).toContain("zen 1.17.9b");
	expect(listBackups(t.paths, "zen").map((p) => p.version)).toEqual(["1.17.9b"]);
	expect(readInflight(t.paths)).toBeNull();
});

test("install: a bin failure whose restore also fails says the restore failed", async () => {
	script(join(BIN_UV(), "uv"), 'echo "uv 0.9.1"');
	script(join(BIN_UV(), "uvx"), 'echo "uvx 0.9.1"');
	publish("0.9.2", { "uv-x86_64-unknown-linux-gnu.tar.gz": await tarball({ "d/uv": 'echo "uv 0.9.2"' }) });
	const { run } = recordingRun(t.paths, (argv) =>
		argv[0] === "install" && argv[3]?.includes("/backups/")
			? { code: 1, stdout: "", stderr: "install: No space left on device", timedOut: false }
			: undefined,
	);
	const spec = uv(["d/uv", "d/uvx"]);
	const c = ctx(run);
	expect(await installRelease(spec, await checkAndTarget(spec, c), c)).toMatchObject({
		result: "failed",
		detail: "Could not install uvx. Restore failed: Could not restore uv: install: No space left on device",
	});
});

test("install: a copy that comes out short is never moved over the old bin", async () => {
	script(join(BIN_UV(), "uv"), 'echo "uv 0.9.1"');
	publish("0.9.2", { "uv-x86_64-unknown-linux-gnu.tar.gz": await tarball({ "d/uv": 'echo "uv 0.9.2"' }) });
	const { run, calls } = recordingRun(t.paths, (argv) => {
		if (argv[0] !== "install" || argv[3]?.includes("/backups/")) return undefined;
		writeFileSync(argv[4] ?? "", "short");
		return ok();
	});
	const spec = uv(["d/uv"]);
	const c = ctx(run);
	expect(await installRelease(spec, await checkAndTarget(spec, c), c)).toMatchObject({ result: "failed" });
	const i = calls.findIndex((x) => x.argv[0] === "install");
	expect(calls[i + 1]?.argv).toEqual(["rm", "-f", join(BIN_UV(), "uv.upkeep-new")]);
	expect(readFileSync(join(BIN_UV(), "uv"), "utf8")).toContain("uv 0.9.1");
});

test("install: with no restore point from this run, a broken new copy is not rolled back to an older one", async () => {
	const dest = installZen("1.0.0");
	const old = script(join(t.dir, "ancient/zen.AppImage"), 'echo "zen 0.5.0"');
	takeBackup(t.paths, zen(), "0.5.0", [old], "2026-01-01T00:00:00.000Z");
	writeFileSync(old, "untouched");
	publish("1.1.0", {
		"zen.linux-x86_64.AppImage": bash('echo "x: error while loading shared libraries: libgtk.so" >&2; exit 127'),
	});
	const c = ctx();
	const target = await checkAndTarget(zen(), c);
	rmSync(dest);
	expect(await installRelease(zen(), target, c)).toMatchObject({
		result: "failed",
		detail: "Would not start after the update. No restore point was taken.",
	});
	expect(readFileSync(old, "utf8")).toBe("untouched");
});

test("install: a sudo AppImage that wants a password fails plainly and leaves no inflight marker", async () => {
	const dest = installZen("1.0.0");
	publish("1.1.0", { "zen.linux-x86_64.AppImage": bash('echo "zen 1.1.0"') });
	const { run } = recordingRun(t.paths, (argv) => (argv[0] === "sudo" ? SUDO : undefined));
	const spec = { ...zen(), sudo: true };
	const c = ctx(run);
	expect(await installRelease(spec, await checkAndTarget(spec, c), c)).toMatchObject({
		result: "failed",
		detail: "sudo needs a password here. Run the update from a terminal.",
	});
	expect(readInflight(t.paths)).toBeNull();
	expect(readFileSync(dest, "utf8")).toContain("zen 1.0.0");
});

test("install: a release whose binary still reports the old version fails", async () => {
	script(join(BIN_UV(), "uv"), 'echo "uv 0.9.1"');
	publish("0.9.2", { "uv-x86_64-unknown-linux-gnu.tar.gz": await tarball({ uv: 'echo "uv 0.9.1"' }) });
	const spec = uv(["uv"]);
	const c = ctx();
	expect(await installRelease(spec, await checkAndTarget(spec, c), c)).toMatchObject({
		result: "failed",
		installed: "0.9.1",
		detail: "Still at 0.9.1 after the update.",
	});
});

test("install: a restore point that cannot be re-taken keeps the old one", async () => {
	script(join(BIN_UV(), "uv"), 'echo "uv 0.9.1"');
	script(join(BIN_UV(), "uvx"), 'echo "uvx 0.9.1"');
	const spec = uv(["uv", "uvx"]);
	takeBackup(t.paths, spec, "0.9.1", [join(BIN_UV(), "uv"), join(BIN_UV(), "uvx")], "2026-10-01T00:00:00.000Z");
	publish("0.9.2", {
		"uv-x86_64-unknown-linux-gnu.tar.gz": await tarball({ uv: 'echo "uv 0.9.2"', uvx: 'echo "uvx 0.9.2"' }),
	});
	const c = ctx();
	const target = await checkAndTarget(spec, c);
	chmodSync(join(BIN_UV(), "uvx"), 0o111);
	await expect(installRelease(spec, target, c)).rejects.toThrow("EACCES");
	expect(listBackups(t.paths, "uv")).toEqual([{ version: "0.9.1", at: "2026-10-01T00:00:00.000Z" }]);
	expect(readdirSync(join(t.paths.data, "backups/uv"))).toEqual(["0.9.1"]);
	expect(readFileSync(join(BIN_UV(), "uv"), "utf8")).toContain("uv 0.9.1");
});

test("install: a bin this run added is removed when a later bin fails", async () => {
	script(join(BIN_UV(), "uv"), 'echo "uv 0.9.1"');
	publish("0.9.2", { "uv-x86_64-unknown-linux-gnu.tar.gz": await tarball({ "d/uvx": 'echo "uvx 0.9.2"' }) });
	const spec = uv(["d/uvx", "d/uv"]);
	const c = ctx();
	expect(await installRelease(spec, await checkAndTarget(spec, c), c)).toMatchObject({
		result: "failed",
		detail: "Could not install uv. Restored 0.9.1.",
	});
	expect(existsSync(join(BIN_UV(), "uvx"))).toBe(false);
	expect(readFileSync(join(BIN_UV(), "uv"), "utf8")).toContain("uv 0.9.1");
});

test("an absent app the owner added is listed ready and installs with no restore point", async () => {
	publish("1.18.0b", { "zen.linux-x86_64.AppImage": bash('echo "zen 1.18.0b"') });
	const spec = { ...zen(), install_if_missing: true };
	const c = ctx();
	const checked = await checkRelease(spec, c);
	expect(checked).toMatchObject({ installed: null, latest: "1.18.0b", status: "ready" });
	if (!checked?.target) throw new Error("no target");
	expect(checked.target.from).toBeNull();
	expect(await installRelease(spec, checked.target, c)).toMatchObject({ result: "done", installed: "1.18.0b" });
	expect(readFileSync(join(t.paths.home, ".local/bin/zen-browser.AppImage"), "utf8")).toContain("zen 1.18.0b");
	expect(listBackups(t.paths, "zen")).toEqual([]);
	// Once it is there the flag stops mattering.
	expect((await checkRelease(spec, c))?.status).toBe("fresh");
});

test("an AppImage whose latest is a json: source checks and installs with no repo", async () => {
	const api = "https://api2.example.test/updates/linux-x64/app";
	const dlUrl = "https://downloads.example.test/x/Cursor-3.29.15-x86_64.AppImage";
	// An AppImage of a size the API never states: above the 1 MiB floor, it installs.
	const body = new Uint8Array(1024 * 1024 + 10);
	body.set(bash('echo "cursor 3.29.15"'));
	const c = {
		...ctx(),
		fetch: (async (url: string) =>
			url === api
				? Response.json({ version: "3.29.15", downloadUrl: dlUrl })
				: url === dlUrl
					? new Response(body)
					: new Response("", { status: 404 })) as FetchLike,
	};
	const dest = script(join(t.paths.home, ".local/bin/cursor.appimage"), 'echo "cursor 3.29.9"');
	const spec: AppSpec = {
		key: "cursor",
		name: "Cursor",
		kind: "appimage",
		latest: `json:${api}`,
		asset: "\\.AppImage$",
		dest,
	};
	const checked = await checkRelease(spec, c);
	expect(checked).toMatchObject({ installed: "3.29.9", latest: "3.29.15", status: "ready" });
	expect(checked?.target?.asset?.name).toBe("Cursor-3.29.15-x86_64.AppImage");
	if (!checked?.target) throw new Error("no target");
	expect(await installRelease(spec, checked.target, c)).toMatchObject({ result: "done", installed: "3.29.15" });
	// A cut answer below the floor is refused before anything is replaced.
	const small = {
		...c,
		fetch: (async (url: string) =>
			url === api
				? Response.json({ version: "3.29.16", downloadUrl: dlUrl })
				: new Response(new Uint8Array(500_000))) as FetchLike,
	};
	const next = await checkRelease(spec, small);
	if (!next?.target) throw new Error("no target");
	// As a size mismatch does, it throws; the engine turns that into a failed row.
	await expect(installRelease(spec, next.target, small)).rejects.toThrow("too small to be a release");
	expect(await Bun.file(dest).text()).toContain("cursor 3.29.15");
	// A latest that gives no download has nothing to install.
	const versionOnly = { ...spec, latest: "npm:cursor" };
	const nf = { ...c, fetch: (async () => Response.json({ version: "9.9.9" })) as FetchLike };
	expect(await checkRelease(versionOnly, nf)).toMatchObject({
		status: "problem",
		detail: "npm:cursor gives a version but no download.",
	});
});

test("install: a deb dpkg refuses whose point cannot go back either says so, with what is installed now", async () => {
	const dest = script(join(t.dir, "usr/bin/rustdesk"), 'echo "1.4.2"');
	oldRelease = { tag: "1.4.2", files: { "rustdesk-1.4.2-x86_64.deb": new Uint8Array([9]) } };
	publish("1.4.3", { "rustdesk-1.4.3-x86_64.deb": new Uint8Array([1, 2, 3]) });
	const { run } = recordingRun(t.paths, (argv) =>
		argv[2] === "dpkg" ? { code: 1, stdout: "", stderr: "dpkg: error", timedOut: false } : undefined,
	);
	const c = ctx(run);
	expect(await installRelease(rustdesk(dest), await checkAndTarget(rustdesk(dest), c), c)).toMatchObject({
		result: "failed",
		installed: "1.4.2",
		detail: "dpkg could not install rustdesk-1.4.3-x86_64.deb, and putting 1.4.2 back failed. See the log.",
	});
	oldRelease = null;
});
