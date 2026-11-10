<script lang="ts">
	import type { AppState } from "../../shared/types";
	import {
		CHIP,
		COLUMN,
		KIND_LABEL,
		NO_RESTORE,
		TEXT,
		releasedLabel,
		restoreLabel,
		restoredText,
		skipLabel,
		statusText,
		stopSkipLabel,
	} from "../lib/copy";
	import { clockTime, formatBytes, relativeTime } from "../lib/format";
	import type { Model } from "../lib/model.svelte";
	import { type Inline, parseNotes } from "../lib/notes";
	import { CARE, glyphColor } from "../lib/state";
	import Glyph from "./Glyph.svelte";
	import Stem from "./Stem.svelte";
	import Versions from "./Versions.svelte";
	import { tick } from "svelte";

	let { app, model, onclose }: { app: AppState; model: Model; onclose: () => void } = $props();

	let copied = $state(false);
	let restoreNote = $state<string | null>(null);
	let busy = $state(false);
	let resultEl = $state<HTMLElement | null>(null);

	const inRun = $derived(model.run.phase === "installing");
	const pending = $derived(app.latest !== null && app.latest !== app.installed && !app.versionless);
	const lines = $derived(model.log.filter((l) => l.key === app.key));
	const care = $derived(CARE[app.status]);
	const failed = $derived(app.status === "failed" || app.status === "rolled_back");
	const from = $derived(model.run.results.find((r) => r.key === app.key)?.from ?? null);
	const chip = $derived(app.kind === "legacy" ? CHIP.runningLegacy : CHIP.running);
	const notes = $derived(app.notes ? parseNotes(app.notes) : []);

	async function retryOne() {
		await model.install([app.key]);
		// The Retry button leaves with the failure; keep focus inside the pane.
		document.querySelector<HTMLElement>('[data-testid="inspector-close"]')?.focus();
	}

	async function copyCommand(text: string) {
		const res = await model.request("copy", { text });
		if (!res.ok) return;
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}

	async function restore(version: string) {
		busy = true;
		const res = await model.request("restore", { key: app.key, version });
		busy = false;
		restoreNote = res.ok ? restoredText(version) : (res.detail ?? null);
		// The Restore button for the now-installed version goes away; keep focus on the result it produced.
		await tick();
		resultEl?.focus();
		// The row moves to Held back; bring it into view so the open row stays in sight.
		document.querySelector(`[data-row="${CSS.escape(app.key)}"]`)?.scrollIntoView({ block: "nearest" });
	}
</script>

{#snippet runs(parts: Inline[])}
	{#each parts as part, i (i)}
		{#if part.t === "code"}<code class="mono inl">{part.s}</code>{:else if part.t === "bold"}<strong>{part.s}</strong
			>{:else if part.t === "url"}
			{#if part.s === app.releaseUrl}
				<button type="button" class="url linkish" onclick={() => model.request("open", { what: "release", key: app.key })}
					>{part.s}</button
				>
			{:else}<span class="url">{part.s}</span>{/if}
		{:else}{part.s}{/if}
	{/each}
{/snippet}

<section class="detail" id="detail-{app.key}" data-testid="detail-{app.key}" aria-labelledby="pane-name-{app.key}">
	<header class="head">
		<div class="name-line">
			<Glyph name={care.glyph} color={glyphColor(app.status)} />
			<h2 class="tag-name" id="pane-name-{app.key}">{app.name}</h2>
			<!-- Docked: a close cross. As a sheet under 900 px: Back to list, first in the header. -->
			<button type="button" class="close btn small" data-testid="inspector-close" onclick={onclose}>
				<svg class="x" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
				<svg class="back" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
				<span class="backtext">{TEXT.backToList}</span>
			</button>
		</div>
		<div class="sub">
			{#if app.repo}<span class="latin">{app.repo}</span>{/if}
			<span class="kind">{KIND_LABEL[app.kind]}</span>
			{#if app.running}<span class="chip-use" title={chip.title}><span class="dot" aria-hidden="true"></span>{chip.text}</span
				>{/if}
			{#if app.sudo}<span class="chip" title={CHIP.root.title}>{CHIP.root.text}</span>{/if}
			{#if app.auto}<span class="chip" title={CHIP.auto.title}>{CHIP.auto.text}</span>{/if}
		</div>
		<div class="state">
			<Versions {app} {from} />
			<span class="pane-status s-{app.status}" data-testid="pane-status">{statusText(app)}</span>
		</div>
		{#if app.status === "working" || app.status === "done"}
			<div class="stem"><Stem {app} caption={false} /></div>
		{/if}
		{#if app.detail}<p class="sentence" data-testid="pane-detail">{app.detail}</p>{/if}
		{#if failed}
			<div>
				<button
					type="button"
					class="btn"
					data-testid="retry-one"
					disabled={inRun}
					onclick={retryOne}>{TEXT.retry}</button
				>
			</div>
		{/if}
	</header>

	{#if app.kind === "manual" && app.run}
		<div class="block by-hand">
			<span class="label">{TEXT.runItYourself}</span>
			<div class="command-row">
				<code class="mono">{app.run}</code>
				<button type="button" class="btn small" data-testid="copy-{app.key}" onclick={() => app.run && copyCommand(app.run)}
					>{copied ? TEXT.copied : TEXT.copy}</button
				>
			</div>
		</div>
	{/if}

	{#if app.versionless}
		<div class="block">
			<button
				type="button"
				class="btn small"
				aria-disabled={model.run.phase !== "idle"}
				data-testid="run-now-{app.key}"
				onclick={() => model.run.phase === "idle" && model.install([app.key])}>{TEXT.runNow}</button
			>
		</div>
	{/if}

	<div class="block">
		<h3>{TEXT.restorePoints}</h3>
		{#if app.restorePoints.length === 0}
			<p class="none" data-testid="no-restore">{(!app.canRestore && NO_RESTORE[app.kind]) || TEXT.none}</p>
		{:else}
			<ul class="points">
				{#each app.restorePoints as point (point.version)}
					<li>
						<span class="mono">{point.version}</span>
						<span class="when">{relativeTime(point.at)}</span>
						{#if app.canRestore && point.version !== app.installed}
							<button
								type="button"
								class="btn small"
								disabled={inRun || busy}
								data-testid="restore-{app.key}-{point.version}"
								onclick={() => restore(point.version)}>{restoreLabel(point.version)}</button
							>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		<span class="result" role="status" tabindex="-1" bind:this={resultEl} data-testid="restore-result"
			>{restoreNote ?? ""}</span
		>
	</div>

	{#if app.kind !== "manual"}
		<div class="actions">
			{#if app.skipped || (pending && app.latest)}
				<button
					type="button"
					class="btn small"
					disabled={inRun}
					data-testid="skip-{app.key}"
					onclick={() => model.request("setSkip", { key: app.key, version: app.skipped ? null : app.latest })}
					>{app.skipped ? stopSkipLabel(app.skipped) : skipLabel(app.latest ?? "")}</button
				>
			{/if}
			<button
				type="button"
				class="btn small"
				disabled={inRun}
				data-testid="hold-{app.key}"
				onclick={() => model.request("setHold", { key: app.key, held: !app.held })}
				>{app.held ? TEXT.releaseHold : TEXT.holdUpdates}</button
			>
			<label class="auto">
				<input
					type="checkbox"
					checked={app.auto}
					data-testid="auto-{app.key}"
					onchange={(e) => model.request("setAuto", { key: app.key, auto: e.currentTarget.checked })}
				/>
				{TEXT.installAuto}
			</label>
			{#if app.releaseUrl}
				<button
					type="button"
					class="btn small"
					data-testid="release-{app.key}"
					onclick={() => model.request("open", { what: "release", key: app.key })}
				>
					{TEXT.openRelease}
					<svg class="ext" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"
						><path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v3.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-8a.5.5 0 0 1 .5-.5H7" /></svg
					>
				</button>
			{/if}
		</div>
	{/if}

	{#if pending || app.notes}
		<div class="block">
			<h3>{TEXT.whatChanged}</h3>
			{#if app.publishedAt}<span class="released">{releasedLabel(relativeTime(app.publishedAt))}</span>{/if}
			{#if notes.length > 0}
				<div class="notes" data-testid="notes">
					{#each notes as block, b (b)}
						{#if block.t === "list"}
							<ul>
								{#each block.items as item, i (i)}
									<li>{@render runs(item)}</li>
								{/each}
							</ul>
						{:else if block.t === "heading"}
							<p class="nh">{@render runs(block.inline)}</p>
						{:else}
							<p>{@render runs(block.inline)}</p>
						{/if}
					{/each}
				</div>
			{:else}
				<p class="none">{TEXT.noNotes}</p>
			{/if}
		</div>
	{/if}

	{#if app.note}<p class="note">{app.note}</p>{/if}

	<dl class="facts">
		{#if app.dest}
			<div class="fact">
				<dt>{TEXT.installedAt}</dt>
				<dd class="mono path" title={app.dest}>{app.dest}</dd>
			</div>
		{/if}
		{#if typeof app.size === "number"}
			<div class="fact">
				<dt>{COLUMN.size}</dt>
				<dd class="mono">{formatBytes(app.size)}</dd>
			</div>
		{/if}
	</dl>

	<div class="block">
		<h3>{TEXT.logTitle}</h3>
		{#if lines.length === 0}
			<p class="none">{TEXT.noLog}</p>
		{:else}
			<ol class="lines mono" data-testid="pane-log">
				{#each lines.slice(-40) as line, i (i)}
					<li><time>{clockTime(line.at)}</time> {line.text}</li>
				{/each}
			</ol>
		{/if}
	</div>
</section>

<style>
	.detail {
		display: flex;
		flex-direction: column;
		gap: var(--s5);
		padding: 0 var(--s5) var(--s6);
	}
	.head {
		position: relative;
		display: grid;
		gap: var(--s2);
		padding: var(--s4) 0;
		border-bottom: 1px solid var(--line-soft);
	}
	.name-line {
		display: flex;
		align-items: center;
		gap: var(--s2);
		min-width: 0;
	}
	h2.tag-name {
		flex: 1;
		min-width: 0;
		margin: 0;
		font-size: var(--fs-19);
		line-height: 1.1;
		overflow-wrap: anywhere;
	}
	.close {
		flex: none;
		min-width: 28px;
		height: 28px;
		padding: 0 6px;
	}
	.back,
	.backtext {
		display: none;
	}
	@media (max-width: 899px) {
		.close {
			order: -1;
			margin-right: var(--s2);
			padding: 0 var(--s3) 0 var(--s2);
		}
		.x {
			display: none;
		}
		.back,
		.backtext {
			display: inline;
		}
	}
	@media (min-width: 900px) {
		/* The words stay as the button's name when only the cross shows. */
		.backtext {
			display: inline;
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip: rect(0, 0, 0, 0);
			white-space: nowrap;
		}
	}
	.chip-use {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: var(--fs-11);
		font-weight: 540;
		color: var(--text-2);
		cursor: help;
	}
	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--text-2);
	}
	.notes {
		display: grid;
		gap: var(--s2);
		max-width: 68ch;
		line-height: 1.5;
		color: var(--text);
		overflow-wrap: anywhere;
	}
	.notes ul {
		margin: 0;
		padding-left: 1.2em;
	}
	.notes .nh {
		font-weight: 640;
		margin-top: var(--s1);
	}
	.inl {
		font-size: 0.92em;
		padding: 0 3px;
		border-radius: 3px;
		background: var(--ground);
	}
	.url {
		color: var(--water);
		overflow-wrap: anywhere;
	}
	.linkish {
		padding: 0;
		border: 0;
		background: none;
		font: inherit;
		text-align: left;
		text-decoration: underline;
		text-underline-offset: 2px;
		cursor: pointer;
	}
	.close svg,
	.ext {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.sub,
	.state,
	.stem,
	.sentence,
	.head > div:last-child:has(.btn) {
		padding-left: 24px;
	}
	.sub {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: var(--s1) var(--s2);
	}
	.kind {
		font-size: var(--fs-12);
		color: var(--text-3);
	}
	.state {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--s1) var(--s3);
		margin-top: var(--s1);
	}
	.state :global(.versions) {
		flex: none;
		font-size: var(--fs-14);
		grid-template-columns: auto 24px auto;
	}
	.pane-status {
		font-weight: 560;
		color: var(--text-2);
		white-space: nowrap;
	}
	.pane-status.s-ready,
	.pane-status.s-queued {
		color: var(--sun);
	}
	.pane-status.s-working {
		color: var(--water);
	}
	.pane-status.s-done,
	.pane-status.s-fresh {
		color: var(--leaf);
	}
	.pane-status.s-manual {
		color: var(--bloom);
	}
	.pane-status.s-problem {
		color: var(--rust);
	}
	.pane-status.s-failed,
	.pane-status.s-rolled_back {
		color: var(--fail);
	}
	.sentence {
		margin: 0;
		color: oklch(0.82 0.09 48);
	}
	.head > div:last-child:has(.btn) {
		padding-left: 24px;
	}
	p {
		margin: 0;
	}
	.block {
		display: grid;
		gap: var(--s2);
	}
	h3 {
		margin: 0;
		font-size: var(--fs-12);
		font-weight: 620;
		color: var(--text-2);
	}
	.released {
		font-size: var(--fs-12);
		color: var(--text-3);
	}
	.note {
		color: var(--text-2);
		max-width: 60ch;
	}
	.none {
		color: var(--text-3);
		font-size: var(--fs-12);
	}
	.label {
		font-size: var(--fs-12);
		color: var(--text-2);
	}
	.command-row {
		display: flex;
		align-items: center;
		gap: var(--s2);
		min-width: 0;
	}
	code {
		min-width: 0;
		padding: 5px var(--s2);
		border-radius: var(--radius-sm);
		background: var(--ground);
		border: 1px solid var(--line-soft);
		color: var(--text);
		overflow-wrap: anywhere;
	}
	.points {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--s2);
	}
	.points li {
		display: flex;
		align-items: center;
		gap: var(--s2);
		flex-wrap: wrap;
	}
	.when {
		font-size: var(--fs-12);
		color: var(--text-3);
	}
	.result {
		font-size: var(--fs-12);
		color: var(--leaf);
	}
	.result:empty {
		display: none;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s2);
	}
	.auto {
		display: inline-flex;
		align-items: center;
		gap: var(--s2);
		min-height: 28px;
		padding: 0 var(--s1);
		font-size: var(--fs-12);
		color: var(--text-2);
		cursor: pointer;
	}
	.facts {
		margin: 0;
		display: grid;
		gap: var(--s2);
	}
	.fact {
		display: grid;
		grid-template-columns: 96px minmax(0, 1fr);
		gap: var(--s3);
		align-items: baseline;
	}
	dt {
		font-size: var(--fs-12);
		color: var(--text-3);
	}
	dd {
		margin: 0;
		min-width: 0;
		color: var(--text-2);
	}
	.path {
		overflow-wrap: anywhere;
	}
	.lines {
		list-style: none;
		margin: 0;
		padding: var(--s2) var(--s3);
		border-radius: var(--radius);
		background: var(--ground);
		border: 1px solid var(--line-soft);
		font-size: var(--fs-11);
		line-height: 1.6;
		color: var(--text-2);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	time {
		color: var(--text-3);
	}
</style>
