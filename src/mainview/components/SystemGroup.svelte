<script lang="ts">
	import { PACKAGES_FROM, SYS, glLine, systemAbsent, systemChecked, systemProblem } from "../lib/copy";
	import { relativeTime } from "../lib/format";
	import type { Model } from "../lib/model.svelte";
	import Glyph from "./Glyph.svelte";
	import SystemRow from "./SystemRow.svelte";

	let { model }: { model: Model } = $props();

	// Folded by default, like Fresh; the choice lasts for the session. A filter opens it while it is active.
	const OPEN_KEY = "upkeep.systemOpen";
	let open = $state(readOpen());
	/** The fold state kept for this session; false when storage is blocked. */
	function readOpen(): boolean {
		try {
			return sessionStorage.getItem(OPEN_KEY) === "1";
		} catch {
			return false;
		}
	}
	/** Folds or unfolds the group and remembers it; a blocked storage only costs the memory, not the fold. */
	function toggle() {
		open = !open;
		try {
			sessionStorage.setItem(OPEN_KEY, open ? "1" : "0");
		} catch {
			// Storage can be blocked; the fold still works for this page.
		}
	}
	const shown = $derived(open || model.filter.trim() !== "");

	let now = $state(Date.now());
	$effect(() => {
		const id = setInterval(() => (now = Date.now()), 15_000);
		return () => clearInterval(id);
	});

	const sys = $derived(model.extras?.system ?? null);
	// Only Linux Mint's Update Manager has a window to open; the other package lists are commands.
	const mint = $derived(sys?.packages === "mint");
	const checking = $derived(sys?.phase === "checking");
	const sub = $derived(
		systemChecked(
			checking ? null : sys?.checkedAt ? relativeTime(sys.checkedAt, now) : null,
			checking,
			sys?.packages ? PACKAGES_FROM[sys.packages] : "Flatpak",
		),
	);
	// A tool this system does not have is not a fault: one quiet line, no warning glyph.
	const absent = $derived(sys ? systemAbsent(sys.problem) : null);
	const problem = $derived(sys?.problem && !absent ? systemProblem(sys.problem) : null);
	const gl = $derived(sys?.glMissing ? glLine(sys.glMissing) : null);
	const warning = $derived([problem, gl].filter((s) => s !== null).join(" "));
	const rows = $derived(model.systemShown);
</script>

{#if sys}
	<section class="sys" data-testid="group-system-section">
		<div class="ghead">
			<h2>
				<button
					type="button"
					class="fold"
					aria-expanded={shown}
					data-testid="group-system-toggle"
					onclick={toggle}
				>
					<svg class="chev" class:open={shown} viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"
						><path d="M4.5 2.5 8 6l-3.5 3.5" /></svg
					>
					<span data-testid="group-system">{SYS.group}</span>
					<span class="count mono" data-testid="count-system">{sys.rows.length}</span>
					{#if !shown && warning}<span class="warn" role="img" aria-label={warning} data-testid="system-warn"
							><Glyph name="bang" color="var(--rust)" /></span
						>{/if}
				</button>
			</h2>
			<span class="sub" data-testid="system-checked">{sub}</span>
			{#if mint}<button
					type="button"
					class="btn small quiet tool"
					data-testid="open-update-manager"
					onclick={() => model.send("openTool", { what: "update-manager" })}>{SYS.open}</button
				>{/if}
		</div>
		{#if shown}
			{#if absent}
				<p class="line" data-testid="system-absent">{absent}</p>
			{/if}
			{#if problem}
				<p class="note" data-testid="system-problem"><Glyph name="bang" color="var(--rust)" />{problem}</p>
			{/if}
			{#if gl}
				<p class="note" data-testid="system-gl"><Glyph name="bang" color="var(--rust)" />{gl}</p>
			{/if}
			{#if checking && sys.rows.length === 0}
				<p class="line" data-testid="system-checking"><Glyph name="dot" color="var(--dot)" />{SYS.checking}</p>
			{:else if !checking && sys.rows.length === 0 && !problem}
				<p class="line" data-testid="system-none">{SYS.none}</p>
			{/if}
			{#each rows as row (row.id)}
				<SystemRow {row} />
			{/each}
		{/if}
	</section>
{/if}

<style>
	.ghead {
		display: flex;
		align-items: baseline;
		gap: var(--s2);
		height: 44px;
		padding: var(--s5) var(--pad-r) 0 20px;
		scroll-margin-top: 34px;
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
	.warn {
		align-self: center;
		display: inline-flex;
	}
	.sub {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-12);
		color: var(--text-3);
	}
	.tool {
		flex: none;
		margin-left: auto;
		height: 26px;
		letter-spacing: 0;
		font-size: var(--fs-12);
	}
	.note,
	.line {
		display: flex;
		align-items: flex-start;
		gap: var(--s2);
		margin: 0;
		/* The glyph sits in the rows' glyph column: past the tick track, the gap, and centred in its 20 px. */
		padding: var(--s2) var(--pad-r) var(--s2) calc(32px + var(--gap) + 2px);
		font-size: var(--fs-12);
		line-height: 16px;
	}
	.note {
		color: oklch(0.84 0.08 48);
	}
	.line {
		align-items: center;
		color: var(--text-2);
	}
	.note :global(.glyph),
	.line :global(.glyph) {
		flex: none;
	}
</style>
