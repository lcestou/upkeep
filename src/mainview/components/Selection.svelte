<script lang="ts">
	import { TEXT, selectionText } from "../lib/copy";
	import type { Model } from "../lib/model.svelte";
	import { tick } from "svelte";

	let { model }: { model: Model } = $props();

	const idle = $derived(model.run.phase === "idle");
	const partial = $derived(model.tickedApps.some((a) => typeof a.size !== "number") && model.tickedBytes !== null);

	let allBtn = $state<HTMLButtonElement | null>(null);
	let noneBtn = $state<HTMLButtonElement | null>(null);

	// The pressed button disables itself, so focus moves to its partner instead of falling to the page.
	async function pick(all: boolean) {
		if (all) model.selectAll();
		else model.selectNone();
		await tick();
		(all ? noneBtn : allBtn)?.focus();
	}
</script>

<div class="selection">
	<span class="count" data-testid="selection" aria-live="polite" title={partial ? TEXT.sizesUnknown : undefined}>{selectionText(
		model.tickedApps.length,
		model.tickedBytes,
		partial,
		model.hiddenTicked,
	)}</span>
	<span class="links">
		<button
			type="button"
			class="btn small"
			data-testid="select-all"
			bind:this={allBtn}
			disabled={!idle || model.tickedApps.length === model.ready.length}
			onclick={() => pick(true)}>{TEXT.selectAll}</button
		>
		<button
			type="button"
			class="btn small"
			data-testid="select-none"
			bind:this={noneBtn}
			disabled={!idle || model.tickedApps.length === 0}
			onclick={() => pick(false)}>{TEXT.selectNone}</button
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
		gap: var(--s2);
	}
</style>
