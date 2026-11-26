<script lang="ts">
	import { say } from "../lib/engine-say";
	import type { AppState } from "../../shared/types";
	import { CHIP, KIND_LABEL, TEXT, WATCH, quietLine, statusText } from "../lib/copy";
	import { fitLine, fitWords } from "../lib/fit";
	import { formatBytes } from "../lib/format";
	import { IN_RUN, type Model } from "../lib/model.svelte";
	import { ms } from "../lib/motion";
	import { CARE, glyphColor, restoreText } from "../lib/state";
	import { quietOf } from "../lib/quiet";
	import { fade } from "svelte/transition";
	import Glyph from "./Glyph.svelte";
	import Stem from "./Stem.svelte";
	import Versions from "./Versions.svelte";

	let { app, model, tabbable }: { app: AppState; model: Model; tabbable: boolean } = $props();

	const care = $derived(CARE[app.status]);
	const open = $derived(model.openKey === app.key);
	const fresh = $derived(app.status === "fresh");
	const inRun = $derived(model.run.phase === "installing");
	const place = $derived(model.queue.findIndex((a) => a.key === app.key) + 1);
	const from = $derived(model.run.results.find((r) => r.key === app.key)?.from ?? null);
	const restore = $derived(restoreText(app));
	const stemmed = $derived(app.status === "working" || app.status === "done");
	// A ready row may carry why its last try ended; it reads like any reason line.
	const sentence = $derived(
		app.detail && ["problem", "failed", "rolled_back", "stopped", "done", "ready"].includes(app.status) ? say(app.detail) : null,
	);
	// While a row is re-checked it keeps what it showed before: its versions and its (disabled) tick.
	const was = $derived(app.status === "checking" ? model.prior[app.key] : undefined);
	const look = $derived(was ? { ...app, status: was } : app);
	// An app that can keep a restore point but has none yet says so; one that cannot stays blank.
	const canRestore = $derived(app.canRestore);
	const noVersions = $derived(app.installed === null && app.latest === null && !app.versionless);
	// During a run only the working row and a failure burn at full colour; the rest of the run steps back.
	const back = $derived(inRun && (app.status === "queued" || app.status === "done"));
	const chip = CHIP.running;
	const statusWord = $derived(fresh && !app.restartToApply ? "" : statusText(app));
	// The quiet line's clock ticks only while the row works; the newest log line is read only then too.
	let now = $state(Date.now());
	$effect(() => {
		if (app.status !== "working") return;
		now = Date.now();
		const id = setInterval(() => (now = Date.now()), 15_000);
		return () => clearInterval(id);
	});
	const lastLine = $derived(app.status === "working" ? model.log.findLast((l) => l.key === app.key)?.at : undefined);
	const quiet = $derived(quietOf(app, lastLine, now));
	// What a working row waits for after Stop now (an engine sentence), else its quiet line.
	const workLine = $derived(
		// The row has room for the short form only; the pane carries the step's limit too.
		app.status === "working" && app.waiting ? say(app.waiting) : quiet ? quietLine(quiet.m, null) : null,
	);
</script>

<div
	class="row ledger-cols s-{app.status}"
	class:fresh
	class:said={sentence !== null || workLine !== null}
	class:quiet={quiet !== null && !app.waiting && !model.run.stoppingNow}
	class:wide={sentence !== null && noVersions}
	class:open
	class:back
	class:dim={inRun && !IN_RUN.has(app.status)}
	data-testid="row-{app.key}"
	style:--band={care.band}
>
	<span class="band" aria-hidden="true"></span>
	<span class="cell tick">
		{#if app.status === "queued" && place > 0}
			<span class="place mono" data-testid="place-{app.key}">{place}</span>
		{:else if look.status === "ready"}
			<!-- The label widens the hit area past the 16 px box to 28 px; Space on the row ticks it from the keyboard. -->
			<label class="tickhit">
				<input
					type="checkbox"
					tabindex="-1"
					checked={model.ticked.has(app.key)}
					disabled={model.run.phase === "checking" || (model.run.phase === "installing" && model.run.stopping)}
					aria-labelledby="name-{app.key}"
					data-testid="tick-{app.key}"
					onclick={(e) => {
						model.toggle(app.key, e.shiftKey);
						// During a run a tick asks to join instead of ticking: the box shows the model, not the click.
						e.currentTarget.checked = model.ticked.has(app.key);
					}}
				/>
			</label>
		{/if}
	</span>
	<button
		type="button"
		class="hit"
		data-row={app.key}
		tabindex={tabbable ? 0 : -1}
		aria-current={open ? "true" : undefined}
		aria-expanded={open}
		aria-controls="inspector"
		data-testid="open-{app.key}"
		onclick={() => model.select(app.key)}
	>
		<span class="cell mark"><Glyph name={care.glyph} color={glyphColor(app.status)} /></span>
		<span class="cell name">
			<!-- One line: the repo gives way first, then each chip shrinks to its glyph; nothing wraps or is cut. -->
			<span class="line" {@attach fitLine}>
				<span class="tag-name" id="name-{app.key}">{app.name}</span>
				{#if app.watch || app.running || (!fresh && (app.sudo || app.auto || app.security))}
					<span class="chips">
						{#if app.watch}<span class="chip watch" title={WATCH.title} data-testid="chip-watch-{app.key}"
								><svg class="cg" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"
									><path d="M6 2.5v4.25M6 9v.5" /></svg
								><span class="ct">{WATCH.chip[app.watch.sign]}</span></span
							>{/if}
						{#if app.running}<span class="chip-use" title={chip.title} data-testid="chip-running"
								><span class="dot" aria-hidden="true"></span><span class="ct">{chip.text}</span></span
							>{/if}
						{#if app.sudo && !fresh}<span class="chip" title={CHIP.root.title} data-testid="chip-root"
								><svg class="cg lock" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"
									><path d="M3.5 5.5V4a2.5 2.5 0 0 1 5 0v1.5M2.75 5.5h6.5v4.25h-6.5Z" /></svg
								><span class="ct">{CHIP.root.text}</span></span
							>{/if}
						{#if app.security && !fresh}<span class="chip sec" title={CHIP.security.title} data-testid="chip-security"
								><svg class="cg shield" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"
									><path d="M6 1.25 2.25 2.75v3c0 2.4 1.6 4.1 3.75 5 2.15-.9 3.75-2.6 3.75-5v-3Z" /></svg
								><span class="ct">{CHIP.security.text}</span></span
							>{/if}
						{#if app.auto && !fresh}<span class="chip" title={CHIP.auto.title} data-testid="chip-auto"
								><span class="cg auto-tile" aria-hidden="true"></span><span class="ct">{CHIP.auto.text}</span></span
							>{/if}
					</span>
				{/if}
				{#if app.repo}<span class="latin">{app.repo}</span>{/if}
			</span>
			{#if sentence}<span class="sentence" title={sentence} data-testid="sentence-{app.key}">{sentence}</span>{/if}
			{#if workLine}<span class="sentence" title={workLine} data-testid="{app.waiting ? 'wait' : 'quiet'}-{app.key}">{workLine}</span
				>{/if}
		</span>
		<span class="cell kind" title={KIND_LABEL[app.kind]}>{KIND_LABEL[app.kind]}</span>
		<span class="cell ver"><Versions app={look} {from} /></span>
		<span class="cell size mono">{!fresh && typeof app.size === "number" ? formatBytes(app.size) : ""}</span>
		<span class="cell restore">
			{#key restore}
				<span class="restore-in" in:fade={{ duration: ms(240) }}>
					{#if restore}
						<svg class="saved" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"
							><path d="M2.25 6.25 4.75 8.75 9.75 3.5" /></svg
						><span class="mono point" title={restore}>{restore}</span>
					{:else if canRestore}
						<span class="none-yet" data-testid="none-yet-{app.key}">{TEXT.noneYet}</span>
					{:else}
						<span class="sr-only">{TEXT.none}</span>
					{/if}
				</span>
			{/key}
		</span>
		<span class="cell status">
			{#if stemmed}
				<Stem {app} />
			{:else if app.status === "manual" && app.run}
				<span class="sr-only">{app.run}</span>
				<span class="command mono" aria-hidden="true" title={app.run} data-testid="status-{app.key}" {@attach fitWords(app.run)}
				></span>
			{:else}
				<span class="status-text" data-testid="status-{app.key}">{statusWord}</span>
			{/if}
		</span>
		<!-- Always present and absolutely placed, so opening a row never changes the button's set of grid items. -->
		<svg class="marker" class:shown={open} viewBox="0 0 8 14" aria-hidden="true"><path d="M8 0v14L1 7Z" /></svg>
	</button>
	{#if quiet !== null && !app.waiting && !model.run.stoppingNow}
		<!-- Outside the row's own button: a quiet row carries its Stop now where the reason is read. The list stays one
			tab stop; from the keyboard the footer's Stop after this one escalates to Stop now. -->
		<button
			type="button"
			class="btn small row-stop"
			data-testid="stop-now-{app.key}"
			tabindex="-1"
			onclick={() => model.stopNow()}>{TEXT.stopNow}</button
		>
	{/if}
</div>

<style>
	/* Column sets follow the list's own width, so the same rows serve the full ledger and the narrowed one beside the inspector. */
	.row {
		position: relative;
		display: grid;
		grid-template-columns: var(--cols);
		column-gap: var(--gap);
		align-items: center;
		height: 44px;
		padding-right: var(--pad-r);
		background: var(--surface);
		/* The hairline is drawn, not laid out, so the row's height centres its text exactly. */
		box-shadow: inset 0 -1px 0 var(--line-soft);
		/* A focused row clears the sticky column header (34 px) and the covered bottom edge. */
		scroll-margin: 42px 0 8px;
		transition:
			opacity 240ms ease-out,
			background-color 100ms ease-out;
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
	/* A reason at rest may take two lines; a failed row in a run keeps 44 px and one line (the pane has it whole). */
	.row.said {
		height: 56px;
	}
	.row.said.s-failed,
	.row.said.s-rolled_back {
		height: 44px;
	}
	.s-failed .sentence,
	.s-rolled_back .sentence {
		-webkit-line-clamp: 1;
		line-clamp: 1;
	}
	/* A quiet row reads its line and keeps its Stop now under the status, so its cells sit at the top. */
	.row.quiet {
		height: 76px;
	}
	.row.quiet .hit {
		align-items: start;
		padding-top: 10px;
	}
	.row-stop {
		position: absolute;
		right: var(--pad-r);
		bottom: 8px;
	}
	.row.fresh {
		height: 36px;
		background: transparent;
	}
	.row:hover {
		background: var(--raised);
	}
	.row.open {
		background: var(--raised);
	}
	/* 72 percent, and the faintest text steps up a tone so it still measures 4.5:1 once dimmed. */
	.row.dim {
		opacity: 0.72;
		--text-3: var(--text-2);
		--rust: oklch(0.8 0.12 44);
		--bloom: oklch(0.82 0.13 352);
		--frost: oklch(0.84 0.03 250);
	}
	.band {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 4px;
		background: var(--band);
	}
	.fresh .band {
		opacity: 0.3;
	}
	.back .band {
		opacity: 0.4;
	}
	.fresh .mark,
	.back .mark,
	.back .place {
		--glyph: var(--text-3);
		color: var(--text-3);
	}
	.fresh .mark :global(.glyph),
	.back .mark :global(.glyph) {
		color: var(--text-3) !important;
	}
	.back .tag-name {
		color: var(--text-2);
	}
	.back .status-text,
	.back :global(.caption) {
		color: var(--text-3) !important;
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
	.place {
		width: 16px;
		text-align: center;
		font-size: var(--fs-11);
		color: var(--sun);
	}
	.hit {
		position: relative;
		grid-column: 2 / -1;
		display: grid;
		grid-template-columns: var(--hit-cols);
		column-gap: var(--gap);
		align-items: center;
		align-self: stretch;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
		background: none;
		text-align: left;
		cursor: pointer;
	}
	.hit:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: -2px;
		border-radius: var(--radius-sm);
	}
	.marker {
		position: absolute;
		right: calc(-1 * var(--pad-r));
		top: 50%;
		width: 8px;
		height: 14px;
		transform: translateY(-50%);
		fill: var(--text);
		visibility: hidden;
	}
	.marker.shown {
		visibility: visible;
	}
	/* Every cell names its column, so no cell's place depends on which others are shown. */
	.mark {
		grid-column: mark;
	}
	.name {
		grid-column: name;
	}
	.kind {
		grid-column: kind;
		/* A kind longer than its column, as some languages write it, is cut; the title has it whole. */
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ver {
		grid-column: ver;
	}
	.size {
		grid-column: size;
	}
	.restore {
		grid-column: restore;
	}
	.status {
		grid-column: status;
	}
	/* One row: every cell keeps its column, and a reason sits in the name column under the name, never a second row. */
	.cell {
		grid-row: 1;
		min-width: 0;
	}
	.mark {
		display: flex;
		justify-content: center;
	}
	.name {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.line {
		display: flex;
		flex-wrap: nowrap;
		align-items: center;
		column-gap: var(--s2);
		height: 18px;
		overflow: hidden;
		min-width: 0;
	}
	.chips {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: var(--s1);
	}
	.line:global(.no-repo) .latin {
		display: none;
	}
	.cg {
		display: none;
	}
	.line:global(.compact) .ct {
		display: none;
	}
	/* In use and a watch sign keep their words for assistive tech when only the glyph shows. */
	.line:global(.compact) .chip-use .ct,
	.line:global(.compact) .chip.watch .ct {
		display: inline;
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.line:global(.compact) .cg {
		display: inline-block;
	}
	.line:global(.compact) .chip {
		padding: 0 4px;
	}
	/* Last resort, when even glyph chips do not fit: the name takes the browser's ellipsis, the chips stay whole. */
	.line:global(.compact) .tag-name {
		flex: 0 1 auto;
		min-width: 0;
	}
	/* The letter is drawn, not text, so the chip's text stays "Auto". */
	.auto-tile::before {
		content: "A";
		font-weight: 700;
	}
	/* A sign since the update needs a look: rust, as Needs a look, on the chip's own outline. */
	.chip.watch {
		color: var(--rust);
		border-color: color-mix(in oklch, var(--rust) 55%, transparent);
	}
	.chip.watch path {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
	}
	/* The breaking-change sign's colour: a fix worth reading about, not an alarm. */
	.sec {
		color: var(--rust);
		border-color: var(--rust);
	}
	.shield {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.4;
		stroke-linejoin: round;
	}
	.lock {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.4;
		stroke-linejoin: round;
	}
	.tag-name {
		flex: none;
		line-height: 18px;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.fresh .tag-name {
		font-weight: 560;
		color: var(--text-2);
	}
	.latin {
		white-space: nowrap;
		line-height: 18px;
	}
	.chip,
	.chip-use {
		flex: none;
	}
	/* In use is a status mark, not a control: a dot and two words. */
	.chip-use {
		display: inline-flex;
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
	/* Reasons wrap to two lines at most, with the browser's own ellipsis. */
	.sentence {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
		font-size: var(--fs-12);
		line-height: 15px;
		color: var(--text-2);
	}
	.s-problem .sentence {
		color: oklch(0.84 0.08 48);
	}
	.s-failed .sentence,
	.s-rolled_back .sentence {
		color: oklch(0.84 0.09 25);
	}
	.kind {
		font-size: var(--fs-12);
		color: var(--text-3);
		white-space: nowrap;
	}
	.size {
		text-align: right;
		color: var(--text-2);
	}
	.restore {
		padding-left: var(--s3);
		color: var(--text-2);
	}
	.none-yet {
		font-size: var(--fs-12);
		color: var(--text-3);
	}
	.restore-in {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		max-width: 100%;
	}
	/* A commit as a restore point can outrun the column: it takes the ellipsis and keeps the whole value in title. */
	.point {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.saved {
		flex: none;
		fill: none;
		stroke: var(--leaf);
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.command {
		display: block;
		font-size: var(--fs-12);
		color: var(--text);
		white-space: nowrap;
		overflow: hidden;
	}
	.status {
		display: flex;
		flex-direction: column;
		justify-content: center;
		min-width: 0;
	}
	.status-text {
		font-size: var(--fs-13);
		font-weight: 540;
		color: var(--text-2);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.s-ready .status-text,
	.s-queued .status-text {
		color: var(--sun);
	}
	.s-manual .status-text {
		color: var(--bloom);
	}
	.s-problem .status-text {
		color: var(--rust);
	}
	.s-failed .status-text,
	.s-rolled_back .status-text {
		color: var(--fail);
	}
	.s-held .status-text {
		color: var(--frost);
	}
	.s-checking .status-text,
	.fresh .status-text {
		font-weight: 440;
		color: var(--text-3);
	}
</style>
