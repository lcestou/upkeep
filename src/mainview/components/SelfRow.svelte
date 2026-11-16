<!--
@component
Upkeep's own update, pinned above the app list while there is something to say about it. One row: the mark, the
name, the versions, one sentence, and at most two buttons. Pressing Update downloads the new version and starts it
once as a test beside this one; only then does Restart now appear, and only the restart swaps anything.
-->
<script lang="ts">
	import { say } from "../lib/engine-say";
	import { SELF, WIN, selfRolledBack, selfUpdated } from "../lib/copy";
	import type { Model } from "../lib/model.svelte";
	import Glyph from "./Glyph.svelte";

	let { model }: { model: Model } = $props();

	const self = $derived(model.self);
	// $derived: each sentence follows a language switch.
	const sentence = $derived.by(() => {
		switch (self.phase) {
			case "available":
				return SELF.available;
			case "preparing":
				return SELF.preparing;
			case "ready":
				return SELF.ready;
			case "restarting":
				return SELF.restarting;
			case "failed":
				return say(self.why);
			case "rolled-back":
				return selfRolledBack(self.version);
			case "updated":
				return selfUpdated(self.version);
			default:
				return "";
		}
	});
	// What the main button does in this phase, or nothing while Upkeep is at work on it.
	const action = $derived.by(() => {
		if (self.phase === "available") return { id: "self-update", label: SELF.update, request: "selfUpdate" } as const;
		if (self.phase === "failed" || self.phase === "rolled-back")
			return { id: "self-update", label: SELF.again, request: "selfUpdate" } as const;
		if (self.phase === "ready") return { id: "self-restart", label: SELF.restart, request: "selfRestart" } as const;
		return null;
	});
	const bad = $derived(self.phase === "failed" || self.phase === "rolled-back");
	const working = $derived(self.phase === "preparing" || self.phase === "restarting");
	const notes = $derived(self.phase === "available" || self.phase === "ready" || self.phase === "updated");
	const dismissable = $derived(self.phase === "updated" || self.phase === "rolled-back");
	// The care band and glyph the app rows use for the same meanings.
	const care = $derived(
		bad
			? ({ band: "var(--rust)", glyph: "bang" } as const)
			: working
				? ({ band: "var(--water)", glyph: "drop" } as const)
				: self.phase === "updated"
					? ({ band: "var(--leaf)", glyph: "leaf" } as const)
					: ({ band: "var(--sun)", glyph: "bud" } as const),
	);
</script>

{#if self.phase !== "none"}
	<div
		class="self"
		class:bad
		class:working
		data-testid="self-row"
		data-phase={self.phase}
		style:--band={care.band}
	>
		<span class="band" aria-hidden="true"></span>
		<span class="mark"><Glyph name={care.glyph} color={care.band} /></span>
		<span class="tag-name">{WIN.word}</span>
		<span class="versions mono" data-testid="self-version">
			{#if self.phase === "updated"}
				{self.version}
			{:else if self.phase === "rolled-back"}
				{self.from}
			{:else}
				<span class="from">{self.from}</span>
				<span class="arrow" aria-hidden="true">→</span>
				{self.version}
			{/if}
		</span>
		{#if working}<span class="spin" aria-hidden="true" data-testid="self-spinner"></span>{/if}
		<span class="sentence" role="status" data-testid="self-sentence">{sentence}</span>
		<span class="actions">
			{#if notes}
				<button
					type="button"
					class="btn small quiet"
					data-testid="self-notes"
					onclick={() => model.send("open", { what: "self-notes" })}>{WIN.whatsNew}</button
				>
			{/if}
			{#if action}
				<button
					type="button"
					class="btn small"
					class:primary={!bad}
					data-testid={action.id}
					disabled={model.selfBusy}
					title={model.selfBusy ? SELF.busy : undefined}
					onclick={() => model.send(action.request, {})}>{action.label}</button
				>
			{/if}
			{#if dismissable}
				<button type="button" class="btn small quiet" data-testid="self-dismiss" onclick={() => model.send("selfDismiss", {})}
					>{SELF.dismiss}</button
				>
			{/if}
		</span>
	</div>
{/if}

<style>
	.self {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--s3);
		min-height: 44px;
		padding: var(--s1) var(--pad-r) var(--s1) 20px;
		background: var(--raised);
		box-shadow: inset 0 -1px 0 var(--line-soft);
	}
	.band {
		position: absolute;
		inset: 0 auto 0 0;
		width: 3px;
		background: var(--band);
	}
	.mark {
		display: grid;
	}
	.versions {
		color: var(--text);
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.from,
	.arrow {
		color: var(--text-3);
	}
	.sentence {
		flex: 1;
		min-width: 0;
		color: var(--text-2);
	}
	.bad .sentence {
		color: var(--rust);
	}
	/* Plain text beside a spinner: water words with no bar under them read as a link. */
	.working .sentence {
		color: var(--text);
	}
	.spin {
		flex: none;
		width: 12px;
		height: 12px;
		border: 2px solid oklch(0.955 0.012 110 / 0.25);
		border-top-color: var(--water);
		border-radius: 50%;
		animation: spin 800ms linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(1turn);
		}
	}
	.actions {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--s2);
	}
</style>
