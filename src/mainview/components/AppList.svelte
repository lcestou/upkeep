<script lang="ts">
	import type { AppState } from "../../shared/types";
	import { COLUMN, type GroupId, TEXT } from "../lib/copy";
	import type { Group, Model } from "../lib/model.svelte";
	import { ms } from "../lib/motion";
	import { CARE, type Layout, glyphColor, isStruck } from "../lib/state";
	import { flip } from "svelte/animate";
	import { slide } from "svelte/transition";
	import AppRow from "./AppRow.svelte";
	import Glyph from "./Glyph.svelte";
	import RowDetail from "./RowDetail.svelte";
	import Selection from "./Selection.svelte";

	let { model, layout }: { model: Model; layout: Layout } = $props();

	// C splits the bench: what needs a decision on top as tall rows, everything settled below as a dense grid.
	const DENSE = new Set<GroupId>(["held", "checking", "fresh"]);

	type Item = { id: string; group: Group; app?: AppState };

	const top = $derived(layout === "c" ? model.groups.filter((g) => !DENSE.has(g.id)) : model.groups);
	const dense = $derived(layout === "c" ? model.groups.filter((g) => DENSE.has(g.id)) : []);
	const items: Item[] = $derived.by(() => {
		const out: Item[] = [];
		for (const group of top) {
			out.push({ id: `g:${group.id}`, group });
			for (const app of group.apps) out.push({ id: app.key, group, app });
		}
		return out;
	});

	function onkeydown(e: KeyboardEvent) {
		if (e.key !== "Escape" || !model.open || layout === "b") return;
		const key = model.open;
		model.open = null;
		document.querySelector<HTMLElement>(`[data-testid="open-${key}"]`)?.focus();
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="list {layout}" {onkeydown} data-testid="app-list">
	{#if layout !== "c"}
		<div class="heads" aria-hidden="true">
			<span class="h-name">{COLUMN.app}</span>
			{#if layout === "a"}<span class="h-kind">{COLUMN.kind}</span>{/if}
			<span class="h-ver">{COLUMN.version}</span>
			{#if layout === "a"}
				<span class="h-size">{COLUMN.size}</span>
				<span class="h-restore">{COLUMN.restore}</span>
			{/if}
			<span class="h-status">{COLUMN.status}</span>
		</div>
	{/if}

	{#each items as item (item.id)}
		<div class="item" class:head={!item.app} animate:flip={{ duration: ms(320) }}>
			{#if item.app}
				<AppRow app={item.app} {model} {layout} />
				{#if layout !== "b" && model.open === item.app.key}
					<div transition:slide={{ duration: ms(220) }}>
						<RowDetail app={item.app} {model} />
					</div>
				{/if}
			{:else}
				<div class="ghead" class:first={item.group === top[0]}>
					<h2 data-testid="group-{item.group.id}">{item.group.label}</h2>
					<span class="count mono">{item.group.apps.length}</span>
					{#if layout === "c" && item.group.id === "ready" && model.run.phase === "idle"}
						<span class="ghead-end"><Selection {model} /></span>
					{/if}
				</div>
			{/if}
		</div>
	{/each}

	{#each dense as group (group.id)}
		<section class="dense-group">
			<div class="ghead">
				<h2 data-testid="group-{group.id}">{group.label}</h2>
				<span class="count mono">{group.apps.length}</span>
			</div>
			<div class="dense">
				{#each group.apps as app (app.key)}
					{@const care = CARE[app.status]}
					<button
						type="button"
						class="tile s-{app.status}"
						class:open={model.open === app.key}
						style:--band={care.band}
						aria-expanded={model.open === app.key}
						aria-controls="detail-{app.key}"
						data-testid="open-{app.key}"
						onclick={() => model.toggleRow(app.key)}
					>
						<span class="band" aria-hidden="true"></span>
						<Glyph name={care.glyph} color={glyphColor(app.status)} />
						<span class="tile-name" id="name-{app.key}">{app.name}</span>
						{#if app.status === "checking"}
							<span class="skeleton" aria-hidden="true"></span>
						{:else if app.versionless}
							<span class="tile-ver quiet-note">{TEXT.versionless}</span>
						{:else}
							<span class="tile-ver mono" class:struck={isStruck(app)}>{app.status === "held" ? app.latest : app.installed}</span>
						{/if}
					</button>
					{#if model.open === app.key}
						<div class="dense-detail" transition:slide={{ duration: ms(220) }}>
							<RowDetail {app} {model} />
						</div>
					{/if}
				{/each}
			</div>
		</section>
	{/each}
</div>

<style>
	.list {
		container: list / inline-size;
		height: 100%;
		overflow-y: auto;
		overflow-x: hidden;
		overscroll-behavior: contain;
		padding-bottom: var(--s6);
		--gap: 10px;
		--pad-r: 16px;
	}

	/* Grid templates per layout. Named lines let a working row's stem claim the columns to its right. */
	.a {
		--cols: [tick] 36px [mark] 20px [name] minmax(0, 1fr) [kind] 88px [ver] 176px [size stem] 68px [restore] 92px [status] 140px
			[end];
		--indent: 76px;
	}
	@media (max-width: 859px) {
		.a {
			--cols: [tick] 36px [mark] 20px [name] minmax(0, 1fr) [kind] 88px [ver] 176px [restore stem] 92px [status] 140px [end];
		}
	}
	@media (max-width: 799px) {
		.a {
			--cols: [tick] 36px [mark] 20px [name] minmax(0, 1fr) [ver] 176px [restore stem] 92px [status] 140px [end];
		}
	}
	.b {
		--cols: [tick] 36px [mark] 20px [name] minmax(0, 1fr) [ver] 164px [stem status] 132px [end];
	}
	.c {
		--cols: [tick] 36px [mark] 20px [name] minmax(0, 1fr) [ver] 184px [size] 64px [restore] 88px [stem status] minmax(200px, 0.85fr)
			[end];
		--gap: 14px;
		--indent: 84px;
	}
	@media (max-width: 859px) {
		.c {
			--cols: [tick] 32px [mark] 20px [name] minmax(0, 1fr) [ver] 160px [restore] 84px [stem status] 196px [end];
		}
		.c :global(.row .size) {
			display: none;
		}
	}

	@container list (max-width: 519px) {
		.heads {
			--cols: [tick] 32px [mark] 20px [name] minmax(0, 1fr) [stem status] 128px [end];
		}
		.h-ver {
			display: none;
		}
	}
	.heads {
		position: sticky;
		top: 0;
		z-index: 2;
		display: grid;
		grid-template-columns: var(--cols);
		column-gap: var(--gap);
		align-items: end;
		height: 30px;
		padding: 0 var(--pad-r) 7px 0;
		background: var(--ground);
		border-bottom: 1px solid var(--line-soft);
		font-size: var(--fs-11);
		font-weight: 560;
		letter-spacing: 0.02em;
		color: var(--text-3);
		white-space: nowrap;
	}
	.h-name {
		grid-column: name;
	}
	.h-kind {
		grid-column: kind;
	}
	.h-ver {
		grid-column: ver;
		justify-self: center;
	}
	.h-size {
		grid-column: size;
		justify-self: end;
	}
	.h-restore {
		grid-column: restore;
	}
	.a .h-restore {
		padding-left: var(--s3);
	}
	.h-status {
		grid-column: status;
	}
	@media (max-width: 859px) {
		.a .h-size {
			display: none;
		}
	}
	@media (max-width: 799px) {
		.a .h-kind {
			display: none;
		}
	}

	.ghead {
		display: flex;
		align-items: baseline;
		gap: var(--s2);
		padding: var(--s5) var(--pad-r) var(--s2) 20px;
	}
	.ghead.first {
		padding-top: var(--s4);
	}
	.ghead h2 {
		margin: 0;
		font-size: var(--fs-13);
		font-weight: 640;
		color: var(--text);
	}
	.count {
		font-size: var(--fs-11);
		color: var(--text-3);
	}
	.ghead-end {
		margin-left: auto;
		align-self: center;
	}
	.item.head + .item :global(.row) {
		border-top: 1px solid var(--line-soft);
	}

	/* C's dense grid. */
	.dense {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		grid-auto-flow: row dense;
		column-gap: var(--s6);
		padding: 0 var(--pad-r) 0 20px;
	}
	.tile {
		position: relative;
		display: grid;
		grid-template-columns: 16px minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--s2);
		height: 30px;
		padding: 0 var(--s2) 0 14px;
		border: 0;
		border-bottom: 1px solid var(--line-soft);
		background: transparent;
		text-align: left;
		cursor: pointer;
		color: var(--text-2);
	}
	.tile:hover,
	.tile.open {
		background: var(--raised);
	}
	.tile:focus-visible {
		outline-offset: -2px;
	}
	.tile .band {
		position: absolute;
		left: 0;
		top: 5px;
		bottom: 5px;
		width: 4px;
		background: var(--band);
		opacity: 0.55;
	}
	.tile-name {
		font-stretch: var(--tag-stretch);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.035em;
		font-size: var(--fs-13);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.tile-ver {
		color: var(--text-3);
		font-size: var(--fs-11);
	}
	.tile-ver.struck {
		text-decoration: line-through;
		text-decoration-color: var(--rust);
	}
	.quiet-note {
		font-style: italic;
		font-size: var(--fs-12);
	}
	.s-held .tile-name {
		color: var(--frost);
	}
	.skeleton {
		width: 52px;
		height: 8px;
		border-radius: 4px;
		background: var(--line-soft);
		animation: breathe 1.4s ease-in-out infinite;
	}
	@keyframes breathe {
		50% {
			opacity: 0.45;
		}
	}
	.dense-detail {
		grid-column: 1 / -1;
		--indent: 20px;
	}
</style>
