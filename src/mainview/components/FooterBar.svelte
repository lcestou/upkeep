<script lang="ts">
	import type { Model } from "../lib/model.svelte";
	import { ms } from "../lib/motion";
	import { fade } from "svelte/transition";
	import LogToggle from "./LogToggle.svelte";
	import RunBar from "./RunBar.svelte";
	import RunControls from "./RunControls.svelte";
	import Selection from "./Selection.svelte";

	let { model, logOpen, ontogglelog }: { model: Model; logOpen: boolean; ontogglelog: () => void } = $props();

	const running = $derived(model.run.phase === "installing" || model.run.phase === "summary");
	// Selection controls only where something can be ticked.
	const selectable = $derived(model.view === "updates" && model.ready.length > 0);
</script>

<footer class="bar">
	<div class="inner">
	<div class="start">
		{#key running}
			<div class="slot" in:fade={{ duration: ms(240) }} out:fade={{ duration: ms(120) }}>
				{#if running}
					<RunBar {model} />
				{:else if selectable}
					<Selection {model} />
				{/if}
			</div>
		{/key}
	</div>
	<div class="end">
		<LogToggle open={logOpen} ontoggle={ontogglelog} />
		<!-- The primary button belongs to the Updates view; History and Settings show Show log alone. -->
		{#if (!model.allFresh || running) && model.view === "updates"}
			<RunControls {model} />
		{/if}
	</div>
	</div>
</footer>

<style>
	.bar {
		position: relative;
		height: 64px;
		background: var(--shell);
		border-top: 1px solid oklch(0.12 0.03 160);
		z-index: 3;
	}
	/* Over 1280 px the content lines up with the capped ledger; the bar's colour spans the window. */
	.inner {
		display: flex;
		align-items: center;
		gap: var(--s6);
		max-width: 1280px;
		height: 100%;
		margin: 0 auto;
		padding: 0 var(--s4) 0 var(--s5);
	}
	.start {
		display: grid;
		flex: 1;
		min-width: 0;
	}
	.slot {
		grid-area: 1 / 1;
		display: flex;
		min-width: 0;
	}
	.end {
		display: flex;
		align-items: center;
		gap: var(--s6);
		flex: none;
	}
</style>
