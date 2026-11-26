<script lang="ts">
	import type { SystemOutcome, SystemRow } from "../../shared/types";
	import { CHIP, SYS, notInstalledLine } from "../lib/copy";
	import Glyph from "./Glyph.svelte";

	let {
		row,
		can = false,
		ticked = false,
		locked = false,
		onTick = () => {},
		outcome = null,
		note = null,
	}: {
		row: SystemRow;
		/** Upkeep can install this row: it gets a tick box. Never true for a kernel or driver row. */
		can?: boolean;
		ticked?: boolean;
		/** A System install is running: the ticks keep what they show. */
		locked?: boolean;
		/** `range` is true for a Shift-click, which the group spreads to every row since the last one clicked. */
		onTick?: (on: boolean, range: boolean) => void;
		/** Its place in the System install now running. */
		outcome?: SystemOutcome | null;
		/** A note the group words for it, such as which tool installs it. */
		note?: string | null;
	} = $props();

	const spice = $derived(
		row.type === "applet" || row.type === "desklet" || row.type === "extension" || row.type === "theme"
			? SYS.spiceNote[row.type]
			: null,
	);

	const sameBuild = $derived(row.installed !== null && row.installed === row.latest);
	// The whole change, as the cell's title and its accessible name; the drawn parts are hidden from assistive tech.
	const said = $derived(
		row.installed === null
			? notInstalledLine(row.latest)
			: sameBuild
				? `${row.latest} ${SYS.newBuild}`
				: `${row.installed} → ${row.latest}`,
	);
</script>

<!-- Not a button and no pane. A row Upkeep can install has a tick box, its only tab stop; any other row has none.
     The cells sit on the ledger's own columns. -->
<div class="row ledger-cols" data-testid="sys-row-{row.id}">
	<span class="cell tick">
		{#if can}
			<label class="tickhit">
				<input
					type="checkbox"
					checked={ticked}
					disabled={locked}
					aria-labelledby="sys-name-{row.id}"
					data-testid="sys-tick-{row.id}"
					onclick={(e) => onTick(e.currentTarget.checked, e.shiftKey)}
				/>
			</label>
		{/if}
	</span>
	<div class="hit">
		<span class="cell mark"><Glyph name="leaf" color="var(--text-3)" /></span>
		<span class="cell name">
			<span class="line">
				<span class="tag-name" id="sys-name-{row.id}" data-testid="sys-name">{row.name}</span>
				{#if row.running}<span class="chip-use" title={CHIP.running.title} data-testid="sys-chip-running"
						><span class="dot" aria-hidden="true"></span>{CHIP.running.text}</span
					>{/if}
			</span>
		</span>
		<span class="cell kind" class:security={row.type === "security"} data-testid="sys-type">{SYS.type[row.type]}</span>
		<!-- A system row has no size, restore point or status of its own, so the change runs on across those columns:
		     the arrow stays on the version column's arrow line, only the old version may be cut, the new one never is. -->
		<span class="cell ver" title={said} data-testid="sys-ver">
			<span class="sr-only">{said}</span>
			<span class="old mono" class:same={sameBuild} aria-hidden="true" data-testid="sys-old">{sameBuild ? row.latest : (row.installed ?? "")}</span>
			{#if !sameBuild}<svg class="arrow" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"
					><path d="M1.5 6h8.25M7 3.25 9.75 6 7 8.75" /></svg
				>{/if}
			<span class="after">
				{#if sameBuild}<span class="quiet" aria-hidden="true" data-testid="sys-newbuild">{SYS.newBuild}</span>
				{:else}<span class="new mono" aria-hidden="true" data-testid="sys-new">{row.latest}</span>{/if}
				{#if outcome}<span class="state" class:working={outcome.status === "working"} data-testid="sys-state"
						>{#if outcome.status === "working"}<Glyph name="dot" color="var(--sun)" />{/if}{SYS.state[outcome.status]}</span
					>
				{:else if row.note === "update-manager-only"}<span class="note" data-testid="sys-note">{SYS.restartNote}</span>
				{:else if row.note === "restart-needed"}<span class="note" data-testid="sys-restart">{SYS.restartNeeded}</span>
				{:else if can && spice}<span class="note" data-testid="sys-note">{spice}</span>
				{:else if note}<span class="note" data-testid="sys-note">{note}</span>{/if}
			</span>
		</span>
	</div>
</div>

<style>
	.row {
		position: relative;
		display: grid;
		grid-template-columns: var(--cols);
		column-gap: var(--gap);
		align-items: center;
		min-height: 36px;
		padding-right: var(--pad-r);
		box-shadow: inset 0 -1px 0 var(--line-soft);
		/* The version column's width in the ledger's column sets (app.css), so the arrow lands on its line. */
		--ver-w: 168px;
	}
	@container list (max-width: 639px) {
		.row {
			--ver-w: 150px;
		}
	}
	.hit {
		grid-column: 2 / -1;
		display: grid;
		grid-template-columns: var(--hit-cols);
		column-gap: var(--gap);
		align-items: center;
		align-self: stretch;
		min-width: 0;
	}
	@container list (max-width: 899px) {
		.kind {
			display: none;
		}
	}
	.cell {
		grid-row: 1;
		min-width: 0;
	}
	.mark {
		grid-column: mark;
		display: flex;
		justify-content: center;
	}
	.name {
		grid-column: name;
	}
	.kind {
		grid-column: kind;
		font-size: var(--fs-12);
		color: var(--text-2);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* Weight, not colour, marks a security update. */
	.kind.security {
		color: var(--text);
		font-weight: 600;
	}
	.ver {
		grid-column: ver / end;
		display: grid;
		grid-template-columns: calc(var(--ver-w) / 2 - 10px) 20px minmax(0, 1fr);
		align-items: center;
		padding: 4px 0;
	}
	.old {
		grid-column: 1;
		justify-self: end;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-3);
	}
	.old.same {
		color: var(--text-2);
	}
	.arrow {
		grid-column: 2;
		justify-self: center;
		fill: none;
		stroke: var(--text-3);
		stroke-width: 1.4;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	/* The new version, then the note after the normal gap; the note wraps under it when both do not fit. */
	.after {
		grid-column: 3;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		column-gap: var(--s4);
		row-gap: 2px;
		min-width: 0;
	}
	.new {
		flex: none;
		white-space: nowrap;
		color: var(--text);
		font-variation-settings: "wght" 380;
	}
	.quiet {
		padding-left: 6px;
		font-size: var(--fs-12);
		color: var(--text-3);
		white-space: nowrap;
	}
	.note {
		font-size: var(--fs-12);
		color: var(--text-2);
	}
	.state {
		display: inline-flex;
		align-items: center;
		gap: var(--s2);
		font-size: var(--fs-12);
		color: var(--text-2);
		white-space: nowrap;
	}
	.state.working {
		color: var(--text);
	}
	.tick {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		align-self: stretch;
	}
	.tickhit {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		margin-right: -6px;
		cursor: pointer;
	}
	.line {
		display: flex;
		align-items: center;
		column-gap: var(--s2);
		height: 18px;
		overflow: hidden;
		min-width: 0;
	}
	.tag-name {
		flex: 0 1 auto;
		min-width: 0;
		line-height: 18px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 560;
		color: var(--text-2);
	}
	.chip-use {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 5px;
		height: 18px;
		font-size: var(--fs-11);
		font-weight: 540;
		color: var(--text-2);
		white-space: nowrap;
		cursor: help;
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--text-2);
	}
</style>
