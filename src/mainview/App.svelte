<script lang="ts">
	import AppList from "./components/AppList.svelte";
	import FooterBar from "./components/FooterBar.svelte";
	import HeaderBar from "./components/HeaderBar.svelte";
	import HistoryView from "./components/HistoryView.svelte";
	import LogDrawer from "./components/LogDrawer.svelte";
	import RowDetail from "./components/RowDetail.svelte";
	import SettingsView from "./components/SettingsView.svelte";
	import { getBridge } from "./lib/bridge";
	import { Model } from "./lib/model.svelte";
	import type { Layout } from "./lib/state";

	const asked = new URLSearchParams(location.search).get("layout");
	const layout: Layout = asked === "b" || asked === "c" ? asked : "a";

	let model = $state<Model | null>(null);
	let logOpen = $state(false);

	void getBridge().then((bridge) => {
		const live = new Model(bridge);
		model = live;
		return live.start();
	});

	// B always shows one app's tag; during a run it follows the app being installed.
	$effect(() => {
		if (layout !== "b" || !model?.loaded) return;
		const key =
			model.run.phase === "installing"
				? model.run.currentKey
				: model.run.phase === "summary"
					? (model.failedKeys[0] ?? null)
					: null;
		if (key) model.open = key;
		else if (!model.openApp) model.open = model.groups[0]?.apps[0]?.key ?? null;
	});

	$effect(() => {
		if (model?.view === "history" && model.run.phase !== "installing") void model.loadHistory();
	});

	function onkeydown(e: KeyboardEvent) {
		if (e.key === "Escape" && logOpen) {
			logOpen = false;
			document.querySelector<HTMLElement>('[data-testid="log-toggle"]')?.focus();
		}
	}
</script>

<svelte:window {onkeydown} />

{#if model?.loaded}
	{@const m = model}
	<div class="shell layout-{layout}" data-layout={layout}>
		<HeaderBar model={m} {layout} {logOpen} ontogglelog={() => (logOpen = !logOpen)} />
		<main id="view" role={m.view === "updates" ? undefined : "tabpanel"} aria-labelledby="tab-{m.view}">
			{#if m.view === "history"}
				<HistoryView model={m} />
			{:else if m.view === "settings"}
				<SettingsView model={m} />
			{:else if layout === "b"}
				<div class="bench">
					<AppList model={m} {layout} />
					<aside class="tag" data-testid="tag-pane">
						{#if m.openApp}
							<!-- Keyed so a different app starts with no leftover Copied or Restored message. -->
							{#key m.openApp.key}
								<RowDetail app={m.openApp} model={m} pane />
							{/key}
						{/if}
					</aside>
				</div>
			{:else}
				<AppList model={m} {layout} />
			{/if}
		</main>
		{#if layout !== "c"}
			<FooterBar model={m} {logOpen} ontogglelog={() => (logOpen = !logOpen)} />
		{/if}
		{#if logOpen}
			<LogDrawer model={m} bottom={layout === "c" ? 0 : 64} />
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
	.layout-c {
		grid-template-rows: 56px minmax(0, 1fr);
	}
	main {
		min-height: 0;
		min-width: 0;
		position: relative;
	}
	.bench {
		display: grid;
		grid-template-columns: minmax(0, 58fr) minmax(0, 42fr);
		height: 100%;
	}
	.tag {
		min-height: 0;
		overflow-y: auto;
		background: var(--surface);
		border-left: 1px solid var(--line-soft);
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
