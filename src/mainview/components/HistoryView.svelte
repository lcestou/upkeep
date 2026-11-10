<script lang="ts">
	import type { HistoryRow } from "../../shared/types";
	import { RUN_TEXT, TEXT, resultCounts } from "../lib/copy";
	import { formatDuration, formatRunTime } from "../lib/format";
	import type { Model } from "../lib/model.svelte";
	import { CARE, glyphColor } from "../lib/state";
	import Glyph from "./Glyph.svelte";

	let { model }: { model: Model } = $props();

	const STATUS = { updated: "done", failed: "failed", rolled_back: "rolled_back", restored: "held" } as const;
	const RESULT = { updated: TEXT.updated, failed: TEXT.failed, rolled_back: TEXT.rolledBack, restored: TEXT.restored } as const;

	// The newest update of each app that still waits on a restart carries a Restart pending note.
	const pending = $derived.by(() => {
		const waiting = new Set(model.apps.filter((a) => a.restartToApply).map((a) => a.key));
		const out = new Set<string>();
		for (const row of model.history) {
			if (row.result !== "updated" || !waiting.has(row.key)) continue;
			out.add(`${row.runId}:${row.key}`);
			waiting.delete(row.key);
		}
		return out;
	});

	const runs = $derived.by(() => {
		const byRun = new Map<string, HistoryRow[]>();
		for (const row of model.history) byRun.set(row.runId, [...(byRun.get(row.runId) ?? []), row]);
		return [...byRun.entries()].map(([id, rows]) => ({ id, at: rows[0]?.at ?? "", rows }));
	});
</script>

<div class="history" data-testid="history">
	{#if runs.length === 0}
		<p class="empty" data-testid="history-empty">{model.run.phase === "installing" ? RUN_TEXT.inProgress : TEXT.noRuns}</p>
	{:else}
		{#each runs as run (run.id)}
			<section>
				<h2>{formatRunTime(run.at)} {#if run.rows.some((r) => r.result !== "restored")}<span class="counts">{resultCounts(run.rows)}</span>{/if}
					{#if run.rows.some((r) => r.retry)}<span class="tag" data-testid="history-retry">{RUN_TEXT.retry}</span>{/if}</h2>
				<ul>
					{#each run.rows as row (row.key)}
						{@const status = STATUS[row.result]}
						<li class="r-{row.result}" style:--band={CARE[status].band}>
							<span class="band" aria-hidden="true"></span>
							<Glyph name={CARE[status].glyph} color={glyphColor(status)} />
							<span class="what">
								<span class="line">
									<span class="tag-name">{row.name}</span>
									<span class="mono vers"
										>{row.from ?? "?"} <span class="to">to</span> <span class:struck={row.result !== "updated"}>{row.to ?? "?"}</span></span
									>
								</span>
								{#if row.detail}<span class="detail">{row.detail}</span>{/if}
								{#if row.result === "updated" && pending.has(`${row.runId}:${row.key}`)}<span class="pending" data-testid="restart-pending"
										>{RUN_TEXT.restartPending}</span
									>{/if}
							</span>
							<span class="result">{RESULT[row.result]}</span>
							<span class="mono dur">{formatDuration(row.ms)}</span>
						</li>
					{/each}
				</ul>
			</section>
		{/each}
	{/if}
</div>

<style>
	.history {
		height: 100%;
		overflow: auto;
		padding: var(--s5) var(--s5) var(--s6);
	}
	section {
		max-width: 820px;
		margin: 0 auto var(--s5);
	}
	h2 {
		margin: 0 0 var(--s2);
		font-size: var(--fs-13);
		font-weight: 640;
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}
	.tag {
		margin-left: var(--s2);
		padding: 1px 6px;
		border: 1px solid var(--line);
		border-radius: 3px;
		font-size: var(--fs-11);
		font-weight: 560;
		color: var(--text-2);
	}
	.pending {
		font-size: var(--fs-12);
		color: var(--sun);
	}
	.counts {
		margin-left: var(--s2);
		font-weight: 440;
		color: var(--text-3);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		border-top: 1px solid var(--line-soft);
	}
	li {
		position: relative;
		display: grid;
		grid-template-columns: 16px minmax(0, 1fr) 96px 64px;
		align-items: center;
		gap: var(--s3);
		min-height: 40px;
		padding: 6px var(--s3) 6px 18px;
		background: var(--surface);
		border-bottom: 1px solid var(--line-soft);
	}
	.band {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 4px;
		background: var(--band);
	}
	.what {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.line {
		display: flex;
		align-items: baseline;
		gap: var(--s3);
		min-width: 0;
	}
	.vers {
		color: var(--text-2);
		white-space: nowrap;
	}
	.to {
		font-family: var(--sans);
		color: var(--text-3);
		font-size: var(--fs-12);
	}
	.struck {
		text-decoration: line-through;
		text-decoration-color: var(--fail);
		color: var(--text-3);
	}
	.detail {
		font-size: var(--fs-12);
		color: oklch(0.84 0.09 25);
	}
	.result {
		font-weight: 560;
		color: var(--leaf);
	}
	/* One colour, one meaning: failure red, as in the ledger; rust stays for Needs a look. */
	.r-failed .result,
	.r-rolled_back .result {
		color: var(--fail);
	}
	.dur {
		justify-self: end;
		color: var(--text-3);
	}
	.empty {
		margin: var(--s6) auto;
		max-width: 820px;
		color: var(--text-3);
	}
</style>
