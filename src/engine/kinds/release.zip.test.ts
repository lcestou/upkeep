import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppSpec } from "../../shared/types";
import { listBackups } from "../backup";
import type { FetchLike } from "../github";
import { readInflight } from "../store";
import { realRun, script, tempHome } from "../testkit";
import type { KindCtx } from "./context";
import { checkRelease, installRelease } from "./release";

let t: ReturnType<typeof tempHome>;
let assets: Record<string, Uint8Array<ArrayBuffer>> = {};
let release: Record<string, unknown> = {};
beforeEach(() => {
	t = tempHome("zip");
	mkdirSync(join(t.dir, "proc"));
});
afterEach(() => t.cleanup());

const sha = (b: Uint8Array) => `sha256:${new Bun.CryptoHasher("sha256").update(b).digest("hex")}`;

function publish(tag: string, files: Record<string, Uint8Array<ArrayBuffer>>): void {
	assets = files;
	release = {
		tag_name: tag,
		html_url: `https://github.com/sxyazi/yazi/releases/tag/${tag}`,
		published_at: "2026-11-09T00:00:00Z",
		body: "",
		assets: Object.entries(files).map(([name, b]) => ({
			name,
			browser_download_url: `https://dl.test/${name}`,
			size: b.length,
			digest: sha(b),
		})),
	};
}

const fakeFetch: FetchLike = async (url) => {
	if (url.startsWith("https://api.github.com/")) return Response.json(release);
	const body = assets[url.replace("https://dl.test/", "")];
	return body ? new Response(body) : new Response("missing", { status: 404 });
};

const ctx = (): KindCtx => ({
	paths: t.paths,
	run: realRun(t.paths),
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
	log: () => {},
	stage: () => {},
	procRoot: join(t.dir, "proc"),
});

/** Builds a real .zip with /usr/bin/zip, the way yazi and bun ship. */
async function zipball(files: Record<string, string>): Promise<Uint8Array<ArrayBuffer>> {
	const src = join(t.dir, "zipsrc");
	for (const [name, body] of Object.entries(files)) script(join(src, name), body);
	const out = join(t.dir, "out.zip");
	const r = await realRun(t.paths)(["zip", "-qr", out, "."], { cwd: src });
	if (r.code !== 0) throw new Error(r.stderr || r.stdout);
	return new Uint8Array(readFileSync(out));
}

const yazi = (): AppSpec => ({
	key: "yazi",
	name: "Yazi",
	kind: "archive",
	repo: "sxyazi/yazi",
	asset: "x86_64-unknown-linux-gnu\\.zip$",
	dest: "~/.local/bin/yazi",
	bins: ["yazi-x86_64-unknown-linux-gnu/yazi", "yazi-x86_64-unknown-linux-gnu/ya"],
});

test("install: a zip archive is unpacked with unzip and every bin is installed", async () => {
	const bin = join(t.paths.home, ".local/bin");
	script(join(bin, "yazi"), 'echo "Yazi 26.1.0 (abc 2026-01-01)"');
	script(join(bin, "ya"), 'echo "Ya 26.1.0"');
	publish("v26.9.1", {
		"yazi-x86_64-unknown-linux-gnu.zip": await zipball({
			"yazi-x86_64-unknown-linux-gnu/yazi": 'echo "Yazi 26.9.1 (def 2026-09-01)"',
			"yazi-x86_64-unknown-linux-gnu/ya": 'echo "Ya 26.9.1"',
			"yazi-x86_64-unknown-linux-gnu/README.md": "not a bin",
		}),
		"yazi-aarch64-unknown-linux-gnu.zip": new Uint8Array([0]),
	});
	const c = ctx();
	const checked = await checkRelease(yazi(), c);
	expect(checked).toMatchObject({ installed: "26.1.0", latest: "26.9.1", status: "ready" });
	if (!checked?.target) throw new Error("no target");
	expect(checked.target.asset?.name).toBe("yazi-x86_64-unknown-linux-gnu.zip");
	const outcome = await installRelease(yazi(), checked.target, c);
	expect(outcome).toMatchObject({ result: "done", installed: "26.9.1" });
	expect(readFileSync(join(bin, "yazi"), "utf8")).toContain("Yazi 26.9.1");
	expect(readFileSync(join(bin, "ya"), "utf8")).toContain("Ya 26.9.1");
	expect(statSync(join(bin, "ya")).mode & 0o777).toBe(0o755);
	expect(readdirSync(bin).toSorted()).toEqual(["ya", "yazi"]);
	expect(listBackups(t.paths, "yazi").map((p) => p.version)).toEqual(["26.1.0"]);
	expect(readdirSync(join(t.paths.data, "backups/yazi/26.1.0")).toSorted()).toEqual(["meta.json", "ya", "yazi"]);
	expect(readdirSync(join(t.paths.cache, "dl"))).toEqual([]);
	expect(readInflight(t.paths)).toBeNull();
});

test("install: a zip that unzip cannot read fails and changes nothing", async () => {
	const bin = join(t.paths.home, ".local/bin");
	script(join(bin, "yazi"), 'echo "Yazi 26.1.0"');
	script(join(bin, "ya"), 'echo "Ya 26.1.0"');
	publish("v26.9.1", { "yazi-x86_64-unknown-linux-gnu.zip": new TextEncoder().encode("PK not really a zip") });
	const c = ctx();
	const checked = await checkRelease(yazi(), c);
	if (!checked?.target) throw new Error("no target");
	const outcome = await installRelease(yazi(), checked.target, c);
	expect(outcome).toMatchObject({
		result: "failed",
		installed: "26.1.0",
		detail: "Could not extract yazi-x86_64-unknown-linux-gnu.zip.",
	});
	expect(readFileSync(join(bin, "yazi"), "utf8")).toContain("Yazi 26.1.0");
	expect(readdirSync(join(t.paths.cache, "dl"))).toEqual([]);
	expect(readInflight(t.paths)).toBeNull();
});
