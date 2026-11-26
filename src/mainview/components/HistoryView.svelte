<script lang="ts">
	import { isStopNote, say } from "../lib/engine-say";
	import type { CleanupId, HistoryRow } from "../../shared/types";
	import { CHECKED_SHORT, CLEAN, RUN_TEXT, SYS, TEXT, freedShort, installedText, runSentence } from "../lib/copy";
	import { formatBytes, formatDuration, formatRunTime } from "../lib/format";
	import type { Model } from "../lib/model.svelte";
	import { CARE, glyphColor } from "../lib/state";
	import Glyph from "./Glyph.svelte";

	let { model }: { model: Model } = $props();

	const STATUS = {
		updated: "done",
		failed: "failed",
		rolled_back: "rolled_back",
		stopped: "stopped",
		restored: "held",
		cleaned: "done",
		skipped: "held",
	} as const;
	// $derived: the labels follow a language switch.
	const RESULT = $derived({
		updated: TEXT.updated,
		failed: TEXT.failed,
		rolled_back: TEXT.rolledBack,
		stopped: TEXT.stoppedByYou,
		restored: TEXT.restored,
		cleaned: CLEAN.cleaned,
		skipped: CLEAN.state.skipped,
	} as const);

	/** The History row of the snapshot before a System install; taken reads as Taken, not Updated. */
	const SNAPSHOT_KEY = "system:snapshot";

	/** A Cleanup row's key is cleanup:<id>; its name is the item's, in the language shown. Any other row keeps its own. */
	function nameOf(row: HistoryRow): string {
		const id = row.key.startsWith("cleanup:") ? row.key.slice("cleanup:".length) : "";
		return isCleanupId(id) ? CLEAN.name[id] : row.name;
	}

	/** True for an id Cleanup names; a history file from a later version may hold others. */
	const isCleanupId = (id: string): id is CleanupId => Object.hasOwn(CLEAN.name, id);

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

<!-- A scroll box is a tab stop, named as its tab, so the runs scroll from the keyboard when they overflow the window. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="history" data-testid="history" role="region" tabindex="0" aria-label={TEXT.history}>
	<!-- A live run is the top line; the past runs stay listed under it. -->
	{#if model.run.phase === "installing"}
		<p class="empty live" data-testid="history-empty">{RUN_TEXT.inProgress}</p>
	{:else if runs.length === 0}
		<p class="empty" data-testid="history-empty">{TEXT.noRuns}</p>
	{/if}
	{#if runs.length > 0}
		{#each runs as run (run.id)}
			<section>
				<h2>{formatRunTime(run.at)} {#if run.rows.some((r) => r.result !== "restored")}<span class="counts" data-testid="history-counts"
						>{runSentence(run.rows.filter((r) => r.key !== SNAPSHOT_KEY))}</span
					>{/if}
					{#if run.rows.some((r) => r.retry)}<span class="tag" data-testid="history-retry">{RUN_TEXT.retry}</span>{/if}</h2>
				<ul>
					{#each run.rows as row (row.key)}
						{@const status = STATUS[row.result]}
						<li class="r-{row.result}" style:--band={CARE[status].band}>
							<span class="band" aria-hidden="true"></span>
							<Glyph name={CARE[status].glyph} color={glyphColor(status)} />
							<span class="what">
								<span class="line">
									<span class="tag-name">{nameOf(row)}</span>
									{#if row.freed !== undefined}<span class="mono vers" data-testid="history-freed">{freedShort(formatBytes(row.freed))}</span
										>{:else if row.from === null && row.to}<span class="mono vers" data-testid="history-vers"
											>{installedText(row.to)}</span
										>{:else if row.key !== SNAPSHOT_KEY}<span class="mono vers" data-testid="history-vers"
											>{row.from ?? ""} <span class="to">to</span> <span class:struck={row.result !== "updated"}>{row.to ?? ""}</span></span
										>{/if}
								</span>
								{#if row.detail}<span class="detail" class:note={isStopNote(row.detail)}>{say(row.detail)}</span>{/if}
								{#if row.checked}<span class="checked" data-testid="history-checked">{CHECKED_SHORT[row.checked]}</span>{/if}
								{#if row.result === "updated" && pending.has(`${row.runId}:${row.key}`)}<span class="pending" data-testid="restart-pending"
										>{RUN_TEXT.restartPending}</span
									>{/if}
							</span>
							<span class="result" data-testid="history-result"
								>{row.key === SNAPSHOT_KEY && row.result === "updated" ? SYS.snapshotTaken : RESULT[row.result]}</span
							>
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
	/* The ring sits inside the area, which fills the window and would clip one drawn outside it. */
	.history:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: -2px;
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
	.checked {
		font-size: var(--fs-12);
		color: var(--text-3);
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
	/* What Stop now put back is a plain note, not a failure. */
	.detail.note {
		color: var(--text-2);
	}
	.r-stopped .struck {
		text-decoration-color: var(--text-3);
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
	/* Left alone on purpose: neither done nor failed. */
	.r-skipped .result {
		color: var(--text-2);
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
