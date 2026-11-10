<script lang="ts">
	import type { AppState } from "../../shared/types";
	import { CHIP, COLUMN, KIND_LABEL, TEXT, statusText } from "../lib/copy";
	import { formatBytes } from "../lib/format";
	import type { Model } from "../lib/model.svelte";
	import { CARE, type Layout, glyphColor, isQuiet, restoreText } from "../lib/state";
	import Glyph from "./Glyph.svelte";
	import Stem from "./Stem.svelte";
	import Versions from "./Versions.svelte";

	let { app, model, layout }: { app: AppState; model: Model; layout: Layout } = $props();

	const care = $derived(CARE[app.status]);
	const open = $derived(model.open === app.key);
	const tickable = $derived(app.status === "ready" || app.status === "queued");
	const quiet = $derived(isQuiet(app));
	const inRun = $derived(model.run.phase === "installing");
	const from = $derived(model.run.results.find((r) => r.key === app.key)?.from ?? null);
	const restore = $derived(restoreText(app));
	const stemmed = $derived(
		layout === "c"
			? ["ready", "queued", "working", "done"].includes(app.status)
			: app.status === "working" || app.status === "done",
	);
	const sentence = $derived(
		app.detail && ["problem", "failed", "rolled_back", "done"].includes(app.status) ? app.detail : null,
	);
	const command = $derived(layout === "c" && app.status === "manual" ? (app.run ?? null) : null);
</script>

<div
	class="row {layout} s-{app.status}"
	class:quiet
	class:open
	class:dim={inRun && app.status !== "working"}
	class:stemmed
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
		aria-expanded={layout === "b" ? undefined : open}
		aria-current={layout === "b" && open ? "true" : undefined}
		aria-controls="detail-{app.key}"
		data-testid="open-{app.key}"
		onclick={() => model.toggleRow(app.key, layout === "b")}
	>
		<span class="cell mark"><Glyph name={care.glyph} color={glyphColor(app.status)} /></span>
		<span class="cell name">
			<span class="line">
				<span class="tag-name" id="name-{app.key}">{app.name}</span>
				{#if app.repo}<span class="latin">{app.repo}</span>{/if}
				<span class="kind-inline">{KIND_LABEL[app.kind]}</span>
				{#if !quiet || app.running}
					<span class="chips">
						{#if app.running}<span class="chip running" title={CHIP.running.title} data-testid="chip-running"
								>{CHIP.running.text}</span
							>{/if}
						{#if app.sudo && !quiet}<span class="chip" title={CHIP.root.title} data-testid="chip-root">{CHIP.root.text}</span
							>{/if}
						{#if app.auto && !quiet}<span class="chip" title={CHIP.auto.title} data-testid="chip-auto">{CHIP.auto.text}</span
							>{/if}
					</span>
				{/if}
			</span>
			{#if sentence}<span class="sentence">{sentence}</span>{/if}
		</span>
		<span class="cell kind">{KIND_LABEL[app.kind]}</span>
		<span class="cell ver"><Versions {app} {from} /></span>
		<span class="cell size">
			{#if !quiet && typeof app.size === "number"}
				<span class="label">{COLUMN.size}</span>
				<span class="mono">{formatBytes(app.size)}</span>
			{/if}
		</span>
		<span class="cell restore">
			<span class="label">{COLUMN.restore}</span>
			{#if app.status !== "checking"}
				{#if restore}<span class="mono">{restore}</span>{:else}<span class="none">{TEXT.none}</span>{/if}
			{/if}
		</span>
		<span class="cell status">
			{#if stemmed}
				<Stem {app} />
			{:else if command}
				<span class="command mono" title={command}>{command}</span>
				<span class="status-text">{statusText(app)}</span>
			{:else}
				<span class="status-text" data-testid="status-{app.key}">{statusText(app)}</span>
			{/if}
		</span>
	</button>
</div>

<style>
	/* The grid template belongs to the layout (--cols on the list); the cells are the same in all three. */
	.row {
		position: relative;
		display: grid;
		grid-template-columns: var(--cols);
		column-gap: var(--gap, 12px);
		align-items: center;
		min-height: var(--row-h, 44px);
		padding-right: var(--pad-r, 16px);
		background: var(--surface);
		border-bottom: 1px solid var(--line-soft);
		transition:
			opacity 240ms ease-out,
			background-color 120ms ease-out;
	}
	.row.quiet {
		min-height: var(--quiet-h, 36px);
		background: transparent;
	}
	.row:hover {
		background: var(--raised);
	}
	.row.open {
		background: var(--raised);
		border-bottom-color: transparent;
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
		grid-column: 2 / -1;
		display: grid;
		grid-template-columns: subgrid;
		align-items: center;
		align-self: stretch;
		min-width: 0;
		margin: 0;
		padding: 6px 0;
		border: 0;
		background: none;
		text-align: left;
		cursor: pointer;
	}
	.hit:focus-visible {
		outline-offset: -2px;
		border-radius: var(--radius-sm);
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
		gap: 3px;
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
		color: var(--text-2);
		line-height: 1.35;
	}
	.s-failed .sentence,
	.s-rolled_back .sentence,
	.s-problem .sentence {
		color: oklch(0.82 0.09 48);
	}
	.kind,
	.kind-inline {
		font-size: var(--fs-12);
		color: var(--text-3);
		white-space: nowrap;
	}
	.kind-inline,
	.label {
		display: none;
	}
	.size {
		text-align: right;
		color: var(--text-2);
	}
	.restore {
		color: var(--text-2);
	}
	.a .restore {
		padding-left: var(--s3);
	}
	.none {
		color: var(--text-3);
		font-size: var(--fs-12);
	}
	.status {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 2px;
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
	.command {
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* A, the ledger: the stem takes over size, restore point and status while it runs. */
	.a.stemmed .size,
	.a.stemmed .restore {
		display: none;
	}
	.a.stemmed .status {
		grid-column: stem / end;
	}
	@media (max-width: 859px) {
		.a .size {
			display: none;
		}
	}
	@media (max-width: 799px) {
		.a .kind {
			display: none;
		}
	}

	/* B, bench and tag: narrow rows, the rest lives in the tag pane. */
	.b .kind,
	.b .size,
	.b .restore,
	.b .latin {
		display: none;
	}
	.b.open {
		box-shadow: inset -3px 0 0 var(--sun);
	}
	@container list (max-width: 519px) {
		.b {
			--cols: [tick] 32px [mark] 20px [name] minmax(0, 1fr) [stem status] 128px [end];
		}
		.b .latin {
			display: none;
		}
		.b .mark,
		.b .status {
			grid-row: 1 / span 2;
		}
		.b .name {
			grid-row: 1;
		}
		.b .ver {
			grid-column: name;
			grid-row: 2;
		}
		.b .ver :global(.versions) {
			grid-template-columns: auto 20px auto;
			justify-content: start;
		}
	}

	/* C, queue first: tall rows with labelled facts and the stem always out. */
	.c {
		--row-h: 64px;
	}
	.c .kind {
		display: none;
	}
	.c .status {
		padding-right: 6px;
	}
	.c .line {
		flex-wrap: wrap;
		row-gap: 2px;
	}
	.c .tag-name {
		font-size: var(--fs-16);
		flex-basis: 100%;
	}
	.c .kind-inline {
		display: inline;
	}
	.c .size,
	.c .restore {
		display: flex;
		flex-direction: column;
		gap: 2px;
		text-align: left;
	}
	.c .label {
		display: block;
		font-size: var(--fs-11);
		color: var(--text-3);
		white-space: nowrap;
	}
	.c :global(.versions) {
		font-size: var(--fs-13);
	}
</style>
