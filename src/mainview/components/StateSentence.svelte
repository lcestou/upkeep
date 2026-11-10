<script lang="ts">
	import { checkedTitle } from "../lib/copy";
	import { relativeTime } from "../lib/format";
	import type { Model } from "../lib/model.svelte";
	import { ms } from "../lib/motion";
	import { fade } from "svelte/transition";

	let { model }: { model: Model } = $props();

	const title = $derived(model.checkedAt ? checkedTitle(relativeTime(model.checkedAt)) : undefined);
</script>

<h1 class="sentence" data-testid="state-sentence" {title} aria-live="polite">
	{#key model.sentence}
		<span in:fade={{ duration: ms(160) }} out:fade={{ duration: ms(160) }}>{model.sentence}</span>
	{/key}
</h1>

<style>
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
	span {
		grid-area: 1 / 1;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
