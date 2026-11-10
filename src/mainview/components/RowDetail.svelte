<script lang="ts">
	import type { AppState } from "../../shared/types";
	import {
		CHIP,
		COLUMN,
		KIND_LABEL,
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
	import { CARE, glyphColor } from "../lib/state";
	import Glyph from "./Glyph.svelte";
	import Versions from "./Versions.svelte";

	let { app, model, pane = false }: { app: AppState; model: Model; pane?: boolean } = $props();

	let copied = $state(false);
	let restoreNote = $state<string | null>(null);
	let busy = $state(false);

	const inRun = $derived(model.run.phase === "installing");
	const pending = $derived(app.latest !== null && app.latest !== app.installed && !app.versionless);
	const lines = $derived(pane ? model.log.filter((l) => l.key === app.key) : []);
	const care = $derived(CARE[app.status]);

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
	}
</script>

<section class="detail" class:pane id="detail-{app.key}" data-testid="detail-{app.key}" aria-label={app.name}>
	{#if pane}
		<header class="head" style:--band={care.band}>
			<span class="band" aria-hidden="true"></span>
			<div class="title">
				<div class="name-line">
					<Glyph name={care.glyph} color={glyphColor(app.status)} />
					<h2 class="tag-name">{app.name}</h2>
				</div>
				<div class="sub">
					{#if app.repo}<span class="latin">{app.repo}</span>{/if}
					<span class="kind">{KIND_LABEL[app.kind]}</span>
					{#if app.running}<span class="chip running" title={CHIP.running.title}>{CHIP.running.text}</span>{/if}
					{#if app.sudo}<span class="chip" title={CHIP.root.title}>{CHIP.root.text}</span>{/if}
					{#if app.auto}<span class="chip" title={CHIP.auto.title}>{CHIP.auto.text}</span>{/if}
				</div>
			</div>
			<div class="pane-versions">
				<Versions {app} from={model.run.results.find((r) => r.key === app.key)?.from ?? null} />
				<span class="pane-status s-{app.status}">{statusText(app)}</span>
			</div>
			{#if app.detail}<p class="sentence">{app.detail}</p>{/if}
		</header>
	{/if}

	<div class="body">
		<div class="story">
			{#if app.note}<p class="note">{app.note}</p>{/if}

			{#if app.kind === "manual" && app.run}
				<div class="by-hand">
					<span class="label">{TEXT.runItYourself}</span>
					<div class="command-row">
						<code class="mono">{app.run}</code>
						<button
							type="button"
							class="btn small"
							data-testid="copy-{app.key}"
							onclick={() => app.run && copyCommand(app.run)}>{copied ? TEXT.copied : TEXT.copy}</button
						>
					</div>
				</div>
			{/if}

			{#if app.versionless}
				<div>
					<button
						type="button"
						class="btn small"
						disabled={model.run.phase !== "idle"}
						data-testid="run-now-{app.key}"
						onclick={() => model.install([app.key])}>{TEXT.runNow}</button
					>
				</div>
			{/if}

			{#if pending || app.notes}
				<div class="changes">
					<h3>{TEXT.whatChanged}</h3>
					{#if app.publishedAt}<span class="released">{releasedLabel(relativeTime(app.publishedAt))}</span>{/if}
					{#if app.notes}
						<p class="notes">{app.notes}</p>
					{:else}
						<p class="empty">{TEXT.noNotes}</p>
					{/if}
				</div>
			{/if}
		</div>

		<div class="facts">
			<dl>
				{#if app.dest}
					<div class="fact">
						<dt>{TEXT.installedAt}</dt>
						<dd class="mono path" title={app.dest}>{app.dest}</dd>
					</div>
				{/if}
				{#if app.repo}
					<div class="fact">
						<dt>{TEXT.source}</dt>
						<dd><span class="latin">{app.repo}</span></dd>
					</div>
				{/if}
				{#if typeof app.size === "number" && pending}
					<div class="fact">
						<dt>{COLUMN.size}</dt>
						<dd class="mono">{formatBytes(app.size)}</dd>
					</div>
				{/if}
				<div class="fact">
					<dt>{TEXT.restorePoints}</dt>
					<dd>
						{#if app.restorePoints.length === 0}
							<span class="none">{TEXT.none}</span>
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
						<span class="result" role="status" data-testid="restore-result">{restoreNote ?? ""}</span>
					</dd>
				</div>
			</dl>
		</div>
	</div>

	<div class="actions">
		{#if app.skipped}
			<button type="button" class="btn small" data-testid="skip-{app.key}" onclick={() => model.request("setSkip", { key: app.key, version: null })}
				>{stopSkipLabel(app.skipped)}</button
			>
		{:else if pending && app.latest && app.kind !== "manual"}
			<button
				type="button"
				class="btn small"
				disabled={inRun}
				data-testid="skip-{app.key}"
				onclick={() => app.latest && model.request("setSkip", { key: app.key, version: app.latest })}>{skipLabel(app.latest)}</button
			>
		{/if}
		{#if app.kind !== "manual"}
			<button
				type="button"
				class="btn small"
				disabled={inRun}
				data-testid="hold-{app.key}"
				onclick={() => model.request("setHold", { key: app.key, held: !app.held })}>{app.held ? TEXT.releaseHold : TEXT.holdUpdates}</button
			>
		{/if}
		{#if app.releaseUrl}
			<button type="button" class="btn small quiet" data-testid="release-{app.key}" onclick={() => model.request("open", { what: "release", key: app.key })}
				>{TEXT.openRelease}</button
			>
		{/if}
		{#if app.kind !== "manual"}
			<label class="auto">
				<input
					type="checkbox"
					checked={app.auto}
					data-testid="auto-{app.key}"
					onchange={(e) => model.request("setAuto", { key: app.key, auto: e.currentTarget.checked })}
				/>
				{TEXT.installAuto}
			</label>
		{/if}
	</div>

	{#if pane}
		<div class="log">
			<h3>{TEXT.log}</h3>
			{#if lines.length === 0}
				<p class="empty">{TEXT.noLog}</p>
			{:else}
				<ol class="lines mono">
					{#each lines.slice(-40) as line, i (i)}
						<li><time>{clockTime(line.at)}</time> {line.text}</li>
					{/each}
				</ol>
			{/if}
		</div>
	{/if}
</section>

<style>
	.detail {
		container-type: inline-size;
		display: flex;
		flex-direction: column;
		gap: var(--s4);
		padding: var(--s3) var(--s4) var(--s4) var(--indent, 76px);
		background: var(--raised);
		border-bottom: 1px solid var(--line-soft);
	}
	.detail.pane {
		padding: 0 var(--s5) var(--s5);
		background: transparent;
		border: 0;
		gap: var(--s5);
	}
	.head {
		position: relative;
		display: grid;
		gap: var(--s3);
		padding: var(--s5) 0 var(--s4) var(--s3);
		border-bottom: 1px solid var(--line-soft);
	}
	.head .band {
		position: absolute;
		left: 0;
		top: var(--s5);
		bottom: var(--s4);
		width: 4px;
		background: var(--band);
	}
	.name-line {
		display: flex;
		align-items: center;
		gap: var(--s2);
	}
	h2.tag-name {
		margin: 0;
		font-size: var(--fs-19);
		line-height: 1.1;
	}
	.sub {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: var(--s2);
		margin-top: var(--s1);
		padding-left: 24px;
	}
	.kind {
		font-size: var(--fs-12);
		color: var(--text-3);
	}
	.pane-versions {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--s1) var(--s3);
		padding-left: 24px;
	}
	.pane-versions :global(.versions) {
		flex: none;
		font-size: var(--fs-14);
		justify-content: start;
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
	.pane-status.s-problem,
	.pane-status.s-failed,
	.pane-status.s-rolled_back {
		color: var(--rust);
	}
	.sentence {
		margin: 0;
		padding-left: 24px;
		color: oklch(0.82 0.09 48);
		font-size: var(--fs-13);
	}
	.body {
		display: grid;
		gap: var(--s4) var(--s6);
		grid-template-columns: 1fr;
	}
	@container (min-width: 600px) {
		.body {
			grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
		}
	}
	.story {
		display: flex;
		flex-direction: column;
		gap: var(--s3);
		min-width: 0;
	}
	p {
		margin: 0;
	}
	.note {
		color: var(--text-2);
		max-width: 60ch;
	}
	h3 {
		margin: 0;
		font-size: var(--fs-12);
		font-weight: 620;
		color: var(--text-2);
	}
	.changes {
		display: grid;
		gap: var(--s1);
	}
	.changes h3 {
		display: inline;
	}
	.released {
		font-size: var(--fs-12);
		color: var(--text-3);
	}
	.notes {
		margin-top: var(--s1);
		white-space: pre-line;
		color: var(--text);
		max-width: 68ch;
		max-height: 9.5em;
		overflow: auto;
		line-height: 1.5;
	}
	.pane .notes {
		max-height: none;
	}
	.empty,
	.none {
		color: var(--text-3);
		font-size: var(--fs-12);
	}
	.by-hand {
		display: grid;
		gap: var(--s1);
	}
	.label {
		font-size: var(--fs-12);
		color: var(--text-2);
	}
	.command-row {
		display: flex;
		align-items: center;
		gap: var(--s2);
	}
	code {
		padding: 5px var(--s2);
		border-radius: var(--radius-sm);
		background: var(--ground);
		border: 1px solid var(--line-soft);
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	dl {
		margin: 0;
		display: grid;
		gap: var(--s3);
	}
	.fact {
		display: grid;
		grid-template-columns: 104px minmax(0, 1fr);
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
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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
		display: block;
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
		margin-left: var(--s2);
		font-size: var(--fs-12);
		color: var(--text-2);
		cursor: pointer;
	}
	.log {
		display: grid;
		gap: var(--s2);
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
		max-height: 168px;
		overflow: auto;
	}
	time {
		color: var(--text-3);
	}
</style>
