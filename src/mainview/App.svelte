<script lang="ts">
	import { say } from "./lib/engine-say";
	import AddPane from "./components/AddPane.svelte";
	import AppList from "./components/AppList.svelte";
	import FooterBar from "./components/FooterBar.svelte";
	import HeaderBar from "./components/HeaderBar.svelte";
	import HistoryView from "./components/HistoryView.svelte";
	import RateBar from "./components/RateBar.svelte";
	import LogDrawer from "./components/LogDrawer.svelte";
	import RowDetail from "./components/RowDetail.svelte";
	import SettingsView from "./components/SettingsView.svelte";
	import CleanupView from "./components/CleanupView.svelte";
	import { getBridge } from "./lib/bridge";
	import { Model } from "./lib/model.svelte";
	import { ADD } from "./lib/copy";
	import { ms } from "./lib/motion";
	import { shade } from "./lib/shade";
	import { tick } from "svelte";
	import { fly } from "svelte/transition";

	let model = $state<Model | null>(null);
	// The pane is a sheet over the list below 900 px.
	const narrow = globalThis.matchMedia?.("(max-width: 899px)") ?? null;
	let sheet = $state(narrow?.matches ?? false);
	narrow?.addEventListener("change", (e) => (sheet = e.matches));
	// Opening the sheet moves focus to Back to list.
	let lastKey: string | null = null;
	$effect(() => {
		const key = model?.openKey ?? (model?.adding ? "+add" : null);
		if (key === lastKey) return;
		const opened = lastKey === null && key !== null;
		lastKey = key;
		if (sheet && opened && key !== "+add")
			// preventScroll: focusing inside the overflow-hidden bench would otherwise scroll it sideways.
			void tick().then(() =>
				document.querySelector<HTMLElement>('[data-testid="inspector-close"]')?.focus({ preventScroll: true }),
			);
	});
	let logOpen = $state(false);
	// The reset the rate bar was dismissed for: it stays hidden until GitHub's hour starts over.
	let rateDismissed = $state<string | null>(null);
	// Hides the bar when GitHub's hour starts over, even if no check has answered since.
	$effect(() => {
		const at = rateOut?.resetAt;
		if (!at) return;
		const t = setTimeout(() => (rateDismissed = at), Math.max(0, Date.parse(at) - Date.now()));
		return () => clearTimeout(t);
	});
	const rateOut = $derived.by(() => {
		const r = model?.rate;
		if (!r || r.remaining > 0 || !r.resetAt || r.resetAt === rateDismissed) return null;
		return Date.parse(r.resetAt) > Date.now() ? r : null;
	});

	void getBridge().then((bridge) => {
		const live = new Model(bridge);
		model = live;
		return live.start();
	});

	/** Focuses a list row by its app key; does nothing when the key is null or the row is not drawn. */
	function focusRow(key: string | null) {
		if (key) document.querySelector<HTMLElement>(`[data-row="${CSS.escape(key)}"]`)?.focus();
	}

	/** Closes the pane or sheet and returns focus to where it came from: the row that was open, or the add button. */
	function closeInspector() {
		const key = model?.openKey ?? null;
		const wasAdding = model?.adding ?? false;
		model?.close();
		// After the list wakes from inert, or focus has nowhere to land.
		void tick().then(() => {
			if (wasAdding) document.querySelector<HTMLElement>('[data-testid="add-app"]')?.focus();
			else focusRow(key);
		});
	}

	// Drop a file (or a repo link) anywhere on the window to add it.
	let veil = $state(false);
	let depth = 0;
	/** True for a drag that holds a file, a link or text, the three things the add pane accepts. */
	const carries = (e: DragEvent) =>
		[...(e.dataTransfer?.types ?? [])].some(
			(t) => t === "Files" || t === "text/uri-list" || t === "text/plain" || t === "text/html",
		);
	/**
	 * The address in dropped HTML. WebKitGTK, the real window's webview, keeps a dropped file's file:// address out of
	 * text/uri-list and files; it hands it over only in text/html, as the text of an <a> with no href (seen in the real
	 * window, 2026-11-12). A link's href, when there is one, wins over its text; text outside the link is never taken.
	 */
	function linkIn(html: string | undefined): string | undefined {
		// shortcut: a large HTML drop (a long selection) is not parsed; WebKitGTK's file drop is one short <a>.
		if (!html || html.length > 65_536) return undefined;
		const a = new DOMParser().parseFromString(html, "text/html").querySelector("a");
		return a?.getAttribute("href") || a?.textContent?.trim() || undefined;
	}

	/** Shows the drop veil on the first enter; `depth` counts nested enters so child elements do not flicker it off. */
	function ondragenter(e: DragEvent) {
		if (!carries(e)) return;
		e.preventDefault();
		depth++;
		veil = true;
	}
	/** Cancels the browser default for a drag that carries something, which is what makes the window a drop target. */
	function ondragover(e: DragEvent) {
		if (carries(e)) e.preventDefault();
	}
	/** Hides the veil only once every nested enter has been matched by a leave. */
	function ondragleave() {
		depth = Math.max(0, depth - 1);
		if (depth === 0) veil = false;
	}
	/** Opens the add pane with the dropped path or link. A dropped file the webview cannot read a path for opens the pane with an "unreadable" problem instead. */
	function ondrop(e: DragEvent) {
		if (!carries(e)) return;
		e.preventDefault();
		depth = 0;
		veil = false;
		const data = e.dataTransfer;
		const uri = data?.getData("text/uri-list").split(/\r?\n/).find((l) => l && !l.startsWith("#"));
		// Plain text before HTML: a dragged selection keeps its own words; WebKitGTK's file drop has neither uri nor text.
		const text = uri || data?.getData("text/plain").trim() || linkIn(data?.getData("text/html"));
		if (text) {
			const path = text.startsWith("file://") ? decodeURIComponent(text.replace(/^file:\/\//, "")) : text;
			model?.openAdd(path);
		} else if (data?.files[0]?.name) {
			model?.openAdd();
			if (model) model.dropProblem = ADD.unreadable;
		}
	}

	/** Window shortcuts: Ctrl+W closes a self-drawn window, `/` or Ctrl+F focuses the filter, Tab wraps at the ends, Escape closes the log, then the pane. */
	function onkeydown(e: KeyboardEvent) {
		const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
		if (e.key === "w" && e.ctrlKey && model?.chrome?.own) {
			e.preventDefault();
			model.windowOp("close");
			return;
		}
		if ((e.key === "/" && !typing) || (e.key === "f" && (e.ctrlKey || e.metaKey))) {
			const field = document.querySelector<HTMLElement>('[data-testid="filter"]');
			if (field) {
				e.preventDefault();
				field.focus();
			}
			return;
		}
		// The tab loop never rests on the page: past the last control, Tab goes to the first.
		if (e.key === "Tab") {
			const stops = [
				...document.querySelectorAll<HTMLElement>(
					'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]), [tabindex="0"]',
				),
			].filter((el) => el.offsetParent !== null && !el.closest("[inert]"));
			const first = stops[0];
			const last = stops.at(-1);
			if (!e.shiftKey && document.activeElement === last && first) {
				e.preventDefault();
				first.focus();
			} else if (e.shiftKey && document.activeElement === first && last) {
				e.preventDefault();
				last.focus();
			}
			return;
		}
		if (e.key !== "Escape") return;
		if (logOpen) {
			logOpen = false;
			document.querySelector<HTMLElement>('[data-testid="log-toggle"]')?.focus();
		} else if (model?.openKey || model?.adding) {
			closeInspector();
		}
	}

	// The page goes see-through only once the main process says the window was built that way.
	$effect(() => {
		const on = model?.chrome?.rounded === true && !model.chrome.maximized;
		document.documentElement.toggleAttribute("data-rounded", on);
	});

	// First focus lands in the list, on its first row, so the keyboard starts where the work is.
	let focused = false;
	$effect(() => {
		if (focused || !model?.loaded) return;
		focused = true;
		// SAFETY: `focusVisible` is a real option in current WebKit and Chromium, but the DOM typings do not list it yet.
		const quiet = { preventScroll: true, focusVisible: false } as FocusOptions;
		void tick().then(() => document.querySelector<HTMLElement>("[data-row]")?.focus(quiet));
	});

	$effect(() => {
		// Past runs load during a run too, and again whenever the run's phase changes, so a finished run appears.
		const phase = model?.run.phase;
		if (model?.view === "history" && phase) void model.loadHistory();
	});
</script>

<svelte:window {onkeydown} {ondragenter} {ondragover} {ondragleave} {ondrop} />

{#if model?.loaded}
	{@const m = model}
	<div
		class="shell"
		class:edged={m.chrome?.own === true && !m.chrome.maximized}
		class:rounded={m.chrome?.rounded === true && !m.chrome.maximized}
		class:barred={rateOut !== null}
	>
		<HeaderBar model={m} />
		{#if rateOut?.resetAt}
			{@const at = rateOut.resetAt}
			<RateBar resetAt={at} signedIn={rateOut.limit > 60} ondismiss={() => (rateDismissed = at)} />
		{/if}
		<main id="view" role={m.view === "updates" ? undefined : "tabpanel"} aria-labelledby="tab-{m.view}">
			{#if m.view === "history"}
				<HistoryView model={m} />
			{:else if m.view === "cleanup"}
				<CleanupView model={m} />
			{:else if m.view === "settings"}
				<SettingsView model={m} />
			{:else}
				<div class="bench">
					<!-- Under 900 px the pane is a sheet: the list behind it is out of reach until it closes. -->
					<div class="listbox" inert={sheet && (m.openApp !== null || m.adding)}>
						<AppList model={m} />
					</div>
					{#if m.adding}
						<aside class="inspector" id="inspector" data-testid="inspector" aria-labelledby="add-title" transition:fly={{ x: 32, duration: ms(200) }}>
							<div class="scroll" {@attach shade}>
								<AddPane model={m} onclose={closeInspector} />
							</div>
						</aside>
					{:else if m.openApp}
						<aside
							class="inspector"
							id="inspector"
							data-testid="inspector"
							aria-label={m.openApp.name}
							transition:fly={{ x: 32, duration: ms(200) }}
						>
							<!-- Keyed so a different app starts at the top, with no leftover Copied or Restored message. -->
							{#key m.openApp.key}
								<div class="scroll" {@attach shade}>
									<RowDetail app={m.openApp} model={m} onclose={closeInspector} />
								</div>
							{/key}
						</aside>
					{/if}
				</div>
			{/if}
		</main>
		<FooterBar model={m} {logOpen} ontogglelog={() => (logOpen = !logOpen)} />
		{#if logOpen}
			<LogDrawer model={m} bottom={64} />
		{/if}
		{#if veil}
			<div class="veil" data-testid="drop-veil" aria-hidden="true"><span>{ADD.drop}</span></div>
		{/if}
		{#if m.refusal}
			<p class="refusal" role="alert" data-testid="refusal">{say(m.refusal)}</p>
		{/if}
	</div>
{/if}

<style>
	/* With Upkeep's own frame the desktop draws no border: the page draws a 1 px inside edge, except maximised. */
	.shell.edged::after {
		content: "";
		position: fixed;
		inset: 0;
		border: 1px solid var(--line);
		pointer-events: none;
		z-index: 7;
	}
	/* clip-path, not only overflow, so fixed layers (the log sheet, the drop veil, the edge) stay inside the corners. */
	.shell.rounded {
		border-radius: var(--window-radius);
		clip-path: inset(0 round var(--window-radius));
	}
	.shell.rounded::after {
		border-radius: var(--window-radius);
	}
	.shell {
		background: var(--ground);
		display: grid;
		grid-template-rows: 56px minmax(0, 1fr) 64px;
		/* The window's width, never the widest content's. */
		grid-template-columns: minmax(0, 1fr);
		height: 100%;
		min-width: 0;
	}
	/* The rate bar takes its own row between the header and the view while it shows. */
	.shell.barred {
		grid-template-rows: 56px auto minmax(0, 1fr) 64px;
	}
	main {
		position: relative;
		min-height: 0;
		min-width: 0;
		overflow: clip;
	}
	.bench {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		grid-template-rows: minmax(0, 1fr);
		height: 100%;
		/* clip, not hidden: a hidden box can still be scrolled by focus(), which slid the sheet sideways. */
		overflow: clip;
	}
	.listbox {
		min-width: 0;
		min-height: 0;
		height: 100%;
	}
	.inspector {
		position: relative;
		min-height: 0;
		background: var(--surface);
	}
	.scroll {
		height: 100%;
		overflow-y: auto;
		overflow-x: hidden;
		overscroll-behavior: contain;
	}
	/* Scroll shadows: an edge with more content behind it carries a soft shade. */
	.inspector::before,
	.inspector::after {
		content: "";
		position: absolute;
		left: 0;
		right: 0;
		height: 16px;
		pointer-events: none;
		opacity: 0;
		transition: opacity 150ms ease-out;
		z-index: 1;
	}
	.inspector::before {
		top: 0;
		background: linear-gradient(oklch(0.08 0.02 165 / 0.6), transparent);
	}
	.inspector::after {
		bottom: 0;
		background: linear-gradient(transparent, oklch(0.08 0.02 165 / 0.6));
	}
	.inspector:has(:global(.scroll[data-more-top])):before {
		opacity: 1;
	}
	.inspector:has(:global(.scroll[data-more-bottom])):after {
		opacity: 1;
	}
	@media (min-width: 900px) {
		/* The pane's column lasts as long as the pane is on the page, its fly-out included: keyed on a class that
		   drops at the close, the closing pane fell into a second row and squeezed the list to nothing for 200 ms. */
		.bench:has(> .inspector) {
			grid-template-columns: minmax(0, 1fr) max(380px, 42%);
		}
		.listbox {
			grid-area: 1 / 1;
		}
		/* Both panes share one cell, so one leaving while the other arrives never makes a second row either. */
		.inspector {
			grid-area: 1 / 2;
			border-left: 1px solid var(--line-soft);
		}
	}
	@media (max-width: 899px) {
		/* Under 900 px the pane is a full-width sheet over the list, with Back to list in its header. */
		.inspector {
			position: absolute;
			inset: 0;
			z-index: 3;
			border-left: 1px solid var(--line);
			box-shadow: var(--shadow-pop);
		}
	}
	.veil {
		position: fixed;
		inset: 12px;
		z-index: 6;
		display: grid;
		place-items: center;
		border: 2px dashed var(--leaf);
		border-radius: 12px;
		background: oklch(0.19 0.022 165 / 0.85);
		pointer-events: none;
	}
	.veil span {
		font-size: var(--fs-19);
		font-weight: 640;
		color: var(--text);
	}
	.refusal {
		position: fixed;
		left: 50%;
		bottom: 80px;
		transform: translateX(-50%);
		margin: 0;
		padding: var(--s2) var(--s4);
		border-radius: var(--radius);
		background: var(--raised);
		border: 1px solid var(--rust);
		color: var(--text);
		box-shadow: var(--shadow-pop);
		z-index: 5;
	}
</style>
