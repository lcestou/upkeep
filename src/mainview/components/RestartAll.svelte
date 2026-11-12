<script lang="ts">
	import type { AppState } from "../../shared/types";
	import { RESTART, restartAllLabel, restartAsk, restartedNote } from "../lib/copy";
	import type { Model } from "../lib/model.svelte";
	import { tick } from "svelte";

	let { apps, model }: { apps: AppState[]; model: Model } = $props();

	const can = $derived(apps.filter((a) => a.canRestart));
	const closing = $derived(can.filter((a) => a.closes).map((a) => a.name));
	let asking = $state(false);
	let busy = $state(false);
	let problem = $state<string | null>(null);
	let notNowBtn = $state<HTMLButtonElement | null>(null);

	/** Asks first when a desktop app would close, else restarts straight away. */
	async function start() {
		if (closing.length === 0) return restart();
		asking = true;
		await tick();
		notNowBtn?.focus();
	}

	/**
	 * Restarts each app in turn, one at a time so two password prompts never stack. The first failure stops the rest
	 * and stays on screen; what worked is said in the notice.
	 */
	async function restart() {
		asking = false;
		busy = true;
		problem = null;
		const done: string[] = [];
		try {
			for (const a of can) {
				// oxlint-disable-next-line no-await-in-loop -- one restart at a time is the point
				const res = await model.send("restartApp", { key: a.key });
				if (!res?.ok) {
					problem = res?.detail ?? null;
					break;
				}
				done.push(a.name);
			}
		} finally {
			busy = false;
		}
		if (done.length > 0) model.flash("notice", restartedNote(done));
	}
</script>

{#if can.length > 0}
	<div class="restart-all">
		{#if asking}
			<div class="confirm" role="group" aria-labelledby="restart-all-ask">
				<p id="restart-all-ask" data-testid="restart-all-ask">{restartAsk(closing)}</p>
				<button type="button" class="btn small" data-testid="restart-all-confirm" onclick={restart}>{RESTART.yes}</button>
				<button
					type="button"
					class="btn small"
					data-testid="restart-all-cancel"
					bind:this={notNowBtn}
					onclick={() => (asking = false)}>{RESTART.notNow}</button
				>
			</div>
		{:else}
			<button
				type="button"
				class="btn small"
				data-testid="restart-all"
				disabled={busy || model.run.phase === "installing"}
				onclick={start}>{restartAllLabel(can.map((a) => a.name))}</button
			>
		{/if}
		{#if problem}<span class="problem" role="status" data-testid="restart-all-result">{problem}</span>{/if}
	</div>
{/if}

<style>
	.restart-all {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s2);
		padding: var(--s2) var(--pad-r) var(--s2) 20px;
	}
	.confirm {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s2);
		padding: var(--s3);
		border: 1px solid var(--line);
		border-radius: var(--radius);
	}
	.confirm p {
		flex-basis: 100%;
		margin: 0;
		color: var(--text);
		font-size: var(--fs-13);
	}
	.problem {
		font-size: var(--fs-13);
		color: var(--fail);
	}
</style>
