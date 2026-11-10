<script lang="ts">
	import { TEXT } from "../lib/copy";

	let { open, ontoggle }: { open: boolean; ontoggle: () => void } = $props();
</script>

<button
	type="button"
	class="btn small quiet log-toggle"
	class:on={open}
	aria-expanded={open}
	aria-controls="log-drawer"
	data-testid="log-toggle"
	onclick={ontoggle}
>
	<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 4.5h10M3 8h10M3 11.5h6" /></svg>
	{TEXT.log}
</button>

<style>
	svg {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.5;
		stroke-linecap: round;
	}
	.on {
		color: var(--text);
		background: oklch(0.955 0.012 110 / 0.08);
	}
</style>
