<script lang="ts">
	import type { Settings } from "../../shared/types";
	import { TEXT, WIN, rateText, versionText } from "../lib/copy";
	import Mark from "./Mark.svelte";
	import type { Model } from "../lib/model.svelte";

	let { model }: { model: Model } = $props();

	const frames = [
		{ v: "own", t: WIN.frameOwn },
		{ v: "system", t: WIN.frameSystem },
	] as const;
	const sides = [
		{ v: "auto", t: WIN.buttonsAuto },
		{ v: "left", t: WIN.buttonsLeft },
		{ v: "right", t: WIN.buttonsRight },
	] as const;

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
	<h2 class="group">{WIN.group}</h2>
	<div class="sheet">
		<div class="row stack">
			<span class="text" id="frame-label">{WIN.frame}</span>
			<div class="seg" role="radiogroup" aria-labelledby="frame-label" data-testid="setting-frame">
				{#each frames as f (f.v)}
					<button
						type="button"
						role="radio"
						aria-checked={model.settings.frame === f.v}
						data-testid="setting-frame-{f.v}"
						onclick={() => set({ frame: f.v })}>{f.t}</button
					>
				{/each}
			</div>
			<p class="help">{WIN.frameHelp}</p>
		</div>
		{#if model.settings.frame === "own"}
			<div class="row stack">
				<span class="text" id="buttons-label">{WIN.buttons}</span>
				<div class="seg" role="radiogroup" aria-labelledby="buttons-label" data-testid="setting-buttons">
					{#each sides as b (b.v)}
						<button
							type="button"
							role="radio"
							aria-checked={model.settings.buttons === b.v}
							data-testid="setting-buttons-{b.v}"
							onclick={() => set({ buttons: b.v })}>{b.t}</button
						>
					{/each}
				</div>
			</div>
		{/if}
	</div>

	<h2 class="group">{WIN.about}</h2>
	<div class="sheet about" data-testid="about">
		<span class="tile"><Mark size={40} /></span>
		<div>
			<p class="word">{WIN.word}</p>
			<p class="about-version" data-testid="version">{versionText(model.version)}</p>
			<p class="about-line">{WIN.tagline}</p>
		</div>
	</div>

	<div class="meta">
		{#if model.rate}
			<div data-testid="rate">{rateText(model.rate.remaining, model.rate.limit)}</div>
		{/if}
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
	.group {
		max-width: 560px;
		margin: var(--s6) auto var(--s2);
		padding: 0 var(--s1);
		font-size: var(--fs-13);
		font-weight: 640;
		color: var(--text);
	}
	.stack {
		flex-wrap: wrap;
		padding: var(--s3) var(--s4);
		row-gap: var(--s2);
	}
	.help {
		flex-basis: 100%;
		margin: 0;
		font-size: var(--fs-12);
		color: var(--text-3);
	}
	.seg {
		display: inline-flex;
		padding: 3px;
		gap: 2px;
		border-radius: 8px;
		background: var(--ground);
		border: 1px solid var(--line-soft);
	}
	.seg button {
		height: 26px;
		padding: 0 var(--s3);
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-2);
		font-size: var(--fs-12);
		font-weight: 560;
		cursor: pointer;
	}
	.seg button:hover {
		color: var(--text);
	}
	.seg button[aria-checked="true"] {
		background: var(--shell-hi);
		color: var(--text);
	}
	.about {
		display: flex;
		align-items: center;
		gap: var(--s4);
		padding: var(--s4);
	}
	.tile {
		display: grid;
		place-items: center;
		width: 64px;
		height: 64px;
		border-radius: 14px;
		background: var(--sun);
		color: var(--on-sun);
	}
	.about p {
		margin: 0;
	}
	.word {
		font-stretch: var(--tag-stretch);
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		word-spacing: 0.14em;
		font-size: var(--fs-16);
	}
	.about-version {
		font-size: var(--fs-12);
		color: var(--text-3);
		font-variant-numeric: tabular-nums;
	}
	.about-line {
		margin-top: var(--s1) !important;
		color: var(--text-2);
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
