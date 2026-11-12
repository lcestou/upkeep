<!--
@component
The Language choice in Settings: a button that opens a list drawn by the page, not the desktop's own menu. GTK sets a
native select's menu so the chosen item sits over the box, so a list of eleven ran off the window with scroll arrows
and empty space; this list opens below the button (above it when there is no room) and scrolls inside itself.
It is a listbox: the arrows, Home and End move, Enter or Space picks, Escape, Tab or a click elsewhere closes, and
focus returns to the button. Each language is named in itself and marked with its own `lang`.
-->
<script lang="ts">
	import { LANGUAGES, type LanguageSetting } from "../../shared/languages";
	import { TEXT } from "../lib/copy";

	let {
		value,
		labelledby,
		onpick,
	}: {
		value: LanguageSetting;
		/** The id of the row's label, which names both the button and the list. */
		labelledby: string;
		onpick: (v: LanguageSetting) => void;
	} = $props();

	// $derived: the "Same as the system" label follows a language switch.
	const options: { v: LanguageSetting; label: string; lang: string | undefined }[] = $derived([
		{ v: "system", label: TEXT.languageSystem, lang: undefined },
		...LANGUAGES.map((l) => ({ v: l.code, label: l.name, lang: l.code })),
	]);
	const shown = $derived(options.find((o) => o.v === value) ?? options[0]);

	let open = $state(false);
	let active = $state(0);
	let button: HTMLButtonElement | undefined = $state();
	let list: HTMLUListElement | undefined = $state();
	/** Where the list sits, in the window's coordinates: under the button, or over it when the window ends first. */
	let place = $state({ top: 0, right: 0, up: false });

	const ROW = 30;
	const MAX = 8;

	/** Opens the list on the chosen language and places it where it fits. */
	function show() {
		if (!button) return;
		const r = button.getBoundingClientRect();
		const height = Math.min(options.length, MAX) * ROW + 8;
		const up = r.bottom + 4 + height > window.innerHeight && r.top - 4 - height > 0;
		place = { top: up ? r.top - 4 - height : r.bottom + 4, right: window.innerWidth - r.right, up };
		active = Math.max(
			0,
			options.findIndex((o) => o.v === value),
		);
		open = true;
		queueMicrotask(() => {
			list?.focus();
			list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
		});
	}

	/** Closes the list and gives focus back to the button. */
	function hide() {
		open = false;
		button?.focus();
	}

	/** Picks an option, closes the list, and tells the row. */
	function pick(v: LanguageSetting) {
		hide();
		if (v !== value) onpick(v);
	}

	/**
	 * The down and up arrows open the list, as a select does. Enter and Space are the button's own click, which
	 * toggles it: handling them here too would open it on the key press and close it again on the click.
	 */
	function onbutton(e: KeyboardEvent) {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			show();
		}
	}

	/** Moves through the list, picks, or closes it; Escape and Tab close it with focus back on the button. */
	function onlist(e: KeyboardEvent) {
		const last = options.length - 1;
		const to = new Map([
			["ArrowDown", Math.min(last, active + 1)],
			["ArrowUp", Math.max(0, active - 1)],
			["Home", 0],
			["End", last],
		]).get(e.key);
		if (to !== undefined) {
			e.preventDefault();
			active = to;
			list?.querySelectorAll('[role="option"]')[to]?.scrollIntoView({ block: "nearest" });
		} else if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			const o = options[active];
			if (o) pick(o.v);
		} else if (e.key === "Escape" || e.key === "Tab") {
			// Tab too: the list leaves the page before the browser would move focus, so focus goes back to the button,
			// as a native select keeps it.
			e.preventDefault();
			hide();
		}
	}

	/** A press anywhere outside the button and the list closes it, as a menu does. */
	function outside(e: PointerEvent) {
		if (!open || !(e.target instanceof Node)) return;
		if (button?.contains(e.target) || list?.contains(e.target)) return;
		open = false;
	}
</script>

<svelte:window onpointerdown={outside} onresize={() => (open = false)} />
<!-- The list is fixed to the window, so a scroll of the page under it closes it; a scroll inside the list does not. -->
<svelte:document onscrollcapture={(e) => (open = open && e.target === list)} />

<button
	bind:this={button}
	type="button"
	class="pick"
	aria-haspopup="listbox"
	aria-expanded={open}
	aria-labelledby={[labelledby, "language-shown"].join(" ")}
	data-testid="setting-language"
	onclick={() => (open ? hide() : show())}
	onkeydown={onbutton}
>
	<span id="language-shown" lang={shown?.lang}>{shown?.label}</span>
	<span class="caret" aria-hidden="true"></span>
</button>
{#if open}
	<ul
		bind:this={list}
		role="listbox"
		tabindex="-1"
		class="list"
		class:up={place.up}
		style:top="{place.top}px"
		style:right="{place.right}px"
		style:max-height="{MAX * ROW + 8}px"
		aria-labelledby={labelledby}
		aria-activedescendant="language-{options[active]?.v}"
		data-testid="setting-language-list"
		onkeydown={onlist}
	>
		{#each options as o, i (o.v)}
			<li
				id="language-{o.v}"
				role="option"
				aria-selected={o.v === value}
				class:active={i === active}
				lang={o.lang}
				data-testid="setting-language-{o.v}"
				onpointerenter={() => (active = i)}
				onpointerup={() => pick(o.v)}
			>
				{o.label}
			</li>
		{/each}
	</ul>
{/if}

<style>
	.pick {
		display: inline-flex;
		align-items: center;
		gap: var(--s2);
		height: 30px;
		min-width: 64px;
		padding: 0 var(--s2);
		border-radius: var(--radius);
		border: 1px solid var(--line);
		background: var(--ground);
		color: var(--text);
		font-family: var(--mono);
		font-size: var(--fs-12);
		cursor: pointer;
	}
	.pick:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	/* The native select's filled triangle, drawn in the text colour. */
	.caret {
		width: 0;
		height: 0;
		border-left: 4px solid transparent;
		border-right: 4px solid transparent;
		border-top: 5px solid currentColor;
	}
	/* Fixed to the window, so the settings sheet's rounded clip never cuts it. */
	.list {
		position: fixed;
		z-index: 20;
		min-width: 180px;
		margin: 0;
		padding: 4px;
		list-style: none;
		overflow-y: auto;
		border-radius: var(--radius);
		border: 1px solid var(--line);
		background: var(--ground);
		box-shadow: 0 6px 18px oklch(0.1 0.03 160 / 0.45);
		font-family: var(--mono);
		font-size: var(--fs-12);
	}
	.list:focus {
		outline: none;
	}
	li {
		display: flex;
		align-items: center;
		height: 30px;
		padding: 0 var(--s2);
		border-radius: calc(var(--radius) - 2px);
		color: var(--text-2);
		white-space: nowrap;
		cursor: pointer;
	}
	li.active {
		background: var(--shell-hi);
		color: var(--text);
	}
	li[aria-selected="true"] {
		color: var(--text);
		font-weight: 600;
	}
</style>
