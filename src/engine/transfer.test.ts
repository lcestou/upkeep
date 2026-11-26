import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadState, readToken, readWebhook, updateState, writeToken, writeWebhook } from "./store";
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

test("an import that shortens the release wait asks first; one that lengthens it does not", () => {
	const t = tempHome("transfer-wait");
	try {
		const seed = join(t.dir, "seed.toml");
		writeFileSync(seed, "");
		updateState(t.paths, (s) => {
			s.settings.waitDays = 7;
		});
		const out = exportSetup(t.paths, seed, new Date());
		const off = JSON.stringify({ ...out, settings: { ...out.settings, waitDays: 0 } });
		const r = importSetup(t.paths, seed, off, new Date());
		expect(r).toEqual({
			ok: false,
			ask: { apps: [], plain: 0, turnsOn: [], turnsOff: [], waitDays: { from: 7, to: 0 } },
		});
		expect(loadState(t.paths).settings.waitDays).toBe(7);
		expect(importSetup(t.paths, seed, off, new Date(), true).ok).toBe(true);
		expect(loadState(t.paths).settings.waitDays).toBe(0);
		const longer = JSON.stringify({ ...out, settings: { ...out.settings, waitDays: 3 } });
		expect(importSetup(t.paths, seed, longer, new Date()).ok).toBe(true);
		expect(loadState(t.paths).settings.waitDays).toBe(3);
	} finally {
		t.cleanup();
	}
});

test("an import that turns Except security fixes back on asks first, like any switch it turns on", () => {
	const t = tempHome("transfer-security");
	try {
		const seed = join(t.dir, "seed.toml");
		writeFileSync(seed, "");
		updateState(t.paths, (s) => {
			s.settings.waitDays = 3;
			s.settings.waitExceptSecurity = false;
		});
		const out = exportSetup(t.paths, seed, new Date());
		const on = JSON.stringify({ ...out, settings: { ...out.settings, waitExceptSecurity: true } });
		expect(importSetup(t.paths, seed, on, new Date())).toEqual({
			ok: false,
			ask: { apps: [], plain: 0, turnsOn: ["waitExceptSecurity"], turnsOff: [] },
		});
		expect(importSetup(t.paths, seed, on, new Date(), true).ok).toBe(true);
		expect(loadState(t.paths).settings.waitExceptSecurity).toBe(true);
	} finally {
		t.cleanup();
	}
});

test("the notice address never goes out in an export; a file that sets or changes it asks and shows its host, the rest masked", () => {
	const t = tempHome("transfer-webhook");
	try {
		const seed = join(t.dir, "seed.toml");
		writeFileSync(seed, "");
		writeWebhook(t.paths, "https://ntfy.sh/mine");
		const out = exportSetup(t.paths, seed, new Date());
		expect(JSON.stringify(out)).not.toContain("ntfy.sh");
		// The same address asks nothing; a file without one leaves this machine's alone.
		const same = JSON.stringify({ ...out, webhook: "https://ntfy.sh/mine" });
		expect(importSetup(t.paths, seed, same, new Date()).ok).toBe(true);
		expect(importSetup(t.paths, seed, JSON.stringify(out), new Date()).ok).toBe(true);
		expect(readWebhook(t.paths)).toBe("https://ntfy.sh/mine");
		const theirs = JSON.stringify({ ...out, webhook: "https://hooks.example.com/collect?k=1" });
		expect(importSetup(t.paths, seed, theirs, new Date())).toEqual({
			ok: false,
			ask: { apps: [], plain: 0, turnsOn: [], turnsOff: [], webhook: "https://hooks.example.com/…" },
		});
		expect(readWebhook(t.paths)).toBe("https://ntfy.sh/mine");
		expect(importSetup(t.paths, seed, theirs, new Date(), true).ok).toBe(true);
		expect(readWebhook(t.paths)).toBe("https://hooks.example.com/collect?k=1");
	} finally {
		t.cleanup();
	}
});

test("an export carries running pauses, and an import takes them without asking, only for its apps and sane days", () => {
	const t = tempHome("transfer-pause");
	try {
		const seed = join(t.dir, "seed.toml");
		writeFileSync(seed, "");
		const now = new Date();
		const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString();
		updateState(t.paths, (s) => {
			s.pause.old = inDays(6);
			s.pause.done = inDays(-1);
		});
		// A pause that ran out stays behind.
		expect(exportSetup(t.paths, seed, now).pause).toEqual({ old: inDays(6) });
		const apps = '[apps.t]\nname = "T"\nkind = "file"\nrepo = "o/t"\nasset = "t-linux"\ndest = "~/.local/bin/t"\n';
		const out = exportSetup(t.paths, seed, now);
		const until = inDays(14);
		const doc = { ...out, apps, pause: { t: until, gone: until } };
		// An unreadable end, one already past and one more than 365 days ahead are each dropped.
		for (const end of ["soon", inDays(-2), inDays(366), 7]) {
			expect(importSetup(t.paths, seed, JSON.stringify({ ...doc, pause: { t: end } }), now, true).ok).toBe(true);
			expect(loadState(t.paths).pause).toEqual({});
		}
		expect(importSetup(t.paths, seed, JSON.stringify(doc), now, true).ok).toBe(true);
		expect(loadState(t.paths).pause).toEqual({ t: until });
		// A file written before pauses has none, and clears them as it does holds.
		const { pause: _pause, ...older } = doc;
		expect(importSetup(t.paths, seed, JSON.stringify(older), now, true).ok).toBe(true);
		expect(loadState(t.paths).pause).toEqual({});
	} finally {
		t.cleanup();
	}
});

test("a file whose notice address is plain http to the internet is refused whole, even when sure", () => {
	const t = tempHome("transfer-webhook-plain");
	try {
		const seed = join(t.dir, "seed.toml");
		writeFileSync(seed, "");
		const out = exportSetup(t.paths, seed, new Date());
		const bad = JSON.stringify({
			...out,
			webhook: "http://me:pw@hooks.example.com/x?token=s3cret#f",
			settings: { ...out.settings, keepBackups: 4 },
		});
		expect(importSetup(t.paths, seed, bad, new Date(), true)).toEqual({
			ok: false,
			problems: [
				"The file's notice address http://…@hooks.example.com/… is not an https address, or an http one on this computer or the home network.",
			],
		});
		expect(loadState(t.paths).settings.keepBackups).toBe(1);
		expect(readWebhook(t.paths)).toBeNull();
	} finally {
		t.cleanup();
	}
});

test("an import drops a skip on a versionless app, which has no version to skip", () => {
	const t = tempHome("transfer-skip-versionless");
	try {
		const seed = join(t.dir, "seed.toml");
		writeFileSync(seed, "");
		const apps =
			'[apps.cc]\nname = "Claude Code plugins"\nkind = "claude-plugins"\nversionless = true\n\n[apps.t]\nname = "T"\nkind = "file"\nrepo = "o/t"\nasset = "t-linux"\ndest = "~/.local/bin/t"\n';
		const doc = { ...exportSetup(t.paths, seed, new Date()), apps, skip: { cc: "1.0", t: "2.0" } };
		expect(importSetup(t.paths, seed, JSON.stringify(doc), new Date(), true).ok).toBe(true);
		expect(loadState(t.paths).skip).toEqual({ t: "2.0" });
	} finally {
		t.cleanup();
	}
});

test("an empty notice address in a file names none: the import keeps this machine's without asking", () => {
	const t = tempHome("transfer-webhook-empty");
	try {
		const seed = join(t.dir, "seed.toml");
		writeFileSync(seed, "");
		writeWebhook(t.paths, "https://ntfy.sh/mine");
		const out = exportSetup(t.paths, seed, new Date());
		for (const webhook of ["", "   "])
			expect(importSetup(t.paths, seed, JSON.stringify({ ...out, webhook }), new Date()).ok).toBe(true);
		expect(readWebhook(t.paths)).toBe("https://ntfy.sh/mine");
	} finally {
		t.cleanup();
	}
});
