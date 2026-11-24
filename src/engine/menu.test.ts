import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MESSAGES } from "../shared/messages";
import { appsDir, execProgram, foreignEntry, quoteExec, removeMenu, rewriteEntry, writeMenu } from "./menu";
import { recordingRun, script, tempHome } from "./testkit";

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("menu");
});
afterEach(() => t.cleanup());

/** A PNG header of the given size: enough for the IHDR read, not a picture. */
function png(w: number, h: number): Buffer {
	const b = Buffer.alloc(33);
	b.write("\x89PNG\r\n\x1a\n", 0, "latin1");
	b.writeUInt32BE(13, 8);
	b.write("IHDR", 12, "latin1");
	b.writeUInt32BE(w, 16);
	b.writeUInt32BE(h, 20);
	return b;
}

/**
 * A fake AppImage at dest whose --appimage-extract copies the top-level payload names that match its pattern into
 * ./squashfs-root, keeping symlinks, as the type-2 runtime does. Any other argument exits 1.
 */
function fakeImage(dest: string, payload: Record<string, string | Buffer | { link: string }>): string {
	const dir = join(t.dir, "payload");
	mkdirSync(dir, { recursive: true });
	for (const [name, body] of Object.entries(payload)) {
		if (typeof body === "object" && "link" in body) symlinkSync(body.link, join(dir, name));
		else writeFileSync(join(dir, name), body);
	}
	return script(
		dest,
		`[ "$1" = --appimage-extract ] || exit 1
mkdir -p squashfs-root
shopt -s dotglob nullglob
for f in "${dir}"/*; do n=$(basename "$f"); case "$n" in $2) cp -P "$f" squashfs-root/;; esac; done`,
	);
}

const DESKTOP =
	"[Desktop Entry]\nName=Zed\nExec=AppRun --foreground %U\nTryExec=AppRun\nIcon=zed\nType=Application\n\n[Desktop Action New]\nExec=AppRun --new\n";

function ctx() {
	const r = recordingRun(t.paths, (argv) =>
		argv[0] === "update-desktop-database" ? { code: 127, stdout: "", stderr: "", timedOut: false } : undefined,
	);
	return { calls: r.calls, ctx: { paths: t.paths, run: r.run } };
}

test("writeMenu: the entry starts the AppImage with its own arguments and an SVG icon goes to hicolor/scalable", async () => {
	const dest = fakeImage(join(t.paths.home, "Apps/Zed 1%.AppImage"), { "zed.desktop": DESKTOP, "zed.svg": "<svg/>" });
	const { calls, ctx: c } = ctx();
	const r = await writeMenu("zed", dest, c);
	const share = join(t.dir, "data");
	const icon = join(share, "icons/hicolor/scalable/apps/upkeep-zed.svg");
	const entry = join(share, "applications/upkeep-zed.desktop");
	expect(r).toEqual({ files: [icon, entry] });
	const text = readFileSync(entry, "utf8");
	expect(text).toContain(`Exec="${dest.replace("%", "%%")}" --foreground %U`);
	expect(text).toContain(`Exec="${dest.replace("%", "%%")}" --new`);
	expect(text).toContain(`Icon=${icon}`);
	expect(text).not.toContain("TryExec");
	expect(readFileSync(icon, "utf8")).toBe("<svg/>");
	// The AppImage is only ever asked to extract, and the menu's database is refreshed on the person's folder.
	const toImage = calls.filter((x) => x.argv[0] === dest).map((x) => x.argv.slice(1));
	expect(toImage).toEqual([
		["--appimage-extract", "*.desktop"],
		["--appimage-extract", "zed.*"],
	]);
	expect(calls.at(-1)?.argv).toEqual(["update-desktop-database", appsDir(t.paths)]);
	// The temp folder is gone.
	expect(readdirSync(t.paths.cache).filter((n) => n.startsWith("menu-"))).toEqual([]);
});

test("writeMenu: a .DirIcon link is followed, a listed PNG size goes to hicolor and any other to pixmaps", async () => {
	const share = join(t.dir, "data");
	const dest = fakeImage(join(t.paths.home, "a.AppImage"), {
		"a.desktop": "[Desktop Entry]\nExec=a\nIcon=missing\n",
		".DirIcon": { link: "a.png" },
		"a.png": png(256, 256),
	});
	expect(await writeMenu("a", dest, ctx().ctx)).toEqual({
		files: [join(share, "icons/hicolor/256x256/apps/upkeep-a.png"), join(share, "applications/upkeep-a.desktop")],
	});
	const odd = fakeImage(join(t.paths.home, "b.AppImage"), {
		"a.desktop": "[Desktop Entry]\nExec=b\nIcon=b\n",
		"b.png": png(300, 200),
	});
	const r = await writeMenu("b", odd, ctx().ctx);
	expect(r).toEqual({ files: [join(share, "pixmaps/upkeep-b.png"), join(share, "applications/upkeep-b.desktop")] });
});

test("writeMenu: an icon link that leaves the image is not followed, and the entry is still written", async () => {
	const dest = fakeImage(join(t.paths.home, "c.AppImage"), {
		"c.desktop": "[Desktop Entry]\nExec=c\n",
		".DirIcon": { link: "/etc/hostname" },
	});
	const r = await writeMenu("c", dest, ctx().ctx);
	expect(r).toEqual({ files: [join(t.dir, "data/applications/upkeep-c.desktop")] });
	expect(readFileSync(join(t.dir, "data/applications/upkeep-c.desktop"), "utf8")).toBe(
		`[Desktop Entry]\nExec="${dest}"\n`,
	);
});

test("writeMenu: an AppImage with no entry, or one that is not there, writes nothing", async () => {
	const dest = fakeImage(join(t.paths.home, "d.AppImage"), { "d.svg": "<svg/>" });
	expect(await writeMenu("d", dest, ctx().ctx)).toEqual({ problem: MESSAGES.menuNoEntry(dest) });
	const gone = join(t.paths.home, "nothing.AppImage");
	expect(await writeMenu("e", gone, ctx().ctx)).toEqual({ problem: MESSAGES.menuNoEntry(gone) });
	expect(existsSync(appsDir(t.paths))).toBe(false);
});

test("foreignEntry: finds another tool's entry for the same file, skipping Upkeep's own and bare names", () => {
	const dir = appsDir(t.paths);
	const dest = join(t.paths.home, "Applications/My App.AppImage");
	expect(foreignEntry(t.paths, dest, [])).toBeNull();
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "other.desktop"), "[Desktop Entry]\nExec=firefox %u\n");
	writeFileSync(join(dir, "README"), `Exec=${dest}`);
	const own = join(dir, "upkeep-my.desktop");
	writeFileSync(own, `[Desktop Entry]\nExec=${quoteExec(dest)} %U\n`);
	expect(foreignEntry(t.paths, dest, [own])).toBeNull();
	const theirs = join(dir, "appimagekit_abc-My_App.desktop");
	writeFileSync(theirs, `[Desktop Entry]\nExec="${dest}" %U\n`);
	expect(foreignEntry(t.paths, dest, [own])).toBe(theirs);
});

test("removeMenu: deletes only Upkeep's files under the data folder", async () => {
	const share = join(t.dir, "data");
	const mine = join(share, "applications/upkeep-x.desktop");
	const notMine = join(share, "applications/x.desktop");
	const outside = join(t.dir, "upkeep-elsewhere.desktop");
	for (const f of [mine, notMine, outside]) {
		mkdirSync(dirname(f), { recursive: true });
		writeFileSync(f, "x");
	}
	const { calls, ctx: c } = ctx();
	await removeMenu([mine, notMine, outside, join(share, "applications/upkeep-gone.desktop")], c);
	expect([existsSync(mine), existsSync(notMine), existsSync(outside)]).toEqual([false, true, true]);
	expect(calls.map((x) => x.argv[0])).toEqual(["update-desktop-database"]);
});

test("execProgram and quoteExec read and write the spec's quoting", () => {
	expect(execProgram("AppRun %U")).toBe("AppRun");
	expect(execProgram(' "/a b/c \\"d\\".AppImage" --x')).toBe('/a b/c "d".AppImage');
	expect(execProgram('"/unclosed')).toBe("/unclosed");
	expect(quoteExec('/a b/$x`y"z\\.AppImage')).toBe('"/a b/\\$x\\`y\\"z\\\\.AppImage"');
	expect(rewriteEntry('[Desktop Entry]\nExec="/old path" %F\nIcon=old', "/new", null)).toBe(
		'[Desktop Entry]\nExec="/new" %F\nIcon=old\n',
	);
	expect(rewriteEntry('Exec="/unclosed', "/n", "/i.png")).toBe('Exec="/n"\n');
});
