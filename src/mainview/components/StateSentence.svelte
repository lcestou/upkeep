<script lang="ts">
	import { byHandLine, checkedTitle, restartLine } from "../lib/copy";
	import { relativeTime } from "../lib/format";
	import type { Model } from "../lib/model.svelte";
	import { ms } from "../lib/motion";
	import { fade } from "svelte/transition";

	let { model }: { model: Model } = $props();

	// Re-read the relative time each minute so "Checked 2 minutes ago" does not go stale on screen.
	let now = $state(Date.now());
	$effect(() => {
		const id = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(id);
	});
	const checked = $derived(model.checkedAt ? checkedTitle(relativeTime(model.checkedAt, now)) : null);
	// "3 updated, 1 failed": the failed part carries the failure colour.
	// "3 updated, 1 failed, 2 not started": only the failed part carries the failure colour.
	const parts = $derived(model.run.phase === "summary" ? model.sentence.split(", ") : null);
	const restart = $derived(model.restarts.map((a) => a.name));
	const manual = $derived(model.apps.filter((a) => a.status === "manual").length);
</script>

<div class="lead">
	<h1 class="sentence" data-testid="state-sentence" title={checked ?? undefined} tabindex="-1" aria-live="polite">
		<!-- Fade in only: an outgoing copy would sit in the DOM beside the new one and be read out with it.
		     Counts while checking update in place instead of fading on every app. -->
		{#key model.run.phase === "checking" ? "checking" : model.sentence}
			<span in:fade={{ duration: ms(160) }}
				>{#if parts}{#each parts as part, i (i)}{i > 0 ? ", " : ""}{#if part.endsWith(" failed")}<em class="failed"
								>{part}</em
							>{:else}{part}{/if}{/each}{:else}{model.sentence}{/if}</span
			>
		{/key}
	</h1>
	{#if model.notice}
		<span class="checked" data-testid="notice">{model.notice}</span>
	{:else if restart.length > 0}
		<span class="checked restart" data-testid="restart-line">{restartLine(restart)}</span>
	{:else if checked && model.run.phase === "idle"}
		<span class="checked" data-testid="checked">{checked}</span>
		{#if manual > 0}<span class="checked" data-testid="by-hand-line"
				><span aria-hidden="true">· </span>{byHandLine(manual)}</span
			>{/if}
	{/if}
</div>

<style>
	.lead {
		display: flex;
		align-items: baseline;
		gap: var(--s3);
		min-width: 0;
		overflow: hidden;
	}
	.sentence {
		display: grid;
		margin: 0;
		min-width: 0;
		font-size: var(--fs-19);
		font-weight: 640;
		font-stretch: 92%;
		letter-spacing: -0.005em;
		line-height: 1.2;
		color: var(--text);
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.sentence:focus {
		outline: none;
	}
	span {
		grid-area: 1 / 1;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.failed {
		font-style: normal;
		color: var(--fail);
	}
	.restart {
		color: var(--text-2);
	}
	.checked {
		font-size: var(--fs-12);
		color: var(--text-3);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}
</style>
