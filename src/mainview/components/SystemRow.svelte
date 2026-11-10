<script lang="ts">
	import type { SystemRow } from "../../shared/types";
	import { CHIP, SYS } from "../lib/copy";
	import Glyph from "./Glyph.svelte";
	import Versions from "./Versions.svelte";

	let { row }: { row: SystemRow } = $props();

	// Versions reads an app's shape; a system row is always a pending update, so it is drawn as one.
	const shape = $derived({
		status: "ready" as const,
		installed: row.installed,
		latest: row.latest,
		versionless: false,
	});
	const sameBuild = $derived(row.installed !== null && row.installed === row.latest);
</script>

<!-- Read-only: not a button, no tab stop, no tick. The cells sit on the ledger's own columns. -->
<div class="row ledger-cols" data-testid="sys-row-{row.id}">
	<span class="cell tick"></span>
	<div class="hit">
		<span class="cell mark"><Glyph name="leaf" color="var(--text-3)" /></span>
		<span class="cell name">
			<span class="line">
				<span class="tag-name" data-testid="sys-name">{row.name}</span>
				{#if row.running}<span class="chip-use" title={CHIP.running.title} data-testid="sys-chip-running"
						><span class="dot" aria-hidden="true"></span>{CHIP.running.text}</span
					>{/if}
			</span>
		</span>
		<span class="cell kind" class:security={row.type === "security"} data-testid="sys-type">{SYS.type[row.type]}</span>
		<span class="cell ver" data-testid="sys-ver">
			<Versions app={shape} unknown="" note={sameBuild ? SYS.newBuild : null} />
		</span>
		<span class="cell size"></span>
		<span class="cell restore"></span>
		<span class="cell status">
			{#if row.note === "update-manager-only"}<span class="status-text" title={SYS.restartNote} data-testid="sys-note"
					>{SYS.restartNote}</span
				>{/if}
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
		height: 36px;
		padding-right: var(--pad-r);
		box-shadow: inset 0 -1px 0 var(--line-soft);
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
		grid-column: ver;
	}
	.size {
		grid-column: size;
	}
	/* The same inset as an app row's restore cell, so the column's content edge is shared. */
	.restore {
		grid-column: restore;
		padding-left: var(--s3);
	}
	.status {
		grid-column: status;
		display: flex;
		flex-direction: column;
		justify-content: center;
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
	.status-text {
		font-size: var(--fs-12);
		color: var(--text-2);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
