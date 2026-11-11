<script lang="ts">
	import type { Settings } from "../../shared/types";
	import { SYS, TEXT, WIN, rateText, versionText } from "../lib/copy";
	import { LOCKUP_SVG } from "../lib/brand";
	import type { Model } from "../lib/model.svelte";

	let { model }: { model: Model } = $props();

	// The span carries the name; the drawing inside is hidden from assistive tech.
	const lockup = LOCKUP_SVG.replace("<svg ", '<svg aria-hidden="true" focusable="false" ');
	const frames = [
		{ v: "own", t: WIN.frameOwn },
		{ v: "system", t: WIN.frameSystem },
	] as const;
	const cornerChoices = [
		{ v: "rounded", t: WIN.cornersRounded },
		{ v: "square", t: WIN.cornersSquare },
	] as const;
	const sides = [
		{ v: "auto", t: WIN.buttonsAuto },
		{ v: "left", t: WIN.buttonsLeft },
		{ v: "right", t: WIN.buttonsRight },
	] as const;

	/** One tab stop per group, on the checked option; the arrows move and select, Home and End go to the ends. */
	function onseg(e: KeyboardEvent) {
		const group = e.currentTarget instanceof HTMLElement ? e.currentTarget.closest('[role="radiogroup"]') : null;
		if (!group) return;
		const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
		const i = radios.findIndex((r) => r === e.currentTarget);
		const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
		const to =
			e.key === "Home"
				? 0
				: e.key === "End"
					? radios.length - 1
					: step === undefined
						? -1
						: (i + step + radios.length) % radios.length;
		const next = radios[to];
		if (!next) return;
		e.preventDefault();
		next.focus();
		next.click();
	}

	/** Sends a settings change and shows what the main process saved; a request that fails leaves the old values on screen. */
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
						onkeydown={onseg}
						aria-checked={model.settings.frame === f.v}
						tabindex={model.settings.frame === f.v ? 0 : -1}
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
						onkeydown={onseg}
							aria-checked={model.settings.buttons === b.v}
						tabindex={model.settings.buttons === b.v ? 0 : -1}
							data-testid="setting-buttons-{b.v}"
							onclick={() => set({ buttons: b.v })}>{b.t}</button
						>
					{/each}
				</div>
			</div>
			<div class="row stack">
				<span class="text" id="corners-label">{WIN.corners}</span>
				<div class="seg" role="radiogroup" aria-labelledby="corners-label" data-testid="setting-corners">
					{#each cornerChoices as c (c.v)}
						<button
							type="button"
							role="radio"
						onkeydown={onseg}
							aria-checked={model.settings.corners === c.v}
						tabindex={model.settings.corners === c.v ? 0 : -1}
							data-testid="setting-corners-{c.v}"
							onclick={() => set({ corners: c.v })}>{c.t}</button
						>
					{/each}
				</div>
				<p class="help">{WIN.cornersHelp}</p>
			</div>
		{/if}
	</div>

	<h2 class="group" data-testid="extras-group">{SYS.extras}</h2>
	<div class="sheet">
		<label class="row stack">
			<span class="text">{SYS.setting}</span>
			<input
				type="checkbox"
				checked={model.extras?.settings.system === "show"}
				disabled={model.extras === null}
				data-testid="setting-system"
				onchange={(e) => model.setExtras({ system: e.currentTarget.checked ? "show" : "off" })}
			/>
			<span class="help" data-testid="setting-system-help">{SYS.settingHelp}</span>
		</label>
	</div>

	<h2 class="group">{WIN.about}</h2>
	<div class="sheet about" data-testid="about">
		<!-- The horizontal lockup for the dark ground carries the mark and the word. Trusted constant markup. -->
		<span class="lockup" role="img" aria-label={WIN.word}>{@html lockup}</span>
		<p class="about-version" data-testid="version">{versionText(model.version)}</p>
		<p class="about-line">{WIN.tagline}</p>
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
		display: grid;
		justify-items: start;
		gap: var(--s1);
		padding: var(--s4);
	}
	/* The lockup's file keeps 48 units of air around a 256-unit drawing: 40 px tall gives the drawing about 28 px. */
	.lockup :global(svg) {
		display: block;
		height: 40px;
		width: auto;
		margin: -6px 0 -6px -7px;
	}
	.about p {
		margin: 0;
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
