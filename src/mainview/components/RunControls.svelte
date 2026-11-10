<script lang="ts">
	import { TEXT, installLabel, retryLabel, stoppingLabel } from "../lib/copy";
	import type { Model } from "../lib/model.svelte";
	import { ms } from "../lib/motion";
	import { fly } from "svelte/transition";

	let { model }: { model: Model } = $props();

	const phase = $derived(model.run.phase);
	const n = $derived(model.tickedApps.length);
</script>

<div class="controls">
	{#key phase === "installing" ? "run" : phase === "summary" ? "summary" : "idle"}
		<div class="set" in:fly={{ y: 8, duration: ms(240), delay: ms(60) }} out:fly={{ y: -8, duration: ms(180) }}>
			{#if phase === "installing"}
				<button
					type="button"
					class="btn"
					data-testid="stop"
					disabled={model.run.stopping}
					onclick={() => model.stopAfterCurrent()}
					>{model.run.stopping ? stoppingLabel(model.current?.name ?? "") : TEXT.stop}</button
				>
			{:else if phase === "summary"}
				{#if model.failedKeys.length > 0}
					<button type="button" class="btn" data-testid="retry" onclick={() => model.retry()}
						>{retryLabel(model.failedKeys.length)}</button
					>
				{/if}
				<button type="button" class="btn primary" data-testid="done" onclick={() => model.dismiss()}>{TEXT.done}</button>
			{:else}
				<button
					type="button"
					class="btn primary"
					data-testid="install"
					disabled={n === 0 || phase === "checking"}
					onclick={() => model.install()}>{installLabel(n)}</button
				>
			{/if}
		</div>
	{/key}
</div>

<style>
	.controls {
		display: grid;
		justify-items: end;
		align-items: center;
	}
	.set {
		grid-area: 1 / 1;
		display: flex;
		align-items: center;
		gap: var(--s2);
	}
</style>
