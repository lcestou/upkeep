import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSpec, Stage } from "../../shared/types";
import { listBackups } from "../backup";
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

const fakeFetch: FetchLike = async (url) => {
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
		settings: { keepBackups: 1, notify: true, checkAtLogin: false },
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

test("install: a deb goes through sudo -n dpkg -i and has no restore point", async () => {
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
	expect(Object.keys(outcome.stages)).toEqual(["download", "install", "verify"]);
	const dpkg = calls.find((x) => x.argv[2] === "dpkg");
	expect(dpkg?.argv).toEqual([
		"sudo",
		"-n",
		"dpkg",
		"-i",
		join(t.paths.cache, "dl/rustdesk-rustdesk-1.4.3-x86_64.deb"),
	]);
	expect(listBackups(t.paths, "rustdesk")).toEqual([]);
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
});
