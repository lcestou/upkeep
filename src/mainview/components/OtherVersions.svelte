<script lang="ts">
	import type { AppState, VersionChoice } from "../../shared/types";
	import { ADD, installVersionLabel, TEXT } from "../lib/copy";
	import { say } from "../lib/engine-say";
	import { relativeTime } from "../lib/format";
	import type { Model } from "../lib/model.svelte";

	let { app, model }: { app: AppState; model: Model } = $props();

	let list = $state<VersionChoice[] | null>(null);
	let loading = $state(false);
	let note = $state<string | null>(null);
	const busy = $derived(model.run.phase === "installing" || model.run.phase === "checking");

	/** Asks for the app's newest releases. Only on the press, so opening a pane spends none of the forge's budget. */
	async function show() {
		loading = true;
		note = null;
		try {
			const res = await model.send("versions", { key: app.key });
			// A request that ran out of time leaves the button to press again.
			if (res === null) return;
			list = res.versions;
			note = res.problem ?? null;
		} finally {
			loading = false;
		}
	}

	/** Installs one release through a run of its own. Started: the list closes, as the row now shows the run; refused: the reason stays. */
	async function install(tag: string) {
		const res = await model.send("installVersion", { key: app.key, tag });
		if (res === null) return;
		if (res.started) list = null;
		note = res.started ? null : (res.reason ?? null);
	}
</script>

<div class="block" data-testid="versions-{app.key}">
	<h3 data-testid="versions-heading">{TEXT.otherVersions}</h3>
	<p class="hint" data-testid="versions-hint">{TEXT.versionsHint}</p>
	{#if list === null}
		<div>
			<button type="button" class="btn small" disabled={loading} data-testid="versions-show-{app.key}" onclick={show}
				>{loading ? TEXT.loadingVersions : TEXT.showVersions}</button
			>
		</div>
	{:else if list.length === 0 && !note}
		<p class="none" data-testid="versions-none">{TEXT.noVersions}</p>
	{:else}
		<ul class="versions">
			{#each list as v (v.tag)}
				<li data-testid="version-{app.key}-{v.version}">
					<span class="mono">{v.version}</span>
					{#if v.prerelease}<span class="chip" data-testid="version-pre-{v.version}">{TEXT.prereleaseTag}</span>{/if}
					{#if v.publishedAt}<span class="when">{relativeTime(v.publishedAt)}</span>{/if}
					{#if v.version === app.installed}
						<span class="when" data-testid="version-installed-{v.version}">{TEXT.installedTag}</span>
					{:else}
						<button
							type="button"
							class="btn small"
							disabled={busy}
							title={busy ? ADD.waitRun : undefined}
							data-testid="install-version-{app.key}-{v.version}"
							onclick={() => install(v.tag)}>{installVersionLabel(v.version)}</button
						>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
	{#if note}<p class="result" role="status" data-testid="versions-note">{say(note)}</p>{/if}
</div>

<style>
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
	p {
		margin: 0;
	}
	.hint,
	.none,
	.when {
		font-size: var(--fs-12);
		color: var(--text-3);
	}
	.hint {
		max-width: 60ch;
	}
	.versions {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--s2);
	}
	.versions li {
		display: flex;
		align-items: center;
		gap: var(--s2);
		flex-wrap: wrap;
	}
	.result {
		font-size: var(--fs-12);
		color: var(--text-2);
	}
</style>
