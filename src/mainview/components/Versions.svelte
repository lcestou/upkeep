<script lang="ts">
	import type { AppState } from "../../shared/types";
	import { TEXT } from "../lib/copy";
	import { isQuiet, isStruck } from "../lib/state";

	let { app, from = null }: { app: AppState; from?: string | null } = $props();

	const done = $derived(app.status === "done");
	const before = $derived(done ? (from ?? app.installed) : app.installed);
	const after = $derived(done ? app.installed : app.latest);
	const pending = $derived(!isQuiet(app) && after !== null && after !== before);
	// One axis for every row: an unknown installed version is a "?" in its slot, then the arrow.
	const arrow = $derived(pending);
</script>

{#if app.status === "checking" && app.installed === null && app.latest === null}
	<span class="versions"><span class="skeleton" aria-hidden="true"></span></span>
{:else if app.versionless}
	<span class="versions"><span class="versionless">{TEXT.versionless}</span></span>
{:else}
	<span class="versions mono" class:pending>
		<span class="installed" class:unknown={before === null && pending} title={before ?? undefined}
			>{before ?? (pending ? "?" : "")}</span
		>
		{#if pending}
			{#if arrow}<svg class="arrow" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M1.5 6h8.25M7 3.25 9.75 6 7 8.75" /></svg>
				<span class="sr-only">to</span>{/if}
			<span class="latest" class:done class:struck={isStruck(app)} class:lost={app.status === "failed" || app.status === "rolled_back"} title={after ?? undefined}>{after}</span>
		{/if}
	</span>
{/if}

<style>
	.versions {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 20px minmax(0, 1fr);
		align-items: center;
		min-width: 0;
	}
	.installed {
		grid-column: 1;
		justify-self: end;
		color: var(--text-2);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 100%;
	}
	.pending .installed {
		color: var(--text-3);
	}
	.installed.unknown {
		font-family: var(--sans);
	}
	.arrow {
		grid-column: 2;
		justify-self: center;
		fill: none;
		stroke: var(--text-3);
		stroke-width: 1.4;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.latest {
		grid-column: 3;
		justify-self: start;
		color: var(--text);
		font-variation-settings: "wght" 380;
		transition: font-variation-settings 400ms var(--ease-out);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 100%;
	}
	.latest.done {
		font-variation-settings: "wght" 720;
		color: var(--leaf);
	}
	.latest.struck {
		color: var(--text-3);
		text-decoration: line-through;
		text-decoration-color: var(--frost);
		text-decoration-thickness: 1.5px;
	}
	.latest.lost {
		color: var(--fail);
		text-decoration-color: var(--fail);
	}
	.versionless {
		grid-column: 1 / -1;
		justify-self: center;
		font-style: italic;
		color: var(--text-3);
		font-size: var(--fs-12);
	}
	.skeleton {
		grid-column: 1 / -1;
		justify-self: center;
		width: 72%;
		height: 8px;
		border-radius: 4px;
		background: var(--line-soft);
		animation: breathe 1.4s ease-in-out infinite;
	}
	@keyframes breathe {
		50% {
			opacity: 0.45;
		}
	}
</style>
