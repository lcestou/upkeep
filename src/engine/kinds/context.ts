import type { Settings, Stage } from "../../shared/types";
import type { Asset, FetchLike, Rate, Release } from "../github";
import type { Paths } from "../paths";
import type { ProbeResult } from "../probe";
import type { Run } from "../run";

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

export function fromRelease(release: Release): Pick<Checked, "notes" | "releaseUrl" | "publishedAt"> {
	return { notes: release.notes, releaseUrl: release.url, publishedAt: release.publishedAt };
}

/** Times each stage and reports it as it starts. */
export function stageClock(ctx: KindCtx): {
	start(stage: Stage, pct?: number | null): void;
	stop(): Partial<Record<Stage, number>>;
} {
	const stages: Partial<Record<Stage, number>> = {};
	let current: Stage | null = null;
	let since = 0;
	const end = () => {
		if (current) stages[current] = (stages[current] ?? 0) + (Date.now() - since);
	};
	return {
		start(stage, pct = null) {
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

export function probeProblem(name: string, dest: string, probe: Exclude<ProbeResult, { version: string }>): string {
	if (probe.state === "broken") return `${name} will not start (${dest}).`;
	return `Version probe failed${probe.detail ? `: ${probe.detail}` : "."}`;
}
