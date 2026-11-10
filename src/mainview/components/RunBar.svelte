<script lang="ts">
	import { workingText } from "../lib/copy";
	import type { Model } from "../lib/model.svelte";
	import { CARE, glyphColor, progressOf } from "../lib/state";
	import Glyph from "./Glyph.svelte";

	let { model }: { model: Model } = $props();

	const stops = $derived(model.queue);
	// Announced once per stage, not per percent: the stage word without its number.
	const stage = $derived(model.current ? `${model.current.name}: ${workingText(model.current.stage, null)}` : "");
</script>

<span class="sr-only" role="status">{stage}</span>
<ol class="runbar" data-testid="runbar">
	{#each stops as app (app.key)}
		{@const p = app.status === "failed" || app.status === "rolled_back" ? 1 : progressOf(app)}
		<li class="stop s-{app.status}" style:--tone={CARE[app.status].band}>
			<span class="label">
				<Glyph name={CARE[app.status].glyph} color={glyphColor(app.status)} />
				<span class="name">{app.name}</span>
			</span>
			<span class="rail"><span class="fill" style:transform="scaleX({p})"></span></span>
		</li>
	{/each}
</ol>

<style>
	.runbar {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		gap: 6px;
		min-width: 0;
		flex: 1;
	}
	.stop {
		flex: 1 1 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.label {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
	.name {
		font-stretch: var(--tag-stretch);
		font-weight: 640;
		text-transform: uppercase;
		letter-spacing: 0.035em;
		word-spacing: 0.14em;
		font-size: var(--fs-12);
		color: var(--text-2);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.s-working .name {
		color: var(--text);
	}
	.rail {
		height: 4px;
		border-radius: 2px;
		background: oklch(0.955 0.012 110 / 0.12);
		overflow: hidden;
	}
	.fill {
		display: block;
		height: 100%;
		background: var(--tone);
		transform-origin: left center;
		transition:
			transform 200ms linear,
			background-color 200ms ease-out;
	}
</style>
