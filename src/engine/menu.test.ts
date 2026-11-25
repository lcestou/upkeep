import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { MESSAGES } from "../shared/messages";
import {
	appsDir,
	entryOwners,
	execProgram,
	foreignEntry,
	quoteExec,
	removeMenu,
	removeMenuFiles,
	rewriteEntry,
	writeMenu,
} from "./menu";
import { recordingRun, script, tempHome } from "./testkit";
import { createRunner } from "./run";

let t: ReturnType<typeof tempHome>;
let images: Map<string, string>;
beforeEach(() => {
	t = tempHome("menu");
	images = new Map();
});
afterEach(() => t.cleanup());

/** The first bytes of a type-2 AppImage: the ELF magic, then AI\x02 at byte 8. */
const MAGIC = "\x7fELF\x02\x01\x01\x00AI\x02\x00\x00\x00\x00\x00";

/**
 * A fake AppImage at dest: a file with the type-2 magic, whose --appimage-extract (answered by a script the runner
 * starts in its place) copies the payload paths that match into ./squashfs-root, keeping symlinks. A pattern with a
 * glob matches top-level names only; a path inside the image must be named exactly.
 */
function fakeImage(dest: string, payload: Record<string, string | Buffer | { link: string }>): string {
	const dir = join(t.dir, `payload-${images.size}`);
	for (const [name, body] of Object.entries(payload)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		if (typeof body === "object" && "link" in body) symlinkSync(body.link, join(dir, name));
		else writeFileSync(join(dir, name), body);
	}
	mkdirSync(dirname(dest), { recursive: true });
	writeFileSync(dest, MAGIC, "latin1");
	images.set(
		dest,
		script(
			join(t.dir, `extract-${images.size}.sh`),
			`[ "$1" = --appimage-extract ] || exit 1
cd "${dir}" && find . -mindepth 1 \\( -type f -o -type l \\) | sed 's|^\\./||' | while read -r rel; do
  case "$rel" in */*) [ "$rel" = "$2" ] || continue;; *) case "$rel" in $2) ;; *) continue;; esac;; esac
  mkdir -p "$OLDPWD/squashfs-root/$(dirname "$rel")"; cp -P "$rel" "$OLDPWD/squashfs-root/$rel"
done`,
		),
	);
	return dest;
}

const DESKTOP =
	"[Desktop Entry]\nName=Zed\nExec=AppRun --foreground %U\nTryExec=AppRun\nDBusActivatable=true\nIcon=zed\nType=Application\n\n[Desktop Action New]\nExec=AppRun --new\nIcon=zed-new\n";

/** A recording runner that starts each fake image's script in its place and has no update-desktop-database. */
function ctx() {
	// Its own capture folder: two runners counting from 0 in one folder would share output files.
	const real = createRunner(t.paths.home, join(t.dir, "fake-tmp"), "/usr/bin:/bin");
	const r = recordingRun(t.paths, (argv, opts) => {
		if (argv[0] === "update-desktop-database") return { code: 127, stdout: "", stderr: "", timedOut: false };
		const fake = images.get(argv[0] ?? "");
		return fake ? real(["bash", fake, ...argv.slice(1)], opts) : undefined;
	});
	return { calls: r.calls, ctx: { paths: t.paths, run: r.run } };
}

const share = () => join(t.dir, "data");

test("writeMenu: the entry starts the AppImage with its own arguments, and the icon is named by its path", async () => {
	const dest = fakeImage(join(t.paths.home, "Apps/Zed 1%.AppImage"), { "zed.desktop": DESKTOP, "zed.svg": "<svg/>" });
	const { calls, ctx: c } = ctx();
	const r = await writeMenu("zed", dest, c);
	const icon = join(share(), "icons/upkeep-zed.svg");
	const entry = join(share(), "applications/upkeep-zed.desktop");
	expect(r).toEqual({ files: [icon, entry] });
	const text = readFileSync(entry, "utf8");
	const quoted = `"${dest.replace("%", "%%")}"`;
	expect(text).toContain(`Exec=${quoted} --foreground %U`);
	expect(text).toContain(`Exec=${quoted} --new`);
	expect(text).toContain(`Icon=${icon}`);
	// An action's own icon stays.
	expect(text).toContain("Icon=zed-new");
	expect(text).not.toContain("TryExec");
	expect(text).not.toContain("DBusActivatable");
	expect(readFileSync(icon, "utf8")).toBe("<svg/>");
	// The AppImage is only ever asked to extract, and the menu's database is refreshed on the person's folder.
	const toImage = calls.filter((x) => x.argv[0] === dest).map((x) => x.argv.slice(1));
	expect(toImage).toEqual([
		["--appimage-extract", "*.desktop"],
		["--appimage-extract", "zed.*"],
	]);
	expect(calls.at(-1)?.argv).toEqual(["update-desktop-database", appsDir(t.paths)]);
	expect(readdirSync(t.paths.cache).filter((n) => n.startsWith("menu-"))).toEqual([]);
});

test("writeMenu: a linked entry and icon are followed into the image, and a .DirIcon PNG or SVG is kept", async () => {
	const dest = fakeImage(join(t.paths.home, "a.AppImage"), {
		"CC Switch.desktop": { link: "usr/share/applications/CC Switch.desktop" },
		"usr/share/applications/CC Switch.desktop": "[Desktop Entry]\r\nExec=env A=1 AppRun %U\r\nIcon=a\r\n",
		"a.png": { link: "usr/share/icons/a.png" },
		"usr/share/icons/a.png": Buffer.from("\x89PNG\r\n\x1a\n", "latin1"),
	});
	const r = await writeMenu("a", dest, ctx().ctx);
	const entry = join(share(), "applications/upkeep-a.desktop");
	expect(r).toEqual({ files: [join(share(), "icons/upkeep-a.png"), entry] });
	expect(readFileSync(entry, "utf8")).toBe(
		`[Desktop Entry]\nExec=env A=1 "${dest}" %U\nIcon=${join(share(), "icons/upkeep-a.png")}\n`,
	);
	const svg = fakeImage(join(t.paths.home, "b.AppImage"), {
		"b.desktop": "[Desktop Entry]\nExec=b\n",
		".DirIcon": '<?xml version="1.0"?><svg/>',
	});
	expect(await writeMenu("b", svg, ctx().ctx)).toEqual({
		files: [join(share(), "icons/upkeep-b.svg"), join(share(), "applications/upkeep-b.desktop")],
	});
});

test("writeMenu: an icon link that leaves the image is not followed, and the entry is still written", async () => {
	const dest = fakeImage(join(t.paths.home, "c.AppImage"), {
		"c.desktop": "[Desktop Entry]\nExec=c\n",
		".DirIcon": { link: "/etc/hostname" },
	});
	const r = await writeMenu("c", dest, ctx().ctx);
	expect(r).toEqual({ files: [join(share(), "applications/upkeep-c.desktop")] });
	expect(readFileSync(join(share(), "applications/upkeep-c.desktop"), "utf8")).toBe(
		`[Desktop Entry]\nExec="${dest}"\n`,
	);
});

test("writeMenu: nothing installed, not a type-2 AppImage, no entry inside, or an entry that stays out: nothing written", async () => {
	const gone = join(t.paths.home, "nothing.AppImage");
	expect(await writeMenu("e", gone, ctx().ctx)).toEqual({ problem: MESSAGES.menuNotInstalled(gone) });
	// A script named .AppImage is never run.
	const plain = script(join(t.paths.home, "plain.AppImage"), `touch "${join(t.dir, "ran")}"`);
	const { calls, ctx: c } = ctx();
	expect(await writeMenu("p", plain, c)).toEqual({ problem: MESSAGES.menuNoEntry(plain) });
	expect(calls).toEqual([]);
	const dest = fakeImage(join(t.paths.home, "d.AppImage"), { "d.svg": "<svg/>" });
	expect(await writeMenu("d", dest, ctx().ctx)).toEqual({ problem: MESSAGES.menuNoEntry(dest) });
	for (const [i, line] of ["NoDisplay=true", "Hidden=true", "X-AppImage-Integrate=false"].entries()) {
		const img = fakeImage(join(t.paths.home, `h${i}.AppImage`), { "h.desktop": `[Desktop Entry]\nExec=h\n${line}\n` });
		// oxlint-disable-next-line no-await-in-loop -- each image is its own case
		expect(await writeMenu(`h${i}`, img, ctx().ctx)).toEqual({ problem: MESSAGES.menuStaysOut(img) });
	}
	// An action's NoDisplay is not the entry's.
	const shown = fakeImage(join(t.paths.home, "s.AppImage"), {
		"s.desktop": "[Desktop Entry]\nExec=s\n[Desktop Action x]\nNoDisplay=true\n",
	});
	expect(await writeMenu("s", shown, ctx().ctx)).toHaveProperty("files");
	expect(existsSync(join(t.dir, "ran"))).toBe(false);
});

test("writeMenu sweeps temp folders an interrupted write left, only when they are old", async () => {
	const old = join(t.paths.cache, "menu-old");
	const fresh = join(t.paths.cache, "menu-fresh");
	mkdirSync(old, { recursive: true });
	mkdirSync(fresh);
	utimesSync(old, new Date(0), new Date(0));
	const dest = fakeImage(join(t.paths.home, "z.AppImage"), { "z.desktop": "[Desktop Entry]\nExec=z\n" });
	await writeMenu("z", dest, ctx().ctx);
	expect(readdirSync(t.paths.cache).filter((n) => n.startsWith("menu-"))).toEqual(["menu-fresh"]);
});

test("entryOwners and foreignEntry: another tool's entry is found through links and env, Upkeep's own never", () => {
	const dir = appsDir(t.paths);
	const realFile = join(t.paths.home, "Applications/My App.AppImage");
	mkdirSync(dirname(realFile), { recursive: true });
	writeFileSync(realFile, MAGIC);
	const link = join(t.paths.home, ".local/bin/myapp.AppImage");
	mkdirSync(dirname(link), { recursive: true });
	symlinkSync(realFile, link);
	expect(foreignEntry(entryOwners(t.paths), link)).toBeNull();
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "other.desktop"), "[Desktop Entry]\nExec=firefox %u\n");
	writeFileSync(join(dir, "README"), `Exec=${realFile}`);
	// A leftover of Upkeep's own is not another tool's, whatever state.json says.
	writeFileSync(join(dir, "upkeep-my.desktop"), `[Desktop Entry]\nExec=${quoteExec(realFile)} %U\n`);
	expect(foreignEntry(entryOwners(t.paths), link)).toBeNull();
	const theirs = join(dir, "appimagekit_abc-My_App.desktop");
	writeFileSync(theirs, `[Desktop Entry]\nExec=env DESKTOPINTEGRATION=1 "${realFile}" %U\n`);
	expect(foreignEntry(entryOwners(t.paths), link)).toBe(theirs);
	expect(foreignEntry(entryOwners(t.paths), realFile)).toBe(theirs);
});

test("removeMenu: deletes only Upkeep's files under the data folder", async () => {
	const mine = join(share(), "applications/upkeep-x.desktop");
	const notMine = join(share(), "applications/x.desktop");
	const outside = join(t.dir, "upkeep-elsewhere.desktop");
	for (const f of [mine, notMine, outside]) {
		mkdirSync(dirname(f), { recursive: true });
		writeFileSync(f, "x");
	}
	const { calls, ctx: c } = ctx();
	await removeMenu([mine, notMine, outside, join(share(), "applications/upkeep-gone.desktop")], c);
	expect([existsSync(mine), existsSync(notMine), existsSync(outside)]).toEqual([false, true, true]);
	expect(calls.map((x) => x.argv[0])).toEqual(["update-desktop-database"]);
	removeMenuFiles([notMine], t.paths);
	expect(existsSync(notMine)).toBe(true);
});

test("execProgram and quoteExec read and write both escape layers of the spec", () => {
	expect(execProgram("AppRun %U")).toBe("AppRun");
	expect(execProgram('"/a b/c \\\\"d\\\\".AppImage" --x')).toBe('/a b/c "d".AppImage');
	expect(execProgram('"/unclosed')).toBe("/unclosed");
	expect(execProgram("env -i A=1 B=2 /x/y %U")).toBe("/x/y");
	expect(execProgram("env")).toBe("");
	// The spec's own example: a $ inside quotes is \\$ in the file.
	expect(quoteExec('/a b/$x`y"z\\.AppImage')).toBe('"/a b/\\\\$x\\\\`y\\\\"z\\\\\\\\.AppImage"');
	expect(execProgram(quoteExec('/a b/$x`y"z\\.AppImage'))).toBe('/a b/$x`y"z\\.AppImage');
	expect(execProgram("/a\\sb")).toBe("/a");
	expect(rewriteEntry('[Desktop Entry]\nExec="/old path" %F\nIcon=old', "/new", null)).toBe(
		'[Desktop Entry]\nExec="/new" %F\nIcon=old\n',
	);
	expect(rewriteEntry('Exec="/unclosed', "/n", "/i.png")).toBe('Exec="/n"\n');
	expect(rewriteEntry("Exec=env", "/n", null)).toBe('Exec=env "/n"\n');
});

test("writeMenu refuses a key or dest that could write elsewhere or add a line, and a failed write is a sentence", async () => {
	const dest = fakeImage(join(t.paths.home, "w.AppImage"), { "w.desktop": "[Desktop Entry]\nExec=w\n" });
	expect(await writeMenu("../../x", dest, ctx().ctx)).toEqual({ problem: MESSAGES.menuNoEntry(dest) });
	const broken = `${dest}\nExec=/bin/sh`;
	expect(await writeMenu("w", broken, ctx().ctx)).toEqual({ problem: MESSAGES.menuNoEntry(broken) });
	expect(() => quoteExec("/a\nb")).toThrow();
	expect(existsSync(appsDir(t.paths))).toBe(false);
	// The applications folder cannot be made: a file stands where it would go.
	mkdirSync(dirname(appsDir(t.paths)), { recursive: true });
	writeFileSync(appsDir(t.paths), "");
	const r = await writeMenu("w", dest, ctx().ctx);
	expect("problem" in r && r.problem.startsWith("Could not write the menu entry: ")).toBe(true);
});

test("removeMenuFiles goes on past a file it may not delete", () => {
	const locked = join(share(), "applications");
	const stuck = join(locked, "upkeep-a.desktop");
	const icon = join(share(), "icons/upkeep-a.svg");
	for (const f of [stuck, icon]) {
		mkdirSync(dirname(f), { recursive: true });
		writeFileSync(f, "x");
	}
	chmodSync(locked, 0o500);
	try {
		removeMenuFiles([stuck, icon], t.paths);
	} finally {
		chmodSync(locked, 0o700);
	}
	expect([existsSync(stuck), existsSync(icon)]).toEqual([true, false]);
});
