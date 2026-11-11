<script lang="ts">
	import type { AppState } from "../../shared/types";
	import { STAGE_NAME, statusText } from "../lib/copy";
	import { progressOf } from "../lib/state";

	let { app, caption = true }: { app: AppState; caption?: boolean } = $props();

	const live = $derived(app.status === "working");
	const active = $derived(live ? app.stages.findIndex((s) => s.id === app.stage) : -1);
	const text = $derived(statusText(app));

	/** Where stage i stands: a finished app shows every stage done; outside a live run all are pending. */
	function phase(i: number): "done" | "active" | "pending" {
		if (app.status === "done") return "done";
		if (!live || i > active) return "pending";
		return i < active ? "done" : "active";
	}

	/** How full stage i's bar is, from 0 to 1; only the active stage takes the live percentage. */
	function fill(i: number): number {
		const p = phase(i);
		if (p === "done") return 1;
		if (p === "pending") return 0;
		return (app.stagePct ?? 0) / 100;
	}
</script>

<div
	class="stem s-{app.status}"
	class:live
	class:complete={app.status === "done"}
	data-testid="stem-{app.key}"
	role={live ? "progressbar" : undefined}
	aria-label={live ? app.name : undefined}
	aria-valuemin={live ? 0 : undefined}
	aria-valuemax={live ? 100 : undefined}
	aria-valuenow={live ? Math.round(progressOf(app) * 100) : undefined}
	aria-valuetext={live ? text : undefined}
>
	<div class="track">
		{#each app.stages as s, i (s.id)}
			{@const p = phase(i)}
			<span class="span {p}" style:flex-grow={s.weight} title={STAGE_NAME[s.id]}>
				<span class="rail">
					{#if p === "active" && app.stagePct === null}
						<span class="fill sweep"></span>
					{:else}
						<span class="fill" style:transform="scaleX({fill(i)})"></span>
					{/if}
				</span>
				<span class="node"></span>
				<svg class="sprout" viewBox="0 0 10 10" aria-hidden="true">
					<path d="M.8 9.2C.8 4.4 4.4.8 9.2.8c0 4.8-3.6 8.4-8.4 8.4Z" />
				</svg>
			</span>
		{/each}
	</div>
	{#if caption}
		<span class="caption" aria-hidden={live ? "true" : undefined}>{text}</span>
	{/if}
</div>

<style>
	.stem {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
		width: 100%;
	}
	.track {
		display: flex;
		align-items: center;
		height: 18px;
		padding-top: 6px;
	}
	.span {
		position: relative;
		display: flex;
		align-items: center;
		flex-basis: 0;
		/* Four leaves stay countable: no stage is drawn narrower than 28 px, the measured weights apply above that. */
		min-width: 28px;
	}
	.rail {
		flex: 1;
		height: 2px;
		margin-right: 2px;
		overflow: hidden;
		border-radius: 1px;
		background: var(--line);
	}
	.fill {
		display: block;
		height: 100%;
		background: var(--water);
		transform-origin: left center;
		transition: transform 160ms linear;
	}
	.done .fill {
		background: var(--leaf);
	}
	.sweep {
		width: 40%;
		animation: sweep 1.1s ease-in-out infinite;
	}
	@keyframes sweep {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(250%);
		}
	}
	.node {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		border: 1.5px solid var(--line);
		background: var(--ground);
		transition:
			background-color 200ms ease-out,
			border-color 200ms ease-out;
	}
	.active .node {
		border-color: var(--water);
	}
	.done .node {
		border-color: var(--leaf);
		background: var(--leaf);
	}
	.sprout {
		position: absolute;
		left: calc(100% - 4px);
		bottom: calc(50% + 1px);
		width: 9px;
		height: 9px;
		fill: var(--leaf);
		transform-origin: 0 100%;
		transform: scale(0) rotate(-50deg);
		opacity: 0;
		transition:
			transform 280ms var(--ease-out),
			opacity 120ms ease-out;
	}
	.done .sprout {
		transform: scale(1) rotate(0deg);
		opacity: 1;
	}
	.caption {
		font-size: var(--fs-12);
		line-height: 14px;
		color: var(--text-2);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.s-ready .caption,
	.s-queued .caption {
		color: var(--sun);
	}
	.live .caption {
		color: var(--water);
		font-weight: 560;
	}
	.complete .caption {
		color: var(--leaf);
	}
	@media (prefers-reduced-motion: reduce) {
		.sweep {
			animation: none;
			transform: translateX(75%);
		}
	}
</style>
