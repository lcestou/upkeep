<script lang="ts">
	import {
		SYS,
		systemSources,
		glLine,
		systemAbsent,
		systemChecked,
		systemProblem,
		systemSummary,
		systemToolNote,
	} from "../lib/copy";
	import { say } from "../lib/engine-say";
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
			systemSources(sys?.packages ?? null, sys?.rows ?? []),
		),
	);
	// A tool this system does not have is not a fault: one quiet line, no warning glyph.
	const absent = $derived(sys ? systemAbsent(sys.problem) : null);
	const problem = $derived(sys?.problem && !absent ? systemProblem(sys.problem) : null);
	const gl = $derived(sys?.glMissing ? glLine(sys.glMissing) : null);
	const warning = $derived([problem, gl].filter((s) => s !== null).join(" "));
	const rows = $derived(model.systemShown);

	// Installing: only while its switch is on, and only the rows the main process says Upkeep can install. The ticks
	// live in the model, since the footer's Install takes them.
	const installOn = $derived(model.extras?.settings.systemInstall === true);
	const can = $derived(model.systemCan);
	const installing = $derived(sys?.phase === "installing");
	const install = $derived(sys?.install ?? null);
	// A result is shown until Done, by the time it started; a new install shows its own.
	const fresh = $derived(install !== null && install.at !== model.systemSeen);
	const refused = $derived(fresh && install?.refused ? install.refused : model.systemReason);
	const outcomes = $derived(installing && install ? new Map(install.outcomes.map((o) => [o.id, o])) : new Map());
	const results = $derived(fresh && !installing && install && !install.refused ? install.outcomes : []);
	// A package row Upkeep cannot install (pacman's, or a kernel or driver row from apt, dnf or zypper) names the
	// system's own tool; the rows Upkeep can install carry no such note.
	const toolNote = $derived(
		installOn && sys?.packages && sys.packages !== "mint" ? systemToolNote(sys.packages) : null,
	);
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
			<span class="tools">
				{#if mint}<button
						type="button"
						class="btn small quiet tool"
						data-testid="open-update-manager"
						onclick={() => model.send("openTool", { what: "update-manager" })}>{SYS.open}</button
					>{/if}
			</span>
		</div>
		{#if refused}
			<p class="note" role="status" data-testid="system-refused"><Glyph name="bang" color="var(--rust)" />{say(refused)}</p>
		{/if}
		{#if results.length > 0}
			<div class="results" role="status" data-testid="system-results">
				<p class="summary" data-testid="system-summary">
					{systemSummary(results.filter((o) => o.status === "done").length, results.length)}
				</p>
				<ul>
					{#each results as o (o.id)}
						<li data-testid="sys-result-{o.id}">
							<span class="rname">{o.name}</span>
							<span class="rstate" class:failed={o.status === "failed"} data-testid="sys-result-state">{SYS.state[o.status]}</span>
							{#if o.detail}<span class="rdetail" data-testid="sys-result-detail">{say(o.detail)}</span>{/if}
						</li>
					{/each}
				</ul>
				<button type="button" class="btn small" data-testid="system-dismiss" onclick={() => (model.systemSeen = install?.at ?? null)}
					>{SYS.dismiss}</button
				>
			</div>
		{/if}
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
				<SystemRow
					{row}
					can={installOn && can.has(row.id)}
					ticked={model.systemTicked.has(row.id) || outcomes.has(row.id)}
					locked={installing}
					onTick={(on, range) => model.tickSystem(row.id, on, range)}
					outcome={outcomes.get(row.id) ?? null}
					note={can.has(row.id) ? null : toolNote}
				/>
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
	.tools {
		display: flex;
		flex: none;
		gap: var(--s2);
		margin-left: auto;
	}
	.tool {
		flex: none;
		height: 26px;
		letter-spacing: 0;
		font-size: var(--fs-12);
	}
	.results {
		display: flex;
		flex-direction: column;
		gap: var(--s2);
		margin: var(--s2) var(--pad-r) var(--s2) 20px;
		padding: var(--s3);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		font-size: var(--fs-13);
		color: var(--text);
	}
	.results p {
		margin: 0;
	}
	.results ul {
		display: flex;
		flex-direction: column;
		gap: var(--s1);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.results li {
		display: flex;
		flex-wrap: wrap;
		column-gap: var(--s3);
		font-size: var(--fs-12);
	}
	.rname {
		font-weight: 560;
	}
	.rstate {
		color: var(--text-2);
	}
	.rstate.failed {
		color: var(--fail);
	}
	.rdetail {
		color: var(--text-2);
	}
	.results .btn {
		align-self: flex-start;
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
