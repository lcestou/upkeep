<script lang="ts">
	import { LEAF_PATH, MARK_PATH, MARK_TRANSFORM, MARK_VIEWBOX, SPROUT_PATH } from "../lib/brand";
	import type { GlyphName } from "../lib/state";

	let { name, color = "currentColor" }: { name: GlyphName; color?: string } = $props();
</script>

<svg class="glyph" class:pulse={name === "dot"} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" style:color>
	{#if name === "dot"}
		<circle cx="8" cy="8" r="2.75" fill="currentColor" />
	{:else if name === "wait"}
		<path d="M4.5 1.75h7M4.5 14.25h7M5.5 1.75c0 3.4 5 3.2 5 6.25s-5 2.85-5 6.25M10.5 1.75c0 3.4-5 3.2-5 6.25s5 2.85 5 6.25" />
	{:else if name === "bud"}
		<!-- At 1.5 dppx and above the vector mark, matched to the hand glyph; below it the 16 px pixel cut, crisp. -->
		<svg class="hi" x="-1.6" y="-0.9" width="19.2" height="19.2" viewBox={MARK_VIEWBOX}
			><g transform={MARK_TRANSFORM}><path d={MARK_PATH} class="solid" fill-rule="evenodd" /></g></svg
		>
		<path class="lo solid" d={SPROUT_PATH} shape-rendering="crispEdges" />
	{:else if name === "drop"}
		<path d="M8 1.9c2.9 3.35 4.45 5.8 4.45 7.7a4.45 4.45 0 0 1-8.9 0c0-1.9 1.55-4.35 4.45-7.7Z" class="fill" />
	{:else if name === "leaf"}
		<path d={LEAF_PATH} class="solid" />
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
	/* Switched in CSS by the screen's density, so there is no script and no flash. */
	.lo {
		display: none;
	}
	@media (max-resolution: 1.49dppx) {
		.hi {
			display: none;
		}
		.lo {
			display: inline;
		}
	}
	.glyph :global(svg) {
		overflow: visible;
	}
	.solid {
		fill: currentColor;
		stroke: none;
	}
	.pulse {
		animation: pulse 1.2s ease-in-out infinite;
	}
	/* Between 0.8 and 1, so the dot never drops under 3:1. */
	@keyframes pulse {
		50% {
			opacity: 0.8;
		}
	}
</style>
