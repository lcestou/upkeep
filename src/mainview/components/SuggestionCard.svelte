<script lang="ts">
	import { say } from "../lib/engine-say";
	import type { AppSpec, Suggestion } from "../../shared/types";
	import { ADD, KIND_LABEL, TEXT, aboutManifest } from "../lib/copy";

	let {
		suggestion,
		busy = false,
		failure = null,
		onadd,
		onasset,
		onmanifest,
	}: {
		suggestion: Suggestion;
		busy?: boolean;
		/** The engine's reason when adding this one failed. */
		failure?: string | null;
		onadd: (spec: AppSpec) => void;
		onasset: (asset: string) => void;
		/** Opens apps.toml, offered when writing it failed. */
		onmanifest?: () => void;
	} = $props();

	// Editable copies; the card is keyed by its suggestion, so a new suggestion starts fresh.
	// svelte-ignore state_referenced_locally
	let name = $state(suggestion.spec.name);
	// svelte-ignore state_referenced_locally
	let dest = $state(suggestion.spec.dest ?? "");

	const s = $derived(suggestion);
	const guess = $derived(s.confidence === "guess");
	const options = $derived(s.asset ? [s.asset.name, ...s.alternatives] : s.alternatives);
	const key = $derived(s.spec.key);
	// A table with commands of its own (a self-updating tool, a source build) says what it will run before it is added.
	const runs = $derived(s.spec.update?.join(" ") ?? s.spec.build?.join(" && ") ?? null);

	/** Hands the engine the spec with the owner's edits; an emptied name or dest falls back to the suggested one. */
	function add() {
		onadd({ ...s.spec, name: name.trim() || s.spec.name, dest: dest.trim() || s.spec.dest });
	}
</script>

<article class="card" class:guess data-testid="suggestion-{key}">
	{#if guess}<span class="band" aria-hidden="true"></span>{/if}
	<label class="field name-field">
		<span class="sr-only">Name</span>
		<input class="tag-name name" type="text" bind:value={name} data-testid="sug-name" disabled={busy} />
	</label>
	<div class="sub">
		{#if s.spec.repo}<span class="latin">{s.spec.repo}</span>{/if}
		<span class="kind">{KIND_LABEL[s.spec.kind]}</span>
	</div>

	{#if s.asset || options.length > 0}
		<div class="fact stacked">
			<span class="dt">{ADD.asset}</span>
			{#if s.alternatives.length > 0}
				<select
					class="mono"
					data-testid="sug-asset"
					aria-label={ADD.asset}
					title={s.asset?.name}
					value={s.asset?.name ?? options[0]}
					disabled={busy}
					onchange={(e) => onasset(e.currentTarget.value)}
				>
					{#each options as option (option)}
						<option value={option}>{option}</option>
					{/each}
				</select>
			{:else if s.asset}
				<span class="mono value">{s.asset.name}</span>
			{/if}
		</div>
	{/if}
	<label class="fact">
		<span class="dt">{ADD.installedAt}</span>
		<input class="mono value input" type="text" bind:value={dest} data-testid="sug-dest" disabled={busy} />
	</label>

	<div class="versions mono">
		<span class="installed">{s.installed ?? ADD.notInstalled}</span>
		<svg class="arrow" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M1.5 6h8.25M7 3.25 9.75 6 7 8.75" /></svg>
		<span class="sr-only">to</span>
		<span class="latest">{s.latest ?? ""}</span>
	</div>

	{#if s.why}
		<p class="why" data-testid="sug-why">
			{#if guess}<svg class="q" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"
					><path d="M5.75 6a2.25 2.25 0 1 1 3.4 1.95c-.7.4-1.15.9-1.15 1.7v.35M8 12.25v.01" /></svg
				>{/if}{say(s.why)}
		</p>
	{/if}

	{#if runs}
		<p class="runs" data-testid="sug-runs">{ADD.runs} <code>{runs}</code></p>
	{/if}

	{#if s.problem || failure}
		<p class="problem" data-testid="sug-problem">{say(failure ?? s.problem)}</p>
		{#if onmanifest && aboutManifest(failure)}<div>
				<button type="button" class="btn small" data-testid="sug-open-manifest" onclick={onmanifest}>{TEXT.openManifest}</button>
			</div>{/if}
	{/if}
	{#if !s.problem}
		<div>
			<button type="button" class="btn primary" data-testid="sug-add" disabled={busy} onclick={add}>{ADD.add}</button>
		</div>
	{/if}
</article>

<style>
	.card {
		position: relative;
		display: grid;
		gap: var(--s2);
		padding: var(--s4) var(--s3) var(--s4) var(--s4);
		border: 1px solid var(--line-soft);
		border-radius: 8px;
		background: var(--raised);
	}
	.band {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 4px;
		border-radius: 8px 0 0 8px;
		background: var(--frost);
	}
	.name {
		width: 100%;
		padding: 2px 4px;
		margin-left: -4px;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text);
		font-size: var(--fs-16);
	}
	.name:hover,
	.name:focus {
		border-color: var(--line);
		background: var(--surface);
	}
	.sub {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s1) var(--s2);
		align-items: baseline;
	}
	.kind,
	.dt {
		font-size: var(--fs-12);
		color: var(--text-3);
	}
	.fact {
		display: grid;
		grid-template-columns: 88px minmax(0, 1fr);
		gap: var(--s3);
		align-items: center;
	}
	/* The asset name is long and must read whole: it takes the card's full width under its label. */
	.fact.stacked {
		grid-template-columns: minmax(0, 1fr);
		gap: var(--s1);
	}
	.stacked select,
	.stacked .value {
		font-size: 0.65625rem;
		font-stretch: 75%;
		letter-spacing: -0.02em;
		width: 100%;
	}
	.stacked select {
		padding: 0 4px;
	}
	.value {
		min-width: 0;
		color: var(--text-2);
		overflow-wrap: anywhere;
	}
	.input,
	select {
		height: 28px;
		padding: 0 var(--s2);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--text);
		font-size: var(--fs-12);
		min-width: 0;
	}
	.versions {
		display: grid;
		grid-template-columns: auto 20px auto;
		justify-content: start;
		align-items: center;
		gap: 0;
		font-size: var(--fs-13);
		padding-left: 0;
	}
	.installed {
		color: var(--text-3);
		font-family: var(--sans);
		font-size: var(--fs-12);
	}
	.versions .installed:not(:empty) {
		font-family: inherit;
	}
	.arrow {
		justify-self: center;
		fill: none;
		stroke: var(--text-3);
		stroke-width: 1.4;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.runs {
		margin: 0;
		font-size: var(--fs-12);
		color: var(--text-2);
		overflow-wrap: anywhere;
	}
	.runs code {
		font-family: var(--mono);
		color: var(--text);
	}
	.why {
		margin: 0;
		font-size: var(--fs-12);
		line-height: 1.5;
		color: var(--text-2);
		max-width: 62ch;
	}
	.q {
		vertical-align: -2px;
		margin-right: 4px;
		fill: none;
		stroke: var(--frost);
		stroke-width: 1.6;
		stroke-linecap: round;
	}
	.problem {
		margin: 0;
		font-size: var(--fs-12);
		color: var(--fail);
	}
</style>
