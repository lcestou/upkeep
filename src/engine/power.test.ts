import { expect, test } from "bun:test";
import { canHoldSleep, holdSleep, inhibitArgv, metered, onBattery, waitReason } from "./power";
import type { ProcessResult, Run } from "./run";
import { join } from "node:path";
import { ok, realRun, script, tempHome } from "./testkit";

const fail: ProcessResult = { code: 1, stdout: "", stderr: "no such name", timedOut: false };

/** A runner that answers each argv by its last word, with no process behind it. */
const answering =
	(answers: Record<string, ProcessResult>): Run =>
	async (argv) =>
		answers[argv.at(-1) ?? ""] ?? fail;

test("the lock blocks sleep only, names Upkeep and ends with the pid it watches", () => {
	expect(inhibitArgv(42, "Installing updates")).toEqual([
		"systemd-inhibit",
		"--what=sleep",
		"--mode=block",
		"--who=Upkeep",
		"--why=Installing updates",
		"tail",
		"--pid=42",
		"-f",
		"/dev/null",
	]);
});

test("no lock without a way to start one or without systemd-inhibit, and a release stops the lock only once", async () => {
	expect(await canHoldSleep(answering({ "--version": ok() }))).toBe(false);
	expect(await holdSleep(answering({ "--version": ok() }), 1, "x", 0)).toBeNull();
	let stops = 0;
	const started: string[][] = [];
	const start = (argv: string[]) => {
		started.push(argv);
		return {
			output: () => "",
			stop: async () => {
				stops += 1;
			},
		};
	};
	const missing: Run = Object.assign(answering({ "--version": { ...fail, code: 127 } }), { start });
	expect(await canHoldSleep(missing)).toBe(false);
	const there: Run = Object.assign(answering({ "--version": ok("systemd 255") }), { start });
	expect(await canHoldSleep(there)).toBe(true);
	expect(started).toHaveLength(0);
	const release = await holdSleep(there, 7, "x", 0);
	expect(started[0]).toContain("--pid=7");
	await release?.();
	await release?.();
	expect(stops).toBe(1);
});

test("metered is NetworkManager's yes or guess-yes; anything else, or no NetworkManager, is not", async () => {
	const answers = ["u 1\n", "u 3\n", "u 0\n", "u 2\n", "u 4\n"];
	const got = await Promise.all(answers.map((a) => metered(answering({ Metered: ok(a) }))));
	expect(got).toEqual([true, true, false, false, false]);
	expect(await metered(answering({}))).toBe(false);
});

test("battery is UPower's OnBattery true; a machine with no UPower runs on mains", async () => {
	expect(await onBattery(answering({ OnBattery: ok("b true\n") }))).toBe(true);
	expect(await onBattery(answering({ OnBattery: ok("b false\n") }))).toBe(false);
	expect(await onBattery(answering({}))).toBe(false);
});

test("the wait names a metered connection first, then the battery, and a broken runner never holds anything", async () => {
	expect(await waitReason(answering({ Metered: ok("u 1"), OnBattery: ok("b true") }))).toBe("metered");
	expect(await waitReason(answering({ Metered: ok("u 4"), OnBattery: ok("b true") }))).toBe("battery");
	expect(await waitReason(answering({ Metered: ok("u 4"), OnBattery: ok("b false") }))).toBeNull();
	expect(
		await waitReason(async () => {
			throw new Error("bus gone");
		}),
	).toBeNull();
});

test("a lock whose process never started throws instead of returning a release", async () => {
	const dead: Run = Object.assign(answering({}), {
		start: () => ({ failed: true, output: () => "", stop: async () => undefined }),
	});
	await expect(holdSleep(dead, 1, "x", 0)).rejects.toThrow("its process did not start");
});

test("a lock that ends at once (logind refused it) throws; one that stays up holds until released", async () => {
	const t = tempHome("power-lock");
	try {
		// A stand-in for systemd-inhibit, first on the runner's PATH, so no real lock is ever asked for.
		const fake = join(t.paths.home, ".local/bin/systemd-inhibit");
		script(fake, "exit 1");
		const run = realRun(t.paths);
		await expect(holdSleep(run, process.pid, "x", 200)).rejects.toThrow("it ended at once");
		script(fake, 'echo "$$"; exec sleep 30');
		const release = await holdSleep(run, process.pid, "x", 200);
		expect(release).not.toBeNull();
		await release?.();
	} finally {
		t.cleanup();
	}
});

test("a metered query that throws reads as unmetered, and the battery is still asked", async () => {
	const asked: string[] = [];
	const run: Run = async (argv) => {
		asked.push(argv.at(-1) ?? "");
		if (argv.includes("Metered")) throw new Error("bus gone");
		return ok("b true");
	};
	expect(await waitReason(run)).toBe("battery");
	expect(asked).toEqual(["Metered", "OnBattery"]);
});
