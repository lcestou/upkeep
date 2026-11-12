import { expect, test } from "bun:test";
import { cargoBin, draftFor, goBin } from "./draft";

/** The build file a draft reads from these root names, or null. */
const buildFile = (names: string[]) => draftFor(names, null, "x")?.file ?? null;

test("the most specific build file wins: a Rust project's Makefile is a convenience", () => {
	expect(buildFile(["Makefile", "Cargo.toml", "README.md"])).toBe("Cargo.toml");
	expect(buildFile(["Makefile", "CMakeLists.txt"])).toBe("CMakeLists.txt");
	expect(buildFile(["configure.ac", "autogen.sh"])).toBe("autogen.sh");
	expect(buildFile(["configure.ac"])).toBe("configure.ac");
	expect(buildFile(["README.md", "build.zig"])).toBeNull();
});

test("Cargo.toml names its program by its first [[bin]], else its package", () => {
	expect(cargoBin('[package]\nname = "ripgrep"\n\n[[bin]]\nname = "rg"\npath = "x"\n')).toBe("rg");
	expect(cargoBin('[package]\nname = "fd-find"\n[dependencies]\nname = "not-this"\n')).toBe("fd-find");
	expect(cargoBin('[workspace]\nmembers = ["a"]\n')).toBeNull();
});

test("go.mod names its program by the module path's last part, past a major-version suffix", () => {
	expect(goBin("module github.com/jesseduffield/lazygit\n\ngo 1.22\n")).toBe("lazygit");
	expect(goBin("module github.com/charmbracelet/glow/v2\n")).toBe("glow");
	expect(goBin("go 1.22\n")).toBeNull();
});

test("a draft takes the program's name from the build file when it says, else the fallback", () => {
	const go = draftFor(["go.mod"], "module example.com/x/hey\n", "repo");
	expect(go).toEqual({
		file: "go.mod",
		tools: ["go"],
		build: ["GOBIN=$HOME/.local/bin go install ./..."],
		bin: "hey",
		system: false,
	});
	expect(draftFor(["go.mod"], null, "repo")?.bin).toBe("repo");
	expect(draftFor(["meson.build"], null, "app")).toMatchObject({ tools: ["meson", "ninja"], bin: "app", system: true });
	expect(draftFor(["README.md"], null, "app")).toBeNull();
	// A name that would climb out of the install folder, or hide, is not taken.
	expect(draftFor(["Cargo.toml"], '[[bin]]\nname = "../../etc/x"\n', "repo")?.bin).toBe("repo");
	expect(draftFor(["go.mod"], "module example.com/.hidden\n", "repo")?.bin).toBe("repo");
});
