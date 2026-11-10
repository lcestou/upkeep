<script lang="ts">
	import { TEXT, installLabel, retryLabel, stoppingLabel } from "../lib/copy";
	import type { Model } from "../lib/model.svelte";
	import { ms } from "../lib/motion";
	import type { Attachment } from "svelte/attachments";
	import { fly } from "svelte/transition";

	let { model }: { model: Model } = $props();

	const phase = $derived(model.run.phase);
	const n = $derived(model.tickedApps.length);
	const why = $derived(
		phase === "checking" ? TEXT.whyChecking : model.ready.length === 0 ? TEXT.whyNothing : n === 0 ? TEXT.whyTick : null,
	);

	let root = $state<HTMLElement | null>(null);
	let first = true;

	// When the buttons swap (Install for Stop, Stop for Done), focus follows instead of falling to the page.
	const handoff: Attachment<HTMLElement> = (node) => {
		if (first) {
			first = false;
			return;
		}
		const was = document.activeElement;
		const lost = was === document.body || was === null || (root?.contains(was) === true && !node.contains(was));
		if (!lost) return;
		const target = [...node.querySelectorAll<HTMLButtonElement>("button")].find((b) => !b.disabled);
		if (target) target.focus();
		else document.querySelector<HTMLElement>('[data-testid="state-sentence"]')?.focus();
	};
</script>

<div class="controls" bind:this={root}>
	{#key phase === "installing" ? "run" : phase === "summary" ? "summary" : "idle"}
		<div class="set" {@attach handoff} in:fly={{ y: 8, duration: ms(240), delay: ms(60) }} out:fly={{ y: -8, duration: ms(180) }}>
			{#if phase === "installing"}
				<button
					type="button"
					class="btn"
					data-testid="stop"
					aria-disabled={model.run.stopping}
					onclick={() => !model.run.stopping && model.stopAfterCurrent()}
					>{model.run.stopping ? stoppingLabel(model.current?.name ?? "") : TEXT.stop}</button
				>
			{:else if phase === "summary"}
				{#if model.failedKeys.length > 0}
					<button type="button" class="btn" data-testid="retry" disabled={model.starting} onclick={() => model.retry()}
						>{retryLabel(model.failedKeys.length)}</button
					>
				{/if}
				<button type="button" class="btn primary" data-testid="done" onclick={() => model.dismiss()}>{TEXT.done}</button>
			{:else}
				<button
					type="button"
					class="btn primary"
					data-testid="install"
					disabled={n === 0 || phase === "checking" || model.starting}
					title={why ?? undefined}
					aria-describedby={why ? "install-why" : undefined}
					onclick={() => model.install()}>{installLabel(n)}</button
				>
				{#if why}<span class="sr-only" id="install-why" data-testid="install-why">{why}</span>{/if}
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
