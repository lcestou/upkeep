<script lang="ts">
	import type { Settings } from "../../shared/types";
	import { TEXT, rateText, versionText } from "../lib/copy";
	import type { Model } from "../lib/model.svelte";

	let { model }: { model: Model } = $props();

	async function set(patch: Partial<Settings>) {
		const next = await model.send("setSettings", patch);
		if (next) model.settings = next;
	}
</script>

<div class="settings" data-testid="settings">
	<div class="sheet">
		<label class="row">
			<span class="text">{TEXT.notify}</span>
			<input
				type="checkbox"
				checked={model.settings.notify}
				data-testid="setting-notify"
				onchange={(e) => set({ notify: e.currentTarget.checked })}
			/>
		</label>
		<label class="row">
			<span class="text">{TEXT.checkAtLogin}</span>
			<input
				type="checkbox"
				checked={model.settings.checkAtLogin}
				data-testid="setting-login"
				onchange={(e) => set({ checkAtLogin: e.currentTarget.checked })}
			/>
		</label>
		<label class="row">
			<span class="text">{TEXT.keepBackups}</span>
			<select
				value={String(model.settings.keepBackups)}
				data-testid="setting-keep"
				onchange={(e) => set({ keepBackups: Number(e.currentTarget.value) })}
			>
				{#each [1, 2, 3, 4, 5] as n (n)}
					<option value={String(n)}>{n}</option>
				{/each}
			</select>
		</label>
		<div class="row">
			<span class="text">{TEXT.appList}</span>
			<button type="button" class="btn small" data-testid="open-manifest" onclick={() => model.send("open", { what: "manifest" })}
				>{TEXT.openManifest}</button
			>
		</div>
	</div>
	<div class="meta">
		{#if model.rate}
			<div data-testid="rate">{rateText(model.rate.remaining, model.rate.limit)}</div>
		{/if}
		<div data-testid="version">{versionText(model.version)}</div>
	</div>
</div>

<style>
	.settings {
		height: 100%;
		overflow: auto;
		padding: var(--s6) var(--s5);
	}
	.sheet {
		max-width: 560px;
		margin: 0 auto;
		border: 1px solid var(--line-soft);
		border-radius: 10px;
		background: var(--surface);
		overflow: hidden;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s4);
		min-height: 52px;
		padding: 0 var(--s4);
		border-bottom: 1px solid var(--line-soft);
		cursor: pointer;
	}
	div.row {
		cursor: default;
	}
	.row:last-child {
		border-bottom: 0;
	}
	.text {
		font-size: var(--fs-14);
		color: var(--text);
	}
	select {
		height: 30px;
		min-width: 64px;
		padding: 0 var(--s2);
		border-radius: var(--radius);
		border: 1px solid var(--line);
		background: var(--ground);
		font-family: var(--mono);
		font-size: var(--fs-12);
		cursor: pointer;
	}
	.meta {
		max-width: 560px;
		margin: var(--s4) auto 0;
		display: grid;
		gap: var(--s1);
		padding: 0 var(--s4);
		font-size: var(--fs-12);
		color: var(--text-3);
		font-variant-numeric: tabular-nums;
	}
</style>
