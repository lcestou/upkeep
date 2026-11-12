<script lang="ts">
	import { TEXT } from "../lib/copy";
	import type { Model, View } from "../lib/model.svelte";
	import { ms } from "../lib/motion";
	import { fade } from "svelte/transition";
	import Mark from "./Mark.svelte";
	import StateSentence from "./StateSentence.svelte";
	import WindowButtons from "./WindowButtons.svelte";

	let { model }: { model: Model } = $props();

	// $derived: the labels follow a language switch.
	const tabs: { id: View; text: string }[] = $derived([
		{ id: "updates", text: TEXT.updates },
		{ id: "history", text: TEXT.history },
		{ id: "settings", text: TEXT.settings },
	]);
	const checking = $derived(model.run.phase === "checking");
	const chrome = $derived(model.chrome);
	const own = $derived(chrome?.own === true);

	/** Double-click on the strip's empty area maximizes, as a desktop title bar does; never on a control, and only with the self-drawn frame. */
	function ondblclick(e: MouseEvent) {
		if (!own || (e.target instanceof Element && e.target.closest("button, input, select, a, [role=tab]"))) return;
		void model.send("window", { op: "maximize" });
	}

	/** Arrow keys, Home and End move between tabs and wrap at the ends; the tab is selected as well as focused. */
	function onTabKey(e: KeyboardEvent, i: number) {
		const target = new Map([["ArrowRight", i + 1], ["ArrowLeft", i - 1], ["Home", 0], ["End", tabs.length - 1]]).get(e.key);
		if (target === undefined) return;
		e.preventDefault();
		const next = tabs[(target + tabs.length) % tabs.length];
		if (!next) return;
		model.view = next.id;
		document.querySelector<HTMLElement>(`[data-testid="tab-${next.id}"]`)?.focus();
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<header
	class="bar"
	class:own
	class:left={own && chrome?.side === "left"}
	class:right={own && chrome?.side === "right"}
	class:electrobun-webkit-app-region-drag={own}
	data-testid="header"
	{ondblclick}
>
	{#if own && chrome}<WindowButtons {model} {chrome} />{/if}
	<div class="inner">
		{#if own && chrome?.side === "left"}<span class="divider" aria-hidden="true"></span>{/if}
		<span class="brand"><Mark /></span>
		<div class="lead">
			<StateSentence {model} />
		</div>
		<div class="side">
			<div class="tabs" role="tablist">
				{#each tabs as tab, i (tab.id)}
					<button
						type="button"
						role="tab"
						class="tab"
						class:electrobun-webkit-app-region-no-drag={own}
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
			<button
				type="button"
				class="btn small"
				class:electrobun-webkit-app-region-no-drag={own}
				data-testid="check"
				aria-label={TEXT.check}
				title={TEXT.check}
				aria-disabled={model.run.phase !== "idle"}
				onclick={() => model.run.phase === "idle" && model.check()}
			>
				<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"
					><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.75V5.5h-2.75" /></svg
				>
				<span class="check-text">{TEXT.check}</span>
			</button>
		</div>
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
		height: 56px;
		user-select: none;
		-webkit-user-select: none;
		/* Over 1280 px the content lines up with the capped ledger; the strip itself spans the window. */
		--edge: max(0px, (100vw - 1280px) / 2);
		/* Three 28 px buttons 6 px apart, 12 px from the edge, end at 108 px; the mark keeps 20 px clear of them. */
		--clear: 118px;
		background: var(--shell);
		border-bottom: 1px solid oklch(0.12 0.03 160);
		z-index: 3;
	}
	.inner {
		display: flex;
		align-items: center;
		gap: var(--s4);
		min-width: 0;
		width: 100%;
		max-width: 1280px;
		height: 100%;
		margin: 0 auto;
		padding: 0 var(--s4) 0 var(--s5);
	}
	/* Window buttons sit at the window's edge; the content clears them by 16 px. */
	.left .inner {
		padding-left: max(var(--s5), calc(var(--clear) - var(--edge)));
	}
	.right .inner {
		padding-right: max(var(--s4), calc(var(--clear) - var(--edge)));
	}
	.divider {
		flex: none;
		width: 1px;
		height: 24px;
		margin-right: calc(10px - var(--s4));
		background: var(--line-soft);
	}
	.brand {
		display: flex;
		color: var(--text);
		margin-right: calc(-1 * var(--s1));
	}
	.lead {
		flex: 1 1 auto;
		min-width: 0;
	}
	/* The tabs and Check again keep their size; the sentence gives way. */
	.side {
		display: flex;
		align-items: center;
		gap: var(--s2);
		flex: none;
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
	/* Below 860 px Check again keeps its icon and its name, and gives its word's width to the check time. */
	@media (max-width: 859px) {
		.check-text {
			display: none;
		}
		[data-testid="check"] {
			padding: 0 6px;
		}
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
