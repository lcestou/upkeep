<script lang="ts">
	import { tick } from "svelte";
	import type { CleanupItem, CleanupPick } from "../../shared/types";
	import {
		CLEAN,
		copiesLine,
		deleteLabel,
		finalLine,
		freedLine,
		kernelsLine,
		measuredLine,
		reviewLabel,
		snapshotsLine,
		totalLine,
		typeLabel,
	} from "../lib/copy";
	import { say } from "../lib/engine-say";
	import { formatBytes, relativeTime } from "../lib/format";
	import type { Model } from "../lib/model.svelte";
	import Glyph from "./Glyph.svelte";

	let { model }: { model: Model } = $props();

	/** The word typed before packages are removed: the engine checks the same one (cleanup.ts TYPE_WORD). Never translated. */
	const WORD = "remove";
	const GROUPS = ["safe", "choice", "shown"] as const;

	const cl = $derived(model.extras?.cleanup ?? null);
	const items = $derived(cl?.items ?? []);
	const measuring = $derived(cl?.phase === "measuring");
	const cleaning = $derived(cl?.phase === "cleaning");

	// The first look at the tab measures; after that only Measure again does.
	$effect(() => {
		if (cl?.phase === "idle" && cl.measuredAt === null) void model.send("cleanupMeasure", {});
	});

	// The person's own ticks over each part's default, for the measure they were made on: a new measure starts fresh.
	let ticks = $state.raw<{ at: string | null; on: ReadonlyMap<string, boolean> }>({ at: null, on: new Map() });
	const own = $derived(ticks.at === (cl?.measuredAt ?? null) ? ticks.on : new Map<string, boolean>());
	/** A part's key in the tick map; a newline cannot occur in an item id. */
	const keyOf = (id: string, part: string) => `${id}\n${part}`;
	/** A part's tick: the person's, else the engine's default for it. */
	const isTicked = (it: CleanupItem, p: CleanupItem["parts"][number]) => own.get(keyOf(it.id, p.id)) ?? p.ticked;
	/** Sets the ticks of these parts in one new map, since a mutation of plain state would not notify. */
	function setTicks(it: CleanupItem, partIds: string[], on: boolean) {
		const next = new Map(own);
		for (const id of partIds) next.set(keyOf(it.id, id), on);
		ticks = { at: cl?.measuredAt ?? null, on: next };
	}

	const picks: CleanupPick[] = $derived(
		items
			.filter((it) => it.group !== "shown")
			.map((it) => ({ id: it.id, partIds: it.parts.filter((p) => isTicked(it, p)).map((p) => p.id) }))
			.filter((p) => p.partIds.length > 0),
	);
	const total = $derived(
		items.reduce((a, it) => a + it.parts.reduce((b, p) => b + (isTicked(it, p) ? p.bytes : 0), 0), 0),
	);

	// The review sheet: what the engine says the picks free and run. Nothing runs until Delete.
	let sheet = $state.raw<{ picks: CleanupPick[]; bytes: number; commands: string[][] } | null>(null);
	let typed = $state("");
	let reason = $state<string | null>(null);
	let backBtn = $state<HTMLButtonElement | null>(null);
	const picked = $derived(sheet ? items.filter((it) => sheet?.picks.some((p) => p.id === it.id)) : []);
	const typing = $derived(picked.some((it) => it.typeToConfirm));
	const final = $derived(picked.filter((it) => it.undo === "none").map((it) => CLEAN.name[it.id]));

	/** Asks the main process what the ticks free and which commands they run, then shows the sheet; nothing runs yet. */
	async function review() {
		reason = null;
		seen = cl?.last?.at ?? null;
		const p = picks;
		const answer = await model.send("cleanupReview", { picks: p });
		if (!answer || answer.reason) {
			reason = answer?.reason ?? null;
			return;
		}
		typed = "";
		sheet = { picks: p, bytes: answer.bytes, commands: answer.commands };
		await tick();
		backBtn?.focus();
	}
	/** Deletes exactly what the sheet showed; the main process refuses it if anything moved meanwhile. */
	async function confirm() {
		const s = sheet;
		sheet = null;
		if (!s) return;
		const answer = await model.send("cleanupRun", { picks: s.picks, commands: s.commands, typed });
		if (!answer?.started) reason = answer?.reason ?? null;
	}

	// A result shows until Done, by the time it started; a new run shows its own.
	let seen = $state<string | null>(null);
	const last = $derived(cl?.last ?? null);
	const fresh = $derived(last !== null && last.at !== seen);
	const refused = $derived(fresh && last?.refused ? last.refused : reason);
	// While cleaning each item says where it is; once done, the summary lists them, since cleaned items leave the list.
	const outcomes = $derived(new Map((cleaning && last ? last.outcomes : []).map((o) => [o.id, o])));
	const finished = $derived(fresh && !cleaning && last !== null && !last.refused && last.outcomes.length > 0);

	/** A shown item's facts, as a sentence; null when it has none. */
	function infoLine(it: CleanupItem): string | null {
		const i = it.info;
		if (!i) return null;
		if (it.id === "kernels" && i.running && i.newest) return kernelsLine(i.running, i.newest);
		if (it.id === "timeshift" && i.count !== undefined && i.newest) return snapshotsLine(i.count, i.newest);
		if (i.count !== undefined) return copiesLine(i.count);
		return null;
	}
	/** Whether an item lists its parts: more than one, or one that is not the whole item. */
	const listsParts = (it: CleanupItem) => it.parts.length > 1 || (it.parts[0] !== undefined && it.parts[0].id !== "all");
</script>

<div class="cleanup" data-testid="cleanup">
	<div class="top">
		<p class="intro" data-testid="cleanup-intro">{CLEAN.intro}</p>
		<p class="measured" data-testid="cleanup-measured">
			{#if measuring}<Glyph name="dot" color="var(--dot)" />{CLEAN.measuring}{:else if cl?.measuredAt}{measuredLine(
					relativeTime(cl.measuredAt),
				)}{:else}{CLEAN.notMeasured}{/if}
		</p>
		<button
			type="button"
			class="btn small"
			data-testid="cleanup-measure"
			disabled={cl?.phase !== "idle" || sheet !== null}
			onclick={() => model.send("cleanupMeasure", {})}>{CLEAN.measure}</button
		>
	</div>

	{#if refused}
		<p class="note" role="status" data-testid="cleanup-refused"><Glyph name="bang" color="var(--rust)" />{say(refused)}</p>
	{/if}

	{#if finished && last}
		<div class="block" role="status" data-testid="cleanup-summary">
			<p class="summary" data-testid="cleanup-freed">
				{freedLine(formatBytes(last.outcomes.reduce((a, o) => a + o.freed, 0)))}
			</p>
			<ul class="picked">
				{#each last.outcomes as o (o.id)}
					<li data-testid="cleanup-result-{o.id}">
						<span class="pname">{CLEAN.name[o.id]}</span>
						<span class="rstate" class:failed={o.status === "failed"} data-testid="cleanup-result-state">{CLEAN.state[o.status]}</span>
						{#if o.status === "done" && o.freed > 0}<span class="mono psize" data-testid="cleanup-result-size">{formatBytes(o.freed)}</span
							>{/if}
						{#if o.detail}<span class="rdetail" data-testid="cleanup-result-detail">{say(o.detail)}</span>{/if}
					</li>
				{/each}
			</ul>
			<button type="button" class="btn small" data-testid="cleanup-dismiss" onclick={() => (seen = last?.at ?? null)}
				>{CLEAN.dismiss}</button
			>
		</div>
	{/if}

	{#if sheet}
		<div class="block" role="group" aria-labelledby="cleanup-review-title" data-testid="cleanup-sheet">
			<h2 id="cleanup-review-title" data-testid="cleanup-review-title">{CLEAN.reviewTitle}</h2>
			<ul class="picked">
				{#each picked as it (it.id)}
					<li data-testid="cleanup-picked-{it.id}">
						<span class="pname">{CLEAN.name[it.id]}</span>
						{#if it.bytes !== null}<span class="mono psize"
								>{formatBytes(it.parts.reduce((a, p) => a + (isTicked(it, p) ? p.bytes : 0), 0))}</span
							>{/if}
					</li>
				{/each}
			</ul>
			<p class="total" data-testid="cleanup-total">{totalLine(formatBytes(sheet.bytes))}</p>
			{#if final.length > 0}<p data-testid="cleanup-final">{finalLine(final)}</p>{/if}
			{#if sheet.commands.length > 0}
				<p>{CLEAN.commands}</p>
				<ol class="cmds" data-testid="cleanup-rootcmds">
					{#each sheet.commands as argv, i (i)}<li><code class="mono" data-testid="cleanup-command">{argv.join(" ")}</code></li>{/each}
				</ol>
			{/if}
			{#if typing}
				<label class="type">
					<span data-testid="cleanup-type-label">{typeLabel(WORD)}</span>
					<input type="text" class="mono" autocomplete="off" spellcheck="false" data-testid="cleanup-type" bind:value={typed} />
				</label>
			{/if}
			<div class="buttons">
				<button
					type="button"
					class="btn small danger"
					data-testid="cleanup-confirm"
					disabled={typing && typed.trim() !== WORD}
					onclick={confirm}>{deleteLabel(formatBytes(sheet.bytes))}</button
				>
				<button type="button" class="btn small" data-testid="cleanup-back" bind:this={backBtn} onclick={() => (sheet = null)}
					>{CLEAN.back}</button
				>
			</div>
		</div>
	{/if}

	{#if cl?.measuredAt && !measuring && items.length === 0}
		<p class="empty" data-testid="cleanup-empty">{CLEAN.nothing}</p>
	{/if}

	{#each GROUPS as g (g)}
		{@const list = items.filter((it) => it.group === g)}
		{#if list.length > 0}
			<h2 class="group" data-testid="cleanup-group-{g}">{CLEAN.group[g]}</h2>
			<ul class="sheet" inert={sheet !== null || cleaning}>
				{#each list as it (it.id)}
					{@const on = it.parts.filter((p) => isTicked(it, p)).length}
					{@const o = outcomes.get(it.id)}
					<li class="item" data-testid="cleanup-item-{it.id}">
						<div class="head">
							{#if g !== "shown"}
								<input
									type="checkbox"
									aria-label={CLEAN.name[it.id]}
									checked={on === it.parts.length}
									indeterminate={on > 0 && on < it.parts.length}
									data-testid="cleanup-tick-{it.id}"
									onchange={(e) =>
										setTicks(
											it,
											it.parts.map((p) => p.id),
											e.currentTarget.checked,
										)}
								/>
							{/if}
							<span class="name">{CLEAN.name[it.id]}</span>
							{#if it.root}<span class="chip" data-testid="cleanup-root-{it.id}">{CLEAN.root}</span>{/if}
							{#if g !== "shown"}<span class="chip" data-testid="cleanup-undo-{it.id}">{CLEAN.undo[it.undo]}</span>{/if}
							<span class="mono size" data-testid="cleanup-size-{it.id}">{it.bytes === null ? "" : formatBytes(it.bytes)}</span>
						</div>
						<p class="what" data-testid="cleanup-what-{it.id}">{CLEAN.what[it.id]}</p>
						{#if infoLine(it)}<p class="what" data-testid="cleanup-info-{it.id}">{infoLine(it)}</p>{/if}
						{#if it.id === "autoremove" && it.parts[0]}<p class="mono pkgs" data-testid="cleanup-packages">{it.parts[0].label}</p>{/if}
						{#if listsParts(it) && it.id !== "autoremove"}
							<ul class="parts">
								{#each it.parts as p, n (p.id)}
									<li data-testid="cleanup-part-{it.id}-{n}">
										<label>
											<input
												type="checkbox"
												checked={isTicked(it, p)}
												onchange={(e) => setTicks(it, [p.id], e.currentTarget.checked)}
											/>
											<span class="mono plabel">{p.label}</span>
											<span class="mono psize">{formatBytes(p.bytes)}</span>
										</label>
										{#if p.note === "newer-copy"}<span class="pnote" data-testid="cleanup-note-{it.id}-{n}">{CLEAN.newerCopy}</span>{/if}
									</li>
								{/each}
							</ul>
						{/if}
						{#if o}
							<p class="result" data-testid="cleanup-state-{it.id}">{CLEAN.state[o.status]}</p>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{/each}

	{#if items.some((it) => it.group !== "shown")}
		<div class="foot">
			{#if picks.length === 0}<span class="why" data-testid="cleanup-why-review">{CLEAN.tickOne}</span>{/if}
			<button
				type="button"
				class="btn primary"
				data-testid="cleanup-review"
				disabled={picks.length === 0 || cl?.phase !== "idle" || sheet !== null}
				onclick={review}>{reviewLabel(formatBytes(total))}</button
			>
		</div>
	{/if}
</div>

<style>
	.cleanup {
		height: 100%;
		overflow: auto;
		padding: var(--s6) var(--s5);
	}
	.top,
	.block,
	.group,
	.sheet,
	.foot,
	.note,
	.empty {
		max-width: 560px;
		margin-inline: auto;
	}
	.top {
		display: grid;
		grid-template-columns: 1fr auto;
		align-items: center;
		gap: 2px var(--s3);
	}
	.top p {
		margin: 0;
	}
	.intro {
		font-size: var(--fs-14);
		color: var(--text);
	}
	.measured {
		display: flex;
		align-items: center;
		gap: var(--s2);
		grid-row: 2;
		font-size: var(--fs-12);
		color: var(--text-3);
	}
	.top .btn {
		grid-row: 1 / span 2;
		grid-column: 2;
	}
	.group {
		margin-top: var(--s6);
		margin-bottom: var(--s2);
		padding: 0 var(--s1);
		font-size: var(--fs-13);
		font-weight: 640;
		color: var(--text);
	}
	.sheet {
		padding: 0;
		list-style: none;
		border: 1px solid var(--line-soft);
		border-radius: 10px;
		background: var(--surface);
		overflow: hidden;
	}
	.item {
		padding: var(--s3) var(--s4);
		border-bottom: 1px solid var(--line-soft);
	}
	.item:last-child {
		border-bottom: 0;
	}
	.head {
		display: flex;
		align-items: center;
		gap: var(--s2);
		min-height: 28px;
	}
	.name {
		font-size: var(--fs-14);
		color: var(--text);
	}
	.size {
		margin-left: auto;
		font-size: var(--fs-13);
		color: var(--text);
	}
	.what,
	.pkgs,
	.result {
		margin: var(--s1) 0 0;
		font-size: var(--fs-12);
		color: var(--text-2);
	}
	.pkgs {
		overflow-wrap: anywhere;
	}
	.parts {
		display: grid;
		gap: 2px;
		margin: var(--s2) 0 0;
		padding: 0;
		list-style: none;
	}
	.parts label {
		display: flex;
		align-items: center;
		gap: var(--s2);
		min-height: 28px;
		cursor: pointer;
	}
	.plabel {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-12);
		color: var(--text-2);
	}
	.psize {
		margin-left: auto;
		font-size: var(--fs-12);
		color: var(--text-2);
	}
	.pnote {
		display: block;
		padding-left: 24px;
		font-size: var(--fs-12);
		color: oklch(0.84 0.08 48);
	}
	.result {
		color: var(--text);
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
	.block {
		display: flex;
		flex-direction: column;
		gap: var(--s2);
		margin-top: var(--s4);
		padding: var(--s3);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		font-size: var(--fs-13);
		color: var(--text);
	}
	.block p,
	.block h2 {
		margin: 0;
	}
	.block h2 {
		font-size: var(--fs-14);
		font-weight: 640;
	}
	.picked,
	.cmds {
		display: flex;
		flex-direction: column;
		gap: var(--s1);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.picked li {
		display: flex;
		flex-wrap: wrap;
		column-gap: var(--s3);
		font-size: var(--fs-12);
	}
	.pname {
		font-weight: 560;
	}
	.total {
		font-weight: 600;
	}
	.cmds code {
		display: block;
		overflow-wrap: anywhere;
		font-size: var(--fs-12);
	}
	.type {
		display: grid;
		gap: var(--s1);
		font-size: var(--fs-12);
		color: var(--text-2);
	}
	.type input {
		height: 32px;
		max-width: 240px;
		padding: 0 var(--s3);
		border: 1px solid var(--line);
		border-radius: 6px;
		background: var(--ground);
		font-size: var(--fs-12);
		color: var(--text);
	}
	.buttons {
		display: flex;
		gap: var(--s2);
	}
	.block .btn {
		align-self: flex-start;
	}
	.danger {
		border-color: var(--fail);
		color: var(--fail);
	}
	.note {
		display: flex;
		align-items: flex-start;
		gap: var(--s2);
		margin-top: var(--s3);
		font-size: var(--fs-12);
		color: oklch(0.84 0.08 48);
	}
	.empty {
		margin-top: var(--s5);
		font-size: var(--fs-13);
		color: var(--text-2);
	}
	.foot {
		position: sticky;
		bottom: calc(-1 * var(--s6));
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--s3);
		margin-top: var(--s5);
		padding: var(--s3) 0;
		background: var(--ground);
	}
	.why {
		font-size: var(--fs-12);
		color: var(--text-2);
	}
</style>
