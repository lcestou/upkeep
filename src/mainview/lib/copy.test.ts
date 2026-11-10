import { expect, test } from "bun:test";
import type { AppState, RunResult, RunState } from "../../shared/types";
import { installLabel, selectionText, stateSentence, statusText } from "./copy";

const run = (patch: Partial<RunState>): RunState => ({
	id: null,
	phase: "idle",
	index: 0,
	total: 0,
	currentKey: null,
	stopping: false,
	results: [],
	...patch,
});

const sentence = (p: Partial<RunState>, ready = 0, problems = 0, currentName: string | null = null) =>
	stateSentence({ run: run(p), ready, problems, currentName });

const result = (r: RunResult["result"]): RunResult => ({ key: "k", name: "n", from: null, to: null, result: r, ms: 1 });

const app = (patch: Partial<AppState>): AppState => ({
	key: "fd",
	name: "fd",
	kind: "archive",
	installed: "10.5.1",
	latest: "10.5.2",
	status: "ready",
	running: false,
	restartToApply: false,
	restorePoints: [],
	canRestore: true,
	auto: false,
	sudo: false,
	versionless: false,
	stages: [],
	held: false,
	...patch,
});

test("state sentence", () => {
	expect(sentence({ phase: "checking", index: 20, total: 32 })).toBe("Checking 20 of 32");
	expect(sentence({}, 1)).toBe("1 update ready");
	expect(sentence({}, 7)).toBe("7 updates ready");
	expect(sentence({})).toBe("Everything is fresh");
	expect(sentence({}, 0, 3)).toBe("3 need a look");
	expect(sentence({}, 0, 1)).toBe("1 needs a look");
	expect(sentence({ phase: "installing", index: 2, total: 4 }, 0, 0, "Zen Browser")).toBe(
		"Installing Zen Browser, 2 of 4",
	);
	expect(sentence({ phase: "summary", results: [result("updated"), result("updated")] })).toBe("2 updated");
	expect(sentence({ phase: "summary", results: [result("updated"), result("failed"), result("rolled_back")] })).toBe(
		"1 updated, 2 failed",
	);
});

test("install and selection labels", () => {
	expect(installLabel(0)).toBe("Install updates");
	expect(installLabel(1)).toBe("Install 1 update");
	expect(installLabel(4)).toBe("Install 4 updates");
	expect(selectionText(0, null)).toBe("Nothing selected");
	expect(selectionText(2, null)).toBe("2 selected");
	expect(selectionText(4, 110_143_744)).toBe("4 selected · 110 MB");
	expect(selectionText(4, 110_143_744, true, 1)).toBe("4 selected · 110 MB+ · 1 hidden");
});

test("status text", () => {
	expect(statusText(app({ status: "working", stage: "download", stagePct: 41.6 }))).toBe("Downloading 42%");
	expect(statusText(app({ status: "working", stage: "download", stagePct: 40, size: 30_000_000 }))).toBe(
		"Downloading 12.0 of 30 MB",
	);
	expect(statusText(app({ status: "working", stage: "backup" }))).toBe("Backing up");
	expect(statusText(app({ status: "working", stage: "verify" }))).toBe("Verifying");
	expect(statusText(app({ status: "done", installed: "10.5.2" }))).toBe("Updated to 10.5.2");
	expect(statusText(app({ status: "done", restartToApply: true }))).toBe("Restart fd to finish");
	expect(statusText(app({ status: "rolled_back", installed: "10.5.1" }))).toBe("Rolled back to 10.5.1");
	expect(statusText(app({ status: "held", skipped: "10.5.2" }))).toBe("Skipping 10.5.2");
	expect(statusText(app({ status: "held" }))).toBe("Held");
});
