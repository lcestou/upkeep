<script lang="ts">
	import type { AppSpec, Suggestion } from "../../shared/types";
	import { ADD, TEXT, addApps, addedMany, addedOne, foundApps, tomlWriteFailed } from "../lib/copy";
	import type { Model } from "../lib/model.svelte";
	import { tick } from "svelte";
	import SuggestionCard from "./SuggestionCard.svelte";

	let { model, onclose }: { model: Model; onclose: () => void } = $props();

	// svelte-ignore state_referenced_locally
	let input = $state(model.addInput);
	let busy = $state<"find" | "scan" | "pick" | "add" | null>(null);
	let error = $state<string | null>(null);
	let problem = $state<string | null>(null);
	let found = $state<Suggestion[]>([]);
	let scanned = $state<Suggestion[] | null>(null);
	let scanTicks = $state.raw<ReadonlySet<string>>(new Set());
	let openCard = $state<string | null>(null);
	let failures = $state<Record<string, string>>({});
	let scanNote = $state<string | null>(null);
	/** A file whose repo the owner is about to paste: a Find on that repo uses this file as dest. */
	let pendingPath = $state<string | null>(null);
	let field = $state<HTMLInputElement | null>(null);

	const working = $derived(busy !== null);
	const TOML_FAIL = tomlWriteFailed("").split(":")[0] ?? "";
	const tickedSpecs = $derived((scanned ?? []).filter((s) => scanTicks.has(s.spec.key) && !s.problem));

	// A drop hands text over and asks for a Find: once on opening with it, and again for each later drop.
	// svelte-ignore state_referenced_locally
	let seen = model.addInput ? model.findSeq - 1 : model.findSeq;
	$effect(() => {
		const seq = model.findSeq;
		if (seq === seen) return;
		seen = seq;
		input = model.addInput;
		model.addInput = "";
		pendingPath = null;
		void find();
	});

	/** Runs one request; a rejection (a timeout, a lost window) says so and gives the field back. */
	async function guard<T>(kind: "find" | "scan" | "pick" | "add", run: () => Promise<T>): Promise<T | null> {
		busy = kind;
		error = null;
		try {
			return await run();
		} catch {
			error = ADD.slow;
			return null;
		} finally {
			busy = null;
		}
	}

	const picks = new Map<string, number>();
	/**
	 * Another asset for a scanned program: ask again for that file with the asset named, and swap its row.
	 * Only the latest pick for a row lands, and only in the list it was made in: an older answer that arrives late,
	 * or one for a list a new Scan replaced, is dropped. Other rows stay usable while it waits.
	 */
	async function pickScanAsset(s: Suggestion, asset: string) {
		const from = s.path ?? s.spec.repo;
		if (!from) return;
		const key = s.spec.key;
		const list = scanned;
		const seq = (picks.get(key) ?? 0) + 1;
		picks.set(key, seq);
		error = null;
		const res = await model.send("suggest", { input: from, asset });
		if (picks.get(key) !== seq || scanned !== list || !list) return;
		const next = res?.suggestions[0];
		// The card would otherwise show the picked asset over a row that still holds the old one.
		if (!next) error = res?.problem ?? ADD.slow;
		else scanned = list.map((x) => (x.spec.key === key ? next : x));
	}

	async function find(asset?: string) {
		const text = input.trim();
		// An empty Find clears what the last one said, so the hint reads alone again.
		if (!text) {
			error = null;
			problem = null;
			model.dropProblem = null;
			found = [];
			return;
		}
		problem = null;
		model.dropProblem = null;
		const res = await guard("find", () => model.request("suggest", { input: text, asset }));
		if (!res) return;
		problem = res.problem ?? null;
		const path = pendingPath;
		// shortcut: a pasted repo for a scanned file keeps that file as dest; the engine does not see the path.
		found = path
			? res.suggestions.map((s) => Object.assign({}, s, { path, spec: Object.assign({}, s.spec, { dest: path }) }))
			: res.suggestions;
		failures = {};
	}

	async function pick() {
		const res = await guard("pick", () => model.request("pickFile", {}));
		if (!res?.path) return;
		input = res.path;
		pendingPath = null;
		await find();
	}

	async function scan() {
		found = [];
		problem = null;
		scanNote = null;
		const res = await guard("scan", () => model.request("scan", {}));
		if (!res) return;
		scanned = res.suggestions;
		scanTicks = new Set(res.suggestions.filter((s) => s.confidence === "sure" && !s.problem).map((s) => s.spec.key));
	}

	async function addOne(spec: AppSpec) {
		const res = await guard("add", () => model.request("addApps", { specs: [spec] }));
		if (!res) return;
		const fail = res.problems.find((p) => p.key === spec.key);
		if (fail) {
			failures = { ...failures, [spec.key]: fail.detail };
			return;
		}
		model.select(spec.key);
		model.reveal++;
		model.flash("added", addedOne(spec.name), spec.key);
		await focusRow(spec.key);
	}

	async function addScanned() {
		const specs = tickedSpecs.map((s) => s.spec);
		const res = await guard("add", () => model.request("addApps", { specs }));
		if (!res || !scanned) return;
		const added = new Set(res.added);
		const fails = Object.fromEntries(res.problems.map((p) => [p.key, p.detail]));
		scanned = scanned.filter((s) => !added.has(s.spec.key));
		failures = { ...failures, ...fails };
		scanTicks = new Set([...scanTicks].filter((k) => !added.has(k)));
		scanNote = res.added.length > 0 ? addedMany(res.added.length) : null;
		model.reveal++;
		if (res.added[0]) await focusRow(res.added[0]);
	}

	/** Focus goes to the new app's row once it is drawn; under 900 px the sheet keeps it instead, and the list is inert. */
	async function focusRow(key: string) {
		await tick();
		await tick();
		const row = document.querySelector<HTMLElement>(`[data-row="${CSS.escape(key)}"]`);
		row?.scrollIntoView({ block: "nearest" });
		if (row && !row.closest("[inert]")) row.focus({ preventScroll: true });
	}

	// shortcut: assumes the Linux /home/<user> layout for "~"; upgrade when the bridge reports the home dir.
	const tilde = (path: string) => path.replace(/^\/home\/[^/]+(?=\/)/, "~");

	function toggleTick(key: string) {
		const next = new Set(scanTicks);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		scanTicks = next;
	}

	async function pasteRepo(s: Suggestion) {
		pendingPath = s.path ?? null;
		input = "";
		await tick();
		field?.focus();
	}

	function onfieldkey(e: KeyboardEvent) {
		if (e.key === "Enter") {
			e.preventDefault();
			void find();
		}
	}
</script>

<section class="add" data-testid="add-pane" aria-labelledby="add-title">
	<header class="head">
		<h2 id="add-title">{ADD.title}</h2>
		<button type="button" class="close btn small" data-testid="inspector-close" onclick={onclose}>
			<svg class="x" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
			<svg class="back" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
			<span class="backtext">{TEXT.backToList}</span>
		</button>
	</header>

	<div class="ask">
		<label for="add-input" class="label">{ADD.label}</label>
		<div class="row">
			<input
				id="add-input"
				type="text"
				placeholder={ADD.placeholder}
				autocomplete="off"
				spellcheck="false"
				data-testid="add-input"
				readonly={working}
				aria-invalid={error || problem ? "true" : undefined}
				aria-describedby={[error && "add-error", problem && "add-problem", "add-hint"].filter(Boolean).join(" ")}
				bind:value={input}
				bind:this={field}
				{@attach (node: HTMLInputElement) => node.focus()}
				onkeydown={onfieldkey}
			/>
			<button type="button" class="btn" data-testid="add-find" aria-disabled={working} onclick={() => !working && find()}>
				{#if busy === "find"}<span class="spin" aria-hidden="true"></span>{ADD.finding}{:else}{ADD.find}{/if}
			</button>
		</div>
		<p class="hint" id="add-hint">{ADD.hint}</p>
		{#if pendingPath}<p class="hint mono" data-testid="pending-path">{pendingPath}</p>{/if}
		<div class="more">
			<button type="button" class="btn small" data-testid="add-pick" aria-disabled={working} onclick={() => !working && pick()}
				>{ADD.pick}</button
			>
			<button type="button" class="btn small" data-testid="add-scan" aria-disabled={working} onclick={() => !working && scan()}>
				{#if busy === "scan"}<span class="spin" aria-hidden="true"></span>{ADD.scanning}{:else}{ADD.scan}{/if}
			</button>
		</div>
		<p class="status" role="status" data-testid="add-status">
			{#if busy === "find" || busy === "pick"}{ADD.lookingRelease}{:else if busy === "scan"}{ADD.lookingDisk}{/if}
		</p>
		{#if error}<p class="problem" id="add-error" role="alert" data-testid="add-error">{error}</p>{/if}
		{#if model.dropProblem}<p class="problem" data-testid="drop-problem">{model.dropProblem}</p>{/if}
		{#if problem}<p class="problem" id="add-problem" role="alert" data-testid="add-problem">{problem}</p>{/if}
	</div>

	{#each found as s (s.spec.key + (s.asset?.name ?? ""))}
		<SuggestionCard
			suggestion={s}
			busy={working}
			failure={failures[s.spec.key] ?? null}
			onadd={addOne}
			onasset={(asset) => find(asset)}
			onmanifest={() => model.send("open", { what: "manifest" })}
		/>
	{/each}

	{#if scanned}
		<div class="scan" data-testid="scan-results">
			<h3>{scanned.length === 0 ? ADD.nothingNew : foundApps(scanned.length)}</h3>
			{#if scanNote}<p class="note" role="status" data-testid="scan-note">{scanNote}</p>{/if}
			<ul>
				{#each scanned as s (s.spec.key)}
					{@const file = s.path?.split("/").pop() ?? s.spec.name}
					<li class:problem-row={!!s.problem}>
						<div class="line">
							<span class="tickcell">
								{#if !s.problem}
									<input
										type="checkbox"
										checked={scanTicks.has(s.spec.key)}
										aria-label={file}
										data-testid="scan-tick-{s.spec.key}"
										onchange={() => toggleTick(s.spec.key)}
									/>
								{/if}
							</span>
							<span class="what">
								<span class="tag-name file" data-testid="scan-name-{s.spec.key}">{file}</span>
								<span class="mono path" title={s.path}>
									{#each tilde(s.path ?? "").split("/") as part, i (i)}{i > 0 ? "/" : ""}<wbr />{part}{/each}
								</span>
								{#if failures[s.spec.key]}
									<span class="fail" data-testid="scan-fail-{s.spec.key}">{failures[s.spec.key]}</span>
									{#if failures[s.spec.key]?.startsWith(TOML_FAIL)}<button
											type="button"
											class="btn small toml"
											data-testid="scan-open-manifest-{s.spec.key}"
											onclick={() => model.send("open", { what: "manifest" })}>{TEXT.openManifest}</button
										>{/if}
								{:else if s.problem}
									<span class="why">{s.problem}</span>
								{:else if s.spec.repo}
									<span class="latin">{s.spec.repo}</span>
								{/if}
							</span>
							<span class="acts">
								{#if s.problem}
									<button type="button" class="btn small" data-testid="paste-repo-{s.spec.key}" onclick={() => pasteRepo(s)}
										>{ADD.pasteRepo}</button
									>
								{:else}
									<button
										type="button"
										class="btn small quiet disclose"
										aria-expanded={openCard === s.spec.key}
										aria-label={s.spec.name}
										data-testid="scan-open-{s.spec.key}"
										onclick={() => (openCard = openCard === s.spec.key ? null : s.spec.key)}
									>
										<svg class="chev" class:open={openCard === s.spec.key} viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"
											><path d="M4.5 2.5 8 6l-3.5 3.5" /></svg
										>
									</button>
								{/if}
							</span>
						</div>
						{#if openCard === s.spec.key}
							<SuggestionCard
								suggestion={s}
								busy={working}
								failure={failures[s.spec.key] ?? null}
								onadd={addOne}
								onasset={(asset) => pickScanAsset(s, asset)}
							/>
						{/if}
					</li>
				{/each}
			</ul>
			{#if scanned.some((s) => !s.problem)}
				<div class="scanfoot">
					<button
						type="button"
						class="btn small"
						data-testid="scan-all"
						onclick={() => (scanTicks = new Set(scanned?.filter((s) => !s.problem).map((s) => s.spec.key)))}
						>{TEXT.selectAll}</button
					>
					<button type="button" class="btn small" data-testid="scan-none" onclick={() => (scanTicks = new Set())}
						>{TEXT.selectNone}</button
					>
					<button
						type="button"
						class="btn primary"
						data-testid="scan-add"
						disabled={tickedSpecs.length === 0 || working}
						title={tickedSpecs.length === 0 ? ADD.tickToAdd : undefined}
						onclick={addScanned}>{addApps(tickedSpecs.length)}</button
					>
				</div>
			{/if}
		</div>
	{/if}
</section>

<style>
	.add {
		display: grid;
		gap: var(--s4);
		padding: 0 var(--s5) var(--s6);
	}
	.head {
		display: flex;
		align-items: center;
		gap: var(--s2);
		padding: var(--s4) 0 var(--s3);
		border-bottom: 1px solid var(--line-soft);
	}
	h2 {
		flex: 1;
		margin: 0;
		font-size: var(--fs-19);
		font-weight: 640;
	}
	.close {
		flex: none;
		min-width: 28px;
		height: 28px;
		padding: 0 6px;
	}
	.close svg,
	.chev {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.back,
	.backtext {
		display: none;
	}
	@media (max-width: 899px) {
		.close {
			order: -1;
			margin-right: var(--s2);
			padding: 0 var(--s3) 0 var(--s2);
		}
		.x {
			display: none;
		}
		.back,
		.backtext {
			display: inline;
		}
	}
	@media (min-width: 900px) {
		.backtext {
			display: inline;
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip: rect(0, 0, 0, 0);
			white-space: nowrap;
		}
	}
	.ask {
		display: grid;
		gap: var(--s2);
	}
	.label {
		font-size: var(--fs-12);
		font-weight: 600;
		color: var(--text-2);
	}
	.row {
		display: flex;
		gap: var(--s2);
	}
	#add-input {
		flex: 1;
		min-width: 0;
		height: 32px;
		padding: 0 var(--s3);
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--ground);
		color: var(--text);
		font-family: var(--mono);
		font-stretch: 87.5%;
		font-size: var(--fs-12);
	}
	#add-input::placeholder {
		color: var(--text-3);
	}
	#add-input[readonly] {
		opacity: 0.7;
	}
	.hint {
		margin: 0;
		font-size: var(--fs-12);
		color: var(--text-3);
		overflow-wrap: anywhere;
	}
	.more {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s2);
		margin-top: var(--s1);
	}
	.status {
		margin: 0;
		min-height: 1.4em;
		font-size: var(--fs-12);
		color: var(--water);
	}
	.problem,
	.fail {
		margin: 0;
		font-size: var(--fs-12);
		color: var(--fail);
	}
	.spin {
		width: 12px;
		height: 12px;
		border: 2px solid oklch(0.955 0.012 110 / 0.25);
		border-top-color: var(--text);
		border-radius: 50%;
		animation: spin 800ms linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(1turn);
		}
	}
	.scan {
		display: grid;
		gap: var(--s2);
	}
	h3 {
		margin: 0;
		font-size: var(--fs-13);
		font-weight: 640;
	}
	.note {
		margin: 0;
		font-size: var(--fs-12);
		color: var(--leaf);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		border-top: 1px solid var(--line-soft);
	}
	li {
		display: grid;
		gap: var(--s2);
		padding: var(--s2) 0;
		border-bottom: 1px solid var(--line-soft);
	}
	.line {
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr) auto;
		gap: var(--s2);
		align-items: start;
	}
	.tickcell {
		display: flex;
		justify-content: center;
		padding-top: 2px;
	}
	.what {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.file {
		color: var(--text);
		overflow-wrap: anywhere;
	}
	.toml {
		justify-self: start;
		margin-top: var(--s1);
	}
	/* A path breaks only after a slash, never inside a name. */
	.path {
		font-size: var(--fs-11);
		color: var(--text-3);
		overflow-wrap: normal;
		word-break: keep-all;
	}
	.why {
		font-size: var(--fs-12);
		color: var(--text-2);
	}
	.acts {
		display: flex;
		align-items: center;
	}
	.chev {
		transition: transform 150ms ease-out;
	}
	.chev.open {
		transform: rotate(90deg);
	}
	.scanfoot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s2);
		justify-content: flex-end;
	}
	@media (prefers-reduced-motion: reduce) {
		.spin {
			animation: none;
		}
	}
</style>
