import { expect, test } from "bun:test";
import { COUNTDOWN_MS, logindActArgv } from "../engine/power";
import type { ProcessResult, Run } from "../engine/run";
import type { RunState, SystemState, WhenDoneState } from "../shared/types";
import { createWhenDone } from "./when-done";

const ok = (stdout = ""): ProcessResult => ({ code: 0, stdout, stderr: "", timedOut: false });

/** A when-done control over a fake logind and a hand-driven clock; nothing real is ever called. */
function harness(opts: { can?: string; refuse?: string } = {}) {
	const calls: string[][] = [];
	const run: Run = async (argv) => {
		calls.push(argv);
		if (argv.at(-1)?.startsWith("Can")) return ok(`s "${opts.can ?? "yes"}"`);
		return opts.refuse ? { code: 1, stdout: opts.refuse, stderr: "", timedOut: false } : ok();
	};
	const timers: { ms: number; fn: () => void; stopped: boolean }[] = [];
	const seen: WhenDoneState[] = [];
	const counts = { raised: 0, quit: 0 };
	const control = createWhenDone({
		run,
		now: () => 1000,
		later: (ms, fn) => {
			const t = { ms, fn, stopped: false };
			timers.push(t);
			return () => {
				t.stopped = true;
			};
		},
		raise: () => counts.raised++,
		quit: () => counts.quit++,
		tell: (s) => seen.push(s),
		log: () => {},
	});
	return { control, calls, timers, seen, counts };
}

/** A finished run whose apps each ended as given. */
function ended(...results: [string, "updated" | "failed" | "stopped"][]): RunState {
	return {
		id: "r",
		phase: "summary",
		index: results.length,
		total: results.length,
		currentKey: null,
		stopping: false,
		results: results.map(([key, result]) => ({ key, name: key, from: null, to: null, result, ms: 1 })),
		retry: false,
		queue: results.map(([key]) => key),
	};
}

/** A System list in the given phase, with one row that ended as status. */
function system(phase: SystemState["phase"], status: "done" | "failed" = "done"): SystemState {
	return {
		mode: "show",
		phase,
		rows: [],
		checkedAt: null,
		problem: null,
		glMissing: null,
		packages: "apt",
		install: { at: "", commands: [], outcomes: [{ id: "x", name: "x", from: null, to: "1", status }], refused: null },
	};
}

test("a run starts at Nothing and asks logind what it allows; a power choice it does not allow is refused", async () => {
	const h = harness({ can: "no" });
	h.control.runStarted();
	await Bun.sleep(0);
	expect(h.control.snapshot()).toMatchObject({ choice: "nothing", can: { suspend: false, poweroff: false } });
	expect(h.control.choose("poweroff")).toBe(false);
	expect(h.control.choose("quit")).toBe(true);
	expect(h.control.snapshot().choice).toBe("quit");
	// The next run starts at Nothing again.
	h.control.runStarted();
	expect(h.control.snapshot().choice).toBe("nothing");
});

test("Quit is handed back to the caller and used up; Nothing does nothing", async () => {
	const h = harness();
	expect(h.control.runEnded(ended(["a", "updated"]))).toBeNull();
	expect(h.counts.raised).toBe(0);
	h.control.choose("quit");
	expect(h.control.runEnded(ended(["a", "failed"]))).toBe("quit");
	expect(h.control.snapshot().choice).toBe("nothing");
});

test("a clean run counts down, then asks logind once with interactive=true and quits after a power-off", async () => {
	const h = harness();
	await h.control.probe();
	expect(h.control.choose("poweroff")).toBe(true);
	h.control.runEnded(ended(["a", "updated"], ["b", "updated"]));
	expect(h.control.snapshot().countdown).toEqual({ action: "poweroff", at: 1000 + COUNTDOWN_MS });
	expect(h.counts.raised).toBe(1);
	expect(h.timers.map((t) => t.ms)).toEqual([COUNTDOWN_MS]);
	h.timers[0]?.fn();
	await Bun.sleep(0);
	expect(h.calls.filter((c) => !c.at(-1)?.startsWith("Can"))).toEqual([logindActArgv("poweroff")]);
	expect(h.counts.quit).toBe(1);
	expect(h.control.snapshot().countdown).toBeNull();
});

test("a suspend logind took leaves Upkeep running", async () => {
	const h = harness();
	await h.control.probe();
	h.control.choose("suspend");
	h.control.runEnded(ended(["a", "updated"]));
	h.timers[0]?.fn();
	await Bun.sleep(0);
	expect(h.calls.at(-1)).toEqual(logindActArgv("suspend"));
	expect(h.counts.quit).toBe(0);
});

test("Cancel stops the countdown, so logind is never asked, and the choice is used up", async () => {
	const h = harness();
	await h.control.probe();
	h.control.choose("suspend");
	h.control.runEnded(ended(["a", "updated"]));
	expect(h.control.cancel()).toBe(true);
	expect(h.timers[0]?.stopped).toBe(true);
	expect(h.control.snapshot()).toMatchObject({ countdown: null, choice: "nothing" });
	expect(h.control.cancel()).toBe(false);
	expect(h.calls.some((c) => c.includes("Suspend"))).toBe(false);
});

test("a System install started during the countdown stops it, so logind is never asked", async () => {
	const h = harness();
	await h.control.probe();
	h.control.system(system("idle"));
	h.control.choose("poweroff");
	h.control.runEnded(ended(["a", "updated"]));
	h.control.system(system("installing"));
	expect(h.timers[0]?.stopped).toBe(true);
	expect(h.control.snapshot()).toMatchObject({ countdown: null, choice: "nothing", cancelled: null });
	expect(h.calls.some((c) => c.includes("PowerOff"))).toBe(false);
});

test("a System install running when the countdown ends keeps logind from being asked", async () => {
	const h = harness();
	await h.control.probe();
	h.control.choose("poweroff");
	h.control.runEnded(ended(["a", "updated"]));
	h.control.system(system("installing"));
	// The timer fires anyway, standing in for one that went off in the same moment the install began.
	h.timers[0]?.fn();
	await Bun.sleep(0);
	expect(h.calls.some((c) => c.includes("PowerOff"))).toBe(false);
	expect(h.counts.quit).toBe(0);
});

test("an unknown choice from the view is refused and changes nothing", async () => {
	const h = harness();
	await h.control.probe();
	// SAFETY: the test sends what a broken view could; the type is the very thing being checked at runtime.
	expect(h.control.choose("bogus" as "nothing")).toBe(false);
	expect(h.control.snapshot().choice).toBe("nothing");
});

test("a failed or stopped app cancels the power action with its reason and raises the window", async () => {
	const h = harness();
	await h.control.probe();
	h.control.choose("poweroff");
	h.control.runEnded(ended(["a", "updated"], ["b", "failed"]));
	expect(h.control.snapshot().cancelled).toEqual({ action: "poweroff", why: "failed" });
	expect(h.control.snapshot().countdown).toBeNull();
	// Done on the summary takes the note away; with nothing left, Cancel says so.
	expect(h.control.cancel()).toBe(true);
	expect(h.control.snapshot().cancelled).toBeNull();
	expect(h.control.cancel()).toBe(false);
	h.control.choose("poweroff");
	h.control.runEnded(ended(["a", "updated"], ["b", "failed"]));
	expect(h.timers).toHaveLength(0);
	expect(h.counts.raised).toBe(2);
	h.control.runStarted();
	expect(h.control.snapshot().cancelled).toBeNull();
	await h.control.probe();
	h.control.choose("suspend");
	h.control.runEnded(ended(["a", "stopped"]));
	expect(h.control.snapshot().cancelled).toEqual({ action: "suspend", why: "stopped" });
});

test("a System step that failed before the apps cancels the power action; one that went well does not", async () => {
	const h = harness();
	await h.control.probe();
	h.control.system(system("idle"));
	h.control.system(system("installing"));
	h.control.system(system("idle", "failed"));
	h.control.choose("poweroff");
	h.control.runEnded(ended(["a", "updated"]));
	expect(h.control.snapshot().cancelled?.why).toBe("system");
	// Used up by that run: the next one is not held to it.
	h.control.runStarted();
	await h.control.probe();
	h.control.choose("poweroff");
	h.control.runEnded(ended(["a", "updated"]));
	expect(h.control.snapshot().countdown?.action).toBe("poweroff");
	h.control.cancel();
	h.control.system(system("installing"));
	h.control.system(system("idle", "done"));
	h.control.runStarted();
	await h.control.probe();
	h.control.choose("poweroff");
	h.control.runEnded(ended(["a", "updated"]));
	expect(h.control.snapshot().countdown?.action).toBe("poweroff");
});

test("logind refusing the call shows what it said, raises the window and stays up", async () => {
	const h = harness({ refuse: "Access denied" });
	await h.control.probe();
	h.control.choose("poweroff");
	h.control.runEnded(ended(["a", "updated"]));
	h.timers[0]?.fn();
	await Bun.sleep(0);
	expect(h.control.snapshot().cancelled).toEqual({ action: "poweroff", why: "refused", detail: "Access denied" });
	expect(h.counts.quit).toBe(0);
	expect(h.counts.raised).toBe(2);
});

test("a choice logind stops allowing goes back to Nothing, and a new run stops an old countdown", async () => {
	let can = "yes";
	const h = harness();
	const control = createWhenDone({
		run: async (argv) => (argv.at(-1)?.startsWith("Can") ? ok(`s "${can}"`) : ok()),
		now: () => 0,
		later: (ms, fn) => {
			h.timers.push({ ms, fn, stopped: false });
			return () => {
				const t = h.timers.at(-1);
				if (t) t.stopped = true;
			};
		},
		raise: () => {},
		quit: () => {},
		tell: () => {},
		log: () => {},
	});
	await control.probe();
	control.choose("suspend");
	can = "na";
	await control.probe();
	expect(control.snapshot().choice).toBe("nothing");
	can = "yes";
	await control.probe();
	control.choose("suspend");
	control.runEnded(ended(["a", "updated"]));
	control.runStarted();
	expect(h.timers.at(-1)?.stopped).toBe(true);
	expect(control.snapshot().countdown).toBeNull();
});
