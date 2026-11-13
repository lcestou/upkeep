import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Attempt,
	clearKept,
	entryArgv,
	installShim,
	keepConfig,
	keepCopy,
	okMarker,
	readAttempt,
	SELF_FILES,
	START_SH,
	treeBytes,
	writeAttempt,
} from "./self-shim";

// The script runs under whatever /bin/sh a distribution ships, so every case runs under each shell found here.
const SHELLS = [["dash"], ["bash", "--posix"], ["busybox", "sh"]].filter(([bin]) => Bun.which(bin ?? "") !== null);

const OLD = "oldhash1";
const NEW = "newhash2";
const ATTEMPT: Attempt = {
	fromVersion: "0.1.0",
	fromHash: OLD,
	toVersion: "0.1.1",
	toHash: NEW,
	window: false,
	startedAt: "2026-11-12T08:00:00.000Z",
};

let dir = "";
let root = "";
let log = "";

beforeEach(() => {
	// A space in the path: every rename and every test in the script has to keep it whole.
	dir = realpathSync(mkdtempSync(join(tmpdir(), "upkeep self ")));
	root = join(dir, "stable");
	log = join(dir, "started.log");
	mkdirSync(root);
	installShim(root);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fake app tree: a launcher that records its hash and its arguments, and the version file the script reads. */
function tree(name: string, hash: string): string {
	const at = join(root, name);
	mkdirSync(join(at, "bin"), { recursive: true });
	mkdirSync(join(at, "Resources"), { recursive: true });
	writeFileSync(join(at, "bin", "launcher"), `#!/bin/sh\necho "started ${hash} $*" >> "${log}"\n`, { mode: 0o755 });
	// The framework writes this file on one line, with no spaces.
	writeFileSync(join(at, "Resources", "version.json"), `{"version":"x","hash":"${hash}","channel":"stable"}`);
	return at;
}

/** Runs the start script under one shell and returns its exit code. */
function start(shell: string[], args: string[] = [root], env: Record<string, string> = {}): number {
	const r = Bun.spawnSync([...shell, join(root, SELF_FILES.shim), ...args], {
		stdout: "ignore",
		stderr: "ignore",
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
	});
	return r.exitCode;
}

/** What the fake launchers recorded, one line per start. */
const started = () =>
	existsSync(log)
		? readFileSync(log, "utf8")
				.split("\n")
				.filter((l) => l !== "")
		: [];
/** The hash of the tree at name, read the way the script reads it. */
const hashOf = (name: string) =>
	/"hash":"([a-z0-9]+)"/.exec(readFileSync(join(root, name, "Resources", "version.json"), "utf8"))?.[1];

for (const shell of SHELLS) {
	describe(`the start script under ${shell.join(" ")}`, () => {
		test("a healthy install just starts, with its arguments, and nothing else changes", () => {
			tree("app", OLD);
			expect(start(shell, [root, "one", "two words"])).toBe(0);
			expect(started()).toEqual([`started ${OLD} one two words`]);
			expect(readdirSync(root).toSorted()).toEqual(["app", SELF_FILES.shim]);
		});

		test("an app folder lost between an update's two renames comes back from app.previous", () => {
			tree("app.previous", OLD);
			tree(SELF_FILES.keep, OLD);
			writeAttempt(root, ATTEMPT);
			expect(start(shell)).toBe(0);
			expect(started()).toEqual([`started ${OLD} `]);
			expect(existsSync(join(root, "app.previous"))).toBe(false);
			// The kept copy was not needed, and the attempt stays for the app to report.
			expect(existsSync(join(root, SELF_FILES.keep))).toBe(true);
			expect(readAttempt(root)).toEqual(ATTEMPT);
		});

		test("with no app.previous, a lost app folder comes back from the kept copy", () => {
			tree(SELF_FILES.keep, OLD);
			writeAttempt(root, ATTEMPT);
			expect(start(shell)).toBe(0);
			expect(started()).toEqual([`started ${OLD} `]);
			expect(hashOf("app")).toBe(OLD);
		});

		test("an app folder with no launcher is set aside, not written over", () => {
			mkdirSync(join(root, "app", "Resources"), { recursive: true });
			writeFileSync(join(root, "app", "Resources", "half"), "cut off");
			tree("app.previous", OLD);
			writeAttempt(root, ATTEMPT);
			expect(start(shell)).toBe(0);
			expect(started()).toEqual([`started ${OLD} `]);
			expect(readFileSync(join(root, SELF_FILES.failed, "Resources", "half"), "utf8")).toBe("cut off");
		});

		test("nothing to restore from: it says so, touches nothing and exits 69", () => {
			writeAttempt(root, ATTEMPT);
			const before = readdirSync(root).toSorted();
			expect(start(shell)).toBe(69);
			expect(started()).toEqual([]);
			expect(readdirSync(root).toSorted()).toEqual(before);
		});

		test("with no attempt recorded, a leftover app.previous is not brought back", () => {
			tree("app.previous", OLD);
			expect(start(shell)).toBe(69);
			expect(started()).toEqual([]);
			expect(existsSync(join(root, "app"))).toBe(false);
		});

		test("a new version that never confirmed and is not running is rolled back, with the person's files", () => {
			tree("app", NEW);
			tree(SELF_FILES.keep, OLD);
			const list = join(dir, "config", "apps.toml");
			const state = join(dir, "state dir", "state.json");
			mkdirSync(join(dir, "config"));
			mkdirSync(join(dir, "state dir"));
			writeFileSync(list, "as the old version wrote it");
			writeFileSync(state, "{old}");
			keepConfig(root, [list, state, join(dir, "config", "not-there.json")]);
			writeFileSync(list, "rewritten by the new version");
			writeFileSync(state, "{new}");
			writeAttempt(root, ATTEMPT);

			expect(start(shell)).toBe(0);
			expect(started()).toEqual([`started ${OLD} `]);
			expect(hashOf("app")).toBe(OLD);
			expect(hashOf(SELF_FILES.failed)).toBe(NEW);
			expect(existsSync(join(root, SELF_FILES.keep))).toBe(false);
			expect(readFileSync(join(root, SELF_FILES.rolledBack), "utf8")).toBe(`${NEW}\n`);
			expect(readFileSync(list, "utf8")).toBe("as the old version wrote it");
			expect(readFileSync(state, "utf8")).toBe("{old}");
		});

		test("a new version that is still starting is running, so it is left alone", () => {
			const app = tree("app", NEW);
			tree(SELF_FILES.keep, OLD);
			writeAttempt(root, ATTEMPT);
			// A real program that runs from the app folder, as the new version's own processes do.
			copyFileSync(realpathSync(Bun.which("sleep") ?? "/bin/sleep"), join(app, "bin", "busy"));
			chmodSync(join(app, "bin", "busy"), 0o755);
			const busy = Bun.spawn([join(app, "bin", "busy"), "30"], { stdout: "ignore", stderr: "ignore" });
			try {
				expect(start(shell)).toBe(0);
				expect(started()).toEqual([`started ${NEW} `]);
				expect(hashOf("app")).toBe(NEW);
				expect(existsSync(join(root, SELF_FILES.rolledBack))).toBe(false);
			} finally {
				busy.kill();
			}
		});

		test("a new version that confirmed is never rolled back", () => {
			tree("app", NEW);
			tree(SELF_FILES.keep, OLD);
			writeAttempt(root, ATTEMPT);
			writeFileSync(join(root, okMarker(NEW)), "");
			expect(start(shell)).toBe(0);
			expect(started()).toEqual([`started ${NEW} `]);
			expect(hashOf(SELF_FILES.keep)).toBe(OLD);
		});

		test("a marker for another version does not count as this one's", () => {
			tree("app", NEW);
			tree(SELF_FILES.keep, OLD);
			writeAttempt(root, ATTEMPT);
			writeFileSync(join(root, okMarker(OLD)), "");
			expect(start(shell)).toBe(0);
			expect(started()).toEqual([`started ${OLD} `]);
		});

		test("a kept copy that is not the version the attempt came from is not trusted", () => {
			tree("app", NEW);
			tree(SELF_FILES.keep, "someother");
			writeAttempt(root, ATTEMPT);
			expect(start(shell)).toBe(0);
			expect(started()).toEqual([`started ${NEW} `]);
			expect(hashOf("app")).toBe(NEW);
		});

		test("a stale attempt after a later install starts what is installed", () => {
			// The person ran the installer for a third version after a rollback; no kept copy is left.
			tree("app", "thirdhash3");
			writeAttempt(root, ATTEMPT);
			expect(start(shell)).toBe(0);
			expect(started()).toEqual(["started thirdhash3 "]);
			expect(existsSync(join(root, SELF_FILES.failed))).toBe(false);
		});

		test("an attempt file that is not what it should be changes nothing", () => {
			tree("app", NEW);
			tree(SELF_FILES.keep, OLD);
			writeFileSync(join(root, SELF_FILES.attempt), "not json at all");
			expect(start(shell)).toBe(0);
			expect(started()).toEqual([`started ${NEW} `]);
		});

		test("an older set-aside tree in the way is moved, not deleted and not a reason to stop", () => {
			tree("app", NEW);
			tree(SELF_FILES.keep, OLD);
			tree(SELF_FILES.failed, "earlierfail");
			writeAttempt(root, ATTEMPT);
			expect(start(shell)).toBe(0);
			expect(started()).toEqual([`started ${OLD} `]);
			expect(hashOf(SELF_FILES.failed)).toBe(NEW);
			const aside = readdirSync(root).filter((n) => n.startsWith(`${SELF_FILES.failed}.`));
			expect(aside).toHaveLength(1);
			expect(hashOf(aside[0] ?? "")).toBe("earlierfail");
		});

		// busybox runs its own mv without looking at PATH, so a failing mv cannot be handed to it.
		test.skipIf(shell[0] === "busybox")(
			"when the kept copy cannot be moved into place, the new version is put back and started",
			() => {
				tree("app", NEW);
				tree(SELF_FILES.keep, OLD);
				writeAttempt(root, ATTEMPT);
				// An mv that refuses to move the kept copy and does everything else.
				const bin = join(dir, "bin");
				mkdirSync(bin);
				const real = realpathSync(Bun.which("mv") ?? "/bin/mv");
				writeFileSync(
					join(bin, "mv"),
					`#!/bin/sh\ncase "$1" in *"/${SELF_FILES.keep}") exit 1 ;; esac\nexec "${real}" "$@"\n`,
					{ mode: 0o755 },
				);
				expect(start(shell, [root], { PATH: `${bin}:${process.env.PATH}` })).toBe(0);
				expect(started()).toEqual([`started ${NEW} `]);
				expect(hashOf("app")).toBe(NEW);
				expect(existsSync(join(root, SELF_FILES.rolledBack))).toBe(false);
			},
		);

		test("a root that is not an absolute path is refused before anything is read", () => {
			tree("app", OLD);
			expect(start(shell, ["stable"])).toBe(64);
			expect(start(shell, [""])).toBe(64);
			expect(start(shell, [])).toBe(64);
			expect(started()).toEqual([]);
		});

		test("the entry's command starts through the script, and still starts when the script is gone", () => {
			tree("app", OLD);
			const [, , script = "", arg = ""] = entryArgv(root);
			expect(Bun.spawnSync([...shell, "-c", script, arg], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
			rmSync(join(root, SELF_FILES.shim));
			expect(Bun.spawnSync([...shell, "-c", script, arg], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
			expect(started()).toEqual([`started ${OLD} `, `started ${OLD} `]);
		});
	});
}

test("at least one shell was found to run the script under", () => {
	expect(SHELLS.length).toBeGreaterThan(0);
});

test("the script never waits, ends a process or deletes", () => {
	const code = START_SH.split("\n").filter((l) => !l.trimStart().startsWith("#"));
	for (const word of ["sleep", "kill", "rm ", "rmdir", "wait"])
		expect(
			code.some((l) => new RegExp(`(^|[\\s;|&(])${word}`).test(l)),
			word,
		).toBe(false);
});

test("the script is written by rename, left alone when unchanged, and replaced when it differs", () => {
	const file = join(root, SELF_FILES.shim);
	expect(readFileSync(file, "utf8")).toBe(START_SH);
	expect(statSync(file).mode & 0o777).toBe(0o700);
	const first = statSync(file).ino;
	installShim(root);
	expect(statSync(file).ino).toBe(first);
	writeFileSync(file, "#!/bin/sh\n# an older version's script\n");
	installShim(root);
	// A new file, so a shell still reading the old one is not handed new text mid-run.
	expect(statSync(file).ino).not.toBe(first);
	expect(readFileSync(file, "utf8")).toBe(START_SH);
	expect(existsSync(`${file}.tmp`)).toBe(false);
});

test("the kept copy holds every file, link and executable bit, and replaces an older copy", () => {
	const app = tree("app", OLD);
	symlinkSync("launcher", join(app, "bin", "link"));
	writeFileSync(join(app, "Resources", "data"), "x".repeat(5000));
	const keep = join(root, SELF_FILES.keep);
	mkdirSync(keep);
	writeFileSync(join(keep, "stale"), "from an earlier attempt");
	keepCopy(app, keep);
	expect(existsSync(join(keep, "stale"))).toBe(false);
	expect(readFileSync(join(keep, "Resources", "data"), "utf8")).toHaveLength(5000);
	expect(statSync(join(keep, "bin", "launcher")).mode & 0o111).not.toBe(0);
	expect(readdirSync(join(keep, "bin")).toSorted()).toEqual(["launcher", "link"]);
	// Its own files: changing the original afterwards does not change the copy.
	writeFileSync(join(app, "Resources", "data"), "changed");
	expect(readFileSync(join(keep, "Resources", "data"), "utf8")).toHaveLength(5000);
});

test("a tree's size is the sum of its files, and a missing folder is 0", () => {
	const app = tree("app", OLD);
	writeFileSync(join(app, "Resources", "data"), "x".repeat(5000));
	symlinkSync("data", join(app, "Resources", "link"));
	const files = [join(app, "bin", "launcher"), join(app, "Resources", "version.json")];
	const small = files.reduce((n, f) => n + statSync(f).size, 0);
	expect(treeBytes(app)).toBeGreaterThanOrEqual(5000 + small);
	expect(treeBytes(app)).toBeLessThan(5000 + small + 200);
	expect(treeBytes(join(root, "nowhere"))).toBe(0);
});

test("a kept copy that does not match is removed and reported", () => {
	const app = tree("app", OLD);
	writeFileSync(join(app, "Resources", "data"), "x".repeat(5000));
	const keep = join(root, SELF_FILES.keep);
	const cut = (from: string, to: string) => {
		cpSync(from, to, { recursive: true });
		truncateSync(join(to, "Resources", "data"), 100);
	};
	expect(() => keepCopy(app, keep, cut)).toThrow("does not match");
	expect(existsSync(keep)).toBe(false);
	// A file that lost its executable bit would not start either.
	const noExec = (from: string, to: string) => {
		cpSync(from, to, { recursive: true });
		chmodSync(join(to, "bin", "launcher"), 0o644);
	};
	expect(() => keepCopy(app, keep, noExec)).toThrow("does not match");
	// A file that is missing.
	const short = (from: string, to: string) => {
		cpSync(from, to, { recursive: true });
		rmSync(join(to, "Resources", "data"));
	};
	expect(() => keepCopy(app, keep, short)).toThrow("does not match");
});

test("the kept files skip what cannot be listed, and settling removes everything an attempt left", () => {
	const real = join(dir, "apps.toml");
	writeFileSync(real, "list");
	keepConfig(root, [real, "relative.json", join(dir, "has\ttab")]);
	const where = readFileSync(join(root, SELF_FILES.configKeep, "where"), "utf8");
	expect(where).toBe(`file0\t${real}\n`);
	tree(SELF_FILES.keep, OLD);
	tree(SELF_FILES.failed, NEW);
	tree(`${SELF_FILES.failed}.4242`, "earlier");
	tree("app", NEW);
	// After a rollback the tree that would not start is left for a bug report.
	clearKept(root, false);
	expect(readdirSync(root).toSorted()).toEqual(
		["app", SELF_FILES.failed, `${SELF_FILES.failed}.4242`, SELF_FILES.shim].toSorted(),
	);
	clearKept(root, true);
	expect(readdirSync(root).toSorted()).toEqual(["app", SELF_FILES.shim]);
	// A root that is not absolute is never cleared.
	clearKept("", true);
});

test("an attempt is read back as written, and anything else reads as none", () => {
	expect(readAttempt(root)).toBeNull();
	writeAttempt(root, ATTEMPT);
	expect(readAttempt(root)).toEqual(ATTEMPT);
	writeFileSync(join(root, SELF_FILES.attempt), '{"fromHash":"a"}');
	expect(readAttempt(root)).toBeNull();
	writeFileSync(join(root, SELF_FILES.attempt), "{");
	expect(readAttempt(root)).toBeNull();
});
