<script lang="ts">
	import type { WindowButton, WindowChrome } from "../../shared/types";
	import { WIN } from "../lib/copy";
	import type { Model } from "../lib/model.svelte";

	let { model, chrome }: { model: Model; chrome: WindowChrome } = $props();

	/** The button's accessible name; maximize reads "Restore" while the window is already maximized. */
	const label = (b: WindowButton) => (b === "maximize" ? (chrome.maximized ? WIN.restore : WIN.maximize) : WIN[b]);
</script>

<!-- Hover waits for the pointer after a close or minimize (model.buttonsCold): the button stays where the pointer left it. -->
<div
	class="win {chrome.side}"
	class:cold={model.buttonsCold}
	data-testid="window-buttons"
	onpointerenter={() => (model.buttonsCold = false)}
>
	{#each chrome.order as b (b)}
		<button
			type="button"
			class="wb {b} electrobun-webkit-app-region-no-drag"
			aria-label={label(b)}
			title={label(b)}
			data-testid="win-{b}"
			onclick={() => model.windowOp(b)}
		>
			<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
				{#if b === "close"}
					<path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
				{:else if b === "minimize"}
					<path d="M4 10.5h8" />
				{:else if chrome.maximized}
					<path d="M6 4.5h5.5V10M4.5 6h5.5v5.5H4.5Z" />
				{:else}
					<path d="M4.5 4.5h7v7h-7Z" />
				{/if}
			</svg>
		</button>
	{/each}
</div>

<style>
	.win {
		position: absolute;
		top: 50%;
		display: flex;
		gap: 6px;
		transform: translateY(-50%);
	}
	.win.left {
		left: 12px;
	}
	.win.right {
		right: 12px;
	}
	.wb {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: transparent;
		color: var(--text-2);
		cursor: default;
		transition:
			background-color 100ms ease-out,
			color 100ms ease-out;
	}
	.win:not(.cold) .wb:hover {
		background: var(--shell-hi);
		color: var(--text);
	}
	/* A deeper red than --fail, so the cross on it measures 4.5:1. */
	.win:not(.cold) .wb.close:hover {
		background: oklch(0.54 0.19 25);
		color: var(--text);
	}
	svg {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
</style>
