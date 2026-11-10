<script lang="ts">
	import type { AppState } from "../../shared/types";
	import { CHIP, KIND_LABEL, TEXT, statusText } from "../lib/copy";
	import { formatBytes } from "../lib/format";
	import type { Model } from "../lib/model.svelte";
	import { CARE, glyphColor, isQuiet, restoreText } from "../lib/state";
	import Glyph from "./Glyph.svelte";
	import Stem from "./Stem.svelte";
	import Versions from "./Versions.svelte";

	let { app, model, tabbable }: { app: AppState; model: Model; tabbable: boolean } = $props();

	const care = $derived(CARE[app.status]);
	const open = $derived(model.openKey === app.key);
	const tickable = $derived(app.status === "ready" || app.status === "queued");
	const quiet = $derived(isQuiet(app));
	const inRun = $derived(model.run.phase === "installing");
	const from = $derived(model.run.results.find((r) => r.key === app.key)?.from ?? null);
	const restore = $derived(restoreText(app));
	const stemmed = $derived(app.status === "working" || app.status === "done");
	const sentence = $derived(
		app.detail && ["problem", "failed", "rolled_back", "done"].includes(app.status) ? app.detail : null,
	);

	function onclick() {
		if (open) model.close();
		else model.select(app.key);
	}
</script>

<div
	class="row ledger-cols s-{app.status}"
	class:quiet
	class:open
	class:dim={inRun && app.status !== "working"}
	data-testid="row-{app.key}"
	style:--band={care.band}
>
	<span class="band" aria-hidden="true"></span>
	<span class="cell tick">
		{#if tickable}
			<input
				type="checkbox"
				checked={app.status === "queued" || model.ticked.has(app.key)}
				disabled={app.status === "queued" || model.run.phase !== "idle"}
				aria-labelledby="name-{app.key}"
				data-testid="tick-{app.key}"
				onchange={() => model.toggle(app.key)}
			/>
		{/if}
	</span>
	<button
		type="button"
		class="hit"
		data-row={app.key}
		tabindex={tabbable ? 0 : -1}
		aria-current={open ? "true" : undefined}
		aria-controls="inspector"
		data-testid="open-{app.key}"
		{onclick}
	>
		<span class="cell mark"><Glyph name={care.glyph} color={glyphColor(app.status)} /></span>
		<span class="cell name">
			<span class="line">
				<span class="tag-name" id="name-{app.key}">{app.name}</span>
				{#if app.repo}<span class="latin">{app.repo}</span>{/if}
				{#if !quiet || app.running}
					<span class="chips">
						{#if app.running}<span class="chip running" title={CHIP.running.title} data-testid="chip-running"
								>{CHIP.running.text}</span
							>{/if}
						{#if app.sudo && !quiet}<span class="chip" title={CHIP.root.title} data-testid="chip-root"
								>{CHIP.root.text}</span
							>{/if}
						{#if app.auto && !quiet}<span class="chip" title={CHIP.auto.title} data-testid="chip-auto"
								>{CHIP.auto.text}</span
							>{/if}
					</span>
				{/if}
			</span>
			{#if sentence}<span class="sentence">{sentence}</span>{/if}
		</span>
		<span class="cell kind">{KIND_LABEL[app.kind]}</span>
		<span class="cell ver"><Versions {app} {from} /></span>
		<span class="cell size mono">{!quiet && typeof app.size === "number" ? formatBytes(app.size) : ""}</span>
		<span class="cell restore">
			{#if app.status !== "checking"}
				{#if restore}<span class="mono">{restore}</span>{:else}<span class="none">{TEXT.none}</span>{/if}
			{/if}
		</span>
		<span class="cell status">
			{#if stemmed}
				<Stem {app} />
			{:else}
				<span class="status-text" data-testid="status-{app.key}">{statusText(app)}</span>
			{/if}
		</span>
		{#if open}<svg class="marker" viewBox="0 0 8 14" aria-hidden="true"><path d="M8 0v14L1 7Z" /></svg>{/if}
	</button>
</div>

<style>
	/* Column sets follow the list's own width, so the same rows serve the full ledger and the narrowed one beside the inspector. */
	.row {
		position: relative;
		display: grid;
		grid-template-columns: var(--cols);
		column-gap: var(--gap);
		align-items: center;
		height: 44px;
		padding-right: var(--pad-r);
		background: var(--surface);
		border-bottom: 1px solid var(--line-soft);
		scroll-margin: 40px 0 52px;
		transition:
			opacity 240ms ease-out,
			background-color 100ms ease-out;
	}
	@container list (max-width: 899px) {
		.kind,
		.size {
			display: none;
		}
	}
	@container list (max-width: 639px) {
		.restore {
			display: none;
		}
	}
	.row.quiet {
		height: 36px;
		background: transparent;
	}
	.row:hover {
		background: var(--raised);
	}
	.row.open {
		background: var(--raised);
	}
	.row.dim {
		opacity: 0.6;
	}
	.band {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 4px;
		background: var(--band);
	}
	.quiet .band {
		opacity: 0.55;
	}
	.tick {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		align-self: stretch;
	}
	.hit {
		position: relative;
		grid-column: 2 / -1;
		display: grid;
		grid-template-columns: subgrid;
		align-items: center;
		align-self: stretch;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
		background: none;
		text-align: left;
		cursor: pointer;
	}
	.hit:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: -2px;
		border-radius: var(--radius-sm);
	}
	.marker {
		position: absolute;
		right: calc(-1 * var(--pad-r));
		top: 50%;
		width: 8px;
		height: 14px;
		transform: translateY(-50%);
		fill: var(--text);
	}
	.cell {
		min-width: 0;
	}
	.mark {
		display: flex;
		justify-content: center;
	}
	.name {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.line {
		display: flex;
		align-items: baseline;
		gap: var(--s2);
		min-width: 0;
	}
	.tag-name {
		flex: none;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.quiet .tag-name {
		font-weight: 560;
		color: var(--text-2);
	}
	.latin {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chips {
		display: inline-flex;
		gap: var(--s1);
		align-self: center;
		flex: none;
	}
	.sentence {
		font-size: var(--fs-12);
		line-height: 15px;
		color: var(--text-2);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.s-failed .sentence,
	.s-rolled_back .sentence,
	.s-problem .sentence {
		color: oklch(0.82 0.09 48);
	}
	.kind {
		font-size: var(--fs-12);
		color: var(--text-3);
		white-space: nowrap;
	}
	.size {
		text-align: right;
		color: var(--text-2);
	}
	.restore {
		padding-left: var(--s3);
		color: var(--text-2);
	}
	.none {
		color: var(--text-3);
		font-size: var(--fs-12);
	}
	.status {
		display: flex;
		flex-direction: column;
		justify-content: center;
		min-width: 0;
	}
	.status-text {
		font-size: var(--fs-13);
		font-weight: 540;
		color: var(--text-2);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.s-ready .status-text,
	.s-queued .status-text {
		color: var(--sun);
	}
	.s-manual .status-text {
		color: var(--bloom);
	}
	.s-problem .status-text,
	.s-failed .status-text,
	.s-rolled_back .status-text {
		color: var(--rust);
	}
	.s-held .status-text {
		color: var(--frost);
	}
	.quiet .status-text {
		font-weight: 440;
		color: var(--text-3);
	}
</style>
