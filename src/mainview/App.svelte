<script lang="ts">
	import AddPane from "./components/AddPane.svelte";
	import AppList from "./components/AppList.svelte";
	import FooterBar from "./components/FooterBar.svelte";
	import HeaderBar from "./components/HeaderBar.svelte";
	import HistoryView from "./components/HistoryView.svelte";
	import LogDrawer from "./components/LogDrawer.svelte";
	import RowDetail from "./components/RowDetail.svelte";
	import SettingsView from "./components/SettingsView.svelte";
	import { getBridge } from "./lib/bridge";
	import { Model } from "./lib/model.svelte";
	import { ADD } from "./lib/copy";
	import { ms } from "./lib/motion";
	import { shade } from "./lib/shade";
	import { tick } from "svelte";
	import { fly } from "svelte/transition";

	let model = $state<Model | null>(null);
	let logOpen = $state(false);

	void getBridge().then((bridge) => {
		const live = new Model(bridge);
		model = live;
		return live.start();
	});

	function focusRow(key: string | null) {
		if (key) document.querySelector<HTMLElement>(`[data-row="${CSS.escape(key)}"]`)?.focus();
	}

	function closeInspector() {
		const key = model?.openKey ?? null;
		const wasAdding = model?.adding ?? false;
		model?.close();
		if (wasAdding) document.querySelector<HTMLElement>('[data-testid="add-app"]')?.focus();
		else focusRow(key);
	}

	// Drop a file (or a repo link) anywhere on the window to add it.
	let veil = $state(false);
	let depth = 0;
	const carries = (e: DragEvent) =>
		[...(e.dataTransfer?.types ?? [])].some((t) => t === "Files" || t === "text/uri-list" || t === "text/plain");
	function ondragenter(e: DragEvent) {
		if (!carries(e)) return;
		e.preventDefault();
		depth++;
		veil = true;
	}
	function ondragover(e: DragEvent) {
		if (carries(e)) e.preventDefault();
	}
	function ondragleave() {
		depth = Math.max(0, depth - 1);
		if (depth === 0) veil = false;
	}
	function ondrop(e: DragEvent) {
		if (!carries(e)) return;
		e.preventDefault();
		depth = 0;
		veil = false;
		const data = e.dataTransfer;
		const uri = data?.getData("text/uri-list").split(/\r?\n/).find((l) => l && !l.startsWith("#"));
		const text = uri ?? data?.getData("text/plain").trim();
		if (text) {
			const path = text.startsWith("file://") ? decodeURIComponent(text.replace(/^file:\/\//, "")) : text;
			model?.openAdd(path);
		} else if (data?.files[0]?.name) {
			model?.openAdd();
			if (model) model.dropProblem = ADD.unreadable;
		}
	}

	function onkeydown(e: KeyboardEvent) {
		const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
		if ((e.key === "/" && !typing) || (e.key === "f" && (e.ctrlKey || e.metaKey))) {
			const field = document.querySelector<HTMLElement>('[data-testid="filter"]');
			if (field) {
				e.preventDefault();
				field.focus();
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

	// First focus lands in the list, on its first row, so the keyboard starts where the work is.
	let focused = false;
	$effect(() => {
		if (focused || !model?.loaded) return;
		focused = true;
		void tick().then(() => document.querySelector<HTMLElement>("[data-row]")?.focus({ preventScroll: true, focusVisible: false } as FocusOptions));
	});

	$effect(() => {
		if (model?.view === "history" && model.run.phase !== "installing") void model.loadHistory();
	});
</script>

<svelte:window {onkeydown} {ondragenter} {ondragover} {ondragleave} {ondrop} />

{#if model?.loaded}
	{@const m = model}
	<div class="shell">
		<HeaderBar model={m} />
		<main id="view" role={m.view === "updates" ? undefined : "tabpanel"} aria-labelledby="tab-{m.view}">
			{#if m.view === "history"}
				<HistoryView model={m} />
			{:else if m.view === "settings"}
				<SettingsView model={m} />
			{:else}
				<div class="bench" class:open={m.openApp !== null || m.adding}>
					<AppList model={m} />
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
							<div class="scroll" {@attach shade}>
								<!-- Keyed so a different app starts with no leftover Copied or Restored message. -->
								{#key m.openApp.key}
									<RowDetail app={m.openApp} model={m} onclose={closeInspector} />
								{/key}
							</div>
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
			<p class="refusal" role="alert">{m.refusal}</p>
		{/if}
	</div>
{/if}

<style>
	.shell {
		display: grid;
		grid-template-rows: 56px minmax(0, 1fr) 64px;
		height: 100%;
		min-width: 0;
	}
	main {
		position: relative;
		min-height: 0;
		min-width: 0;
		overflow: hidden;
	}
	.bench {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		grid-template-rows: minmax(0, 1fr);
		height: 100%;
		overflow: hidden;
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
		.bench.open {
			grid-template-columns: minmax(0, 1fr) max(380px, 42%);
		}
		.inspector {
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
