<script lang="ts">
	import type { GlyphName } from "../lib/state";

	let { name, color = "currentColor" }: { name: GlyphName; color?: string } = $props();
</script>

<svg class="glyph" class:pulse={name === "dot"} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" style:color>
	{#if name === "dot"}
		<circle cx="8" cy="8" r="2.75" fill="currentColor" />
	{:else if name === "wait"}
		<path d="M4.5 1.75h7M4.5 14.25h7M5.5 1.75c0 3.4 5 3.2 5 6.25s-5 2.85-5 6.25M10.5 1.75c0 3.4-5 3.2-5 6.25s5 2.85 5 6.25" />
	{:else if name === "bud"}
		<path d="M8 14.5V10.1M8 12.6c-1.5 0-2.6-.7-3.1-1.9" />
		<path d="M8 10.1c-2.3 0-3.6-1.7-3.6-4.3V3.6L6.2 5 8 2.4 9.8 5l1.8-1.4v2.2c0 2.6-1.3 4.3-3.6 4.3Z" class="fill" />
	{:else if name === "drop"}
		<path d="M8 1.9c2.9 3.35 4.45 5.8 4.45 7.7a4.45 4.45 0 0 1-8.9 0c0-1.9 1.55-4.35 4.45-7.7Z" class="fill" />
	{:else if name === "leaf"}
		<path d="M2.75 13.25c0-6 3.9-10.5 10.5-10.5 0 6.6-4.5 10.5-10.5 10.5Z" class="fill" />
		<path d="M2.75 13.25 9 7" class="rib" />
	{:else if name === "hand"}
		<path d="M5 5.25v6a3.5 3.5 0 0 0 7 0V6" />
		<path d="M7.5 3.5v5M10 4v4.25M5 10.25 3.25 8.5" />
	{:else if name === "pause"}
		<path d="M5.75 3.5v9M10.25 3.5v9" />
	{:else if name === "bang"}
		<path d="M8 1.9 14.6 13.5H1.4L8 1.9Z" />
		<path d="M8 6.4v3.1M8 11.6v.01" />
	{:else}
		<path d="m4.25 4.25 7.5 7.5M11.75 4.25l-7.5 7.5" />
	{/if}
</svg>

<style>
	.glyph {
		display: block;
		flex: none;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.fill {
		fill: currentColor;
		fill-opacity: 0.22;
	}
	.rib {
		stroke-width: 1.3;
	}
	.pulse {
		animation: pulse 1.2s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.3;
		}
	}
</style>
