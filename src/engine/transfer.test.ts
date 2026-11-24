import { expect, test } from "bun:test";
import { commandsOf } from "./transfer";

test("commandsOf lists every command a table runs, quoted as a shell would need it, and nothing for a plain release", () => {
	expect(commandsOf({ key: "fd", name: "fd", kind: "file", repo: "sharkdp/fd", dest: "~/.local/bin/fd" })).toEqual([]);
	// A manual app's run is only shown; Claude Code's plugins run its own CLI.
	expect(commandsOf({ key: "m", name: "M", kind: "manual", run: "sudo rm -rf /" })).toEqual([]);
	expect(commandsOf({ key: "p", name: "P", kind: "claude-plugins" })).toEqual([]);
	// version_args runs dest, so dest leads; without dest there is nothing to run.
	expect(commandsOf({ key: "x", name: "X", kind: "file", dest: "/bin/sh", version_args: ["-c", "it's"] })).toEqual([
		"version_args: /bin/sh -c 'it'\\''s'",
	]);
	expect(commandsOf({ key: "x", name: "X", kind: "file", version_args: ["-V"] })).toEqual([]);
	expect(
		commandsOf({
			key: "s",
			name: "S",
			kind: "source",
			check: ["s", "--version"],
			update: ["s", "up", ""],
			restore: ["s", "pin", "{version}"],
			restart: ["systemctl", "--user", "restart", "s"],
			commit: ["git", "rev-parse", "HEAD"],
			needs: ["cat", "needs.txt"],
			build: ["make -j4 && make install"],
			check_built: ["test -x ./s"],
			undo: ["make clean"],
			record: [{ file: "pip.txt", run: ["pip", "freeze"] }],
			busy: [
				{ say: "busy", run: ["pgrep", "s"] },
				{ say: "named", process: "s" },
			],
			pause: [{ name: "timer", active: ["a"], stop: ["b"] }],
			serve: [
				{
					name: "web",
					active: ["c"],
					stop: ["d"],
					start: ["e"],
					since: ["f"],
					test: [{ run: ["g"] }, { url: "http://x" }],
				},
			],
			test: [{ run: ["h", "two words"] }],
		}),
	).toEqual([
		"check: s --version",
		"update: s up ''",
		"restore: s pin {version}",
		"restart: systemctl --user restart s",
		"commit: git rev-parse HEAD",
		"needs: cat needs.txt",
		"build: make -j4 && make install",
		"check_built: test -x ./s",
		"undo: make clean",
		"record: pip freeze",
		"busy: pgrep s",
		"pause timer active: a",
		"pause timer stop: b",
		"serve web active: c",
		"serve web stop: d",
		"serve web start: e",
		"serve web since: f",
		"serve test: g",
		"test: h 'two words'",
	]);
});
