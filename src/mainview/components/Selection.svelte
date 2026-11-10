<script lang="ts">
	import { TEXT, selectionText } from "../lib/copy";
	import type { Model } from "../lib/model.svelte";

	let { model }: { model: Model } = $props();

	const idle = $derived(model.run.phase === "idle");
</script>

<div class="selection">
	<span class="count" data-testid="selection" aria-live="polite">{selectionText(model.tickedApps.length, model.tickedBytes)}</span>
	<span class="links">
		<button
			type="button"
			class="btn small quiet"
			data-testid="select-all"
			disabled={!idle || model.tickedApps.length === model.ready.length}
			onclick={() => model.selectAll()}>{TEXT.selectAll}</button
		>
		<button
			type="button"
			class="btn small quiet"
			data-testid="select-none"
			disabled={!idle || model.tickedApps.length === 0}
			onclick={() => model.selectNone()}>{TEXT.selectNone}</button
		>
	</span>
</div>

<style>
	.selection {
		display: flex;
		align-items: center;
		gap: var(--s3);
		min-width: 0;
	}
	.count {
		font-weight: 560;
		color: var(--text);
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.links {
		display: flex;
		gap: 2px;
	}
</style>
