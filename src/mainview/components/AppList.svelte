<script lang="ts">
	import type { AppState } from "../../shared/types";
	import { COLUMN, TEXT } from "../lib/copy";
	import { shade } from "../lib/shade";
	import type { Group, Model } from "../lib/model.svelte";
	import { ms } from "../lib/motion";
	import { flip } from "svelte/animate";
	import AppRow from "./AppRow.svelte";

	let { model }: { model: Model } = $props();

	type Item = { id: string; group: Group; app?: AppState };

	// Fresh starts folded; the choice lasts for the session.
	const FRESH_KEY = "upkeep.freshOpen";
	let freshOpen = $state(readFresh());
	function readFresh(): boolean {
		try {
			return sessionStorage.getItem(FRESH_KEY) === "1";
		} catch {
			return false;
		}
	}
	function toggleFresh() {
		freshOpen = !freshOpen;
		try {
			sessionStorage.setItem(FRESH_KEY, freshOpen ? "1" : "0");
		} catch {
			// Storage can be blocked; the fold still works for this page.
		}
	}

	// With nothing else to show, a folded Fresh would leave an empty window: it shows open instead.
	const onlyFresh = $derived(model.groups.every((g) => g.id === "fresh"));
	const freshShown = $derived(freshOpen || onlyFresh);

	const items: Item[] = $derived.by(() => {
		const out: Item[] = [];
		for (const group of model.groups) {
			out.push({ id: `g:${group.id}`, group });
			if (group.id === "fresh" && !freshShown) continue;
			for (const app of group.apps) out.push({ id: app.key, group, app });
		}
		return out;
	});

	const idle = $derived(model.run.phase === "idle");
	const all = $derived(model.ready.length > 0 && model.tickedApps.length === model.ready.length);
	const some = $derived(model.tickedApps.length > 0 && !all);

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
		const key0 = target.dataset.row;
		if (e.key === "ArrowRight" && key0) {
			e.preventDefault();
			model.select(key0);
			return;
		}
		if (e.key === "ArrowLeft" && model.openKey) {
			e.preventDefault();
			model.close();
			return;
		}
		if (e.key === "a" && (e.ctrlKey || e.metaKey) && idle) {
			e.preventDefault();
			model.selectAll();
			return;
		}
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

<div class="wrap">
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="list" bind:this={root} {onkeydown} {onfocusin} data-testid="app-list" {@attach shade}>
	<div class="heads ledger-cols">
		<label class="h-tick">
			<input
				type="checkbox"
				aria-label={TEXT.selectAll}
				data-testid="tick-all"
				checked={all}
				disabled={!idle || model.ready.length === 0}
				{@attach (node: HTMLInputElement) => {
					node.indeterminate = some;
				}}
				onchange={() => (all ? model.selectNone() : model.selectAll())}
			/>
		</label>
		<span class="h-name" aria-hidden="true">{COLUMN.app}</span>
		<span class="h-kind" aria-hidden="true">{COLUMN.kind}</span>
		<span class="h-ver" aria-hidden="true">{COLUMN.version}</span>
		<span class="h-size" aria-hidden="true">{COLUMN.size}</span>
		<span class="h-restore" aria-hidden="true">{COLUMN.restore}</span>
		<span class="h-status" aria-hidden="true">{COLUMN.status}</span>
	</div>

	{#each items as item (item.id)}
		<div class="item" class:head={!item.app} animate:flip={{ duration: ms(320) }}>
			{#if item.app}
				<AppRow app={item.app} {model} tabbable={item.app.key === tabKey} />
			{:else}
				<div class="ghead" class:first={item.group === model.groups[0]}>
					{#if item.group.id === "fresh"}
						<h2>
							<button
								type="button"
								class="fold"
								aria-expanded={freshShown}
								data-testid="group-fresh-toggle"
								onclick={toggleFresh}
							>
								<svg class="chev" class:open={freshShown} viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"
									><path d="M4.5 2.5 8 6l-3.5 3.5" /></svg
								>
								<span data-testid="group-fresh">{item.group.label}</span>
								<span class="count mono">{item.group.apps.length}</span>
							</button>
						</h2>
					{:else}
						<h2 data-testid="group-{item.group.id}">{item.group.label}</h2>
						<span class="count mono">{item.group.apps.length}</span>
					{/if}
				</div>
			{/if}
		</div>
	{/each}
</div>
</div>

<style>
	.wrap {
		position: relative;
		height: 100%;
		min-width: 0;
	}
	/* A row cut by the footer reads as "more below", not as a glitch. */
	.wrap::after {
		content: "";
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: 20px;
		pointer-events: none;
		background: linear-gradient(transparent, oklch(0.12 0.02 165 / 0.75));
		opacity: 0;
		transition: opacity 150ms ease-out;
	}
	.wrap:has(:global(.list[data-more-bottom]))::after {
		opacity: 1;
	}
	.h-tick {
		grid-column: tick;
		display: flex;
		align-items: center;
		justify-content: flex-end;
		align-self: center;
		width: 28px;
		height: 28px;
		margin-right: -6px;
		justify-self: end;
		cursor: pointer;
	}
	.fold {
		display: inline-flex;
		align-items: baseline;
		gap: var(--s2);
		margin: 0 0 0 -4px;
		padding: 2px 6px 2px 4px;
		border: 0;
		border-radius: var(--radius-sm);
		background: none;
		font: inherit;
		color: inherit;
		cursor: pointer;
	}
	.fold:hover {
		background: oklch(0.955 0.012 110 / 0.07);
	}
	.chev {
		align-self: center;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
		transition: transform 150ms ease-out;
	}
	.chev.open {
		transform: rotate(90deg);
	}
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
		align-items: center;
		height: 34px;
		padding: 0 var(--pad-r) 0 0;
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
		box-shadow:
			inset 0 1px 0 var(--line-soft),
			inset 0 -1px 0 var(--line-soft);
	}
</style>
