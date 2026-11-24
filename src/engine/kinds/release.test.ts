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
import { listBackups, restoreBackup, takeBackup } from "../backup";
import type { FetchLike } from "../github";
import type { Run } from "../run";
import { readInflight } from "../store";
import { ok, realRun, recordingRun, script, tempHome } from "../testkit";
import type { KindCtx, Target } from "./context";
import { checkRelease, dlPath, installRelease, probeInstalled } from "./release";

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
			upkeepCommand: false,
			waitUnmetered: false,
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

test("install: a private repo's file comes through GitHub's API with the person's gh token", async () => {
	installZen("1.17.9b");
	const body = bash('echo "zen 1.18.0b"');
	publish("1.18.0b", { "zen.linux-x86_64.AppImage": body });
	release.assets = [
		{
			name: "zen.linux-x86_64.AppImage",
			browser_download_url: "https://dl.test/zen.linux-x86_64.AppImage",
			url: "https://api.github.com/repos/o/r/releases/assets/9",
			size: body.length,
			digest: sha(body),
		},
	];
	const asked: string[] = [];
	const privateFetch: FetchLike = async (url, init) => {
		const auth = new Headers(init?.headers).get("authorization");
		asked.push(`${url} ${auth ?? "-"}`);
		if (url.endsWith("/releases/assets/9"))
			return auth === "Bearer tok" ? new Response(body) : new Response("Not Found", { status: 404 });
		// The public link is GitHub's 404 for a private repo, as it is to anyone not signed in in a browser.
		if (url.startsWith("https://dl.test/")) return new Response("Not Found", { status: 404 });
		return fakeFetch(url, init);
	};
	const c = { ...ctx(), fetch: privateFetch, token: "tok" };
	const outcome = await installRelease(zen(), await checkAndTarget(zen(), c), c);
	expect(outcome).toMatchObject({ result: "done", installed: "1.18.0b" });
	expect(asked.filter((a) => !a.includes("/releases/latest"))).toEqual([
		"https://dl.test/zen.linux-x86_64.AppImage -",
		"https://api.github.com/repos/o/r/releases/assets/9 Bearer tok",
	]);
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
	let heads = 0;
	const c = {
		...ctx(),
		fetch: (async (url: string, init?: RequestInit) => {
			if (url === api) return Response.json({ version: "3.29.15", downloadUrl: dlUrl });
			if (url !== dlUrl) return new Response("", { status: 404 });
			if (init?.method !== "HEAD") return new Response(body);
			heads++;
			return new Response(null, { headers: { "content-length": String(body.length) } });
		}) as FetchLike,
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
	// The API lists no size, so the row shows the length the download server states.
	expect(checked?.size).toBe(body.length);
	if (!checked?.target) throw new Error("no target");
	expect(await installRelease(spec, checked.target, c)).toMatchObject({ result: "done", installed: "3.29.15" });
	// A fresh row shows no size, so the server is not asked.
	expect(await checkRelease(spec, c)).toMatchObject({ status: "fresh", size: undefined });
	expect(heads).toBe(1);
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

/** An AppImage that never names its version: running it at all leaves a mark, so a test can tell it was never run. */
const quiet = (): AppSpec => ({ ...zen(), probe: false });
const ranMark = () => join(t.dir, "ran");
const quietBody = (version: string) => bash(`touch "${ranMark()}"; echo "starting zen ${version} window"`);

test("probe false: a copy Upkeep did not install is offered the latest, never run, and recorded once installed", async () => {
	const dest = join(t.paths.home, ".local/bin/zen-browser.AppImage");
	mkdirSync(join(dest, ".."), { recursive: true });
	writeFileSync(dest, quietBody("1.0.0"));
	chmodSync(dest, 0o755);
	publish("1.1.0", { "zen.linux-x86_64.AppImage": quietBody("1.1.0") });
	const c = ctx();
	const checked = await checkRelease(quiet(), c);
	expect(checked).toMatchObject({
		installed: null,
		latest: "1.1.0",
		status: "ready",
		detail:
			"Zen Browser does not report its version, and this copy was not installed by Upkeep. Installing the latest lets Upkeep keep track of it.",
	});
	if (!checked?.target) throw new Error("no target");
	expect(checked.target.from).toBeNull();
	expect(await installRelease(quiet(), checked.target, c)).toMatchObject({ result: "done", installed: "1.1.0" });
	expect(await checkRelease(quiet(), c)).toMatchObject({ installed: "1.1.0", status: "fresh" });
	expect(existsSync(ranMark())).toBe(false);
	// The next release is an update from the recorded version, with a restore point under it.
	publish("1.2.0", { "zen.linux-x86_64.AppImage": quietBody("1.2.0") });
	const next = await checkAndTarget(quiet(), c);
	expect(next).toMatchObject({ from: "1.1.0", version: "1.2.0" });
	expect(await installRelease(quiet(), next, c)).toMatchObject({ result: "done", installed: "1.2.0" });
	expect(listBackups(t.paths, "zen").map((p) => p.version)).toEqual(["1.1.0"]);
	// A restore records the point's version.
	expect(await restoreBackup(t.paths, quiet(), "1.1.0", c.run)).toEqual({ ok: true });
	expect(await probeInstalled(quiet(), c)).toEqual({ version: "1.1.0" });
	// A file put there some other way is no longer vouched for.
	rmSync(dest);
	writeFileSync(dest, quietBody("1.3.0"));
	expect(await checkRelease(quiet(), c)).toMatchObject({ installed: null, status: "ready" });
	expect(existsSync(ranMark())).toBe(false);
	rmSync(dest);
	expect(await checkRelease(quiet(), c)).toBeNull();
});

test("probe false on an archive: the dest bin is never run and reads back as the version installed", async () => {
	const bin = join(t.paths.home, ".local/bin");
	script(join(bin, "uv"), `touch "${ranMark()}"`);
	publish("0.9.2", { "uv-x86_64-unknown-linux-gnu.tar.gz": await tarball({ "d/uv": `touch "${ranMark()}"` }) });
	const spec = { ...uv(["d/uv"]), probe: false };
	const c = ctx();
	expect(await checkRelease(spec, c)).toMatchObject({ status: "ready", installed: null });
	expect(await installRelease(spec, await checkAndTarget(spec, c), c)).toMatchObject({
		result: "done",
		installed: "0.9.2",
	});
	expect(await checkRelease(spec, c)).toMatchObject({ installed: "0.9.2", status: "fresh" });
	expect(existsSync(ranMark())).toBe(false);
});

test("install: a .tar.xz archive opens like a .tar.gz, and a * in a bin stands for the version in its name", async () => {
	const src = join(t.dir, "xzsrc");
	script(join(src, "bin/uv-0.9.2-linux-amd64"), 'echo "uv 0.9.2"');
	const out = join(t.dir, "out.tar.xz");
	const r = await realRun(t.paths)(["tar", "cJf", out, "-C", src, "."]);
	if (r.code !== 0) throw new Error(r.stderr);
	script(join(t.paths.home, ".local/bin/uv"), 'echo "uv 0.9.1"');
	publish("0.9.2", { "uv-0.9.2-linux-amd64.tar.xz": new Uint8Array(readFileSync(out)) });
	const spec = { ...uv(["uv-*-linux-amd64"]), asset: "linux-amd64\\.tar\\.xz$" };
	const c = ctx();
	expect(await installRelease(spec, await checkAndTarget(spec, c), c)).toMatchObject({
		result: "done",
		installed: "0.9.2",
	});
	expect(readFileSync(join(t.paths.home, ".local/bin/uv"), "utf8")).toContain("uv 0.9.2");
	expect(existsSync(join(t.paths.home, ".local/bin/uv-0.9.2-linux-amd64"))).toBe(false);
	expect(readdirSync(join(t.paths.data, "backups/uv/0.9.1")).toSorted()).toEqual(["meta.json", "uv"]);
});

test("install: a tarball whose decompressor is missing says which program to install, and keeps the old copy", async () => {
	script(join(t.paths.home, ".local/bin/uv"), 'echo "uv 0.9.1"');
	publish("0.9.2", { "uv-x86_64-unknown-linux-gnu.tar.xz": new Uint8Array([1, 2, 3]) });
	const { run } = recordingRun(t.paths, (argv) =>
		argv[0] === "tar"
			? { code: 2, stdout: "", stderr: "tar (child): xz: Cannot exec: No such file or directory", timedOut: false }
			: undefined,
	);
	const spec = { ...uv(["uv"]), asset: "linux-gnu\\.tar\\.xz$" };
	const c = ctx(run);
	expect(await installRelease(spec, await checkAndTarget(spec, c), c)).toMatchObject({
		result: "failed",
		installed: "0.9.1",
		detail:
			"Opening uv-x86_64-unknown-linux-gnu.tar.xz needs the xz program, which is not installed. Install xz from the system's packages, then try again.",
	});
	expect(readFileSync(join(t.paths.home, ".local/bin/uv"), "utf8")).toContain("uv 0.9.1");
});

/** A program that needs its lib/ folder beside it: it prints its version only while ../lib/version is there. */
const kittyBody =
	'here=$(dirname "$(readlink -f "$0")"); cat "$here/../lib/version" 2>/dev/null || { echo "kitty: error while loading shared libraries: libkitty.so: cannot open shared object file" >&2; exit 127; }';

async function kittyTarball(version: string, top = "kitty-x"): Promise<Uint8Array<ArrayBuffer>> {
	const src = join(t.dir, `kittysrc-${version}`);
	script(join(src, top, "bin/kitty"), kittyBody);
	script(join(src, top, "bin/kitten"), 'echo "kitten"');
	mkdirSync(join(src, top, "lib"), { recursive: true });
	writeFileSync(join(src, top, "lib/version"), `kitty ${version}\n`);
	const out = join(t.dir, `kitty-${version}.tar.gz`);
	const r = await realRun(t.paths)(["tar", "czf", out, "-C", src, "."]);
	if (r.code !== 0) throw new Error(r.stderr);
	return new Uint8Array(readFileSync(out));
}

const kitty = (): AppSpec => ({
	key: "kitty",
	name: "kitty",
	kind: "archive",
	repo: "kovidgoyal/kitty",
	asset: "x86_64\\.tar\\.gz$",
	dest: "~/.local/bin/kitty",
	folder: "~/.local/share/kitty",
	bins: ["bin/kitty", "bin/kitten"],
	install_if_missing: true,
});

test("a folder app unpacks whole into its folder, links its bins, updates with a point and rolls back a broken one", async () => {
	const folder = join(t.paths.home, ".local/share/kitty");
	const link = join(t.paths.home, ".local/bin/kitty");
	publish("0.44.0", { "kitty-0.44.0-x86_64.tar.gz": await kittyTarball("0.44.0") });
	const c = ctx();
	expect(await installRelease(kitty(), await checkAndTarget(kitty(), c), c)).toMatchObject({
		result: "done",
		installed: "0.44.0",
	});
	// The archive's one top folder is the folder; each bin is a link into it.
	expect(readFileSync(join(folder, "lib/version"), "utf8")).toBe("kitty 0.44.0\n");
	expect(lstatSync(link).isSymbolicLink()).toBe(true);
	expect(readFileSync(join(t.paths.home, ".local/bin/kitten"), "utf8")).toContain("kitten");
	// The next release swaps the whole folder; the point keeps the old folder and the links as links.
	publish("0.45.0", { "kitty-0.45.0-x86_64.tar.gz": await kittyTarball("0.45.0") });
	expect(await installRelease(kitty(), await checkAndTarget(kitty(), c), c)).toMatchObject({
		result: "done",
		installed: "0.45.0",
	});
	expect(readFileSync(join(folder, "lib/version"), "utf8")).toBe("kitty 0.45.0\n");
	expect(readFileSync(join(t.paths.data, "backups/kitty/0.44.0/folder-kitty/lib/version"), "utf8")).toBe(
		"kitty 0.44.0\n",
	);
	expect(existsSync(`${folder}.upkeep-old`)).toBe(false);
	// A release whose program cannot start without a lib/ it lacks goes back to the point, folder and all.
	const broken = join(t.dir, "brokensrc");
	script(join(broken, "bin/kitty"), kittyBody);
	script(join(broken, "bin/kitten"), "true");
	const out = join(t.dir, "broken.tar.gz");
	await realRun(t.paths)(["tar", "czf", out, "-C", broken, "."]);
	publish("0.46.0", { "kitty-0.46.0-x86_64.tar.gz": new Uint8Array(readFileSync(out)) });
	expect(await installRelease(kitty(), await checkAndTarget(kitty(), c), c)).toMatchObject({
		result: "rolled_back",
		installed: "0.45.0",
	});
	expect(readFileSync(join(folder, "lib/version"), "utf8")).toBe("kitty 0.45.0\n");
	expect(lstatSync(link).isSymbolicLink()).toBe(true);
});

test("a folder app whose archive lacks a bin changes nothing", async () => {
	publish("0.44.0", { "kitty-0.44.0-x86_64.tar.gz": await kittyTarball("0.44.0") });
	const spec = { ...kitty(), bins: ["bin/kitty", "bin/missing"] };
	const c = ctx();
	expect(await installRelease(spec, await checkAndTarget(spec, c), c)).toMatchObject({
		result: "failed",
		detail: expect.stringContaining("missing"),
	});
	expect(existsSync(join(t.paths.home, ".local/share/kitty"))).toBe(false);
	expect(existsSync(join(t.paths.home, ".local/bin/kitty"))).toBe(false);
});

test("a folder app never replaces a folder Upkeep did not make, and keeps nothing of it", async () => {
	const folder = join(t.paths.home, ".local/share/kitty");
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, "notes.txt"), "mine");
	publish("0.44.0", { "kitty-0.44.0-x86_64.tar.gz": await kittyTarball("0.44.0") });
	const c = ctx();
	expect(await installRelease(kitty(), await checkAndTarget(kitty(), c), c)).toMatchObject({
		result: "failed",
		detail: `${folder} is already there and Upkeep did not make it, so it is left alone. Move it, or point the table's folder somewhere new.`,
	});
	expect(readFileSync(join(folder, "notes.txt"), "utf8")).toBe("mine");
	expect(existsSync(join(t.paths.data, "backups/kitty"))).toBe(false);
	expect(existsSync(join(t.paths.cache, "dl"))).toBe(false);
	// One Upkeep made for this app is its own to replace.
	writeFileSync(join(folder, ".upkeep"), "kitty\n");
	expect(await installRelease(kitty(), await checkAndTarget(kitty(), c), c)).toMatchObject({ result: "done" });
	expect(readFileSync(join(folder, ".upkeep"), "utf8")).toBe("kitty\n");
	expect(existsSync(join(folder, "notes.txt"))).toBe(false);
});

test("a table that turns folder on keeps a point of the old program and the folder, though they share a name", async () => {
	// Installed before as a bare program, with a folder Upkeep made earlier beside it.
	const folder = join(t.paths.home, ".local/share/kitty");
	mkdirSync(join(folder, "lib"), { recursive: true });
	writeFileSync(join(folder, ".upkeep"), "kitty\n");
	writeFileSync(join(folder, "lib/version"), "kitty 0.43.0\n");
	script(join(t.paths.home, ".local/bin/kitty"), 'echo "kitty 0.43.0"');
	publish("0.44.0", { "kitty-0.44.0-x86_64.tar.gz": await kittyTarball("0.44.0") });
	const c = ctx();
	expect(await installRelease(kitty(), await checkAndTarget(kitty(), c), c)).toMatchObject({ result: "done" });
	const point = join(t.paths.data, "backups/kitty/0.43.0");
	expect(readdirSync(point).toSorted()).toEqual(
		["folder-kitty", "kitten", "kitty", "meta.json"].filter((n) => existsSync(join(point, n))),
	);
	expect(readFileSync(join(point, "kitty"), "utf8")).toContain("kitty 0.43.0");
	expect(readFileSync(join(point, "folder-kitty/lib/version"), "utf8")).toBe("kitty 0.43.0\n");
	// Putting it back gives the bare program and the old folder again.
	expect(await restoreBackup(t.paths, kitty(), "0.43.0", c.run)).toEqual({ ok: true });
	expect(lstatSync(join(t.paths.home, ".local/bin/kitty")).isSymbolicLink()).toBe(false);
	expect(readFileSync(join(folder, "lib/version"), "utf8")).toBe("kitty 0.43.0\n");
});

test("a folder app finds a program named with its version through a *, and links it under its plain name", async () => {
	publish("0.44.0", { "kitty-0.44.0-x86_64.tar.gz": await kittyTarball("0.44.0") });
	const spec = { ...kitty(), bins: ["bin/kit*"] };
	const c = ctx();
	expect(await installRelease(spec, await checkAndTarget(spec, c), c)).toMatchObject({ result: "done" });
	expect(lstatSync(join(t.paths.home, ".local/bin/kitty")).isSymbolicLink()).toBe(true);
});

test("a folder app whose link cannot be made after the swap is put back", async () => {
	const bin = join(t.paths.home, ".local/bin");
	publish("0.44.0", { "kitty-0.44.0-x86_64.tar.gz": await kittyTarball("0.44.0") });
	const c = ctx();
	await installRelease(kitty(), await checkAndTarget(kitty(), c), c);
	publish("0.45.0", { "kitty-0.45.0-x86_64.tar.gz": await kittyTarball("0.45.0") });
	const target = await checkAndTarget(kitty(), c);
	// The kitten link is gone and the bin directory cannot be written: kitty's link is already right, kitten's fails.
	rmSync(join(bin, "kitten"));
	chmodSync(bin, 0o555);
	try {
		expect(await installRelease(kitty(), target, c)).toMatchObject({
			result: "failed",
			detail: "Could not install kitty. Restored 0.44.0.",
		});
	} finally {
		chmodSync(bin, 0o755);
	}
	expect(readFileSync(join(t.paths.home, ".local/share/kitty/lib/version"), "utf8")).toBe("kitty 0.44.0\n");
});

test("install: a zip on a system without unzip says to install unzip, and keeps the old copy", async () => {
	script(join(t.paths.home, ".local/bin/uv"), 'echo "uv 0.9.1"');
	publish("0.9.2", { "uv-x86_64-unknown-linux-gnu.zip": new Uint8Array([1, 2, 3]) });
	const { run } = recordingRun(t.paths, (argv) =>
		argv[0] === "unzip"
			? { code: 127, stdout: "", stderr: "Executable not found in $PATH: unzip", timedOut: false }
			: undefined,
	);
	const spec = { ...uv(["uv"]), asset: "linux-gnu\\.zip$" };
	const c = ctx(run);
	expect(await installRelease(spec, await checkAndTarget(spec, c), c)).toMatchObject({
		result: "failed",
		installed: "0.9.1",
		detail:
			"Opening uv-x86_64-unknown-linux-gnu.zip needs the unzip program, which is not installed. Install unzip from the system's packages, then try again.",
	});
});

test("install: a file fetched ahead of its turn installs without a download, and its early time is the download stage", async () => {
	installZen("1.17.9b");
	const body = bash('echo "zen 1.18.0b"');
	publish("1.18.0b", { "zen.linux-x86_64.AppImage": body });
	const c = ctx();
	const target = await checkAndTarget(zen(), c);
	mkdirSync(join(t.paths.cache, "dl"), { recursive: true });
	writeFileSync(dlPath(t.paths, "zen", "zen.linux-x86_64.AppImage"), body);
	let asked = 0;
	const counted: FetchLike = async (url, init) => {
		if (url.endsWith(".AppImage")) asked += 1;
		return fakeFetch(url, init);
	};
	const sha256 = new Bun.CryptoHasher("sha256").update(body).digest("hex");
	const outcome = await installRelease(zen(), target, {
		...c,
		fetch: counted,
		early: async () => ({ bytes: body.length, sha256, ms: 1234 }),
	});
	expect(outcome).toMatchObject({ result: "done", installed: "1.18.0b" });
	expect(outcome.stages.download).toBe(1234);
	expect(asked).toBe(0);
	expect(stages.find(([s, p]) => s === "download" && p === 100)).toBeDefined();
});
