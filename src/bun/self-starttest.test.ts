import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStartTest, stagedLauncher } from "./self-starttest";

let dir = "";
let scratch = "";
const real = () => ({ config: join(dir, "real config"), state: join(dir, "real state") });

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "upkeep-starttest-"));
	scratch = join(dir, "cache", "tmp");
	mkdirSync(real().config, { recursive: true });
	mkdirSync(real().state, { recursive: true });
	writeFileSync(join(real().config, "apps.toml"), "the person's list");
	writeFileSync(join(real().state, "state.json"), '{"settings":{}}');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in for a staged build's launcher: a shell script with the test's environment. */
function launcher(body: string): string {
	const file = join(dir, "launcher");
	writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	return file;
}

/** Runs a start test with the fake launcher and a short limit. */
function run(file: string, timeoutMs = 3000, env: Record<string, string | undefined> = {}) {
	return runStartTest({
		launcher: file,
		env: { PATH: process.env.PATH, HOME: dir, ...env },
		real: real(),
		scratch,
		timeoutMs,
		pollMs: 20,
	});
}

/** True while a process with this pid exists. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("a build that answers is heard, reads copies of the person's files, and leaves nothing behind", async () => {
	const out = join(dir, "seen");
	const file = launcher(
		`{ cat "$XDG_CONFIG_HOME/upkeep/apps.toml"; echo; cat "$XDG_STATE_HOME/upkeep/state.json"; echo; ls "$XDG_STATE_HOME/upkeep"; } > "${out}"
echo "changed by the new build" > "$XDG_CONFIG_HOME/upkeep/apps.toml"
[ -d "$XDG_RUNTIME_DIR" ] && echo "ok abc 3" > "$UPKEEP_SELFTEST"`,
	);
	expect(await run(file)).toBe("ok abc 3");
	// It saw the list and the state; extras.json does not exist yet and was simply not copied.
	expect(readFileSync(out, "utf8")).toBe('the person\'s list\n{"settings":{}}\nstate.json\n');
	// What it wrote went to its copy: the real list is untouched.
	expect(readFileSync(join(real().config, "apps.toml"), "utf8")).toBe("the person's list");
	expect(readdirSync(scratch)).toEqual([]);
});

test("a build that hangs gets its time and no more, and is ended with everything it started", async () => {
	const pids = join(dir, "pids");
	const file = launcher(`sleep 60 &\necho "$$ $!" > "${pids}"\nsleep 60`);
	const began = Date.now();
	expect(await run(file, 400)).toBeNull();
	expect(Date.now() - began).toBeLessThan(3000);
	const [parent = 0, child = 0] = readFileSync(pids, "utf8").trim().split(" ").map(Number);
	expect(parent).toBeGreaterThan(0);
	await Bun.sleep(100);
	expect(alive(parent)).toBe(false);
	expect(alive(child)).toBe(false);
	expect(readdirSync(scratch)).toEqual([]);
});

test("a build that exits without answering fails at once, not after the full wait", async () => {
	const began = Date.now();
	expect(await run(launcher("exit 3"), 10_000)).toBeNull();
	expect(Date.now() - began).toBeLessThan(3000);
	// It opened the file and left: still no answer.
	expect(await run(launcher(': > "$UPKEEP_SELFTEST"; exit 0'), 10_000)).toBeNull();
});

test("a build that answers and then lingers is heard and still ended", async () => {
	const pid = join(dir, "pid");
	const file = launcher(`echo $$ > "${pid}"\necho "ok abc 1" > "$UPKEEP_SELFTEST"\nsleep 60`);
	expect(await run(file)).toBe("ok abc 1");
	await Bun.sleep(100);
	expect(alive(Number(readFileSync(pid, "utf8").trim()))).toBe(false);
});

test("a launcher that is not there or cannot run is a failed test, not an exception", async () => {
	expect(await run(join(dir, "missing"))).toBeNull();
	const file = join(dir, "not-executable");
	writeFileSync(file, "#!/bin/sh\n", { mode: 0o644 });
	expect(await run(file)).toBeNull();
	expect(readdirSync(scratch)).toEqual([]);
});

test("the build gets a short environment: no library paths from the running launcher", async () => {
	const file = launcher(
		'echo "${LD_PRELOAD:-none} ${LD_LIBRARY_PATH:-none} ${UPKEEP_BACKGROUND:-none} $LANG" > "$UPKEEP_SELFTEST"',
	);
	const answer = await run(file, 3000, {
		LD_PRELOAD: "/old/app/bin/libasar.so",
		LD_LIBRARY_PATH: "/old/app/bin",
		UPKEEP_BACKGROUND: "1",
		LANG: "pl_PL.UTF-8",
	});
	expect(answer).toBe("none none none pl_PL.UTF-8");
});

test("the staged launcher is found under the app's own folder name, and a missing stage is null", () => {
	const root = join(dir, "stable");
	mkdirSync(join(root, "app.prepared-abc", "Upkeep", "bin"), { recursive: true });
	mkdirSync(join(root, "app.prepared-abc", "notes"), { recursive: true });
	writeFileSync(join(root, "app.prepared-abc", "Upkeep", "bin", "launcher"), "");
	expect(stagedLauncher(root, "abc")).toBe(join(root, "app.prepared-abc", "Upkeep", "bin", "launcher"));
	expect(stagedLauncher(root, "other")).toBeNull();
	mkdirSync(join(root, "app.prepared-empty"));
	expect(stagedLauncher(root, "empty")).toBeNull();
	expect(existsSync(root)).toBe(true);
});
