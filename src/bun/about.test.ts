import { expect, test } from "bun:test";
import { aboutUrl, HOME, systemLine } from "./about";

const MINT = 'NAME="Linux Mint"\nVERSION="22.3 (Zena)"\nPRETTY_NAME="Linux Mint 22.3"\nID=linuxmint\n';

test("the system line names the distribution, the desktop and the session, and leaves out what is not set", () => {
	expect(systemLine(MINT, { XDG_CURRENT_DESKTOP: "X-Cinnamon", XDG_SESSION_TYPE: "x11" })).toBe(
		"Linux Mint 22.3, X-Cinnamon, x11",
	);
	expect(systemLine("PRETTY_NAME=Arch Linux\n", { XDG_SESSION_TYPE: "wayland" })).toBe("Arch Linux, wayland");
	expect(systemLine("PRETTY_NAME='Fedora Linux 45'\n", {})).toBe("Fedora Linux 45");
	expect(systemLine("", { XDG_CURRENT_DESKTOP: "", XDG_SESSION_TYPE: undefined })).toBe("Linux");
	// Whatever the machine holds stays one short line: no line break gets through, and a long value is cut.
	expect(systemLine("", { XDG_CURRENT_DESKTOP: "a\nb\tc", XDG_SESSION_TYPE: "x".repeat(500) })).toBe(
		`a b c, ${"x".repeat(80)}`,
	);
	// A key that only ends in PRETTY_NAME is not the name.
	expect(systemLine("NOT_PRETTY_NAME=x\n", {})).toBe("Linux");
});

test("the repo and the changelog open Upkeep's own pages", () => {
	const info = { version: "0.1.0", arch: "x64", osRelease: MINT, env: {} };
	expect(aboutUrl("repo", info)).toBe(HOME);
	expect(aboutUrl("changelog", info)).toBe(`${HOME}/blob/main/CHANGELOG.md`);
});

test("a bug report opens a new issue with the version and the system filled in, safely encoded", () => {
	const url = aboutUrl("bug", {
		version: "0.1.0",
		arch: "arm64",
		osRelease: 'PRETTY_NAME="Odd & Name #1"\n',
		env: { XDG_CURRENT_DESKTOP: "GNOME", XDG_SESSION_TYPE: "wayland" },
	});
	expect(url.startsWith(`${HOME}/issues/new?body=`)).toBe(true);
	// Nothing in the system's own name can end the body or start another parameter.
	expect(url.slice(url.indexOf("?") + 1)).not.toMatch(/[&#\s]/);
	const body = new URL(url).searchParams.get("body") ?? "";
	expect(body).toContain("**What happened**");
	expect(body).toContain("**What I expected**");
	expect(body.endsWith("Upkeep 0.1.0 (arm64)\nOdd & Name #1, GNOME, wayland")).toBe(true);
});
