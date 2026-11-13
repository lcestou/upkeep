import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MESSAGES } from "../shared/messages";
import type { SelfState } from "../shared/types";
import { okMarker, readAttempt, SELF_FILES, writeAttempt } from "./self-shim";
import { applyAndWait, createSelf, newerSelf, type SelfPorts, startTestAnswer, testEnv } from "./self-update";

const OLD = { version: "0.1.0", hash: "oldhash1" };
const NEW = { version: "0.1.1", hash: "newhash2" };

let dir = "";
let root = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "upkeep-selfupdate-"));
	root = join(dir, "stable");
	mkdirSync(join(root, "app", "bin"), { recursive: true });
	mkdirSync(join(root, "app", "Resources"), { recursive: true });
	writeFileSync(join(root, "app", "bin", "launcher"), "#!/bin/sh\n", { mode: 0o755 });
	writeFileSync(join(root, "app", "Resources", "version.json"), `{"hash":"${OLD.hash}"}`);
	writeFileSync(join(dir, "apps.toml"), "the list");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Ports that offer NEW to a running OLD and let everything pass; each test overrides what it is about. */
function setup(over: Partial<SelfPorts> = {}, running = OLD) {
	const did: string[] = [];
	const seen: SelfState[] = [];
	let failed = "";
	let told = "";
	const ports: SelfPorts = {
		local: async () => ({ ...running, root }),
		check: async () => ({ ...NEW, available: true, error: "" }),
		download: async () => (did.push("download"), { ready: true, error: "" }),
		stagedHash: () => NEW.hash,
		startTest: async (_root, hash) => (did.push(`test ${hash}`), startTestAnswer(hash, 7)),
		// The real one never resolves when the quit happens; a resolved one here is a quit that did not.
		apply: async () => (did.push("apply"), false),
		stayUp: async () => void did.push("stayUp"),
		hasShell: () => true,
		freeBytes: () => 10_000,
		appBytes: () => 1000,
		now: () => new Date("2026-11-12T08:00:00Z"),
		busy: () => false,
		windowOpen: () => false,
		appCount: () => 7,
		configFiles: () => [join(dir, "apps.toml")],
		autoOn: () => false,
		failedHash: () => failed,
		setFailedHash: (hash) => {
			failed = hash;
			did.push(`failed ${hash}`);
		},
		notifiedHash: () => told,
		setNotifiedHash: (hash) => {
			told = hash;
		},
		history: (row) => void did.push(`history ${row.from} ${row.to} ${row.result}`),
		log: (line) => void did.push(`log ${line}`),
		...over,
	};
	const self = createSelf(ports);
	self.subscribe((s) => seen.push(s));
	return { self, did, seen, phases: () => seen.map((s) => s.phase) };
}

test("a newer version is offered once, and the same one is not announced again", async () => {
	const { self } = setup();
	expect(self.snapshot()).toEqual({ phase: "none" });
	expect(await self.check()).toBe("0.1.1");
	expect(self.snapshot()).toEqual({ phase: "available", from: "0.1.0", version: "0.1.1" });
	expect(await self.check()).toBeNull();
	expect(self.snapshot().phase).toBe("available");
});

test("a version is announced once on a machine, not again after Upkeep starts anew", async () => {
	let told = "";
	const memory = { notifiedHash: () => told, setNotifiedHash: (hash: string) => void (told = hash) };
	const first = setup(memory);
	expect(await first.self.check()).toBe("0.1.1");
	// The next day's start: the same build is offered on the row again, and nobody is told twice.
	const next = setup(memory);
	expect(await next.self.check()).toBeNull();
	expect(next.self.snapshot()).toEqual({ phase: "available", from: "0.1.0", version: "0.1.1" });
	// A newer build is news again.
	const later = setup({
		...memory,
		check: async () => ({ version: "0.1.2", hash: "thirdhash3", available: true, error: "" }),
	});
	expect(await later.self.check()).toBe("0.1.2");
});

test("a state file that cannot be written costs a repeated notice, never the offer", async () => {
	const { self, did } = setup({
		setNotifiedHash: () => {
			throw new Error("state.json: ENOSPC");
		},
	});
	expect(await self.check()).toBe("0.1.1");
	expect(self.snapshot()).toEqual({ phase: "available", from: "0.1.0", version: "0.1.1" });
	expect(did).toEqual(["log self-update: could not record that 0.1.1 was announced: Error: state.json: ENOSPC"]);
});

test("a look that begins while the restart is still getting ready is waited out before the swap is asked for", async () => {
	// The restart's own first wait: a look slips in during it, as one from a finished app check would.
	let slow = false;
	let release: (v: { version: string; hash: string; root: string }) => void = () => {};
	let answer: (v: { version: string; hash: string; available: boolean; error: string }) => void = () => {};
	let looks = 0;
	const { self, did } = setup({
		local: () => (slow ? new Promise((r) => (release = r)) : Promise.resolve({ ...OLD, root })),
		check: () => {
			looks += 1;
			return looks === 1 ? Promise.resolve({ ...NEW, available: true, error: "" }) : new Promise((r) => (answer = r));
		},
	});
	await self.prepare();
	slow = true;
	const restarting = self.restart();
	await Bun.sleep(2);
	// The restart is waiting on local(); a look starts now. It needs local() too, so let both through.
	slow = false;
	const looking = self.check();
	release({ ...OLD, root });
	await Bun.sleep(5);
	expect(looks).toBe(2);
	// The look is still out: the framework has not been asked to swap.
	expect(did).not.toContain("apply");
	answer({ ...NEW, available: true, error: "" });
	await looking;
	await restarting;
	expect(did).toContain("apply");
});

test("a port that throws at the restart leaves a failed row and nothing beside the app", async () => {
	let boom = false;
	const { self, did } = setup({
		busy: () => {
			if (boom) throw new Error("run.lock: EIO");
			return false;
		},
	});
	await self.prepare();
	boom = true;
	await self.restart();
	expect(self.snapshot()).toMatchObject({ phase: "failed", why: MESSAGES.selfNotApplied("0.1.1") });
	expect(did).not.toContain("apply");
	expect(readdirSync(root)).toEqual(["app"]);
});

test("a look that cannot reach the address changes nothing: a tested build is kept", async () => {
	let error = "";
	const { self } = setup({ check: async () => ({ ...NEW, available: true, error }) });
	await self.prepare();
	expect(self.snapshot().phase).toBe("ready");
	error = "ConnectionRefused";
	expect(await self.check()).toBeNull();
	expect(self.snapshot()).toEqual({ phase: "ready", from: "0.1.0", version: "0.1.1" });
	// And a check that throws is logged, never passed on.
	const thrown = setup({
		check: async () => {
			throw new Error("boom");
		},
	});
	expect(await thrown.self.check()).toBeNull();
	expect(thrown.did).toEqual(["log self-update: the check failed: Error: boom"]);
});

test("a hash that is not the framework's shape is never offered: it names folders beside the app", async () => {
	await Promise.all(
		["../../x", "ABC", "a b", "", "a/b", "x".repeat(14)].map(async (hash) => {
			const { self } = setup({ check: async () => ({ version: "0.1.1", hash, available: true, error: "" }) });
			expect(await self.check(), hash).toBeNull();
			expect(self.snapshot(), hash).toEqual({ phase: "none" });
		}),
	);
});

test("an exception while preparing ends as a failed row, never a stuck one, and nothing was changed", async () => {
	const cases: Partial<SelfPorts>[] = [
		{
			freeBytes: () => {
				throw new Error("statfs: EACCES");
			},
		},
		{
			download: async () => {
				throw new Error("spawn failed");
			},
		},
		{
			startTest: async () => {
				throw new Error("ENOSPC");
			},
		},
		{
			setFailedHash: () => {
				throw new Error("state.json: ENOSPC");
			},
			startTest: async () => null,
		},
	];
	await Promise.all(
		cases.map(async (over) => {
			const { self } = setup(over);
			await self.prepare();
			expect(self.snapshot()).toMatchObject({ phase: "failed", why: MESSAGES.selfDownload() });
			expect(readdirSync(root)).toEqual(["app"]);
			await self.restart();
		}),
	);
});

test("a restart waits for a check under way, so none of that check's statuses is taken for the restart's", async () => {
	let release: (v: { version: string; hash: string; available: boolean; error: string }) => void = () => {};
	let slow = false;
	const { self, did } = setup({
		check: () => (slow ? new Promise((r) => (release = r)) : Promise.resolve({ ...NEW, available: true, error: "" })),
	});
	await self.prepare();
	slow = true;
	const looking = self.check();
	const restarting = self.restart();
	await Bun.sleep(5);
	// The framework has not been asked to swap while the check is still out.
	expect(did).not.toContain("apply");
	release({ ...NEW, available: true, error: "" });
	await looking;
	await restarting;
	expect(did).toContain("apply");
});

test("going back to normal after a refused restart cannot throw: the row is usable again", async () => {
	const { self } = setup({
		stayUp: async () => {
			throw new Error("socket: EADDRINUSE");
		},
	});
	await self.prepare();
	await self.restart();
	expect(self.snapshot().phase).toBe("ready");
	expect(readdirSync(root)).toEqual(["app"]);
});

test("an older or equal version is never offered, whatever the framework says about its hash", async () => {
	await Promise.all(
		["0.1.0", "0.0.9", "0.1.0-rc1", "0.1", "next", ""].map(async (version) => {
			const { self } = setup({ check: async () => ({ version, hash: "otherhash", available: true, error: "" }) });
			expect(await self.check(), version).toBeNull();
			expect(self.snapshot(), version).toEqual({ phase: "none" });
		}),
	);
});

test("a later release is newer; a prerelease of the running version, and anything that is not a version, is not", () => {
	expect(newerSelf("0.1.0", "0.1.1")).toBe(true);
	expect(newerSelf("0.9.9", "0.10.0")).toBe(true);
	expect(newerSelf("1.0.0-rc1", "1.0.0")).toBe(true);
	expect(newerSelf("0.1.1", "0.1.0")).toBe(false);
	expect(newerSelf("0.1.0", "0.1.0")).toBe(false);
	expect(newerSelf("0.1.0", "0.1.0-rc1")).toBe(false);
	expect(newerSelf("0.1.0", "garbage")).toBe(false);
	expect(newerSelf("", "0.1.1")).toBe(false);
});

test("nothing is offered when the address cannot be read, when nothing differs, or in a dev build", async () => {
	const down = setup({ check: async () => ({ version: "", hash: "", available: false, error: "ConnectionRefused" }) });
	expect(await down.self.check()).toBeNull();
	const same = setup({ check: async () => ({ ...OLD, available: false, error: "" }) });
	expect(await same.self.check()).toBeNull();
	const dev = setup({ local: async () => null });
	expect(await dev.self.check()).toBeNull();
	await dev.self.prepare();
	await dev.self.restart();
	expect(await dev.self.settle()).toBeNull();
	// A dev build offers nothing and writes nothing.
	expect(dev.did).toEqual([]);
	expect(dev.self.snapshot()).toEqual({ phase: "none" });
	expect(readdirSync(root)).toEqual(["app"]);
});

test("an offer that is withdrawn goes away, and a newer one replaces an older one", async () => {
	let offer = { ...NEW, available: true, error: "" };
	const { self } = setup({ check: async () => offer });
	await self.check();
	offer = { version: "0.1.2", hash: "thirdhash3", available: true, error: "" };
	expect(await self.check()).toBe("0.1.2");
	expect(self.snapshot()).toEqual({ phase: "available", from: "0.1.0", version: "0.1.2" });
	offer = { ...OLD, available: false, error: "" };
	expect(await self.check()).toBeNull();
	expect(self.snapshot()).toEqual({ phase: "none" });
});

test("prepare downloads, test-starts and ends ready, having changed nothing beside the app", async () => {
	const { self, did, phases } = setup();
	await self.check();
	await self.prepare();
	expect(did).toEqual(["download", `test ${NEW.hash}`]);
	expect(phases()).toEqual(["available", "preparing", "ready"]);
	expect(self.snapshot()).toEqual({ phase: "ready", from: "0.1.0", version: "0.1.1" });
	expect(readdirSync(root)).toEqual(["app"]);
	// Pressing again while ready does not download again.
	await self.prepare();
	expect(did).toHaveLength(2);
});

test("prepare looks for the offer itself when none is in memory, as after a restart", async () => {
	const { self } = setup();
	await self.prepare();
	expect(self.snapshot().phase).toBe("ready");
});

test("each pre-flight refusal says why and downloads nothing", async () => {
	const cases: [Partial<SelfPorts>, string][] = [
		[{ busy: () => true }, MESSAGES.selfBusy()],
		[{ hasShell: () => false }, MESSAGES.selfNoShell()],
		// Room for the staged copy, the kept copy and the download: three app folders.
		[{ freeBytes: () => 2999 }, MESSAGES.selfNoSpace()],
	];
	await Promise.all(
		cases.map(async ([over, why]) => {
			const { self, did } = setup(over);
			await self.check();
			await self.prepare();
			expect(self.snapshot()).toEqual({ phase: "failed", from: "0.1.0", version: "0.1.1", why });
			// Nothing was downloaded, and the reason is in the log for a bug report.
			expect(did).toEqual([`log self-update: ${why}`]);
		}),
	);
	const enough = setup({ freeBytes: () => 3000 });
	await enough.self.prepare();
	expect(enough.self.snapshot().phase).toBe("ready");
});

test("a download that fails, or stages another build, changes nothing and keeps the framework's words for the log", async () => {
	const failed = setup({ download: async () => ({ ready: false, error: "ArchiveHashMismatch" }) });
	await failed.self.prepare();
	expect(failed.self.snapshot()).toEqual({
		phase: "failed",
		from: "0.1.0",
		version: "0.1.1",
		why: MESSAGES.selfDownload(),
	});
	expect(failed.did).toEqual([
		"log self-update: download failed: ArchiveHashMismatch",
		`log self-update: ${MESSAGES.selfDownload()}`,
	]);
	const other = setup({ stagedHash: () => "somethingelse" });
	await other.self.prepare();
	expect(other.self.snapshot().phase).toBe("failed");
	expect(other.did.some((d) => d.startsWith("test "))).toBe(false);
	// Try again works from a failed state.
	const again = setup();
	await again.self.check();
	let ready = false;
	const flaky = setup({ download: async () => ({ ready, error: "cut" }) });
	await flaky.self.prepare();
	expect(flaky.self.snapshot().phase).toBe("failed");
	ready = true;
	await flaky.self.prepare();
	expect(flaky.self.snapshot().phase).toBe("ready");
});

test("a start test that answers anything but its own hash and the app count fails, and that build is not tried on its own again", async () => {
	const answers: (string | null)[] = [
		null, // wrote nothing in time: it hung or exited
		"",
		"ok otherhash 7",
		`ok ${NEW.hash} 6`, // came up, but lost an app from the person's list
		`ok ${NEW.hash}`,
		`fail ${NEW.hash} 7`,
	];
	await Promise.all(
		answers.map(async (answer) => {
			const { self, did } = setup({ startTest: async () => answer });
			await self.prepare();
			expect(self.snapshot(), String(answer)).toEqual({
				phase: "failed",
				from: "0.1.0",
				version: "0.1.1",
				why: MESSAGES.selfTestFailed("0.1.1"),
			});
			expect(did).toContain(`failed ${NEW.hash}`);
			// Nothing was kept or recorded: the running version was never touched.
			expect(readdirSync(root)).toEqual(["app"]);
			expect(did).toContain(`log self-update: ${MESSAGES.selfTestFailed("0.1.1")}`);
			await self.restart();
			expect(did).not.toContain("apply");
		}),
	);
});

test("a staged build that failed its start test is removed, since it is a whole copy of the app", async () => {
	const stage = join(root, `app.prepared-${NEW.hash}`);
	mkdirSync(join(stage, "Upkeep", "bin"), { recursive: true });
	const { self } = setup({ startTest: async () => null });
	await self.prepare();
	expect(existsSync(stage)).toBe(false);
	// A build that passed stays staged: the restart needs it.
	mkdirSync(join(stage, "Upkeep", "bin"), { recursive: true });
	const good = setup();
	await good.self.prepare();
	expect(existsSync(stage)).toBe(true);
});

test("restart keeps the old version and the person's files, records the attempt, then asks for the swap", async () => {
	let during: string[] = [];
	const { self, did } = setup({
		windowOpen: () => true,
		apply: async () => {
			during = readdirSync(root).toSorted();
			// What the start script would need is all there before the framework is asked.
			expect(readAttempt(root)).toEqual({
				fromVersion: "0.1.0",
				fromHash: OLD.hash,
				toVersion: "0.1.1",
				toHash: NEW.hash,
				window: true,
				startedAt: "2026-11-12T08:00:00.000Z",
			});
			expect(readFileSync(join(root, SELF_FILES.keep, "Resources", "version.json"), "utf8")).toContain(OLD.hash);
			expect(readFileSync(join(root, SELF_FILES.configKeep, "where"), "utf8")).toBe(
				`file0\t${join(dir, "apps.toml")}\n`,
			);
			did.push("apply");
			return false;
		},
	});
	await self.prepare();
	await self.restart();
	expect(during).toEqual([SELF_FILES.configKeep, SELF_FILES.attempt, "app", SELF_FILES.keep].toSorted());
});

test("a restart that did not happen takes the attempt back and stays up", async () => {
	const { self, did, phases } = setup();
	await self.prepare();
	await self.restart();
	expect(did.slice(-2)).toEqual(["apply", "stayUp"]);
	expect(phases().slice(-2)).toEqual(["restarting", "ready"]);
	// Nothing an unfinished attempt left is there for the start script to act on.
	expect(readdirSync(root)).toEqual(["app"]);
});

test("restart is refused unless a test passed, nothing is busy, and the staged build is still the tested, newer one", async () => {
	const untested = setup();
	await untested.self.check();
	await untested.self.restart();
	expect(untested.did).toEqual([]);

	let busy = false;
	const held = setup({ busy: () => busy });
	await held.self.prepare();
	busy = true;
	await held.self.restart();
	expect(held.did).not.toContain("apply");
	expect(held.self.snapshot().phase).toBe("ready");

	// A later check staged something else after the test passed.
	let staged = NEW.hash;
	const swapped = setup({ stagedHash: () => staged });
	await swapped.self.prepare();
	staged = "olderhash0";
	await swapped.self.restart();
	expect(swapped.did).not.toContain("apply");
	expect(swapped.self.snapshot()).toMatchObject({ phase: "failed", why: MESSAGES.selfNotApplied("0.1.1") });
	expect(readdirSync(root)).toEqual(["app"]);

	// The running version moved on (an install by hand) and the tested one is no longer newer.
	let running = OLD;
	const moved = setup({ local: async () => ({ ...running, root }) });
	await moved.self.prepare();
	running = { version: "0.2.0", hash: "handhash9" };
	await moved.self.restart();
	expect(moved.did).not.toContain("apply");
});

test("a kept copy that cannot be made stops the restart before the framework is asked", async () => {
	const { self, did } = setup();
	await self.prepare();
	// The app folder is gone: there is nothing to keep, so nothing may be swapped.
	rmSync(join(root, "app"), { recursive: true });
	await self.restart();
	expect(did).not.toContain("apply");
	expect(self.snapshot()).toMatchObject({ phase: "failed", why: MESSAGES.selfNotApplied("0.1.1") });
	expect(existsSync(join(root, SELF_FILES.attempt))).toBe(false);
});

const ATTEMPT = {
	fromVersion: "0.1.0",
	fromHash: OLD.hash,
	toVersion: "0.1.1",
	toHash: NEW.hash,
	window: true,
	startedAt: "2026-11-12T08:00:00.000Z",
};

test("settle on the new version: confirms it, reports the update once, and clears what the attempt kept", async () => {
	writeAttempt(root, ATTEMPT);
	mkdirSync(join(root, SELF_FILES.keep));
	mkdirSync(join(root, SELF_FILES.configKeep));
	mkdirSync(join(root, SELF_FILES.failed));
	writeFileSync(join(root, okMarker(OLD.hash)), "");
	const { self, did } = setup({}, NEW);
	expect(await self.settle()).toBe(true);
	expect(self.snapshot()).toEqual({ phase: "updated", from: "0.1.0", version: "0.1.1" });
	expect(did).toEqual(["history 0.1.0 0.1.1 updated"]);
	expect(readdirSync(root).toSorted()).toEqual([okMarker(NEW.hash), SELF_FILES.shim, "app"].toSorted());
	// The next start has nothing left to report.
	const next = setup({}, NEW);
	expect(await next.self.settle()).toBeNull();
	expect(next.did).toEqual([]);
	expect(next.self.snapshot()).toEqual({ phase: "none" });
	next.self.dismiss();
	self.dismiss();
	expect(self.snapshot()).toEqual({ phase: "none" });
});

test("settle after the start script rolled back: says so, skips that build from now on, keeps the tree that failed", async () => {
	writeAttempt(root, { ...ATTEMPT, window: false });
	writeFileSync(join(root, SELF_FILES.rolledBack), `${NEW.hash}\n`);
	mkdirSync(join(root, SELF_FILES.failed));
	mkdirSync(join(root, SELF_FILES.configKeep));
	const { self, did } = setup();
	expect(await self.settle()).toBe(false);
	expect(self.snapshot()).toEqual({ phase: "rolled-back", from: "0.1.0", version: "0.1.1" });
	expect(did).toEqual([`failed ${NEW.hash}`, "history 0.1.0 0.1.1 rolled_back"]);
	expect(readdirSync(root).toSorted()).toEqual(
		[okMarker(OLD.hash), SELF_FILES.shim, "app", SELF_FILES.failed].toSorted(),
	);
	// The check at start finds the same version again; the notice stays, and Try again works from it.
	expect(await self.check()).toBeNull();
	expect(self.snapshot().phase).toBe("rolled-back");
	await self.prepare();
	expect(self.snapshot().phase).toBe("ready");
});

test("settle writes the marker and removes the attempt even when a later step fails", async () => {
	writeAttempt(root, ATTEMPT);
	// History cannot be written (a full disk): the attempt must still not survive, or the start script would put
	// this healthy version back at the next click.
	const { self, did } = setup(
		{
			history: () => {
				throw new Error("history.jsonl: ENOSPC");
			},
		},
		NEW,
	);
	expect(await self.settle()).toBe(true);
	expect(existsSync(join(root, okMarker(NEW.hash)))).toBe(true);
	expect(existsSync(join(root, SELF_FILES.attempt))).toBe(false);
	expect(self.snapshot().phase).toBe("updated");
	expect(did).toEqual(["log self-update: settling: history: Error: history.jsonl: ENOSPC"]);
});

test("the rollback note stays until the failed build is on record, so it is never taken again unattended", async () => {
	writeAttempt(root, ATTEMPT);
	writeFileSync(join(root, SELF_FILES.rolledBack), `${NEW.hash}\n`);
	let writable = false;
	const { self, did } = setup({
		setFailedHash: (hash) => {
			if (!writable) throw new Error("state.json: ENOSPC");
			did.push(`failed ${hash}`);
		},
	});
	await self.settle();
	expect(existsSync(join(root, SELF_FILES.rolledBack))).toBe(true);
	// The next start can write again: the build is recorded then, and the note goes.
	writable = true;
	const next = setup({
		setFailedHash: (hash) => void did.push(`failed ${hash}`),
	});
	await next.self.settle();
	expect(did).toContain(`failed ${NEW.hash}`);
	expect(existsSync(join(root, SELF_FILES.rolledBack))).toBe(false);
});

test("a rollback note with no attempt beside it still skips that build, and shows no row it cannot word", async () => {
	writeFileSync(join(root, SELF_FILES.rolledBack), `${NEW.hash}\n`);
	const { self, did } = setup();
	expect(await self.settle()).toBeNull();
	expect(self.snapshot()).toEqual({ phase: "none" });
	expect(did).toEqual([`failed ${NEW.hash}`]);
	expect(existsSync(join(root, SELF_FILES.rolledBack))).toBe(false);
});

test("settle when the swap never happened: the old version says the update was not applied", async () => {
	writeAttempt(root, ATTEMPT);
	mkdirSync(join(root, SELF_FILES.keep));
	const { self, did } = setup();
	expect(await self.settle()).toBe(true);
	expect(self.snapshot()).toEqual({
		phase: "failed",
		from: "0.1.0",
		version: "0.1.1",
		why: MESSAGES.selfNotApplied("0.1.1"),
	});
	expect(did).toEqual([]);
	expect(readdirSync(root).toSorted()).toEqual([okMarker(OLD.hash), SELF_FILES.shim, "app"].toSorted());
});

test("settle with an attempt between two other versions, or a file that is not one, just clears it", async () => {
	writeAttempt(root, ATTEMPT);
	mkdirSync(join(root, SELF_FILES.keep));
	const third = setup({}, { version: "0.2.0", hash: "thirdhash3" });
	expect(await third.self.settle()).toBeNull();
	expect(third.self.snapshot()).toEqual({ phase: "none" });
	expect(readdirSync(root).toSorted()).toEqual([okMarker("thirdhash3"), SELF_FILES.shim, "app"].toSorted());
	writeFileSync(join(root, SELF_FILES.attempt), "{ not an attempt");
	const junk = setup();
	expect(await junk.self.settle()).toBeNull();
	expect(existsSync(join(root, SELF_FILES.attempt))).toBe(false);
});

test("automatic update needs the switch on, the window hidden and nothing busy, and skips a build that failed before", async () => {
	const off = setup();
	await off.self.check();
	await off.self.auto();
	expect(off.did).toEqual([]);

	const shown = setup({ autoOn: () => true, windowOpen: () => true });
	await shown.self.check();
	await shown.self.auto();
	expect(shown.did).toEqual([]);

	const held = setup({ autoOn: () => true, busy: () => true });
	await held.self.check();
	await held.self.auto();
	expect(held.did).toEqual([]);

	const skipped = setup({ autoOn: () => true, failedHash: () => NEW.hash });
	await skipped.self.check();
	await skipped.self.auto();
	expect(skipped.did).toEqual([]);

	const on = setup({ autoOn: () => true });
	await on.self.check();
	await on.self.auto();
	expect(on.did).toEqual(["download", `test ${NEW.hash}`, "apply", "stayUp"]);

	// The window was opened while the test ran: the restart waits for it to be hidden again.
	let open = false;
	const opened = setup({
		autoOn: () => true,
		windowOpen: () => open,
		startTest: async (_r, hash) => {
			open = true;
			return startTestAnswer(hash, 7);
		},
	});
	await opened.self.check();
	await opened.self.auto();
	expect(opened.did).not.toContain("apply");
	expect(opened.self.snapshot().phase).toBe("ready");
	open = false;
	await opened.self.auto();
	expect(opened.did).toContain("apply");
});

test("the automatic update never rejects, whatever a port throws", async () => {
	const { self, did } = setup({
		autoOn: () => {
			throw new Error("state.json unreadable");
		},
	});
	await self.check();
	await self.auto();
	expect(did).toEqual(["log self-update: the automatic update threw: Error: state.json unreadable"]);
});

test("a build that failed its test on its own is not tried again automatically, and a newer one is", async () => {
	let offer = { ...NEW, available: true, error: "" };
	let answer: string | null = null;
	const { self, did } = setup({
		autoOn: () => true,
		check: async () => offer,
		stagedHash: () => offer.hash,
		startTest: async (_r, hash) => answer ?? startTestAnswer(hash, 7),
	});
	answer = "nothing useful";
	await self.check();
	await self.auto();
	expect(self.snapshot().phase).toBe("failed");
	const downloads = () => did.filter((d) => d === "download").length;
	expect(downloads()).toBe(1);
	await self.check();
	await self.auto();
	expect(downloads()).toBe(1);
	// The next release is a different build and gets its own chance.
	offer = { version: "0.1.2", hash: "thirdhash3", available: true, error: "" };
	answer = null;
	await self.check();
	await self.auto();
	expect(downloads()).toBe(2);
	expect(did).toContain("apply");
});

test("checks are ignored while preparing or restarting, and listeners can leave", async () => {
	let release: (v: { ready: boolean; error: string }) => void = () => {};
	const { self, seen } = setup({ download: () => new Promise((r) => (release = r)) });
	await self.check();
	const preparing = self.prepare();
	await Bun.sleep(1);
	expect(self.snapshot().phase).toBe("preparing");
	expect(await self.check()).toBeNull();
	await self.prepare();
	release({ ready: true, error: "" });
	await preparing;
	expect(self.snapshot().phase).toBe("ready");
	const count = seen.length;
	const stop = self.subscribe(() => {
		throw new Error("left already");
	});
	stop();
	self.dismiss();
	expect(seen).toHaveLength(count);
});

/** A fake of the framework's updater: statuses are sent by hand, and its own promise is settled by hand. */
function fakeUpdater() {
	let heard: (status: string) => void = () => {};
	let stopped = false;
	let settle: { resolve: () => void; reject: (e: Error) => void } = { resolve: () => {}, reject: () => {} };
	const apply = () => new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
	const subscribe = (cb: (status: string) => void) => {
		heard = cb;
		return () => {
			stopped = true;
		};
	};
	return { apply, subscribe, say: (s: string) => heard(s), settle: () => settle, stopped: () => stopped };
}

/** Whether a promise settled within a few ticks. */
async function settled(p: Promise<unknown>): Promise<boolean> {
	return Promise.race([p.then(() => true), Bun.sleep(20).then(() => false)]);
}

test("a refused quit, a helper that would not start and nothing to apply all mean Upkeep is staying up", async () => {
	await Promise.all(
		["idle", "error", "no-update"].map(async (status) => {
			const u = fakeUpdater();
			const waiting = applyAndWait(u.apply, u.subscribe);
			u.say("applying");
			expect(await settled(waiting), status).toBe(false);
			u.say(status);
			expect(await waiting).toBe(false);
			expect(u.stopped()).toBe(true);
		}),
	);
});

test("once the restart is announced, the framework's promise resolving is not a reason to clean up", async () => {
	const u = fakeUpdater();
	const waiting = applyAndWait(u.apply, u.subscribe);
	u.say("applying");
	u.say("launching-new-version");
	// The framework resolves here although the process is on its way out.
	u.settle().resolve();
	expect(await settled(waiting)).toBe(false);
});

test("an error after the restart was announced still means staying up", async () => {
	const u = fakeUpdater();
	const waiting = applyAndWait(u.apply, u.subscribe);
	u.say("launching-new-version");
	u.say("error");
	expect(await waiting).toBe(false);
});

test("the framework's promise settling with no word about a restart means staying up", async () => {
	const quiet = fakeUpdater();
	const a = applyAndWait(quiet.apply, quiet.subscribe);
	quiet.settle().resolve();
	expect(await a).toBe(false);
	const thrown = fakeUpdater();
	const b = applyAndWait(thrown.apply, thrown.subscribe);
	thrown.settle().reject(new Error("spawn failed"));
	expect(await b).toBe(false);
	// A late status after the answer was given changes nothing.
	thrown.say("idle");
});

test("a test start inherits a short list and reads copies, never the launcher's library paths", () => {
	const env = testEnv(
		{
			HOME: "/home/x",
			PATH: "/usr/bin",
			DISPLAY: ":0",
			LANG: "de_DE.UTF-8",
			LC_TIME: "de_DE.UTF-8",
			LD_PRELOAD: "/old/app/bin/libasar.so",
			LD_LIBRARY_PATH: "/old/app/bin",
			ELECTROBUN_LAUNCHER_PID: "123",
			UPKEEP_BACKGROUND: "1",
			XDG_CONFIG_HOME: "/home/x/.config",
			WAYLAND_DISPLAY: undefined,
		},
		"/tmp/t",
		"/tmp/t/answer",
	);
	// The inherited names are whatever the machine has, so the result is read as a plain table here.
	expect<Record<string, string>>(env).toEqual({
		HOME: "/home/x",
		PATH: "/usr/bin",
		DISPLAY: ":0",
		LANG: "de_DE.UTF-8",
		LC_TIME: "de_DE.UTF-8",
		XDG_CONFIG_HOME: "/tmp/t/config",
		XDG_STATE_HOME: "/tmp/t/state",
		XDG_DATA_HOME: "/tmp/t/data",
		XDG_CACHE_HOME: "/tmp/t/cache",
		XDG_RUNTIME_DIR: "/tmp/t/run",
		UPKEEP_SELFTEST: "/tmp/t/answer",
	});
});
