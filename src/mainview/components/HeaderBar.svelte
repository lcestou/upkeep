<script lang="ts">
	import { TEXT } from "../lib/copy";
	import type { Model, View } from "../lib/model.svelte";
	import { ms } from "../lib/motion";
	import type { Layout } from "../lib/state";
	import { fade } from "svelte/transition";
	import LogToggle from "./LogToggle.svelte";
	import RunBar from "./RunBar.svelte";
	import RunControls from "./RunControls.svelte";
	import StateSentence from "./StateSentence.svelte";

	let {
		model,
		layout,
		logOpen,
		ontogglelog,
	}: { model: Model; layout: Layout; logOpen: boolean; ontogglelog: () => void } = $props();

	const tabs: { id: View; text: string }[] = [
		{ id: "updates", text: TEXT.updates },
		{ id: "history", text: TEXT.history },
		{ id: "settings", text: TEXT.settings },
	];
	const running = $derived(model.run.phase === "installing" || model.run.phase === "summary");
	const checking = $derived(model.run.phase === "checking");
	const runInHeader = $derived(layout === "c" && running);

	function onTabKey(e: KeyboardEvent, i: number) {
		const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
		if (step === 0) return;
		e.preventDefault();
		const next = tabs[(i + step + tabs.length) % tabs.length];
		if (!next) return;
		model.view = next.id;
		document.querySelector<HTMLElement>(`[data-testid="tab-${next.id}"]`)?.focus();
	}
</script>

<header class="bar {layout}">
	<div class="lead">
		<StateSentence {model} />
	</div>
	<div class="side">
		{#key runInHeader}
			<div class="cluster" in:fade={{ duration: ms(240) }} out:fade={{ duration: ms(120) }}>
				{#if runInHeader}
					<RunBar {model} compact />
					<LogToggle open={logOpen} ontoggle={ontogglelog} />
					<RunControls {model} />
				{:else}
					<div class="tabs" role="tablist">
						{#each tabs as tab, i (tab.id)}
							<button
								type="button"
								role="tab"
								class="tab"
								id="tab-{tab.id}"
								aria-selected={model.view === tab.id}
								aria-controls="view"
								tabindex={model.view === tab.id ? 0 : -1}
								data-testid="tab-{tab.id}"
								onclick={() => (model.view = tab.id)}
								onkeydown={(e) => onTabKey(e, i)}>{tab.text}</button
							>
						{/each}
					</div>
					<button type="button" class="btn small" data-testid="check" disabled={model.run.phase !== "idle"} onclick={() => model.check()}>
						<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"
							><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.75V5.5h-2.75" /></svg
						>
						{TEXT.check}
					</button>
					{#if layout === "c"}
						<LogToggle open={logOpen} ontoggle={ontogglelog} />
						<RunControls {model} />
					{/if}
				{/if}
			</div>
		{/key}
	</div>
	{#if checking}
		<span class="checkbar" aria-hidden="true" transition:fade={{ duration: ms(200) }}>
			<span style:transform="scaleX({model.run.total ? model.run.index / model.run.total : 0})"></span>
		</span>
	{/if}
</header>

<style>
	.bar {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--s4);
		height: 56px;
		padding: 0 var(--s3) 0 var(--s5);
		background: var(--shell);
		border-bottom: 1px solid oklch(0.12 0.03 160);
		z-index: 3;
	}
	.lead {
		flex: 1 1 auto;
		min-width: 0;
	}
	.side {
		display: grid;
		justify-items: end;
		flex: 0 1 auto;
		min-width: 0;
	}
	.c .side {
		flex: 1 1 auto;
	}
	.cluster {
		grid-area: 1 / 1;
		display: flex;
		align-items: center;
		gap: var(--s2);
		min-width: 0;
	}
	.c .cluster:has(:global(.runbar)) {
		width: 100%;
		min-width: 280px;
	}
	.tabs {
		display: flex;
		padding: 3px;
		gap: 2px;
		border-radius: 8px;
		background: var(--shell-lo);
	}
	.tab {
		height: 28px;
		padding: 0 var(--s3);
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-2);
		font-size: var(--fs-13);
		font-weight: 560;
		cursor: pointer;
		white-space: nowrap;
		transition:
			background-color 120ms ease-out,
			color 120ms ease-out;
	}
	.tab:hover {
		color: var(--text);
	}
	.tab[aria-selected="true"] {
		background: var(--shell-hi);
		color: var(--text);
		box-shadow: 0 1px 2px oklch(0.1 0.03 160 / 0.5);
	}
	.btn svg {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.checkbar {
		position: absolute;
		left: 0;
		right: 0;
		bottom: -1px;
		height: 2px;
		background: oklch(0.76 0.11 232 / 0.18);
		overflow: hidden;
	}
	.checkbar span {
		display: block;
		height: 100%;
		background: var(--water);
		transform-origin: left center;
		transition: transform 200ms ease-out;
	}
</style>
