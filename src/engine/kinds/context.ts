import { MESSAGES } from "../../shared/messages";
import type { AppSpec, Settings, Stage } from "../../shared/types";
import type { Asset, FetchLike, Rate, Release } from "../github";
import type { Arch } from "../arch";
import type { Paths } from "../paths";
import { type ProbeResult, readProbe, stripEscapes } from "../probe";
import type { Run } from "../run";

/** Install and every other restore wait until the interrupted update is put back: its marker is the only record of it. */
export const REASON_UNRECOVERED = MESSAGES.reasonUnrecovered();

/** What a kind needs from the engine. Every path and process goes through here so tests pass temp dirs and fakes. */
export type KindCtx = {
	paths: Paths;
	run: Run;
	fetch: FetchLike;
	token: string | null;
	settings: Settings;
	/** A log line for the app being worked on. */
	log(text: string): void;
	/** The stage in progress and its percent, or null when it cannot be measured. */
	stage(stage: Stage, pct: number | null): void;
	onRate?: (rate: Rate) => void;
	/** Tests point GitHub lookups at a local server. */
	api?: string;
	/** The machine's architecture: which of a table's asset patterns a release kind uses. Default x86_64. */
	arch?: Arch;
	procRoot?: string;
	/** Clock for restore point times. */
	now?: () => Date;
	/** Overrides for the download limits, for tests. */
	stallMs?: number;
	retryMs?: number;
	/** The rename a built update's place and put-back use. Tests pass one that dies after a move, as a kill would. */
	rename?: (from: string, to: string) => void;
};

/** What a check found. null from a check means the app is not installed and is left out. */
export type Checked = {
	installed: string | null;
	latest: string | null;
	status: "fresh" | "ready" | "problem";
	detail?: string;
	size?: number;
	notes?: string;
	releaseUrl?: string;
	publishedAt?: string;
	/** The newest commits up to the release tag, newest first, at most 30 and never more than ahead. */
	commits?: { sha: string; title: string }[];
	/** How many commits the release is ahead of the installed build. */
	ahead?: number;
	/** What an install of this app would put in place. */
	target?: Target;
};

export type Target = { from: string | null; version: string; tag: string; asset?: Asset };

export type Outcome = {
	result: "done" | "failed" | "rolled_back";
	installed: string | null;
	detail?: string;
	restartToApply: boolean;
	/** Milliseconds spent in each stage. */
	stages: Partial<Record<Stage, number>>;
};

/** Lifts the notes, release page and publish date off a release; each stays undefined when the release has none. */
export function fromRelease(release: Release): Pick<Checked, "notes" | "releaseUrl" | "publishedAt"> {
	return { notes: release.notes, releaseUrl: release.url, publishedAt: release.publishedAt };
}

/** Times each stage and reports it as it starts. */
export function stageClock(ctx: KindCtx) {
	const stages: Partial<Record<Stage, number>> = {};
	let current: Stage | null = null;
	let since = 0;
	const end = () => {
		if (current) stages[current] = (stages[current] ?? 0) + (Date.now() - since);
	};
	return {
		start(stage: Stage, pct: number | null = null): void {
			end();
			current = stage;
			since = Date.now();
			ctx.stage(stage, pct);
		},
		stop() {
			end();
			current = null;
			return stages;
		},
	};
}

/** The sentence for a probe that found the app but read no version: a broken one will not start, any other shows the probe's own detail. */
export function probeProblem(name: string, dest: string, probe: Exclude<ProbeResult, { version: string }>): string {
	if (probe.state === "broken") return MESSAGES.willNotStart(name, dest);
	return probe.detail ? MESSAGES.versionProbeFailedWithDetail(probe.detail) : MESSAGES.versionProbeFailed();
}

/**
 * The installed version as the table's check prints it, or null when the check reports nothing there (exit 127).
 * The table's author writes the check, so its first line is the version, taken as written: a commit hash or a
 * prerelease must not be reshaped ("f2918cabb" would read "2918cabb", "0.2.2-rc.1" "0.2.2"). An empty first line
 * is unknown. installBuilt's verify reads the version the same way.
 */
export async function readInstalled(
	spec: AppSpec,
	ctx: Pick<KindCtx, "run">,
): Promise<{ probe: ProbeResult; installed: string | null } | null> {
	const out = await ctx.run(spec.check ?? [], { timeoutMs: 10_000, merge: true });
	if (out.code === 127) return null;
	const first = stripEscapes(out.stdout).split("\n")[0]?.trim() ?? "";
	let probe = readProbe(out.code, out.stdout);
	if ("version" in probe && !first) probe = { state: "unknown", detail: MESSAGES.versionProbePrintedNothing() };
	return { probe, installed: "version" in probe ? first : null };
}

/**
 * A root step in the manifest must never wait on a password prompt, so every sudo that starts a command gets -n: at a
 * line start, after ; & | ( { or a backtick, and after then, else or do. A sudo reached through a variable or an alias
 * is not seen.
 */
export function nonInteractive(step: string): string {
	return step.replace(/(^\s*|[;&|({`]\s*|\b(?:then|else|do)\s+)sudo (?!-n )/gm, "$1sudo -n ");
}
