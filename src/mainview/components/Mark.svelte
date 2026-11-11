<script lang="ts">
	import { MARK_PATH, MARK_TRANSFORM, MARK_VIEWBOX } from "../lib/brand";

	let { size = 20 }: { size?: number } = $props();
</script>

<svg class="mark" viewBox={MARK_VIEWBOX} width={size} height={size} aria-hidden="true"
	><g transform={MARK_TRANSFORM}><path d={MARK_PATH} fill="currentColor" fill-rule="evenodd" /></g></svg
>

<style>
	.mark {
		display: block;
		flex: none;
	}
</style>
