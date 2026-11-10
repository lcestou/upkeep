<script lang="ts">
	import { MARK_PATH, MARK_VIEWBOX } from "../lib/brand";

	let { size = 20 }: { size?: number } = $props();
</script>

<svg class="mark" viewBox={MARK_VIEWBOX} width={size} height={size} aria-hidden="true"><path d={MARK_PATH} /></svg>

<style>
	.mark {
		display: block;
		flex: none;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
</style>
