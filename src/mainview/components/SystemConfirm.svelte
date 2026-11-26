<script lang="ts">
	import { SYS, systemConfirmSnapshot, systemThenApps } from "../lib/copy";
	import type { Model } from "../lib/model.svelte";
	import type { Attachment } from "svelte/attachments";

	let { model, plan }: { model: Model; plan: { ids: string[]; commands: string[][] } } = $props();

	const root = $derived(plan.commands.some((argv) => argv[0] === "sudo"));
	const firmware = $derived(plan.commands.some((argv) => argv[0] === "fwupdmgr"));
	const apps = $derived(model.tickedApps.length);
	// The snapshot is not one of the commands: it runs first, only while its setting is on and a tool is set up.
	const setup = $derived(model.extras?.system.snapshotSetup ?? null);
	const snapshot = $derived(
		model.extras?.settings.snapshotBeforeSystem === true && setup
			? systemConfirmSnapshot(setup.tool === "snapper" ? "Snapper" : "Timeshift")
			: null,
	);
	/** Focus lands on Not now when the sheet opens, so a stray Enter cancels instead of running root commands. */
	const focusFirst: Attachment<HTMLButtonElement> = (node) => {
		node.focus();
	};
</script>

<!-- The footer's Install with System rows ticked: the commands, read before anything runs. It sits on the footer's
     top edge, over the end of the list. -->
<div class="confirm" role="group" aria-labelledby="system-confirm-ask" data-testid="system-confirm-sheet">
	<p id="system-confirm-ask" data-testid="system-confirm-ask">{SYS.confirmIntro}</p>
	{#if snapshot}<p data-testid="system-confirm-snapshot">{snapshot}</p>{/if}
	<ol class="cmds">
		{#each plan.commands as argv, i (i)}<li><code class="mono" data-testid="system-command">{argv.join(" ")}</code></li>{/each}
	</ol>
	{#if root}<p data-testid="system-confirm-root">{SYS.confirmRoot}</p>{/if}
	{#if firmware}<p data-testid="system-confirm-firmware">{SYS.confirmFirmware}</p>{/if}
	{#if apps > 0}<p data-testid="system-then-apps">{systemThenApps(apps)}</p>{/if}
	<div class="confirm-buttons">
		<button type="button" class="btn small primary" data-testid="system-confirm" onclick={() => model.confirmSystem()}
			>{SYS.confirmYes}</button
		>
		<button
			type="button"
			class="btn small"
			data-testid="system-cancel"
			{@attach focusFirst}
			onclick={() => (model.systemPlan = null)}>{SYS.confirmNo}</button
		>
	</div>
</div>

<style>
	.confirm {
		position: absolute;
		right: var(--s4);
		bottom: calc(100% + var(--s2));
		display: flex;
		flex-direction: column;
		gap: var(--s2);
		width: min(560px, calc(100% - 2 * var(--s4)));
		max-height: 60vh;
		overflow-y: auto;
		padding: var(--s3) var(--s4);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--shell);
		box-shadow: 0 8px 24px oklch(0 0 0 / 0.35);
		font-size: var(--fs-13);
		color: var(--text);
	}
	.confirm p {
		margin: 0;
	}
	.cmds {
		display: flex;
		flex-direction: column;
		gap: var(--s1);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.cmds code {
		display: block;
		overflow-wrap: anywhere;
		font-size: var(--fs-12);
		color: var(--text);
	}
	.confirm-buttons {
		display: flex;
		gap: var(--s2);
	}
</style>
