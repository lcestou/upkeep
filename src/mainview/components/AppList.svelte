<script lang="ts">
	import type { AppState } from "../../shared/types";
	import { ADD, COLUMN, TEXT, allFreshLine, emptyLine, noMatch } from "../lib/copy";
	import type { Group, Model } from "../lib/model.svelte";
	import { ms } from "../lib/motion";
	import { shade } from "../lib/shade";
	import type { Attachment } from "svelte/attachments";
	import { flip } from "svelte/animate";
	import AppRow from "./AppRow.svelte";
	import Mark from "./Mark.svelte";
	import RestartAll from "./RestartAll.svelte";
	import SystemGroup from "./SystemGroup.svelte";

	let { model }: { model: Model } = $props();

	type Item = { id: string; group: Group; app?: AppState };

	// Fresh starts folded; the choice lasts for the session. A filter opens it while it is active.
	const FRESH_KEY = "upkeep.freshOpen";
	let freshOpen = $state(readFresh());
	/** The fold state kept for this session; false when storage is blocked. */
	function readFresh(): boolean {
		try {
			return sessionStorage.getItem(FRESH_KEY) === "1";
		} catch {
			return false;
		}
	}
	/** Folds or unfolds Fresh and remembers it; a blocked storage only costs the memory. */
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
	// The header tick describes, and acts on, the ready rows the filter shows.
	const shownTicked = $derived(model.shownReady.filter((a) => model.ticked.has(a.key)).length);
	const all = $derived(model.shownReady.length > 0 && shownTicked === model.shownReady.length);
	const some = $derived(shownTicked > 0 && !all);
	const freshCount = $derived(model.apps.filter((a) => a.status === "fresh").length);

	// One tab stop for the whole list: the open row, else the last focused row, else the first.
	let focusKey = $state<string | null>(null);
	const rowKeys = $derived(items.flatMap((i) => (i.app ? [i.app.key] : [])));
	const tabKey = $derived(
		[model.openKey, focusKey].find((k) => k !== null && rowKeys.includes(k)) ?? rowKeys[0] ?? null,
	);

	let root = $state<HTMLElement | null>(null);

	/** Every drawn row, in screen order, for keyboard moves; empty before the list mounts. */
	function rowButtons(): HTMLElement[] {
		return root ? [...root.querySelectorAll<HTMLElement>("[data-row]")] : [];
	}

	/** List keys: PageUp and PageDown move by a screenful, Space ticks, Enter opens, arrows move, `a` adds, Ctrl+A selects all. An open pane follows the focused row. */
	function onkeydown(e: KeyboardEvent) {
		const target = e.target;
		// PageUp and PageDown move row focus by as many rows as the list shows; elsewhere in the list they scroll a page.
		if ((e.key === "PageDown" || e.key === "PageUp") && root) {
			e.preventDefault();
			const dir = e.key === "PageDown" ? 1 : -1;
			const rows = rowButtons();
			const i = target instanceof HTMLElement ? rows.indexOf(target) : -1;
			if (i < 0) {
				root.scrollBy({ top: dir * root.clientHeight * 0.9 });
				return;
			}
			const page = Math.max(1, Math.floor((root.clientHeight - 34) / 44));
			const next = rows[Math.max(0, Math.min(rows.length - 1, i + dir * page))];
			next?.focus({ preventScroll: true });
			next?.scrollIntoView({ block: "nearest" });
			if (model.openKey && next?.dataset.row) model.select(next.dataset.row);
			return;
		}
		if (!(target instanceof HTMLElement) || !target.dataset.row) return;
		const key = target.dataset.row;
		if (e.key === " ") {
			// Space ticks the focused row; Enter opens it.
			e.preventDefault();
			// During a run the tick joins the run, as a click does; toggle decides.
			if (model.run.phase !== "checking") model.toggle(key);
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
		const to = new Map([["ArrowDown", i + 1], ["ArrowUp", i - 1], ["Home", 0], ["End", rows.length - 1]]).get(e.key);
		if (to === undefined) return;
		e.preventDefault();
		const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
		const nextKey = next?.dataset.row;
		if (!next || !nextKey) return;
		next.focus({ preventScroll: true });
		next.scrollIntoView({ block: "nearest" });
		if (model.openKey) model.select(nextKey);
	}

	/** Remembers the last focused row, so the list keeps one tab stop there. */
	function onfocusin(e: FocusEvent) {
		const key = e.target instanceof HTMLElement ? e.target.dataset.row : undefined;
		if (key) focusKey = key;
	}

	/** Filter field keys: Down enters the list, Enter opens the first match, Escape clears the text first. */
	function onfilterkey(e: KeyboardEvent) {
		const first = rowButtons()[0];
		if (e.key === "ArrowDown" && first) {
			e.preventDefault();
			first.focus({ preventScroll: true });
			first.scrollIntoView({ block: "nearest" });
			return;
		}
		if (e.key === "Enter" && model.filter.trim() && first?.dataset.row) {
			e.preventDefault();
			model.select(first.dataset.row);
			return;
		}
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
			{#if model.apps.length === 0 && model.run.phase === "idle"}
				<section class="morning" data-testid="empty-list">
					<span class="morning-mark"><Mark size={32} /></span>
					<p data-testid="empty-line">{emptyLine()}</p>
					<div class="morning-actions">
						<button type="button" class="btn primary" data-testid="add-app" onclick={() => model.openAdd()}>
							<svg class="plus" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
							{ADD.button}
						</button>
					</div>
				</section>
			{:else if model.allFresh}
				<!-- The header already says Everything is fresh, when it was checked, and Check again. -->
				<section class="morning" data-testid="all-fresh">
					<span class="morning-mark"><Mark size={32} /></span>
					<p data-testid="all-fresh-line">{allFreshLine(freshCount)}</p>
					<div class="morning-actions">
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
							disabled={!idle || model.shownReady.length === 0}
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
					<span class="h-kind" aria-hidden="true" title={COLUMN.kind}>{COLUMN.kind}</span>
					<span class="h-ver" aria-hidden="true" title={COLUMN.version}>{COLUMN.version}</span>
					<span class="h-size" aria-hidden="true" title={COLUMN.size}>{COLUMN.size}</span>
					<span class="h-restore" aria-hidden="true" title={COLUMN.restore}>{COLUMN.restore}</span>
					<span class="h-status" aria-hidden="true" title={COLUMN.status}>{COLUMN.status}</span>
					<button type="button" class="btn small quiet add" data-testid="add-app" onclick={() => model.openAdd()}>
						<svg class="plus" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
						{ADD.button}
					</button>
				</div>
			{/if}

			{#if filtering && model.shown.length === 0 && model.systemShown.length === 0}
				<div class="nomatch">
					<p data-testid="no-match">{noMatch(model.filter.trim())}</p>
					<button
						type="button"
						class="btn small"
						data-testid="clear-filter"
						onclick={() => {
							model.filter = "";
							document.querySelector<HTMLElement>('[data-testid="filter"]')?.focus();
						}}>{TEXT.clearFilter}</button
					>
				</div>
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
						{#if item.group.id === "restart"}<RestartAll apps={item.group.apps} {model} />{/if}
					{/if}
				</div>
			{/each}
			<!-- Read-only, last, and outside the rows the keyboard walks and Select all ticks. -->
			{#if model.extras?.settings.system === "show"}<SystemGroup {model} />{/if}
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
		/* No scroll snap: it pulled a row the keyboard had just brought into view back under the edge.
		   The bottom cover keeps the last visible row whole or absent instead. */
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
		user-select: none;
		-webkit-user-select: none;
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
	/* A heading longer than its column, as some languages write it, is cut with an ellipsis; the title has it whole. */
	.h-kind,
	.h-ver,
	.h-size,
	.h-restore,
	.h-status {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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
		/* An automatic scroll never leaves a heading under the sticky column header. */
		scroll-margin-top: 34px;
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
		display: flex;
		align-items: center;
		gap: var(--s3);
		margin: var(--s5) 20px;
		color: var(--text-2);
	}
	.nomatch p {
		margin: 0;
	}
	/* The all-fresh morning: one composed block instead of an empty table. */
	.morning {
		display: grid;
		justify-items: start;
		gap: var(--s2);
		padding: var(--s6) 20px var(--s4);
	}
	.morning-mark {
		color: var(--leaf);
	}
	.morning p {
		margin: 0 0 var(--s2);
		color: var(--text-2);
	}
</style>
