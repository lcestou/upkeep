<script lang="ts">
	import { TEXT } from "../lib/copy";
	import { clockTime } from "../lib/format";
	import type { Model } from "../lib/model.svelte";
	import { ms } from "../lib/motion";
	import { fly } from "svelte/transition";

	let { model, bottom }: { model: Model; bottom: number } = $props();

	let scroller = $state<HTMLElement | null>(null);
	const names = $derived(new Map(model.apps.map((a) => [a.key, a.name])));
	// Following the newest line is on when the drawer opens, even with lines already in it; scrolling up to read an
	// older line pauses it, and so does the Pause button.
	let following = $state(true);
	// Set when Upkeep itself moved the list, so the scroll event that follows a frame later is not read as the reader's.
	let ours = false;

	/**
	 * Moves the list to its newest line and marks the scroll event that move will fire as Upkeep's own. A move that
	 * changes nothing fires no event, so it marks none, and the reader's next scroll still counts.
	 */
	function toBottom(el: HTMLElement): void {
		const was = el.scrollTop;
		el.scrollTop = el.scrollHeight;
		if (el.scrollTop !== was) ours = true;
	}

	$effect(() => {
		void model.log.length;
		const el = scroller;
		if (el && following) toBottom(el);
	});

	/**
	 * A scroll the reader made: up away from the bottom pauses following, back down to the bottom follows again. The
	 * event of Upkeep's own move is skipped: arriving after Pause, it would read as the reader at the bottom and follow
	 * again, which a busy machine made happen often.
	 */
	function scrolled(): void {
		if (ours) {
			ours = false;
			return;
		}
		const el = scroller;
		if (el) following = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
	}

	/** Pauses following where the reader is, or follows again from the newest line. */
	function toggleFollow(): void {
		following = !following;
		const el = scroller;
		if (following && el) toBottom(el);
	}
</script>

<section
	class="drawer"
	id="log-drawer"
	data-testid="log-drawer"
	aria-label={TEXT.logTitle}
	style:bottom="{bottom}px"
	transition:fly={{ y: 24, duration: ms(220) }}
>
	<header>
		<h2>{TEXT.logTitle}</h2>
		<div class="actions">
			<button
				type="button"
				class="btn small"
				id="log-follow"
				data-testid="log-follow"
				onclick={toggleFollow}>{following ? TEXT.logPause : TEXT.logFollow}</button
			>
			<button type="button" class="btn small" data-testid="open-log" onclick={() => model.send("open", { what: "log" })}
				>{TEXT.openLog}</button
			>
		</div>
	</header>
	<div class="scroll" bind:this={scroller} onscroll={scrolled}>
		{#if model.log.length === 0}
			<p class="empty">{TEXT.noLog}</p>
		{:else}
			<ol class="lines mono">
				{#each model.log as line (line.id)}
					<li>
						<time>{clockTime(line.at)}</time>
						<span class="who">{line.key ? (names.get(line.key) ?? line.key) : ""}</span>
						<span class="text">{line.text}</span>
					</li>
				{/each}
			</ol>
		{/if}
	</div>
</section>

<style>
	.drawer {
		position: fixed;
		left: 0;
		right: 0;
		/* A bottom sheet attached to the footer, covering what is behind it: about 45 percent of the list area. */
		height: calc((100vh - 120px) * 0.45);
		display: flex;
		flex-direction: column;
		border-top: 1px solid var(--line);
		background: oklch(0.165 0.02 165);
		box-shadow: var(--shadow-pop);
		z-index: 4;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--s2) var(--s3) var(--s2) var(--s4);
		border-bottom: 1px solid var(--line-soft);
	}
	.actions {
		display: flex;
		gap: var(--s2);
	}
	h2 {
		margin: 0;
		font-size: var(--fs-13);
		font-weight: 640;
	}
	.scroll {
		flex: 1;
		overflow: auto;
		padding: var(--s2) var(--s4) var(--s3);
	}
	.empty {
		margin: var(--s3) 0;
		color: var(--text-3);
	}
	.lines {
		list-style: none;
		margin: 0;
		padding: 0;
		font-size: var(--fs-11);
		line-height: 1.7;
		color: var(--text-2);
	}
	li {
		display: grid;
		grid-template-columns: 64px 128px minmax(0, 1fr);
		gap: var(--s3);
	}
	time {
		color: var(--text-3);
	}
	.who {
		color: var(--water);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.text {
		color: var(--text);
		overflow-wrap: anywhere;
	}
</style>
