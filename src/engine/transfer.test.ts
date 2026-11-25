import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readToken, writeToken } from "./store";
import { tempHome } from "./testkit";
import { commandsOf, exportSetup, importSetup } from "./transfer";

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
		"restore: s pin '{version}'",
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
		"serve test: POST http://x",
		"test: h 'two words'",
		"place: {stage}/s.desktop -> ~/.config/autostart/s.desktop",
		"config: ~/.s/settings.json helper",
		"config: ~/.s/args.json args --port",
	]);
});

test("commandsOf lists what acts as root, relaunches, reaches a URL or moves a checkout, as its own line", () => {
	expect(commandsOf({ key: "d", name: "D", kind: "deb", repo: "o/d", asset: "d", dest: "/usr/bin/d" })).toEqual([
		"source: o/d",
		"root: sudo -n dpkg -i <release file>",
	]);
	expect(commandsOf({ key: "r", name: "R", kind: "rpm", repo: "o/r", asset: "r" })).toEqual([
		"source: o/r",
		"root: sudo -n rpm -U --oldpackage <release file>",
	]);
	expect(commandsOf({ key: "f", name: "F", kind: "file", repo: "o/f", dest: "/usr/local/bin/f", sudo: true })).toEqual([
		"source: o/f",
		"root: sudo -n writes /usr/local/bin/f",
	]);
	expect(
		commandsOf({
			key: "a",
			name: "A",
			kind: "appimage",
			repo: "o/a",
			dest: "~/A.AppImage",
			process: "a",
			relaunch: true,
		}),
	).toEqual(["source: o/a", "relaunch: ends a and starts ~/A.AppImage"]);
	expect(
		commandsOf({
			key: "s",
			name: "S",
			kind: "source",
			repo: "o/s",
			dir: "~/src/s",
			commit: ["git", "rev-parse", "HEAD"],
			build: ["make"],
			serve: [{ name: "web", active: ["a"], stop: ["b"], start: ["c"], health: "http://127.0.0.1:8080/health" }],
			test: [{ url: "http://127.0.0.1:8080/v1", body: "{}" }],
		}),
	).toEqual([
		"source: o/s",
		"commit: git rev-parse HEAD",
		"move: ff ~/src/s",
		"build: make",
		"serve web active: a",
		"serve web stop: b",
		"serve web start: c",
		"serve web health: GET http://127.0.0.1:8080/health",
		"test: POST http://127.0.0.1:8080/v1 '{}'",
	]);
	expect(
		commandsOf({ key: "s", name: "S", kind: "source", repo: "o/s", dir: "~/s", move: "detach", build: ["make"] }),
	).toContain("move: detach ~/s");
});

test("commandsOf judges a version probe's dest with its .. parts, and quotes what no shell would expand", () => {
	// ~/../../../usr/bin/x reads as under home but resolves outside it, so even one plain token is listed.
	expect(
		commandsOf({ key: "u", name: "U", kind: "file", dest: "~/../../../usr/bin/reboot", version_args: ["--force"] }),
	).toEqual(["version_args: ~/../../../usr/bin/reboot --force"]);
	// argv runs with no shell: a placeholder and a ~ inside a word pass as written; only a leading ~/ is expanded.
	expect(
		commandsOf({
			key: "c",
			name: "C",
			kind: "command",
			latest: "npm:c",
			check: ["c", "--version"],
			update: ["npm", "i", "-g", "c@{version}", "--prefix=~/x", "~", "~/bin/c"],
		}),
	).toContain("update: npm i -g 'c@{version}' '--prefix=~/x' ~ ~/bin/c");
});

test("commandsOf shows an HTTP test's body, quoted, and cuts a long one", () => {
	const lines = (body?: string) =>
		commandsOf({
			key: "s",
			name: "S",
			kind: "source",
			repo: "o/s",
			build: ["make"],
			test: [{ url: "http://h/v1", body }],
		});
	expect(lines('{"a": 1}')).toContain(`test: POST http://h/v1 '{"a": 1}'`);
	expect(lines()).toContain("test: POST http://h/v1");
	expect(lines("x".repeat(250))).toContain(`test: POST http://h/v1 '${"x".repeat(200)}…'`);
});

test("a pasted GitHub token never leaves in an export, and an import neither carries one in nor drops the kept one", () => {
	const t = tempHome("transfer-token");
	try {
		const seed = join(t.dir, "seed.toml");
		writeFileSync(seed, "");
		const token = `ghp_${"t".repeat(36)}`;
		expect(writeToken(t.paths, token)).toBe(true);
		const out = exportSetup(t.paths, seed, new Date());
		expect(JSON.stringify(out)).not.toContain(token);
		// A file that names a token anywhere is not where one comes from.
		const doc = { ...out, token: `ghp_${"x".repeat(36)}`, settings: { ...out.settings, waitDays: 0 } };
		expect(importSetup(t.paths, seed, JSON.stringify(doc), new Date()).ok).toBe(true);
		expect(readToken(t.paths)).toBe(token);
	} finally {
		t.cleanup();
	}
});

test("commandsOf lists the settings paths a restore would put back, so an import asks before taking them", () => {
	expect(
		commandsOf({
			key: "t",
			name: "T",
			kind: "file",
			repo: "o/t",
			dest: "~/.local/bin/t",
			keep_with_restore: ["~/.config/t", "~/.trc"],
		}),
	).toEqual(["source: o/t", "keep_with_restore: ~/.config/t", "keep_with_restore: ~/.trc"]);
});
