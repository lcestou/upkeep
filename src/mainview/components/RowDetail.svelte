<script lang="ts">
	import { isStopNote, say } from "../lib/engine-say";
	import type { AppState, NotesSpan } from "../../shared/types";
	import {
		CHECKED,
		CHIP,
		COLUMN,
		commitsHeading,
		heldAt,
		moreCommits,
		KIND_LABEL,
		olderNotes,
		NO_RESTORE,
		TEXT,
		ADD,
		releasedLabel,
		removeAsk,
		removedNote,
		RESTART,
		restartAsk,
		restartedNote,
		restoreLabel,
		restoredText,
		settlesLine,
		skipLabel,
		quietLine,
		statusText,
		stopSkipLabel,
	} from "../lib/copy";
	import { clockTime, formatBytes, relativeTime } from "../lib/format";
	import type { Model } from "../lib/model.svelte";
	import { type Inline, parseNotes } from "../lib/notes";
	import { CARE, glyphColor } from "../lib/state";
	import { quietOf } from "../lib/quiet";
	import Glyph from "./Glyph.svelte";
	import OtherVersions from "./OtherVersions.svelte";
	import Stem from "./Stem.svelte";
	import Versions from "./Versions.svelte";
	import { tick, untrack } from "svelte";

	let { app, model, onclose }: { app: AppState; model: Model; onclose: () => void } = $props();

	let copied = $state(false);
	let restoreNote = $state<string | null>(null);
	let busy = $state(false);
	let resultEl = $state<HTMLElement | null>(null);

	const inRun = $derived(model.run.phase === "installing");
	const pending = $derived(app.latest !== null && app.latest !== app.installed && !app.versionless);
	const lines = $derived(model.log.filter((l) => l.key === app.key));
	let logEl = $state<HTMLElement | null>(null);
	// Lines that arrive keep the log on its newest one, unless the reader scrolled up to read an older one.
	let pinned = true;
	$effect(() => {
		const el = logEl;
		if (!el) return;
		const onScroll = () => (pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 24);
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	});
	$effect(() => {
		void lines.length;
		const el = logEl;
		if (el && pinned) el.scrollTop = el.scrollHeight;
	});
	const care = $derived(CARE[app.status]);
	// The quiet line with its step's limit, which the row has no room for. Its clock ticks only while the app works.
	let now = $state(Date.now());
	$effect(() => {
		if (app.status !== "working") return;
		now = Date.now();
		const id = setInterval(() => (now = Date.now()), 15_000);
		return () => clearInterval(id);
	});
	const lastLine = $derived(app.status === "working" ? model.log.findLast((l) => l.key === app.key)?.at : undefined);
	const quiet = $derived(quietOf(app, lastLine, now));
	const failed = $derived(app.status === "failed" || app.status === "rolled_back");
	const from = $derived(model.run.results.find((r) => r.key === app.key)?.from ?? null);
	const chip = CHIP.running;
	const notes = $derived(app.notes ? parseNotes(app.notes) : []);
	// The notes of every release skipped over, asked for when the pane opens on a listable app with a newer release, and
	// again only when the installed or latest version or the pre-release switch changes (a row's every event would
	// otherwise ask the forge again).
	const spanOf = $derived(
		app.prerelease !== undefined && pending ? `${app.installed} ${app.latest} ${app.prerelease}` : null,
	);
	let span = $state<NotesSpan | null>(null);
	$effect(() => {
		span = null;
		if (spanOf === null) return;
		const key = untrack(() => app.key);
		let live = true;
		void model.send("releaseNotes", { key }).then((res) => {
			// A forge that cannot be read, or a request that ran out of time, keeps the latest release's notes.
			if (live && res && !res.problem) span = res;
		});
		return () => (live = false);
	});
	// One release alone is the latest's notes, unless older ones were left out: then the pane says so under it.
	const spanned = $derived(
		span && (span.releases.length > 1 || (span.releases.length === 1 && (span.older > 0 || span.more)))
			? span.releases
			: null,
	);
	let asking = $state(false);
	let keepBtn = $state<HTMLButtonElement | null>(null);
	let removeBtn = $state<HTMLButtonElement | null>(null);
	let menuNote = $state<string | null>(null);
	let menuBusy = $state(false);

	/** Asks the engine for the menu entry or its removal; a refusal puts the box back and shows the engine's reason. */
	async function setMenu(box: HTMLInputElement) {
		menuBusy = true;
		menuNote = null;
		const res = await model.send("setMenu", { key: app.key, menu: box.checked });
		menuBusy = false;
		if (res?.ok) return;
		box.checked = app.menu === "on";
		menuNote = res?.detail ?? null;
	}

	/** Opens the remove question and puts focus on Keep, the safe answer. */
	async function ask() {
		asking = true;
		await tick();
		keepBtn?.focus();
	}

	/** Dismisses the remove question and returns focus to the Remove button. */
	async function keep() {
		asking = false;
		await tick();
		removeBtn?.focus();
	}

	/** Escape in the question is Keep, and goes no further, so the pane stays open. */
	function escKeep(e: KeyboardEvent) {
		if (e.key !== "Escape") return;
		e.preventDefault();
		e.stopPropagation();
		void keep();
	}

	/** Removes the app from the list after the question, then focuses the next row (or the one before the last). A refused removal just closes the question. */
	async function remove() {
		const name = app.name;
		// Focus goes to the next row, or the one before when this was the last.
		const rows = [...document.querySelectorAll<HTMLElement>("[data-row]")].map((r) => r.dataset.row);
		const i = rows.indexOf(app.key);
		const next = rows[i + 1] ?? rows[i - 1] ?? null;
		const res = await model.send("removeApp", { key: app.key });
		if (!res?.ok) {
			asking = false;
			return;
		}
		model.flash("notice", removedNote(name));
		await tick();
		await tick();
		const row = next ? document.querySelector<HTMLElement>(`[data-row="${CSS.escape(next)}"]`) : null;
		(row ?? document.querySelector<HTMLElement>('[data-testid="filter"]'))?.focus();
	}

	/** Installs this app alone after a failure, keeping focus in the pane because the Retry button leaves with the failure. */
	async function retryOne() {
		await model.install([app.key]);
		// The Retry button leaves with the failure; keep focus inside the pane.
		document.querySelector<HTMLElement>('[data-testid="inspector-close"]')?.focus();
	}

	/** Copies text through the main process and shows "copied" for two seconds; nothing shows when the copy was refused. */
	async function copyCommand(text: string) {
		const res = await model.send("copy", { text });
		if (!res?.ok) return;
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}

	let askingRestart = $state(false);
	let restarting = $state(false);
	let restartNote = $state<string | null>(null);
	let restartNotNow = $state<HTMLButtonElement | null>(null);

	/** Restart now: a desktop app that would close asks first, with focus on Not now. */
	async function askRestart() {
		if (!app.closes) return restartNow();
		askingRestart = true;
		await tick();
		restartNotNow?.focus();
	}

	/** Restarts the app. Success says so in the notice, since the button leaves with the reminder; a failure stays here. */
	async function restartNow() {
		askingRestart = false;
		restarting = true;
		restartNote = null;
		const name = app.name;
		try {
			const res = await model.send("restartApp", { key: app.key });
			if (res?.ok) model.flash("notice", restartedNote([name]));
			else restartNote = res?.detail ?? null;
		} finally {
			restarting = false;
		}
		// The button leaves with the reminder; keep focus inside the pane.
		await tick();
		if (!restartNote) document.querySelector<HTMLElement>('[data-testid="inspector-close"]')?.focus();
	}

	/** Restores a saved version of this app. The result line is kept (failure text included) and takes focus, and the row is scrolled into view because it moves to Held back. */
	async function restore(version: string) {
		busy = true;
		try {
			const res = await model.send("restore", { key: app.key, version });
			// A request that ran out of time says nothing false; the row catches up through events.
			restoreNote = res === null ? null : res.ok ? restoredText(version) : (res.detail ?? null);
		} finally {
			busy = false;
		}
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
				<button type="button" class="url linkish" onclick={() => model.send("open", { what: "release", key: app.key })}
					>{part.s}</button
				>
			{:else}<span class="url">{part.s}</span>{/if}
		{:else}{part.s}{/if}
	{/each}
{/snippet}

{#snippet body(blocks: ReturnType<typeof parseNotes>)}
	{#each blocks as block, b (b)}
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
{/snippet}

<section class="detail" id="detail-{app.key}" data-testid="detail-{app.key}" aria-labelledby="pane-name-{app.key}">
	{#if model.addedNote?.key === app.key}
		<p class="added" role="status" data-testid="added-note">{model.addedNote.text}</p>
	{/if}
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
		{#if app.detail}<p class="sentence" class:note={isStopNote(app.detail)} data-testid="pane-detail">{say(app.detail)}</p>{/if}
		{#if app.status === "held" && app.settles}
			<p class="sentence" data-testid="settles-line">{settlesLine(app.latest ?? "", app.settles)}</p>
			<div>
				<button
					type="button"
					class="btn small"
					data-testid="install-now-{app.key}"
					disabled={model.run.phase === "checking"}
					onclick={() => model.installNow(app.key)}>{TEXT.installNowAnyway}</button
				>
			</div>
		{/if}
		{#if app.checked}<p class="sentence" data-testid="pane-checked">{CHECKED[app.checked]}</p>{/if}
		{#if app.status === "working" && app.waiting}<p class="sentence note" data-testid="pane-wait">{say(app.waiting)}</p>
		{:else if quiet}<p class="sentence note" data-testid="pane-quiet">{quietLine(quiet.m, quiet.n)}</p>{/if}
		{#if app.held && !app.skipped && app.installed}<p class="sentence" data-testid="held-at">{heldAt(app.installed)}</p>{/if}
		{#if app.restartToApply && app.canRestart}
			<div class="restart-now">
				{#if askingRestart}
					<div class="confirm" role="group" aria-labelledby="restart-ask-{app.key}">
						<p id="restart-ask-{app.key}" data-testid="restart-ask">{restartAsk([app.name])}</p>
						<div class="confirm-buttons">
							<button type="button" class="btn small" data-testid="restart-confirm" onclick={restartNow}>{RESTART.yes}</button>
							<button
								type="button"
								class="btn small"
								data-testid="restart-cancel"
								bind:this={restartNotNow}
								onclick={() => (askingRestart = false)}>{RESTART.notNow}</button
							>
						</div>
					</div>
				{:else}
					<button
						type="button"
						class="btn small"
						data-testid="restart-now-{app.key}"
						disabled={inRun || restarting}
						title={inRun ? ADD.waitRun : undefined}
						onclick={askRestart}>{RESTART.now}</button
					>
				{/if}
				{#if restartNote}<p class="sentence" role="status" data-testid="restart-result">{say(restartNote)}</p>{/if}
			</div>
		{/if}
		{#if failed}
			<div>
				<button
					type="button"
					class="btn"
					data-testid="retry-one"
					disabled={inRun}
					title={inRun ? ADD.waitRun : undefined}
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
				title={model.run.phase !== "idle" ? ADD.waitRun : undefined}
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
						{#if point.config}
							<span class="tag" title={TEXT.withSettingsTitle} data-testid="point-config-{app.key}-{point.version}"
								>{TEXT.withSettings}</span
							>
						{/if}
						{#if app.canRestore && point.version !== app.installed}
							<button
								type="button"
								class="btn small"
								disabled={inRun || busy}
								title={inRun ? ADD.waitRun : undefined}
								data-testid="restore-{app.key}-{point.version}"
								onclick={() => restore(point.version)}>{restoreLabel(point.version)}</button
							>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		<span class="result" role="status" tabindex="-1" bind:this={resultEl} data-testid="restore-result"
			>{say(restoreNote)}</span
		>
	</div>

	{#if app.prerelease !== undefined}
		<OtherVersions {app} {model} />
	{/if}

	{#if app.kind !== "manual"}
		<div class="actions">
			{#if app.skipped || (pending && app.latest)}
				<button
					type="button"
					class="btn small"
					disabled={inRun}
					title={inRun ? ADD.waitRun : undefined}
					data-testid="skip-{app.key}"
					onclick={() => model.send("setSkip", { key: app.key, version: app.skipped ? null : app.latest })}
					>{app.skipped ? stopSkipLabel(app.skipped) : skipLabel(app.latest ?? "")}</button
				>
			{/if}
			<button
				type="button"
				class="btn small"
				disabled={inRun}
					title={inRun ? ADD.waitRun : undefined}
				data-testid="hold-{app.key}"
				onclick={() => model.send("setHold", { key: app.key, held: !app.held })}
				>{app.held ? TEXT.releaseHold : TEXT.holdUpdates}</button
			>
			<label class="auto">
				<input
					type="checkbox"
					checked={app.auto}
					data-testid="auto-{app.key}"
					onchange={async (e) => {
						const box = e.currentTarget;
						const res = await model.send("setAuto", { key: app.key, auto: box.checked });
						// Refused (the app left the list meanwhile): the box goes back to what the engine holds.
						if (!res?.ok) box.checked = app.auto;
					}}
				/>
				{TEXT.installAuto}
			</label>
			{#if app.prerelease !== undefined}
				<label class="auto">
					<input
						type="checkbox"
						checked={app.prerelease}
						data-testid="prerelease-{app.key}"
						onchange={async (e) => {
							const box = e.currentTarget;
							const res = await model.send("setPrerelease", { key: app.key, prerelease: box.checked });
							// Refused: the box goes back to what the engine holds.
							if (!res?.ok) box.checked = app.prerelease === true;
						}}
					/>
					<span data-testid="prerelease-label">{TEXT.followPrerelease}</span>
				</label>
			{/if}
			{#if app.menu === "elsewhere"}
				<span class="menu-note" data-testid="menu-elsewhere-{app.key}">{say(app.menuDetail)}</span>
			{:else if app.menu}
				<label class="auto" data-testid="menu-switch-{app.key}">
					<input
						type="checkbox"
						checked={app.menu === "on"}
						disabled={inRun || menuBusy}
						title={inRun ? ADD.waitRun : undefined}
						data-testid="menu-{app.key}"
						onchange={(e) => setMenu(e.currentTarget)}
					/>
					{TEXT.showInMenu}
				</label>
			{/if}
			{#if menuNote}
				<span class="menu-note" role="status" data-testid="menu-result-{app.key}">{say(menuNote)}</span>
			{/if}
			{#if app.releaseUrl}
				<button
					type="button"
					class="btn small"
					data-testid="release-{app.key}"
					onclick={() => model.send("open", { what: "release", key: app.key })}
				>
					{TEXT.openRelease}
					<svg class="ext" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"
						><path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v3.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-8a.5.5 0 0 1 .5-.5H7" /></svg
					>
				</button>
			{/if}
		</div>
	{/if}

	<div class="remove">
		{#if asking}
			<div class="confirm" role="group" aria-labelledby="remove-ask-{app.key}">
				<p id="remove-ask-{app.key}" data-testid="remove-ask">{removeAsk(app.name)}</p>
				<div class="confirm-buttons">
					<button type="button" class="btn small danger" data-testid="remove-confirm" onkeydown={escKeep} onclick={remove}>{ADD.removeYes}</button>
					<button type="button" class="btn small" data-testid="remove-cancel" bind:this={keepBtn} onkeydown={escKeep} onclick={keep}
						>{ADD.keep}</button
					>
				</div>
			</div>
		{:else}
			<button
				type="button"
				class="btn small quiet"
				data-testid="remove-app"
				bind:this={removeBtn}
				aria-disabled={inRun}
				title={inRun ? ADD.waitRun : undefined}
				onclick={() => !inRun && ask()}>{ADD.remove}</button
			>
		{/if}
	</div>

	{#if pending || app.notes}
		<div class="block">
			<h3>{TEXT.whatChanged}</h3>
			{#if span?.breaking.length}
				<div class="breaking" data-testid="breaking">
					<p class="nh"><Glyph name="bang" color="var(--rust)" /><span data-testid="breaking-heading">{TEXT.breakingChanges}</span></p>
					<ul>
						{#each span.breaking as line, i (i)}
							<li data-testid="breaking-line"><span class="mono">{line.version}</span> {line.line}</li>
						{/each}
					</ul>
					<p class="released" data-testid="breaking-hint">{TEXT.breakingHint}</p>
				</div>
			{/if}
			{#if spanned && span}
				<div class="notes" data-testid="notes">
					{#each spanned as r (r.tag)}
						<h4 class="nv" data-testid="notes-version-{r.version}">
							<span class="mono">{r.version}</span>
							{#if r.publishedAt}<span class="released">{releasedLabel(relativeTime(r.publishedAt))}</span>{/if}
						</h4>
						{#if r.notes}{@render body(parseNotes(r.notes))}{:else}<p class="none">{TEXT.noNotes}</p>{/if}
					{/each}
					{#if span.older > 0}<p class="released" data-testid="notes-older">{olderNotes(span.older)}</p>{/if}
					{#if span.more}<p class="released" data-testid="notes-more">{TEXT.olderNotListed}</p>{/if}
				</div>
			{:else}
				{#if app.publishedAt}<span class="released">{releasedLabel(relativeTime(app.publishedAt))}</span>{/if}
				{#if notes.length > 0}
					<div class="notes" data-testid="notes">{@render body(notes)}</div>
				{:else}
					<p class="none">{TEXT.noNotes}</p>
				{/if}
			{/if}
		</div>
	{/if}

	{#if app.commits?.length}
		<!-- What a built app is behind by, newest first. The list scrolls past twelve lines, so it is a labelled tab stop. -->
		<section class="block commits" data-testid="commits-{app.key}" aria-labelledby="commits-heading-{app.key}">
			<h4 id="commits-heading-{app.key}" data-testid="commits-heading-{app.key}">
				{commitsHeading(app.ahead ?? app.commits.length, app.installed)}
			</h4>
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<ul tabindex="0" aria-labelledby="commits-heading-{app.key}" data-testid="commits-list-{app.key}">
				{#each app.commits as c (c.sha)}
					<li title={c.title} data-testid="commit-{c.sha.slice(0, 9)}"><code>{c.sha.slice(0, 9)}</code> <span class="ct">{c.title}</span></li>
				{/each}
			</ul>
			{#if (app.ahead ?? 0) > app.commits.length}
				<p class="more" data-testid="commits-more-{app.key}">{moreCommits(app.ahead ?? 0, app.commits.length)}</p>
			{/if}
		</section>
	{/if}

	{#if app.note}<p class="note">{app.note}</p>{/if}
	{#each app.also ?? [] as line, i (i)}
		<p class="also" data-testid="detail-also"><Glyph name="bang" color="var(--rust)" />{say(line)}</p>
	{/each}

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
			<!-- A box of its own height that scrolls, so arriving lines never move the pane around it. A scroll box is a tab stop. -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<ol class="lines mono" data-testid="pane-log" tabindex="0" aria-label={TEXT.logTitle} bind:this={logEl}>
				{#each lines.slice(-200) as line (line.id)}
					<li><time>{clockTime(line.at)}</time> {line.text}</li>
				{/each}
			</ol>
		{/if}
	</div>
</section>

<style>
	/* What else keeps the app up to date: the same line as on the Add card. */
	.also {
		display: flex;
		gap: 6px;
		align-items: baseline;
		margin: 0 0 var(--s2);
		font-size: var(--fs-12);
		line-height: 1.5;
		color: var(--text);
		max-width: 62ch;
	}
	.also :global(svg) {
		flex: none;
		transform: translateY(2px);
	}
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
	.added {
		margin: var(--s3) 0 0;
		padding: var(--s2) var(--s3);
		border-radius: var(--radius);
		background: oklch(0.8 0.17 148 / 0.1);
		color: var(--leaf);
		font-size: var(--fs-12);
	}
	.remove {
		display: flex;
	}
	.confirm {
		display: grid;
		gap: var(--s2);
		padding: var(--s3);
		border: 1px solid var(--line);
		border-radius: var(--radius);
	}
	.confirm p {
		color: var(--text);
	}
	.confirm-buttons {
		display: flex;
		gap: var(--s2);
	}
	.danger {
		border-color: var(--fail);
		color: var(--fail);
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
	/* One skipped release's heading: its version, then when it came out. */
	.notes .nv {
		display: flex;
		gap: var(--s2);
		align-items: baseline;
		margin: var(--s2) 0 0;
		font-size: var(--fs-12);
		font-weight: 620;
		color: var(--text-2);
	}
	.notes .nv:first-child {
		margin-top: 0;
	}
	.breaking {
		display: grid;
		gap: var(--s1);
		max-width: 68ch;
		line-height: 1.5;
		overflow-wrap: anywhere;
	}
	.breaking .nh {
		display: flex;
		gap: var(--s1);
		align-items: center;
		margin: 0;
		font-weight: 640;
	}
	.breaking ul {
		margin: 0;
		padding-left: 1.2em;
	}
	.breaking .mono {
		color: var(--text-2);
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
	/* Stop now's own sentences and the quiet line are plain notes, in the row's note colour: stopping is not a failure. */
	.sentence.note {
		color: var(--text-2);
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
	.commits h4 {
		margin: 0;
		font-size: var(--fs-12);
		font-weight: 620;
		color: var(--text-2);
	}
	/* Twelve lines, then the list scrolls; each title takes one line and the ellipsis, with the whole title in title. */
	.commits ul {
		margin: 0;
		padding: 0;
		list-style: none;
		max-height: calc(12 * 22px);
		overflow-y: auto;
		border-radius: var(--radius-sm);
	}
	.commits ul:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.commits li {
		display: flex;
		gap: var(--s2);
		min-width: 0;
		height: 22px;
		align-items: baseline;
		line-height: 22px;
		font-size: var(--fs-12);
		color: var(--text);
	}
	.commits code {
		flex: none;
		font-family: var(--mono);
		color: var(--text-2);
	}
	.commits .ct {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.commits .more {
		margin: 0;
		font-size: var(--fs-12);
		color: var(--text-3);
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
	.tag {
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
	.menu-note {
		font-size: var(--fs-12);
		color: var(--text-2);
		overflow-wrap: anywhere;
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
		max-height: calc(1.6em * 14 + 2 * var(--s2));
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	time {
		color: var(--text-3);
	}
</style>
