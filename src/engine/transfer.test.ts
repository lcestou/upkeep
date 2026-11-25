import { expect, test } from "bun:test";
import { commandsOf } from "./transfer";

test("commandsOf lists every command a table runs, quoted as a shell would need it, and nothing for a plain release", () => {
	expect(commandsOf({ key: "fd", name: "fd", kind: "file", repo: "sharkdp/fd", dest: "~/.local/bin/fd" })).toEqual([]);
	// A manual app's run is only shown; Claude Code's plugins run its own CLI.
	expect(commandsOf({ key: "m", name: "M", kind: "manual", run: "sudo rm -rf /" })).toEqual([]);
	expect(commandsOf({ key: "p", name: "P", kind: "claude-plugins" })).toEqual([]);
	// version_args runs dest, so dest leads; without dest there is nothing to run.
	expect(
		commandsOf({ key: "x", name: "X", kind: "file", repo: "o/x", dest: "/bin/sh", version_args: ["-c", "it's"] }),
	).toEqual(["source: o/x", "version_args: /bin/sh -c 'it'\\''s'"]);
	// One plain token on a dest under home asks the release file its version, as the default probe does.
	expect(commandsOf({ key: "z", name: "Z", kind: "file", dest: "~/.local/bin/7zz", version_args: ["i"] })).toEqual([]);
	expect(commandsOf({ key: "z", name: "Z", kind: "file", dest: "~/bin/z", version_args: ["--version"] })).toEqual([]);
	// The same token on a dest outside home is not a probe of a file Upkeep put there.
	expect(commandsOf({ key: "r", name: "R", kind: "file", dest: "/usr/bin/reboot", version_args: ["--force"] })).toEqual(
		["version_args: /usr/bin/reboot --force"],
	);
	expect(commandsOf({ key: "y", name: "Y", kind: "file", dest: "~/bin/y", version_args: ["a b"] })).toEqual([
		"version_args: ~/bin/y 'a b'",
	]);
	expect(commandsOf({ key: "x", name: "X", kind: "file", version_args: ["-V"] })).toEqual([]);
	expect(
		commandsOf({
			key: "s",
			name: "S",
			kind: "source",
			repo: "o/s",
			dir: "~/src/s",
			move: "reset",
			place: [{ from: "{stage}/s.desktop", to: "~/.config/autostart/s.desktop" }],
			config: [
				{ file: "~/.s/settings.json", key: "helper", value: "x" },
				{ file: "~/.s/args.json", array: "args", flag: "--port", value: 1 },
			],
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
		"source: o/s",
		"check: s --version",
		"update: s up ''",
		"restore: s pin {version}",
		"restart: systemctl --user restart s",
		"commit: git rev-parse HEAD",
		"needs: cat needs.txt",
		"move: reset ~/src/s",
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
		"place: {stage}/s.desktop -> ~/.config/autostart/s.desktop",
		"config: ~/.s/settings.json helper",
		"config: ~/.s/args.json args --port",
	]);
});
