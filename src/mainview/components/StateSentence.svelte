<script lang="ts">
	import { checkedTitle } from "../lib/copy";
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
</script>

<div class="lead">
	<h1 class="sentence" data-testid="state-sentence" title={checked ?? undefined} tabindex="-1" aria-live="polite">
		<!-- Fade in only: an outgoing copy would sit in the DOM beside the new one and be read out with it.
		     Counts while checking update in place instead of fading on every app. -->
		{#key model.run.phase === "checking" ? "checking" : model.sentence}
			<span in:fade={{ duration: ms(160) }}>{model.sentence}</span>
		{/key}
	</h1>
	{#if checked && model.run.phase === "idle"}
		<span class="checked" data-testid="checked">{checked}</span>
	{/if}
</div>

<style>
	.lead {
		display: flex;
		align-items: baseline;
		gap: var(--s3);
		min-width: 0;
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
	.checked {
		font-size: var(--fs-12);
		color: var(--text-3);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}
</style>
