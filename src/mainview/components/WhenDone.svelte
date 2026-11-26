<script lang="ts">
	import { TEXT, WHEN, refusedText, shutDownIn, suspendIn } from "../lib/copy";
	import type { Model } from "../lib/model.svelte";
	import type { WhenDone } from "../../shared/types";

	let { model }: { model: Model } = $props();

	const wd = $derived(model.whenDone);
	const installing = $derived(model.run.phase === "installing");
	// Suspend and Shut down only where logind allows them; the current choice stays listed so the box never lies.
	const choices = $derived(
		(["nothing", "quit", "suspend", "poweroff"] as const).filter(
			(c) => c === wd.choice || (c !== "suspend" && c !== "poweroff") || wd.can[c],
		),
	);
	const label = $derived<Record<WhenDone, string>>({
		nothing: WHEN.nothing,
		quit: WHEN.quit,
		suspend: WHEN.suspend,
		poweroff: WHEN.poweroff,
	});

	// The countdown is told once, as the moment it acts; the seconds are counted here.
	let now = $state(Date.now());
	$effect(() => {
		if (!wd.countdown) return;
		now = Date.now();
		const timer = setInterval(() => (now = Date.now()), 250);
		return () => clearInterval(timer);
	});
	const left = $derived(wd.countdown ? Math.max(0, Math.ceil((wd.countdown.at - now) / 1000)) : 0);

	const note = $derived.by(() => {
		const c = wd.cancelled;
		if (!c || installing) return null;
		const lead = c.action === "suspend" ? WHEN.notSuspended : WHEN.notShutDown;
		const why = c.why === "refused" ? refusedText(c.detail ?? "") : WHEN[c.why];
		return `${lead} ${why}`;
	});
</script>

{#if wd.countdown}
	<div class="when" role="status">
		<span class="line" data-testid="when-countdown"
			>{wd.countdown.action === "suspend" ? suspendIn(left) : shutDownIn(left)}</span
		>
		<button type="button" class="btn primary" data-testid="when-cancel" onclick={() => model.cancelWhenDone()}
			>{WHEN.cancel}</button
		>
	</div>
{:else if note}
	<div class="when" role="status">
		<span class="line" data-testid="when-note">{note}</span>
		<!-- On the summary its own Done takes the note away; after it, this one does. -->
		{#if model.run.phase !== "summary"}
			<button type="button" class="btn small" data-testid="when-note-done" onclick={() => model.cancelWhenDone()}
				>{TEXT.done}</button
			>
		{/if}
	</div>
{:else if installing}
	<label class="when choose">
		<span class="line">{WHEN.label}</span>
		<select
			value={wd.choice}
			data-testid="when-done"
			onchange={(e) => {
				const picked = choices.find((c) => c === e.currentTarget.value);
				if (picked) void model.setWhenDone(picked);
			}}
		>
			{#each choices as c (c)}
				<option value={c} data-testid="when-{c}">{label[c]}</option>
			{/each}
		</select>
	</label>
{/if}

<style>
	.when {
		display: flex;
		align-items: center;
		gap: var(--s2);
		min-width: 0;
	}
	.line {
		color: var(--text-2);
		font-size: var(--fs-12);
		max-width: 30em;
	}
	/* The choice sits at the small buttons' height, with their border and type, as Pause for does. */
	select {
		height: 26px;
		padding: 0 var(--s2);
		border-radius: var(--radius);
		border: 1px solid var(--line);
		background: transparent;
		font-size: var(--fs-12);
		font-weight: 560;
		cursor: pointer;
	}
	select option {
		background: var(--ground);
	}
</style>
