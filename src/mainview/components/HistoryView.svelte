<script lang="ts">
	import type { HistoryRow } from "../../shared/types";
	import { TEXT } from "../lib/copy";
	import { formatDuration, formatRunTime } from "../lib/format";
	import type { Model } from "../lib/model.svelte";
	import { CARE, glyphColor } from "../lib/state";
	import Glyph from "./Glyph.svelte";

	let { model }: { model: Model } = $props();

	const STATUS = { updated: "done", failed: "failed", rolled_back: "rolled_back" } as const;
	const RESULT = { updated: TEXT.updated, failed: TEXT.failed, rolled_back: TEXT.rolledBack } as const;

	const runs = $derived.by(() => {
		const byRun = new Map<string, HistoryRow[]>();
		for (const row of model.history) byRun.set(row.runId, [...(byRun.get(row.runId) ?? []), row]);
		return [...byRun.entries()].map(([id, rows]) => ({ id, at: rows[0]?.at ?? "", rows }));
	});
</script>

<div class="history" data-testid="history">
	{#if runs.length === 0}
		<p class="empty">{TEXT.noRuns}</p>
	{:else}
		{#each runs as run (run.id)}
			<section>
				<h2>{formatRunTime(run.at)}</h2>
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
		text-decoration-color: var(--rust);
		color: var(--text-3);
	}
	.detail {
		font-size: var(--fs-12);
		color: oklch(0.82 0.09 48);
	}
	.result {
		font-weight: 560;
		color: var(--leaf);
	}
	.r-failed .result,
	.r-rolled_back .result {
		color: var(--rust);
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
