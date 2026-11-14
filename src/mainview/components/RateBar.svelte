<script lang="ts">
	/**
	 * @component
	 * The bar under the header while GitHub's hourly budget is used up: when checks resume, and, without a GitHub
	 * sign-in (a limit of 60), how gh raises it. Dismissing hides it until the next reset, never for good: a later
	 * hour that runs out shows it again. The parent shows it only while `out` holds.
	 */
	import { RATE, rateOutText } from "../lib/copy";
	import { language } from "../lib/language.svelte";

	let { resetAt, signedIn, ondismiss }: { resetAt: string; signedIn: boolean; ondismiss: () => void } = $props();

	const time = $derived(
		new Date(resetAt).toLocaleTimeString(language.locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
	);
</script>

<div class="bar" role="status" data-testid="rate-bar">
	<p>
		<span data-testid="rate-out">{rateOutText(time)}</span>
		{#if !signedIn}<span data-testid="rate-signin">{RATE.signIn}</span>{/if}
	</p>
	<button type="button" class="close" aria-label={RATE.dismiss} title={RATE.dismiss} data-testid="rate-dismiss" onclick={ondismiss}>
		<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg>
	</button>
</div>

<style>
	.bar {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 8px 12px 8px 20px;
		background: var(--surface);
		border-bottom: 1px solid var(--line-soft);
		color: var(--text-2);
		font-size: var(--fs-12);
		line-height: 1.45;
	}
	p {
		flex: 1;
		margin: 0;
		min-width: 0;
	}
	p span + span::before {
		content: " ";
	}
	.close {
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		flex: none;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: var(--text-2);
		cursor: pointer;
	}
	.close:hover {
		background: var(--shell-hi);
		color: var(--text);
	}
	path {
		stroke: currentColor;
		stroke-width: 1.5;
		stroke-linecap: round;
	}
</style>
