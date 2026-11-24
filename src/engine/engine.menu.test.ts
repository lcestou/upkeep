import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MESSAGES } from "../shared/messages";
import { createEngine, type EngineDeps, REASON_BUSY } from "./engine";
import type { FetchLike } from "./github";
import { appsDir } from "./menu";
import { loadState } from "./store";
import { recordingRun, script, tempHome } from "./testkit";

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("engine-menu");
	mkdirSync(join(t.dir, "proc"));
});
afterEach(() => t.cleanup());

const MANIFEST = `
[apps.img]
name = "Img"
kind = "appimage"
repo = "o/img"
asset = 'img\\.AppImage$'
dest = "~/Applications/img.AppImage"

[apps.tool]
name = "Tool"
kind = "file"
repo = "o/tool"
asset = 'tool$'
dest = "~/.local/bin/tool"
`;

/**
 * A fake AppImage of the given version: --version prints it, and --appimage-extract writes the entry (named after the
 * version, so a refresh shows) and an SVG icon when the pattern matches, as the type-2 runtime does.
 */
const image = (v: string) => `#!/bin/bash
if [ "$1" = --version ]; then echo "img ${v}"; exit 0; fi
[ "$1" = --appimage-extract ] || exit 1
mkdir -p squashfs-root
case img.desktop in $2) printf '[Desktop Entry]\\nName=Img ${v}\\nExec=AppRun %%U\\nIcon=img\\n' > squashfs-root/img.desktop;; esac
case img.svg in $2) echo '<svg/>' > squashfs-root/img.svg;; esac
`;

function deps(): EngineDeps {
	writeFileSync(join(t.dir, "seed.toml"), MANIFEST);
	script(join(t.paths.home, "Applications/img.AppImage"), image("1.0.0").replace("#!/bin/bash\n", ""));
	script(join(t.paths.home, ".local/bin/tool"), 'echo "tool 1.0.0"');
	const fetch: FetchLike = async (url) => {
		if (url === "https://api.github.com/repos/o/img/releases/latest")
			return Response.json({
				tag_name: "v1.1.0",
				html_url: "https://github.com/o/img/releases/tag/v1.1.0",
				published_at: "2026-11-09T00:00:00Z",
				body: "",
				assets: [
					{
						name: "img.AppImage",
						browser_download_url: "https://dl.test/img.AppImage",
						size: image("1.1.0").length,
						digest: null,
					},
				],
			});
		if (url === "https://dl.test/img.AppImage") return new Response(image("1.1.0"));
		return new Response("{}", { status: 404 });
	};
	const { run } = recordingRun(t.paths, (argv) =>
		argv[0] === "gh"
			? { code: 1, stdout: "", stderr: "", timedOut: false }
			: ["flatpak", "snap", "apt-cache", "update-desktop-database"].includes(argv[0] ?? "")
				? { code: 127, stdout: "", stderr: "", timedOut: false }
				: undefined,
	);
	return {
		paths: t.paths,
		seedManifest: join(t.dir, "seed.toml"),
		fetch,
		run,
		now: () => new Date(),
		procRoot: join(t.dir, "proc"),
		retryMs: 1,
		pollMs: 10,
	};
}

const entry = () => join(appsDir(t.paths), "upkeep-img.desktop");
const row = (e: ReturnType<typeof createEngine>, key: string) => e.snapshot().apps.find((a) => a.key === key);

test("the menu switch is off for an AppImage row, absent for another kind, and on writes and records the entry", async () => {
	const engine = createEngine(deps());
	await engine.check();
	expect(row(engine, "img")?.menu).toBe("off");
	expect(row(engine, "tool")?.menu).toBeUndefined();
	expect(await engine.setMenu("tool", true)).toEqual({ ok: false });
	expect(await engine.setMenu("nope", true)).toEqual({ ok: false });
	expect(await engine.setMenu("img", true)).toEqual({ ok: true });
	expect(row(engine, "img")?.menu).toBe("on");
	const files = loadState(t.paths).menu.img ?? [];
	expect(files).toEqual([join(t.dir, "data/icons/hicolor/scalable/apps/upkeep-img.svg"), entry()]);
	expect(readFileSync(entry(), "utf8")).toContain("Name=Img 1.0.0");
	// Off deletes exactly what was recorded.
	expect(await engine.setMenu("img", false)).toEqual({ ok: true });
	expect(files.some((f) => existsSync(f))).toBe(false);
	expect(loadState(t.paths).menu.img).toBeUndefined();
	expect(row(engine, "img")?.menu).toBe("off");
});

test("an update writes the entry again from the new AppImage, and removing the app deletes it", async () => {
	const engine = createEngine(deps());
	await engine.check();
	await engine.setMenu("img", true);
	await engine.install(["img"]);
	await engine.idle();
	expect(row(engine, "img")?.installed).toBe("1.1.0");
	expect(readFileSync(entry(), "utf8")).toContain("Name=Img 1.1.0");
	engine.dismissSummary();
	expect(await engine.removeApp("img")).toEqual({ ok: true });
	expect(readdirSync(appsDir(t.paths))).toEqual([]);
	expect(loadState(t.paths).menu).toEqual({});
	// The AppImage itself stays, as removing from the list always left it.
	expect(existsSync(join(t.paths.home, "Applications/img.AppImage"))).toBe(true);
});

test("another tool's entry for the same AppImage shows on the row and stops a second one", async () => {
	mkdirSync(appsDir(t.paths), { recursive: true });
	const theirs = join(appsDir(t.paths), "appimagekit_img.desktop");
	writeFileSync(theirs, `[Desktop Entry]\nExec=${join(t.paths.home, "Applications/img.AppImage")} %U\n`);
	const engine = createEngine(deps());
	await engine.check();
	expect(row(engine, "img")).toMatchObject({ menu: "elsewhere", menuDetail: MESSAGES.menuElsewhere(theirs) });
	expect(await engine.setMenu("img", true)).toEqual({ ok: false, detail: MESSAGES.menuElsewhere(theirs) });
	expect(existsSync(entry())).toBe(false);
});

test("an AppImage with no entry inside says so and records nothing; a run in progress refuses", async () => {
	const engine = createEngine(deps());
	await engine.check();
	const dest = join(t.paths.home, "Applications/img.AppImage");
	script(dest, 'echo "img 1.0.0"');
	expect(await engine.setMenu("img", true)).toEqual({ ok: false, detail: MESSAGES.menuNoEntry(dest) });
	expect(loadState(t.paths).menu).toEqual({});
	const during: { p?: Promise<{ ok: boolean; detail?: string }> } = {};
	engine.subscribe((e) => {
		if (e.type === "run" && e.run.phase === "installing") during.p ??= engine.setMenu("img", true);
	});
	await engine.install(["img"]);
	await engine.idle();
	expect(await during.p).toEqual({ ok: false, detail: REASON_BUSY });
});
