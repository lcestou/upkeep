<script lang="ts">
	import type { AppState } from "../../shared/types";
	import { ADD, COLUMN, TEXT, allFreshLine, noMatch } from "../lib/copy";
	import { relativeTime } from "../lib/format";
	import type { Group, Model } from "../lib/model.svelte";
	import { ms } from "../lib/motion";
	import { shade } from "../lib/shade";
	import type { Attachment } from "svelte/attachments";
	import { flip } from "svelte/animate";
	import AppRow from "./AppRow.svelte";
	import Glyph from "./Glyph.svelte";

	let { model }: { model: Model } = $props();

	type Item = { id: string; group: Group; app?: AppState };

	// Fresh starts folded; the choice lasts for the session. A filter opens it while it is active.
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
	// An add that lands an app in Fresh opens it, so the new row is there to see.
	// svelte-ignore state_referenced_locally
	let revealed = model.reveal;
	$effect(() => {
		if (model.reveal === revealed) return;
		revealed = model.reveal;
		if (model.apps.some((a) => a.status === "fresh")) freshOpen = true;
	});
	const filtering = $derived(model.filter.trim() !== "");
	const freshShown = $derived(freshOpen || filtering);

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
	const freshCount = $derived(model.apps.filter((a) => a.status === "fresh").length);

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
		const key = target.dataset.row;
		if (e.key === " ") {
			// Space ticks the focused row; Enter opens it.
			e.preventDefault();
			if (idle) model.toggle(key);
			return;
		}
		if (e.key === "ArrowRight") {
			e.preventDefault();
			model.select(key);
			return;
		}
		if (e.key === "ArrowLeft" && model.openKey) {
			e.preventDefault();
			model.close();
			return;
		}
		if (e.key === "a" && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			model.openAdd();
			return;
		}
		if (e.key === "a" && (e.ctrlKey || e.metaKey) && idle) {
			e.preventDefault();
			model.selectAll();
			return;
		}
		const rows = rowButtons();
		const i = rows.indexOf(target);
		const go: Record<string, number> = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: rows.length - 1 };
		const to = go[e.key];
		if (to === undefined) return;
		e.preventDefault();
		const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
		const nextKey = next?.dataset.row;
		if (!next || !nextKey) return;
		next.focus();
		if (model.openKey) model.select(nextKey);
	}

	function onfocusin(e: FocusEvent) {
		const key = e.target instanceof HTMLElement ? e.target.dataset.row : undefined;
		if (key) focusKey = key;
	}

	function onfilterkey(e: KeyboardEvent) {
		if (e.key !== "Escape" || !model.filter) return;
		// Escape in the field clears it and goes no further, so an open pane stays open.
		e.preventDefault();
		e.stopPropagation();
		model.filter = "";
	}

	/** A row the list's bottom edge cuts in half is covered, so the last visible row is whole or absent. */
	const cutoff: Attachment<HTMLElement> = (node) => {
		const wrap = node.parentElement;
		const update = () => {
			const bottom = node.getBoundingClientRect().bottom;
			let cut = 0;
			for (const row of node.querySelectorAll<HTMLElement>(".row, .ghead")) {
				const r = row.getBoundingClientRect();
				if (r.top < bottom && r.bottom > bottom + 0.5) cut = bottom - r.top;
			}
			wrap?.style.setProperty("--cut", `${Math.max(0, Math.round(cut))}px`);
		};
		const ro = new ResizeObserver(update);
		ro.observe(node);
		const mo = new MutationObserver(update);
		mo.observe(node, { childList: true, subtree: true });
		node.addEventListener("scroll", update, { passive: true });
		update();
		return () => {
			ro.disconnect();
			mo.disconnect();
			node.removeEventListener("scroll", update);
		};
	};
</script>

<div class="wrap">
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="list" bind:this={root} {onkeydown} {onfocusin} data-testid="app-list" {@attach shade} {@attach cutoff}>
		<div class="ledger">
			{#if model.allFresh}
				<section class="morning" data-testid="all-fresh">
					<Glyph name="leaf" color="var(--leaf)" />
					<h2>{model.sentence}</h2>
					<p data-testid="all-fresh-line">
						{allFreshLine(freshCount, model.checkedAt ? relativeTime(model.checkedAt) : "")}
					</p>
					<div class="morning-actions">
						<button type="button" class="btn" data-testid="all-fresh-check" onclick={() => model.check()}>{TEXT.check}</button>
						<button type="button" class="btn" data-testid="add-app" onclick={() => model.openAdd()}>
							<svg class="plus" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
							{ADD.button}
						</button>
					</div>
				</section>
			{:else}
				<div class="heads ledger-cols">
					<label class="h-tick">
						<input
							type="checkbox"
							tabindex="-1"
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
					<input
						class="filter"
						type="search"
						placeholder={TEXT.filter}
						aria-label={TEXT.filter}
						data-testid="filter"
						bind:value={model.filter}
						onkeydown={onfilterkey}
					/>
					<span class="h-kind" aria-hidden="true">{COLUMN.kind}</span>
					<span class="h-ver" aria-hidden="true">{COLUMN.version}</span>
					<span class="h-size" aria-hidden="true">{COLUMN.size}</span>
					<span class="h-restore" aria-hidden="true">{COLUMN.restore}</span>
					<span class="h-status" aria-hidden="true">{COLUMN.status}</span>
					<button type="button" class="btn small quiet add" data-testid="add-app" onclick={() => model.openAdd()}>
						<svg class="plus" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
						{ADD.button}
					</button>
				</div>
			{/if}

			{#if filtering && model.shown.length === 0}
				<p class="nomatch" data-testid="no-match">{noMatch(model.filter.trim())}</p>
			{/if}

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
								<span class="count mono" data-testid="count-{item.group.id}">{item.group.apps.length}</span>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	</div>
</div>

<style>
	.wrap {
		position: relative;
		height: 100%;
		min-width: 0;
		--cut: 0px;
	}
	/* A row cut by the list's bottom edge is covered: solid ground under a short fade. */
	.wrap::after {
		content: "";
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: var(--cut);
		pointer-events: none;
		background: linear-gradient(transparent, var(--ground) 10px);
	}
	.list {
		container: list / inline-size;
		height: 100%;
		overflow-y: auto;
		overflow-x: hidden;
		overscroll-behavior: contain;
		scroll-snap-type: y mandatory;
		scroll-padding-top: 34px;
		--gap: 10px;
		--pad-r: 16px;
	}
	/* On a wide window the ledger stops at 1280 px and sits in the middle, so versions stay near names. */
	.ledger {
		max-width: 1280px;
		margin: 0 auto;
		padding-bottom: 44px;
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
		box-shadow: inset 0 -1px 0 var(--line-soft);
		font-size: var(--fs-11);
		font-weight: 560;
		letter-spacing: 0.02em;
		color: var(--text-3);
		white-space: nowrap;
	}
	.h-tick {
		grid-column: tick;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		margin-right: -6px;
		justify-self: end;
		cursor: pointer;
	}
	.filter {
		grid-column: mark / kind;
		height: 26px;
		min-width: 0;
		max-width: 260px;
		margin-left: -2px;
		padding: 0 var(--s2);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		font-size: var(--fs-12);
		letter-spacing: 0;
	}
	.filter::placeholder {
		color: var(--text-3);
	}
	.filter:focus-visible {
		outline-offset: 0;
	}
	.h-kind {
		grid-column: kind;
	}
	/* Each head fills its column, so its box is the column's box; text alignment does the rest. */
	.h-ver {
		grid-column: ver;
		text-align: center;
	}
	.h-size {
		grid-column: size;
		text-align: right;
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
		.filter {
			grid-column: mark / ver;
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
		scroll-snap-align: start;
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
	.item.head + .item :global(.row) {
		box-shadow:
			inset 0 1px 0 var(--line-soft),
			inset 0 -1px 0 var(--line-soft);
	}
	/* Add app sits at the right end of the head row, in the Status column. */
	.add {
		grid-column: status;
		grid-row: 1;
		justify-self: end;
		height: 26px;
		letter-spacing: 0;
		font-size: var(--fs-12);
	}
	.h-status {
		grid-row: 1;
	}
	.plus {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
	}
	.morning-actions {
		display: flex;
		gap: var(--s2);
	}
	.nomatch {
		margin: var(--s5) 20px;
		color: var(--text-2);
	}
	/* The all-fresh morning: one composed block instead of an empty table. */
	.morning {
		display: grid;
		justify-items: start;
		gap: var(--s2);
		padding: var(--s6) 20px var(--s4);
	}
	.morning h2 {
		margin: var(--s1) 0 0;
		font-size: var(--fs-19);
		font-weight: 640;
	}
	.morning p {
		margin: 0 0 var(--s2);
		color: var(--text-2);
	}
</style>
