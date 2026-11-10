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
</script>

<footer class="bar">
	<div class="start">
		{#key running}
			<div class="slot" in:fade={{ duration: ms(240) }} out:fade={{ duration: ms(120) }}>
				{#if running}
					<RunBar {model} />
				{:else}
					<Selection {model} />
				{/if}
			</div>
		{/key}
	</div>
	<div class="end">
		<LogToggle open={logOpen} ontoggle={ontogglelog} />
		<RunControls {model} />
	</div>
</footer>

<style>
	.bar {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--s6);
		height: 64px;
		padding: 0 var(--s4) 0 var(--s5);
		background: var(--shell);
		border-top: 1px solid oklch(0.12 0.03 160);
		z-index: 3;
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
		gap: var(--s2);
		flex: none;
	}
</style>
