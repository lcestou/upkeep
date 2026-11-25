<script lang="ts">
	import { say } from "../lib/engine-say";
	import type { ImportAsk, ImportSwitch, Settings } from "../../shared/types";
	import {
		CHECK_EVERY,
		CLEAN,
		IMPORT,
		SELF,
		SYS,
		TEXT,
		UNINSTALL,
		WAIT_DAYS,
		WIN,
		exportedNote,
		importAutoOffNote,
		importPlain,
		importedNote,
		rateText,
		setupFailed,
		tokenKeptLine,
		versionText,
	} from "../lib/copy";
	import { LOCKUP_SVG } from "../lib/brand";
	import { followSetting } from "../lib/language.svelte";
	import type { Model } from "../lib/model.svelte";
	import LanguagePicker from "./LanguagePicker.svelte";
	import { tick } from "svelte";
	import type { Attachment } from "svelte/attachments";

	let { model }: { model: Model } = $props();
	let askingUninstall = $state(false);
	let purge = $state(false);
	let uninstallSaid = $state<string | null>(null);
	let closing = $state(false);

	/** Opens the uninstall question and brings it into view: it sits at the very end of Settings. */
	async function askUninstall() {
		askingUninstall = true;
		await tick();
		// The whole question with its buttons, not only its first line.
		document.querySelector('[aria-labelledby="uninstall-ask"]')?.scrollIntoView({ block: "nearest" });
	}

	/** Asks the main process to uninstall; on ok Upkeep quits by itself, otherwise the reason shows under the question. */
	async function uninstall() {
		uninstallSaid = null;
		const res = await model.send("uninstall", { purge });
		if (res?.ok) closing = true;
		else uninstallSaid = res?.problem ?? null;
	}

	// The span carries the name; the drawing inside is hidden from assistive tech.
	const lockup = LOCKUP_SVG.replace("<svg ", '<svg aria-hidden="true" focusable="false" ');
	// $derived: the labels follow a language switch.
	const frames = $derived([
		{ v: "own", t: WIN.frameOwn },
		{ v: "system", t: WIN.frameSystem },
	] as const);
	// $derived: the labels follow a language switch.
	const cornerChoices = $derived([
		{ v: "rounded", t: WIN.cornersRounded },
		{ v: "square", t: WIN.cornersSquare },
	] as const);
	// $derived: the labels follow a language switch. The main process builds each address; the view only names it.
	const ABOUT_LINKS = $derived([
		{ what: "changelog", label: WIN.whatsNew },
		{ what: "bug", label: WIN.reportBug },
		{ what: "repo", label: WIN.onGitHub },
	] as const);
	// $derived: the labels follow a language switch.
	const sides = $derived([
		{ v: "auto", t: WIN.buttonsAuto },
		{ v: "left", t: WIN.buttonsLeft },
		{ v: "right", t: WIN.buttonsRight },
	] as const);

	/** One tab stop per group, on the checked option; the arrows move and select, Home and End go to the ends. */
	function onseg(e: KeyboardEvent) {
		const group = e.currentTarget instanceof HTMLElement ? e.currentTarget.closest('[role="radiogroup"]') : null;
		if (!group) return;
		const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
		const i = radios.findIndex((r) => r === e.currentTarget);
		const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
		const to =
			e.key === "Home"
				? 0
				: e.key === "End"
					? radios.length - 1
					: step === undefined
						? -1
						: (i + step + radios.length) % radios.length;
		const next = radios[to];
		if (!next) return;
		e.preventDefault();
		next.focus();
		next.click();
	}

	/** What the last Export or Import did, in place of the help line; null shows the help. */
	let note = $state<string | null>(null);

	/** Asks for a folder and saves the export there; a cancelled dialog says nothing. */
	async function exportSetup() {
		const r = await model.send("exportSetup", {});
		if (r?.file) note = exportedNote(r.file);
		else if (r?.problem) note = setupFailed(say(r.problem));
	}

	/** What the picked file's apps would run, while Import waits on the person; null when nothing is asked. */
	let importAsk = $state<ImportAsk | null>(null);

	/**
	 * Asks for an export and replaces the settings and list from it; the window follows through its events. sure is the
	 * press on the ask's Import: the main process then writes the file it asked about, not a newly picked one.
	 */
	async function importSetup(sure = false) {
		const shown = importAsk;
		importAsk = null;
		const r = await model.send("importSetup", sure ? { sure } : {});
		if (r?.ask) importAsk = r.ask;
		else if (r?.ok) {
			const off = r.autoOff ?? 0;
			note = off > 0 ? `${importedNote(r.apps ?? 0)} ${importAutoOffNote(off)}` : importedNote(r.apps ?? 0);
		}
		else if (r?.problems?.length) {
			note = setupFailed(r.problems.map((p) => say(p)).join(" "));
			// A refused Import (a run started) keeps the ask open, so the press can be made again once the run ends.
			if (sure) importAsk = shown;
		}
	}

	/** The last four characters of the kept GitHub token, or null; the token itself never reaches the window. */
	let tokenHint = $state<string | null>(null);
	let tokenDraft = $state("");
	/** Why the last paste was not kept: not a token's characters, or GitHub answered it 401. */
	let tokenProblem = $state<"shape" | "refused" | null>(null);
	/** The last check found GitHub refusing the kept token: "gh" when gh's sign-in stood in. */
	let tokenFallback = $state<"gh" | "none" | null>(null);
	$effect(() => {
		void model.send("token", {}).then((r) => {
			if (!r) return;
			tokenHint = r.hint;
			tokenFallback = r.refused;
		});
	});

	/** Saves the pasted token, or forgets the kept one with null. A refused paste stays in the field with the reason under it. */
	async function setToken(token: string | null) {
		const r = await model.send("setToken", { token });
		if (!r) return;
		tokenProblem = r.ok ? null : (r.problem ?? "shape");
		tokenHint = r.hint;
		tokenFallback = r.refused;
		if (r.ok) tokenDraft = "";
	}

	/** The Settings label of what an import would turn on, the same words the person finds the switch under. */
	function switchName(k: ImportSwitch): string {
		const names = {
			notify: TEXT.notify,
			checkAtLogin: TEXT.startAtLogin,
			selfAuto: SELF.auto,
			upkeepCommand: TEXT.upkeepCommand,
			system: SYS.setting,
			systemInstall: SYS.installSetting,
			cleanup: CLEAN.setting,
			devCaches: CLEAN.devSetting,
		} satisfies Record<ImportSwitch, string>;
		return names[k];
	}

	/** A release wait in Settings' own words: "Off", "3 days". */
	const waitLabel = (d: number) => WAIT_DAYS.find((o) => o.v === d)?.label ?? String(d);

	/** Focus lands on Cancel when the ask opens, so a stray Enter writes nothing. */
	const focusFirst: Attachment<HTMLButtonElement> = (node) => {
		node.focus();
	};

	/** Sends a settings change and shows what the main process saved; a request that fails leaves the old values on screen. */
	async function set(patch: Partial<Settings>) {
		const next = await model.send("setSettings", patch);
		if (!next) return;
		model.settings = next;
		followSetting(next.language, model.desktopLanguages);
	}
</script>

<div class="settings" data-testid="settings">
	<div class="sheet">
		<label class="row">
			<span class="text">{TEXT.notify}</span>
			<input
				type="checkbox"
				checked={model.settings.notify}
				data-testid="setting-notify"
				onchange={(e) => set({ notify: e.currentTarget.checked })}
			/>
		</label>
		<label class="row">
			<span class="text">
				<span data-testid="setting-login-label">{TEXT.startAtLogin}</span>
				<span class="hint" data-testid="setting-login-hint">{TEXT.startAtLoginHint}</span>
			</span>
			<input
				type="checkbox"
				checked={model.settings.checkAtLogin}
				data-testid="setting-login"
				onchange={(e) => set({ checkAtLogin: e.currentTarget.checked })}
			/>
		</label>
		<label class="row">
			<span class="text">
				<span data-testid="setting-command-label">{TEXT.upkeepCommand}</span>
				<span class="hint" data-testid="setting-command-hint">{TEXT.upkeepCommandHint}</span>
			</span>
			<input
				type="checkbox"
				checked={model.settings.upkeepCommand}
				data-testid="setting-command"
				onchange={(e) => set({ upkeepCommand: e.currentTarget.checked })}
			/>
		</label>
		<label class="row">
			<span class="text" data-testid="setting-check-every-label">{TEXT.checkEvery}</span>
			<select
				value={model.settings.checkEvery}
				data-testid="setting-check-every"
				onchange={(e) => {
					const v = e.currentTarget.value;
					const picked = CHECK_EVERY.find((o) => o.v === v);
					if (picked) set({ checkEvery: picked.v });
				}}
			>
				{#each CHECK_EVERY as o (o.v)}
					<option value={o.v}>{o.label}</option>
				{/each}
			</select>
		</label>
		<label class="row">
			<span class="text">
				<span data-testid="setting-wait-label">{TEXT.waitDays}</span>
				<span class="hint" data-testid="setting-wait-hint">{TEXT.waitDaysHint}</span>
			</span>
			<select
				value={String(model.settings.waitDays)}
				data-testid="setting-wait"
				onchange={(e) => {
					const v = Number(e.currentTarget.value);
					const picked = WAIT_DAYS.find((o) => o.v === v);
					if (picked) set({ waitDays: picked.v });
				}}
			>
				{#each WAIT_DAYS as o (o.v)}
					<option value={String(o.v)}>{o.label}</option>
				{/each}
			</select>
		</label>
		<div class="row">
			<span class="text" id="language-label" data-testid="setting-language-label">{TEXT.language}</span>
			<LanguagePicker
				value={model.settings.language}
				labelledby="language-label"
				onpick={(v) => set({ language: v })}
			/>
		</div>
		<label class="row">
			<span class="text">{TEXT.keepBackups}</span>
			<select
				value={String(model.settings.keepBackups)}
				data-testid="setting-keep"
				onchange={(e) => set({ keepBackups: Number(e.currentTarget.value) })}
			>
				{#each [1, 2, 3, 4, 5] as n (n)}
					<option value={String(n)}>{n}</option>
				{/each}
			</select>
		</label>
		<div class="row stack">
			<span class="text">
				<span id="token-label" data-testid="setting-token-label">{TEXT.githubToken}</span>
				<span class="hint" data-testid="setting-token-hint">{TEXT.githubTokenHint}</span>
			</span>
			{#if tokenHint}
				<span class="buttons">
					<span class="kept" data-testid="token-kept">{tokenKeptLine(tokenHint)}</span>
					<button type="button" class="btn small" data-testid="token-remove" onclick={() => setToken(null)}
						>{TEXT.removeToken}</button
					>
				</span>
			{:else}
				<form
					class="buttons"
					onsubmit={(e) => {
						e.preventDefault();
						if (tokenDraft.trim()) void setToken(tokenDraft);
					}}
				>
					<input
						class="token"
						type="password"
						autocomplete="off"
						spellcheck="false"
						aria-labelledby="token-label"
						data-testid="token-input"
						bind:value={tokenDraft}
					/>
					<button type="submit" class="btn small" data-testid="token-save">{TEXT.saveToken}</button>
				</form>
			{/if}
			{#if tokenProblem}<p class="help" role="status" data-testid="token-refused">
					{tokenProblem === "refused" ? TEXT.tokenGithubRefused : TEXT.tokenRefused}
				</p>{/if}
			{#if tokenHint && tokenFallback}<p class="help" role="status" data-testid="token-fallback">
					{tokenFallback === "gh" ? TEXT.tokenFallbackGh : TEXT.tokenFallbackNone}
				</p>{/if}
		</div>
		<div class="row stack">
			<span class="text">{TEXT.appList}</span>
			<span class="buttons">
				<button type="button" class="btn small" data-testid="open-manifest" onclick={() => model.send("open", { what: "manifest" })}
					>{TEXT.openManifest}</button
				>
				<button type="button" class="btn small" data-testid="export-setup" onclick={exportSetup}>{TEXT.exportSetup}</button>
				<button type="button" class="btn small" data-testid="import-setup" onclick={() => importSetup()}
					>{TEXT.importSetup}</button
				>
			</span>
			<p class="help" data-testid="setup-note" aria-live="polite">{note ?? TEXT.setupHelp}</p>
			{#if importAsk}
				<div class="confirm import-ask" role="group" aria-labelledby="import-ask">
					{#if importAsk.apps.length > 0}
						<p id="import-ask" data-testid="import-ask">{IMPORT.ask}</p>
						<ul class="cmds">
							{#each importAsk.apps as a (a.key)}
								<li data-testid="import-app">
									<span class="app-name" data-testid="import-app-name">{a.name}</span>
									{#each a.commands as c, i (i)}<code class="mono" data-testid="import-command">{c}</code>{/each}
								</li>
							{/each}
						</ul>
						{#if importAsk.plain > 0}<p data-testid="import-plain">{importPlain(importAsk.plain)}</p>{/if}
					{/if}
					{#if importAsk.turnsOn.length > 0}
						<p id={importAsk.apps.length > 0 ? undefined : "import-ask"} data-testid="import-turns-on">{IMPORT.turnsOn}</p>
						<ul class="switches">
							{#each importAsk.turnsOn as k (k)}<li data-testid="import-switch">{switchName(k)}</li>{/each}
						</ul>
					{/if}
					{#if importAsk.waitDays}
						<p
							id={importAsk.apps.length > 0 || importAsk.turnsOn.length > 0 ? undefined : "import-ask"}
							data-testid="import-wait"
						>
							{IMPORT.waitShorter}
						</p>
						<ul class="switches">
							<li data-testid="import-wait-change">
								{waitLabel(importAsk.waitDays.from)} → {waitLabel(importAsk.waitDays.to)}
							</li>
						</ul>
					{/if}
					<p data-testid="import-auto-off">{IMPORT.autoOff}</p>
					<div class="confirm-buttons">
						<button type="button" class="btn small primary" data-testid="import-confirm" onclick={() => importSetup(true)}
							>{IMPORT.yes}</button
						>
						<button
							type="button"
							class="btn small"
							data-testid="import-cancel"
							{@attach focusFirst}
							onclick={() => (importAsk = null)}>{IMPORT.no}</button
						>
					</div>
				</div>
			{/if}
		</div>
	</div>
	<h2 class="group">{WIN.group}</h2>
	<div class="sheet">
		<div class="row stack">
			<span class="text" id="frame-label">{WIN.frame}</span>
			<div class="seg" role="radiogroup" aria-labelledby="frame-label" data-testid="setting-frame">
				{#each frames as f (f.v)}
					<button
						type="button"
						role="radio"
						onkeydown={onseg}
						aria-checked={model.settings.frame === f.v}
						tabindex={model.settings.frame === f.v ? 0 : -1}
						data-testid="setting-frame-{f.v}"
						onclick={() => set({ frame: f.v })}>{f.t}</button
					>
				{/each}
			</div>
			<p class="help">{WIN.frameHelp}</p>
		</div>
		{#if model.settings.frame === "own"}
			<div class="row stack">
				<span class="text" id="buttons-label">{WIN.buttons}</span>
				<div class="seg" role="radiogroup" aria-labelledby="buttons-label" data-testid="setting-buttons">
					{#each sides as b (b.v)}
						<button
							type="button"
							role="radio"
						onkeydown={onseg}
							aria-checked={model.settings.buttons === b.v}
						tabindex={model.settings.buttons === b.v ? 0 : -1}
							data-testid="setting-buttons-{b.v}"
							onclick={() => set({ buttons: b.v })}>{b.t}</button
						>
					{/each}
				</div>
			</div>
			<div class="row stack">
				<span class="text" id="corners-label">{WIN.corners}</span>
				<div class="seg" role="radiogroup" aria-labelledby="corners-label" data-testid="setting-corners">
					{#each cornerChoices as c (c.v)}
						<button
							type="button"
							role="radio"
						onkeydown={onseg}
							aria-checked={model.settings.corners === c.v}
						tabindex={model.settings.corners === c.v ? 0 : -1}
							data-testid="setting-corners-{c.v}"
							onclick={() => set({ corners: c.v })}>{c.t}</button
						>
					{/each}
				</div>
				<p class="help">{WIN.cornersHelp}</p>
			</div>
		{/if}
	</div>

	<h2 class="group" data-testid="extras-group">{SYS.extras}</h2>
	<div class="sheet">
		<label class="row stack">
			<span class="text">{SYS.setting}</span>
			<input
				type="checkbox"
				checked={model.extras?.settings.system === "show"}
				disabled={model.extras === null || model.extras.system.phase === "installing"}
				data-testid="setting-system"
				onchange={(e) => model.setExtras({ system: e.currentTarget.checked ? "show" : "off" })}
			/>
			<span class="help" data-testid="setting-system-help">{SYS.settingHelp}</span>
		</label>
		{#if model.extras?.settings.system === "show"}
			<label class="row stack">
				<span class="text">{SYS.installSetting}</span>
				<input
					type="checkbox"
					checked={model.extras.settings.systemInstall === true}
					disabled={model.extras.system.phase === "installing"}
					data-testid="setting-system-install"
					onchange={(e) => model.setExtras({ systemInstall: e.currentTarget.checked })}
				/>
				<span class="help" data-testid="setting-system-install-help">{SYS.installSettingHelp}</span>
			</label>
		{/if}
		<label class="row stack">
			<span class="text">{CLEAN.setting}</span>
			<input
				type="checkbox"
				checked={model.extras?.settings.cleanup === true}
				disabled={model.extras === null}
				data-testid="setting-cleanup"
				onchange={(e) => model.setExtras({ cleanup: e.currentTarget.checked })}
			/>
			<span class="help" data-testid="setting-cleanup-help">{CLEAN.settingHelp}</span>
		</label>
		{#if model.extras?.settings.cleanup}
			<label class="row stack">
				<span class="text">{CLEAN.devSetting}</span>
				<input
					type="checkbox"
					checked={model.extras.settings.devCaches === true}
					data-testid="setting-cleanup-dev"
					onchange={(e) => model.setExtras({ devCaches: e.currentTarget.checked })}
				/>
				<span class="help" data-testid="setting-cleanup-dev-help">{CLEAN.devSettingHelp}</span>
			</label>
		{/if}
	</div>

	<h2 class="group">{WIN.about}</h2>
	<div class="sheet about" data-testid="about">
		<!-- The horizontal lockup for the dark ground carries the mark and the word. Trusted constant markup. -->
		<span class="lockup" role="img" aria-label={WIN.word}>{@html lockup}</span>
		<p class="about-version" data-testid="version">{versionText(model.version)}</p>
		<p class="about-line">{WIN.tagline}</p>
		<label class="auto">
			<input
				type="checkbox"
				checked={model.settings.selfAuto}
				data-testid="setting-self-auto"
				onchange={(e) => set({ selfAuto: e.currentTarget.checked })}
			/>
			<span>
				<span class="auto-label" data-testid="setting-self-auto-label">{SELF.auto}</span>
				<span class="auto-help" data-testid="setting-self-auto-help">{SELF.autoHelp}</span>
			</span>
		</label>
		<div class="about-links">
			{#each ABOUT_LINKS as link (link.what)}
				<button
					type="button"
					class="btn small"
					data-testid="about-{link.what}"
					onclick={() => model.send("open", { what: link.what })}
				>
					{link.label}
					<svg class="ext" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"
						><path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v3.5a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-8a.5.5 0 0 1 .5-.5H7" /></svg
					>
				</button>
			{/each}
		</div>
		<div class="uninstall">
			{#if closing}
				<p role="status" data-testid="uninstall-closing">{UNINSTALL.closing}</p>
			{:else if askingUninstall}
				<div class="confirm" role="group" aria-labelledby="uninstall-ask">
					<p id="uninstall-ask" data-testid="uninstall-ask">{UNINSTALL.ask}</p>
					<label class="purge">
						<input type="checkbox" bind:checked={purge} data-testid="uninstall-purge" />
						<span data-testid="uninstall-purge-label">{UNINSTALL.purge}</span>
					</label>
					<div class="confirm-buttons">
						<button type="button" class="btn small danger" data-testid="uninstall-confirm" onclick={uninstall}
							>{UNINSTALL.yes}</button
						>
						<button type="button" class="btn small" data-testid="uninstall-cancel" onclick={() => (askingUninstall = false)}
							>{UNINSTALL.keep}</button
						>
					</div>
					{#if uninstallSaid}<p class="problem" role="alert" data-testid="uninstall-problem">{say(uninstallSaid)}</p>{/if}
				</div>
			{:else}
				<button type="button" class="btn small quiet" data-testid="uninstall" onclick={askUninstall}>{UNINSTALL.button}</button>
			{/if}
		</div>
	</div>

	<div class="meta">
		{#if model.rate}
			<div data-testid="rate">{rateText(model.rate.remaining, model.rate.limit)}</div>
		{/if}
	</div>
</div>

<style>
	.settings {
		height: 100%;
		overflow: auto;
		padding: var(--s6) var(--s5);
	}
	.sheet {
		max-width: 560px;
		margin: 0 auto;
		border: 1px solid var(--line-soft);
		border-radius: 10px;
		background: var(--surface);
		overflow: hidden;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s4);
		min-height: 52px;
		padding: 0 var(--s4);
		border-bottom: 1px solid var(--line-soft);
		cursor: pointer;
	}
	div.row {
		cursor: default;
	}
	.row:last-child {
		border-bottom: 0;
	}
	.text {
		display: grid;
		gap: 2px;
		padding-block: var(--s2);
		font-size: var(--fs-14);
		color: var(--text);
	}
	.hint {
		font-size: var(--fs-12);
		color: var(--text-2);
	}
	select {
		height: 30px;
		min-width: 64px;
		padding: 0 var(--s2);
		border-radius: var(--radius);
		border: 1px solid var(--line);
		background: var(--ground);
		font-family: var(--mono);
		font-size: var(--fs-12);
		cursor: pointer;
	}
	.group {
		max-width: 560px;
		margin: var(--s6) auto var(--s2);
		padding: 0 var(--s1);
		font-size: var(--fs-13);
		font-weight: 640;
		color: var(--text);
	}
	.stack {
		flex-wrap: wrap;
		padding: var(--s3) var(--s4);
		row-gap: var(--s2);
	}
	.buttons {
		display: inline-flex;
		gap: var(--s2);
	}
	.kept {
		align-self: center;
		font-size: var(--fs-12);
		color: var(--text-2);
	}
	.token {
		height: 30px;
		min-width: 0;
		width: 16em;
		padding: 0 var(--s2);
		border-radius: var(--radius);
		border: 1px solid var(--line);
		background: var(--ground);
		color: var(--text);
		font-family: var(--mono);
		font-size: var(--fs-12);
	}
	.help {
		flex-basis: 100%;
		margin: 0;
		font-size: var(--fs-12);
		color: var(--text-3);
	}
	.seg {
		display: inline-flex;
		padding: 3px;
		gap: 2px;
		border-radius: 8px;
		background: var(--ground);
		border: 1px solid var(--line-soft);
	}
	.seg button {
		height: 26px;
		padding: 0 var(--s3);
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-2);
		font-size: var(--fs-12);
		font-weight: 560;
		cursor: pointer;
	}
	.seg button:hover {
		color: var(--text);
	}
	.seg button[aria-checked="true"] {
		background: var(--shell-hi);
		color: var(--text);
	}
	.about {
		display: grid;
		justify-items: start;
		gap: var(--s1);
		padding: var(--s4);
	}
	/* The lockup's file keeps 48 units of air around a 256-unit drawing: 40 px tall gives the drawing about 28 px. */
	.lockup :global(svg) {
		display: block;
		height: 40px;
		width: auto;
		margin: -6px 0 -6px -7px;
	}
	.about p {
		margin: 0;
	}
	.about-version {
		font-size: var(--fs-12);
		color: var(--text-3);
		font-variant-numeric: tabular-nums;
	}
	.about-line {
		margin-top: var(--s1) !important;
		color: var(--text-2);
	}
	.ext {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.auto {
		display: flex;
		align-items: flex-start;
		gap: var(--s2);
		margin-top: var(--s3);
		max-width: 60ch;
	}
	.auto input {
		margin-top: 2px;
	}
	.auto-label,
	.auto-help {
		display: block;
	}
	.auto-help {
		margin-top: 2px;
		font-size: var(--fs-12);
		color: var(--text-3);
	}
	.about-links {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s2);
		margin-top: var(--s3);
	}
	.uninstall {
		justify-self: stretch;
		margin-top: var(--s4);
		padding-top: var(--s3);
		border-top: 1px solid var(--line-soft);
		font-size: var(--fs-12);
	}
	.confirm {
		display: grid;
		gap: var(--s2);
		padding: var(--s3);
		border: 1px solid var(--line);
		border-radius: var(--radius);
	}
	.confirm p {
		margin: 0;
		color: var(--text);
	}
	.purge {
		display: flex;
		gap: var(--s2);
		align-items: center;
		color: var(--text-2);
	}
	.confirm-buttons {
		display: flex;
		gap: var(--s2);
	}
	.import-ask {
		flex-basis: 100%;
		font-size: var(--fs-13);
	}
	.cmds {
		display: grid;
		gap: var(--s2);
		max-height: 40vh;
		overflow-y: auto;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.cmds li {
		display: grid;
		gap: 2px;
	}
	.switches {
		margin: 0;
		padding-left: var(--s4);
	}
	.app-name {
		font-weight: 560;
		color: var(--text);
	}
	.cmds code {
		display: block;
		overflow-wrap: anywhere;
		font-size: var(--fs-12);
		color: var(--text);
	}
	.danger {
		border-color: var(--fail);
		color: var(--fail);
	}
	.problem {
		color: var(--fail);
	}
	.meta {
		max-width: 560px;
		margin: var(--s4) auto 0;
		display: grid;
		gap: var(--s1);
		padding: 0 var(--s4);
		font-size: var(--fs-12);
		color: var(--text-3);
		font-variant-numeric: tabular-nums;
	}
</style>
