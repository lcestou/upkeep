<script lang="ts">
	import type { AppState } from "../../shared/types";
	import { COLUMN } from "../lib/copy";
	import type { Group, Model } from "../lib/model.svelte";
	import { ms } from "../lib/motion";
	import { flip } from "svelte/animate";
	import AppRow from "./AppRow.svelte";

	let { model }: { model: Model } = $props();

	type Item = { id: string; group: Group; app?: AppState };

	const items: Item[] = $derived.by(() => {
		const out: Item[] = [];
		for (const group of model.groups) {
			out.push({ id: `g:${group.id}`, group });
			for (const app of group.apps) out.push({ id: app.key, group, app });
		}
		return out;
	});

	// One tab stop for the whole list: the open row, else the last focused row, else the first.
	let focusKey = $state<string | null>(null);
	const rowKeys = $derived(items.flatMap((i) => (i.app ? [i.app.key] : [])));
	const tabKey = $derived(
		[model.openKey, focusKey].find((k) => k !== null && rowKeys.includes(k)) ?? rowKeys[0] ?? null,
	);

	let root = $state<HTMLElement | null>(null);

	function rowButtons(): HTMLElement[] {
		return root ? [...root.querySelectorAll<HTMLElement>("[data-row]")] : [];
	}

	function onkeydown(e: KeyboardEvent) {
		const target = e.target;
		if (!(target instanceof HTMLElement) || !target.dataset.row) return;
		const rows = rowButtons();
		const i = rows.indexOf(target);
		const go: Record<string, number> = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: rows.length - 1 };
		const to = go[e.key];
		if (to === undefined) return;
		e.preventDefault();
		const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
		const key = next?.dataset.row;
		if (!next || !key) return;
		next.focus();
		if (model.openKey) model.select(key);
	}

	function onfocusin(e: FocusEvent) {
		const key = e.target instanceof HTMLElement ? e.target.dataset.row : undefined;
		if (key) focusKey = key;
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="list" bind:this={root} {onkeydown} {onfocusin} data-testid="app-list">
	<div class="heads ledger-cols" aria-hidden="true">
		<span class="h-name">{COLUMN.app}</span>
		<span class="h-kind">{COLUMN.kind}</span>
		<span class="h-ver">{COLUMN.version}</span>
		<span class="h-size">{COLUMN.size}</span>
		<span class="h-restore">{COLUMN.restore}</span>
		<span class="h-status">{COLUMN.status}</span>
	</div>

	{#each items as item (item.id)}
		<div class="item" class:head={!item.app} animate:flip={{ duration: ms(320) }}>
			{#if item.app}
				<AppRow app={item.app} {model} tabbable={item.app.key === tabKey} />
			{:else}
				<div class="ghead" class:first={item.group === model.groups[0]}>
					<h2 data-testid="group-{item.group.id}">{item.group.label}</h2>
					<span class="count mono">{item.group.apps.length}</span>
				</div>
			{/if}
		</div>
	{/each}
</div>

<style>
	.list {
		container: list / inline-size;
		height: 100%;
		overflow-y: auto;
		overflow-x: hidden;
		overscroll-behavior: contain;
		padding-bottom: 44px;
		--gap: 10px;
		--pad-r: 16px;
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
		padding-left: var(--s3);
	}
	.h-status {
		grid-column: status;
	}
	@container list (max-width: 899px) {
		.h-kind,
		.h-size {
			display: none;
		}
	}
	@container list (max-width: 639px) {
		.h-restore {
			display: none;
		}
	}
	.ghead {
		display: flex;
		align-items: baseline;
		gap: var(--s2);
		height: 44px;
		padding: var(--s5) var(--pad-r) 0 20px;
	}
	.ghead.first {
		height: 40px;
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
	.item.head + .item :global(.row) {
		border-top: 1px solid var(--line-soft);
	}
</style>
