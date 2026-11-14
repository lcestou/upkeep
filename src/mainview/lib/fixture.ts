// The dev bridge: the 32 seeded apps with the real pending list of 2026-11-10, and a scripted run.
import type {
	AppKind,
	AppState,
	AppStatus,
	Bridge,
	CleanupId,
	CleanupOutcome,
	CleanupPick,
	CleanupState,
	EngineEvent,
	ExtrasSettings,
	ExtrasSnapshot,
	HistoryRow,
	LogLine,
	Requests,
	RequestHandlers,
	RunResult,
	RunState,
	SelfState,
	Settings,
	Snapshot,
	Stage,
	Suggestion,
	SystemState,
	WindowButton,
	WindowChrome,
} from "../../shared/types";
import { PICKED, scanResults, suggestFor } from "./fixture-add";
import { afterClean, fixtureCleanupItems, fixtureReview } from "./fixture-cleanup";
import { lastTryFailed, tomlWriteFailed } from "./copy";
import { MESSAGES } from "../../shared/messages";
import { type SystemVariant, fixtureInstallable, fixtureOutcome, fixturePlan, systemFor } from "./fixture-system";

export type FixtureVariant = "default" | "empty" | "checking" | "problems" | "many" | "built" | "none";

type Seed = {
	key: string;
	name: string;
	kind: AppKind;
	repo?: string;
	installed: string | null;
	latest?: string | null;
	status?: AppStatus;
	size?: number;
	detail?: string;
	running?: boolean;
	sudo?: boolean;
	auto?: boolean;
	versionless?: boolean;
	run?: string;
	note?: string;
	dest?: string;
	restore?: string[];
	stages?: [Stage, number][];
	notes?: string;
	publishedDaysAgo?: number;
	/** Read in place of CAN_RESTORE for the kind: a source row with dir or stage keeps a restore point. */
	canRestore?: boolean;
	/** How the table restarts the app: relaunch closes and reopens it, restart runs an argv. */
	restarts?: "relaunch" | "restart";
	commits?: { sha: string; title: string }[];
	ahead?: number;
};

export const ZEN_NOTES =
	"# Zen Stable Release\n\n\n## Security\n- https://www.mozilla.org/en-US/security/advisories/mfsa2026-123/\n\n## New Features\n- Updated to Firefox 159.0.1\n- New grain options have been added to the theme picker. You can cycle through different grain effects by clicking on the circle inside the dial.\n\n## Fixes\n- Fixed a command prompt window briefly appearing on Windows when Zen restarts to apply an update.\n- Fixed passkey sign-in failing on websites that share passkeys across related sites, such as Facebook and Instagram.\n- Fixed crashes on Windows that could occur with some antivirus or other security software installed, in some cases also leaving WebGL disabled.\n- Fixed red and blue colors appearing swapped on some websites that use WebGL on Linux, including video call background effects.\n- More bug fixes and improvements.\n\n## Changes\n- On macOS, icons on the UI will now start using SF Symbols.\n- The 'About Zen' window has been redesigned.\n- 'My Review Request' option for Pull Requests live folder now searches for 'user-review-requested:@me' instead of 'review-requested:@me'";

const NOTE_SESSIONS = "Open sessions keep the old version until restarted.";

const SEEDS: Seed[] = [
	{
		key: "zen",
		name: "Zen Browser",
		kind: "appimage",
		repo: "zen-browser/desktop",
		installed: "1.24b",
		latest: "1.24.1b",
		status: "ready",
		size: 108_940_288,
		running: true,
		dest: "~/.local/bin/zen-browser.AppImage",
		restore: ["1.23.4b"],
		restarts: "relaunch",
		stages: [
			["download", 72],
			["backup", 8],
			["install", 12],
			["verify", 8],
		],
		// Zen's real release body, fetched 2026-11-10.
		notes: ZEN_NOTES,
		publishedDaysAgo: 2,
	},
	{
		key: "ghostty",
		name: "Ghostty Terminal",
		kind: "appimage",
		repo: "pkgforge-dev/ghostty-appimage",
		installed: "1.3.1",
		running: true,
		dest: "~/.local/bin/ghostty.appimage",
		restore: ["1.3.0"],
	},
	{
		key: "lrcget",
		name: "LRCGET",
		kind: "appimage",
		repo: "tranxuanthang/lrcget",
		installed: null,
		latest: "1.0.2",
		status: "problem",
		detail: "Could not read the version from the AppImage's metainfo.",
		dest: "~/.local/bin/lrcget",
	},
	{
		key: "starship",
		name: "Starship",
		kind: "archive",
		repo: "starship/starship",
		installed: "1.24.1",
		sudo: true,
		dest: "/usr/local/bin/starship",
		restore: ["1.24.0"],
	},
	{ key: "yazi", name: "Yazi", kind: "archive", repo: "sxyazi/yazi", installed: "26.1.22", restore: ["25.5.31"] },
	{ key: "zoxide", name: "Zoxide", kind: "archive", repo: "ajeetdsouza/zoxide", installed: "0.9.9" },
	{ key: "bat", name: "bat", kind: "archive", repo: "sharkdp/bat", installed: "0.26.1", restore: ["0.26.0"] },
	{
		key: "fd",
		name: "fd",
		kind: "archive",
		repo: "sharkdp/fd",
		installed: "10.5.1",
		latest: "10.5.2",
		status: "ready",
		size: 1_203_456,
		dest: "~/.local/bin/fd",
		restore: ["10.5.0"],
		stages: [
			["download", 44],
			["backup", 12],
			["install", 26],
			["verify", 18],
		],
		notes:
			"Bugfixes\n- Fix --exec-batch when combined with --max-results.\n- Respect .ignore files in parent directories again.\n\nChanges\n- Colorize symlinks to directories like ls does.",
		publishedDaysAgo: 3,
	},
	{ key: "fzf", name: "fzf", kind: "archive", repo: "junegunn/fzf", installed: "0.68.0", restore: ["0.67.0"] },
	{ key: "rtk", name: "rtk", kind: "archive", repo: "rtk-ai/rtk", installed: "0.31.2", restore: ["0.31.0"] },
	{ key: "uv", name: "uv", kind: "archive", repo: "astral-sh/uv", installed: "0.10.4", restore: ["0.10.2"] },
	{ key: "bun", name: "Bun", kind: "archive", repo: "oven-sh/bun", installed: "1.4.4", restore: ["1.4.3"] },
	{
		key: "borg",
		name: "BorgBackup",
		kind: "file",
		repo: "borgbackup/borg",
		installed: "1.4.3",
		dest: "~/.local/bin/borg",
	},
	{ key: "rustdesk", name: "RustDesk", kind: "deb", repo: "rustdesk/rustdesk", installed: "1.4.4", sudo: true },
	{ key: "lutris", name: "Lutris", kind: "deb", repo: "lutris/lutris", installed: "0.5.21", sudo: true },
	{ key: "tmux", name: "tmux", kind: "source", repo: "tmux/tmux", installed: "3.6a", sudo: true },
	{ key: "cava", name: "CAVA", kind: "source", repo: "karlstav/cava", installed: "0.10.6", sudo: true },
	{ key: "claude", name: "Claude Code", kind: "command", installed: "2.4.12", auto: true, note: NOTE_SESSIONS },
	{ key: "omp", name: "omp", kind: "command", installed: "14.2.0", auto: true, note: NOTE_SESSIONS },
	{ key: "opencode", name: "opencode", kind: "command", installed: "1.3.8", auto: true, note: NOTE_SESSIONS },
	{
		key: "wrangler",
		name: "wrangler",
		kind: "command",
		installed: "4.157.0",
		latest: "4.160.0",
		status: "ready",
		auto: true,
		stages: [
			["install", 82],
			["verify", 18],
		],
		notes: "Minor Changes\n- Add `wrangler deploy --strict` to refuse a deploy that would delete bindings.",
		publishedDaysAgo: 1,
	},
	{
		key: "cursor",
		name: "Cursor",
		kind: "appimage",
		installed: "3.29.9",
		latest: "3.29.15",
		status: "ready",
		dest: "~/.local/bin/cursor.appimage",
		restarts: "relaunch",
	},
	{
		key: "dsh",
		name: "dsh",
		kind: "manual",
		installed: "0.1.7",
		run: "dsh-update",
		note: "Never installed unattended. dsh-update asks, stops dsh-web, smoke-tests and rolls back.",
	},
	{ key: "pr-agent", name: "pr-agent", kind: "command", installed: "0.48.2", auto: true },
	{ key: "headroom", name: "headroom", kind: "command", installed: "0.9.1", auto: true },
	{
		key: "claude-code-telegram",
		name: "claude-code-telegram",
		kind: "manual",
		installed: "1.6.0",
		run: "uv tool install --reinstall claude-code-telegram",
	},
	{
		key: "claude-plugins",
		name: "Claude Code plugins",
		kind: "claude-plugins",
		installed: null,
		versionless: true,
		auto: true,
	},
	{ key: "omp-ponytail", name: "omp plugin ponytail", kind: "command", installed: "5.3.3", auto: true },
	{ key: "whisper", name: "whisper.cpp", kind: "manual", installed: "1.8.2", run: "whisper-update" },
	{
		key: "llama",
		name: "llama.cpp",
		kind: "manual",
		installed: "b7712",
		latest: "b7790",
		status: "manual",
		run: "llama-update",
	},
	{
		key: "strata",
		name: "Strata",
		kind: "manual",
		installed: "0.2.10",
		latest: "0.2.13",
		status: "manual",
		run: "strata-update",
	},
	{
		key: "comfyui",
		name: "ComfyUI",
		kind: "manual",
		installed: "0.43.0",
		latest: "0.44.0",
		status: "manual",
		run: "comfyui-update",
	},
];

const DEFAULT_STAGES = {
	appimage: [
		["download", 60],
		["backup", 10],
		["install", 20],
		["verify", 10],
	],
	archive: [
		["download", 60],
		["backup", 10],
		["install", 20],
		["verify", 10],
	],
	file: [
		["download", 60],
		["backup", 10],
		["install", 20],
		["verify", 10],
	],
	deb: [
		["download", 50],
		["install", 40],
		["verify", 10],
	],
	rpm: [
		["download", 50],
		["install", 40],
		["verify", 10],
	],
	source: [
		["download", 10],
		["install", 80],
		["verify", 10],
	],
	command: [
		["install", 85],
		["verify", 15],
	],
	"claude-plugins": [["install", 100]],
	manual: [],
} satisfies Record<AppKind, [Stage, number][]>;

const CAN_RESTORE = {
	appimage: true,
	archive: true,
	file: true,
	deb: true,
	rpm: true,
	source: false,
	command: false,
	"claude-plugins": false,
	manual: false,
} satisfies Record<AppKind, boolean>;

const NOW = Date.parse("2026-11-10T09:41:00Z");
const DAY = 86_400_000;
/** An epoch time in the ISO form the engine sends. */
const iso = (ms: number) => new Date(ms).toISOString();

/** Fills an AppState from a seed, taking the engine's defaults for anything the seed leaves out. */
function toApp(seed: Seed): AppState {
	const restore = seed.restore ?? [];
	return {
		key: seed.key,
		name: seed.name,
		kind: seed.kind,
		repo: seed.repo,
		installed: seed.installed,
		latest: seed.versionless ? null : (seed.latest ?? seed.installed),
		status: seed.status ?? "fresh",
		detail: seed.detail,
		size: seed.size,
		notes: seed.notes,
		releaseUrl: seed.repo ? `https://github.com/${seed.repo}/releases/latest` : undefined,
		publishedAt: seed.publishedDaysAgo === undefined ? undefined : iso(NOW - seed.publishedDaysAgo * DAY),
		running: seed.running ?? false,
		restartToApply: false,
		restorePoints: restore.map((version, i) => ({ version, at: iso(NOW - (12 + i * 20) * DAY) })),
		canRestore: seed.canRestore ?? CAN_RESTORE[seed.kind],
		canRestart: seed.restarts !== undefined,
		closes: seed.restarts === "relaunch",
		commits: seed.commits,
		ahead: seed.ahead,
		auto: seed.auto ?? false,
		sudo: seed.sudo ?? false,
		versionless: seed.versionless ?? false,
		run: seed.run,
		note: seed.note,
		dest: seed.dest,
		stages: (seed.stages ?? DEFAULT_STAGES[seed.kind]).map(([id, weight]) => ({ id, weight })),
		held: false,
	};
}

/** The five stages of a built app, weighted as the engine weighs them (plan 5 E); they sum to 100. */
const BUILT_STAGES: [Stage, number][] = [
	["download", 5],
	["backup", 5],
	["build", 60],
	["install", 15],
	["verify", 15],
];

/** Thirty commit titles shaped like llama.cpp's, newest first, one long enough to be cut in the pane. */
const LLAMA_TITLES = [
	"server : add --reasoning-budget-message to the chat template path",
	"CUDA : fuse rms_norm and mul for the Ampere tile path",
	"ggml : fix a race in the threadpool when n_threads changes between graphs, seen with speculative decoding on two GPUs at once",
	"model : add support for Qwen3.8 MoE routing",
	"vulkan : skip the coopmat path on drivers older than 1.3.280",
	"server : stream usage in the final chunk when stream_options is set",
	"llama : refactor the KV cache defrag heuristics",
	"CUDA : FA kernels for head size 576",
	"common : accept --no-mmap in the presets file",
	"convert : handle tied embeddings in the HF converter",
	"server : return 503 while the model is loading",
	"ggml-cpu : AVX-512 path for q4_K dot products",
	"metal : fix the argsort kernel for large rows",
	"llama-bench : print the build commit",
	"sampling : add top-n-sigma",
	"server : fix the /slots endpoint when slots are disabled",
	"CUDA : reduce register pressure in mmq for sm_86",
	"docs : describe the tool-call grammar",
	"ggml : add ggml_set_rows for quantized types",
	"server : keep the prompt cache across model reloads",
	"llama : fix the chat template for gpt-oss",
	"cmake : find CUDA 13.1 on Debian layouts",
	"tests : cover the new rope scaling types",
	"server : expose n_ctx_train in /props",
	"vocab : fix the pre-tokenizer for Kimi",
	"CUDA : enable graphs for batch size 1 decoding",
	"common : log the effective sampler chain",
	"ggml : speed up get_rows for f16",
	"server : honour cache_prompt=false in the OAI endpoint",
	"llama : print the device split at load time",
];
/** A distinct made-up 40-character sha per position, starting from the real newest commit's short form. */
const fakeSha = (i: number) =>
	(i === 0 ? "cd959bae9" : (0xcd959bae9 - i * 0x1f3a7).toString(16).padStart(9, "0")).padEnd(40, "0");
const LLAMA_COMMITS = LLAMA_TITLES.map((title, i) => ({ sha: fakeSha(i), title }));

/** The built-from-source rows the native-builds plan moves into Upkeep, as the engine reports them once their tables are live. */
const BUILT_SEEDS: Seed[] = [
	{
		key: "llama",
		name: "llama.cpp",
		kind: "source",
		repo: "ggml-org/llama.cpp",
		installed: "f2918cabb",
		latest: "v0.9.0",
		status: "ready",
		canRestore: true,
		restore: ["a41d0c7e2"],
		ahead: 569,
		commits: LLAMA_COMMITS,
		stages: BUILT_STAGES,
		note: "Updating restarts the llama-server services that are running.",
	},
	{
		key: "whisper",
		name: "whisper.cpp",
		kind: "source",
		repo: "ggml-org/whisper.cpp",
		installed: "v1.8.2",
		latest: "v1.8.3",
		status: "ready",
		canRestore: true,
		ahead: 3,
		commits: [
			{ sha: "7be3f0a1c".padEnd(40, "0"), title: "cli : print the model's language list with --help" },
			{ sha: "4d91e2b06".padEnd(40, "0"), title: "ggml : sync with llama.cpp" },
			{ sha: "e05c13f87".padEnd(40, "0"), title: "release : v1.8.3" },
		],
		stages: BUILT_STAGES,
	},
	{
		key: "strata",
		name: "Strata",
		kind: "source",
		repo: "Niko1221/Strata",
		installed: "0.2.10",
		latest: "0.2.13",
		status: "ready",
		canRestore: true,
		stages: BUILT_STAGES,
	},
	{
		key: "comfyui",
		name: "ComfyUI",
		kind: "source",
		repo: "comfyanonymous/ComfyUI",
		installed: "0.43.0",
		latest: "0.44.0",
		status: "ready",
		canRestore: true,
		stages: BUILT_STAGES,
	},
	{
		key: "cava",
		name: "CAVA",
		kind: "source",
		repo: "karlstav/cava",
		installed: "0.10.6",
		latest: "0.10.7",
		status: "ready",
		canRestore: true,
		stages: BUILT_STAGES,
	},
	{
		key: "dsh",
		name: "dsh",
		kind: "source",
		repo: "dsh-dev/dsh",
		installed: "0.2.2-alpha.3",
		latest: "0.2.2-rc.1",
		status: "ready",
		canRestore: true,
		stages: BUILT_STAGES,
	},
	{
		key: "tmux",
		name: "tmux",
		kind: "source",
		repo: "tmux/tmux",
		installed: "3.6a",
		latest: "3.6b",
		status: "ready",
		canRestore: true,
		stages: BUILT_STAGES,
	},
	{
		key: "btop",
		name: "btop",
		kind: "source",
		repo: "aristocratos/btop",
		installed: "1.4.3",
		latest: "1.4.4",
		status: "ready",
		canRestore: true,
		restore: ["1.4.2"],
		stages: BUILT_STAGES,
	},
	{
		key: "neovim",
		name: "Neovim",
		kind: "source",
		repo: "neovim/neovim",
		installed: "0.11.4",
		latest: "0.11.5",
		status: "ready",
		canRestore: true,
		stages: BUILT_STAGES,
	},
];

/** The recorded window and System operations the specs read back from the page. */
declare global {
	var upkeepOps: string[] | undefined;
	var upkeepSysOps: string[] | undefined;
}

/** How each built row's scripted run ends in the built variant: the starred sentences of plan 5 E. */
type BuiltEnd = { result: "failed" | "rolled_back"; detail: (from: string | null) => string };
const BUILT_ENDS = {
	strata: { result: "failed", detail: () => "sudo needs a password here, so nothing was stopped or changed." },
	comfyui: { result: "failed", detail: () => "The image queue has a job waiting. Nothing was changed." },
	cava: { result: "failed", detail: () => "Build step failed: cmake --build build -j 6. Nothing was changed." },
	dsh: { result: "rolled_back", detail: (from) => `Would not start after the update. Restored ${from ?? ""}.` },
	whisper: {
		result: "rolled_back",
		detail: (from) => `Failed its test after the update: whisper-cli starts. Restored ${from ?? ""}.`,
	},
	tmux: {
		result: "failed",
		detail: (from) =>
			`Would not start after the update, and putting ${from ?? ""} back failed: tmux did not answer. See the log.`,
	},
	btop: { result: "failed", detail: (from) => `Could not stop btop to put ${from ?? ""} back. See the log.` },
	neovim: {
		result: "failed",
		detail: () =>
			"Refused /home/you/src/neovim/runtime/link/doc: a link inside it leads outside what this table may change. Nothing was changed.",
	},
} satisfies Record<string, BuiltEnd>;

/** The rows whose scripted end keeps the in-flight marker, as a put-back that failed does; Install waits on them. */
const KEPT_MARKER = new Set(["btop"]);
const REASON_UNRECOVERED = "An update was interrupted and could not be put back. Restore it from its row first.";

/** The scripted end for a built row's key, or undefined for a row whose run succeeds. */
const builtEnd = (key: string): BuiltEnd | undefined => Object.entries(BUILT_ENDS).find(([k]) => k === key)?.[1];

/**
 * Builds the app list for a fixture variant; built swaps in the source rows, adds the ones the default list lacks at
 * the end, and rests every other pending row.
 */
function seedsFor(variant: FixtureVariant): AppState[] {
	const apps = SEEDS.map(toApp);
	if (variant === "built") {
		const built = new Map(BUILT_SEEDS.map((s) => [s.key, toApp(s)]));
		const added = BUILT_SEEDS.filter((s) => !SEEDS.some((d) => d.key === s.key)).map(toApp);
		return [
			...apps.map(
				(a): AppState =>
					built.get(a.key) ?? (a.status === "ready" ? { ...a, status: "fresh", installed: a.latest } : a),
			),
			...added,
		];
	}
	// A new person's first run: the list that ships holds no apps.
	if (variant === "none") return [];
	if (variant === "empty") {
		return apps.map((a) => ({
			...a,
			status: "fresh",
			installed: a.versionless ? null : (a.latest ?? a.installed),
			detail: undefined,
		}));
	}
	if (variant === "problems") {
		return apps.map((a) => {
			if (a.key === "lrcget") return a;
			if (a.key === "borg")
				return {
					...a,
					status: "problem",
					detail: "BorgBackup will not start (~/.local/bin/borg).",
				};
			if (a.key === "pr-agent")
				return {
					...a,
					status: "problem",
					detail: "Could not look: GitHub API rate limit exceeded. Try again after 10:12.",
				};
			if (a.key === "zen") return { ...a, status: "held", skipped: "1.24.1b" };
			if (a.status === "ready" || a.status === "manual") return { ...a, status: "fresh", installed: a.latest };
			return a;
		});
	}
	if (variant === "many") {
		const extra = SEEDS.slice(3, 31).map((s) =>
			toApp({ ...s, key: `${s.key}-2`, name: `${s.name} nightly`, status: s.status === "ready" ? "fresh" : s.status }),
		);
		return [...apps, ...extra];
	}
	return apps;
}

/** The state a self-update variant starts in: 0.1.0 running, 0.1.1 offered. */
function selfStart(phase: FixtureOptions["self"]): SelfState {
	if (!phase) return { phase: "none" };
	const base = { from: "0.1.0", version: "0.1.1" };
	if (phase === "failed") return { phase, ...base, why: MESSAGES.selfDownload() };
	return { phase, ...base };
}

/** Resolves after ms; the fixture's stand-in for engine work taking time. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** A deep copy, so a caller changing a reply cannot reach the fixture's own state. */
const clone = <T>(v: T): T => structuredClone(v);

/** fail names one request that rejects, as a request that ran past its time limit does. */
export type FixtureOptions = {
	variant?: FixtureVariant;
	speed?: number;
	fail?: string;
	buttons?: "left" | "right";
	frame?: "own" | "system";
	corners?: "rounded" | "square";
	/** Start with no recorded runs, as on a first launch. */
	noHistory?: boolean;
	/** "unknown" makes a scan find only programs whose source it cannot tell; "also" finds Obsidian, which is a Flatpak too. */
	scan?: "unknown" | "also";
	/** The System group's starting state; off unless asked. */
	system?: SystemVariant;
	/** "on" starts with the Cleanup tab switched on. */
	cleanup?: "on";
	/** The phase Upkeep's own update starts in; none unless asked. */
	self?: Exclude<SelfState["phase"], "none">;
	/** The offered version fails its start test, so a press on Update ends failed and never ready. */
	selfTestFails?: boolean;
	/** GitHub's budget is used up for the next half hour: "out" with no sign-in (60), "signed" with one (5,000); "soon" starts over in 1.5 s. */
	rate?: "out" | "signed" | "soon";
};

// Cinnamon can put the window buttons on the left: close, maximize, minimize.
/** The window button order for the side the buttons sit on. */
const orderFor = (side: "left" | "right"): WindowButton[] =>
	side === "left" ? ["close", "maximize", "minimize"] : ["minimize", "maximize", "close"];

/** A bridge that answers from canned data, with timers standing in for the engine; speed scales them. Also records window and System operations on globalThis for the specs to read. */
export function createFixture(opts: FixtureOptions = {}): Bridge {
	const variant = opts.variant ?? "default";
	const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
	const listeners = new Set<(e: EngineEvent) => void>();
	let apps = seedsFor(variant);
	let settings: Settings = {
		keepBackups: 1,
		notify: true,
		checkAtLogin: false,
		checkEvery: "6h",
		frame: opts.frame ?? "own",
		buttons: "auto",
		corners: opts.corners ?? "rounded",
		language: "system",
		selfAuto: false,
		upkeepCommand: false,
	};
	let chrome: WindowChrome = {
		own: settings.frame === "own",
		side: opts.buttons ?? "left",
		order: orderFor(opts.buttons ?? "left"),
		maximized: false,
		rounded: settings.frame === "own" && settings.corners === "rounded",
	};
	let run: RunState = {
		id: null,
		phase: "idle",
		index: 0,
		total: 0,
		currentKey: null,
		stopping: false,
		results: [],
		retry: false,
	};
	const resetAt = iso(Date.now() + (opts.rate === "soon" ? 1500 : 30 * 60_000));
	const rate =
		opts.rate === "out" || opts.rate === "soon"
			? { limit: 60, remaining: 0, resetAt }
			: opts.rate === "signed"
				? { limit: 5000, remaining: 0, resetAt }
				: { limit: 5000, remaining: 4977 };
	let checkedAt: string | null = iso(Date.now() - 2 * 60_000);
	const history: HistoryRow[] = opts.noHistory ? [] : pastHistory();
	const logs = new Map<string, LogLine[]>();
	let attempts = 0;
	// A built row whose put-back failed: as the engine's recover() refuses Install until it is restored by hand.
	let kept = false;
	globalThis.upkeepOps = [];
	const offered = new Map<string, Suggestion>();
	const sysOps: string[] = [];
	globalThis.upkeepSysOps = sysOps;
	const installing = opts.system === "install" || opts.system === "refuse";
	const systemSettings: ExtrasSettings =
		!opts.system || opts.system === "off"
			? { system: "off" }
			: installing
				? { system: "show", systemInstall: true }
				: { system: "show" };
	let extras: ExtrasSnapshot = {
		settings: opts.cleanup === "on" ? { ...systemSettings, cleanup: true } : systemSettings,
		system: systemFor(opts.system ?? "off", iso(Date.now() - 5 * 60_000)),
		cleanup: { phase: opts.cleanup === "on" ? "idle" : "off", items: [], measuredAt: null, last: null },
	};
	/** What the main process sends: the installable ids worked out from the rows, as the engine does, only while installing is on. */
	const extrasNow = (): ExtrasSnapshot =>
		clone(
			extras.settings.systemInstall && extras.system.mode === "show"
				? { ...extras, system: { ...extras.system, installable: fixtureInstallable(extras.system) } }
				: extras,
		);
	const setExtras = (system: SystemState) => {
		extras = { ...extras, system };
		emit({ type: "extras", extras: extrasNow() });
	};
	const setCleanup = (cleanup: CleanupState) => {
		extras = { ...extras, cleanup };
		emit({ type: "extras", extras: extrasNow() });
	};
	/** A fake measure: the items land after a moment. Nothing is read from disk. */
	async function runMeasure() {
		setCleanup({ ...extras.cleanup, phase: "measuring", items: [] });
		await sleep(400 / speed);
		if (!extras.settings.cleanup) return;
		setCleanup({
			...extras.cleanup,
			phase: "idle",
			items: fixtureCleanupItems(extras.settings.devCaches === true),
			measuredAt: iso(Date.now()),
		});
	}
	/** A fake delete: each picked item works for a moment and is cleaned, then the list drops what went. Nothing is deleted. */
	async function runClean(picks: CleanupPick[], ids: CleanupId[]) {
		const at = iso(Date.now());
		const sizes = new Map(
			extras.cleanup.items.map((it) => [
				it.id,
				it.parts
					.filter((p) => picks.some((k) => k.id === it.id && k.partIds.includes(p.id)))
					.reduce((a, p) => a + p.bytes, 0),
			]),
		);
		const outcomes: CleanupOutcome[] = ids.map((id) => ({ id, status: "queued", freed: 0 }));
		setCleanup({ ...extras.cleanup, phase: "cleaning", last: { at, outcomes, refused: null } });
		for (const o of outcomes) {
			o.status = "working";
			setCleanup({ ...extras.cleanup, last: { at, outcomes: clone(outcomes), refused: null } });
			// oxlint-disable-next-line no-await-in-loop -- one item at a time is the point, as the engine cleans them
			await sleep(300 / speed);
			o.status = "done";
			o.freed = sizes.get(o.id) ?? 0;
		}
		for (const o of outcomes)
			history.unshift({
				key: `cleanup:${o.id}`,
				name: o.id,
				from: null,
				to: null,
				result: "cleaned",
				ms: 300,
				runId: `${at}-cleanup`,
				at,
				stages: {},
				freed: o.freed,
			});
		setCleanup({
			...extras.cleanup,
			phase: "idle",
			items: afterClean(extras.cleanup.items, picks),
			measuredAt: iso(Date.now()),
			last: { at, outcomes: clone(outcomes), refused: null },
		});
	}
	/**
	 * A fake System install: the refuse variant is refused by its sudo check; any other runs each ticked row for a
	 * moment, then libsoup3 stays pending and the rest are installed and leave the list. Nothing real runs.
	 */
	async function runSystemInstall(ids: string[], commands: string[][]) {
		const at = iso(Date.now());
		const picked = extras.system.rows.filter((r) => ids.includes(r.id));
		await sleep(300 / speed);
		if (opts.system === "refuse") {
			setExtras({
				...extras.system,
				phase: "idle",
				install: { at, commands, outcomes: [], refused: MESSAGES.systemSudo() },
			});
			return;
		}
		setExtras({
			...extras.system,
			install: { at, commands, refused: null, outcomes: picked.map((r) => fixtureOutcome(r, "working")) },
		});
		await sleep(1200 / speed);
		const outcomes = picked.map((r) =>
			r.id === "apt:libsoup3" ? fixtureOutcome(r, "failed", MESSAGES.systemStillPending()) : fixtureOutcome(r, "done"),
		);
		const done = new Set(outcomes.filter((o) => o.status === "done").map((o) => o.id));
		setExtras({
			...extras.system,
			phase: "idle",
			rows: extras.system.rows.filter((r) => !done.has(r.id)),
			checkedAt: iso(Date.now()),
			install: { at, commands, refused: null, outcomes },
		});
	}
	/** A check that ends with the full list after a short wait; the checking variant never ends, so specs can read it. */
	async function runSystemCheck() {
		setExtras({ ...extras.system, phase: "checking" });
		if (opts.system === "checking") return;
		await sleep(900 / speed);
		if (extras.settings.system !== "show") return;
		setExtras(systemFor(opts.system && opts.system !== "off" ? opts.system : "show", iso(Date.now())));
	}

	if (variant === "checking") {
		const tail = new Set(apps.slice(-12).map((a) => a.key));
		apps = apps.map((a) => (tail.has(a.key) ? { ...a, status: "checking", installed: null, latest: null } : a));
		run = { ...run, id: null, phase: "checking", index: 20, total: apps.length };
		checkedAt = null;
	}

	/** Upkeep's own update, as the main process would report it. */
	let selfNow: SelfState = selfStart(opts.self);
	const setSelf = (next: SelfState) => {
		selfNow = next;
		emit({ type: "self", self: clone(next) });
	};
	const emit = (e: EngineEvent) => {
		const copy = clone(e);
		queueMicrotask(() => listeners.forEach((l) => l(copy)));
	};
	const put = (app: AppState) => {
		apps = apps.map((a) => (a.key === app.key ? app : a));
		emit({ type: "app", app });
	};
	const get = (key: string) => apps.find((a) => a.key === key);
	const setRun = (patch: Partial<RunState>) => {
		run = { ...run, ...patch };
		emit({ type: "run", run });
	};
	const log = (runId: string, key: string | null, text: string) => {
		const line: LogLine = { at: iso(Date.now()), key, text };
		const lines = logs.get(runId) ?? [];
		lines.push(line);
		logs.set(runId, lines);
		emit({ type: "log", line });
	};

	async function installOne(runId: string, key: string): Promise<RunResult> {
		const start = Date.now();
		const app = get(key);
		if (!app) throw new Error(`No app ${key}`);
		const from = app.installed;
		const to = app.latest;
		const total = 3000 / speed;
		put({ ...app, status: "working", stage: app.stages[0]?.id, stagePct: 0 });
		for (const { id, weight } of app.stages) {
			const ms = (total * weight) / 100;
			const steps = Math.max(2, Math.round(ms / 80));
			const measured = id === "download";
			log(runId, key, stageLog(app, id));
			for (let i = 0; i <= steps; i++) {
				const current = get(key);
				if (!current) break;
				put({ ...current, stage: id, stagePct: measured ? Math.round((i / steps) * 100) : null });
				// oxlint-disable-next-line no-await-in-loop -- the scripted run is sequential on purpose
				await sleep(ms / steps);
			}
		}
		const after = get(key);
		if (!after) throw new Error(`No app ${key}`);
		const ms = Date.now() - start;
		const end = variant === "built" ? builtEnd(key) : undefined;
		if (end) {
			if (KEPT_MARKER.has(key)) kept = true;
			const detail = end.detail(from);
			log(runId, key, detail);
			put({ ...after, status: end.result, stage: undefined, stagePct: undefined, detail });
			return { key, name: app.name, from, to, result: end.result, detail, ms };
		}
		if (key === "wrangler" && attempts === 1) {
			const detail = "Still at 4.157.0 after the update.";
			log(runId, key, `wrangler --version printed 4.157.0. ${detail}`);
			put({ ...after, status: "failed", stage: undefined, stagePct: undefined, detail });
			return { key, name: app.name, from, to, result: "failed", detail, ms };
		}
		const restorePoints =
			app.canRestore && from
				? [{ version: from, at: iso(Date.now()) }, ...after.restorePoints].slice(0, settings.keepBackups)
				: after.restorePoints;
		log(runId, key, `${app.name} reports ${to}.`);
		put({
			...after,
			status: "done",
			installed: to,
			stage: undefined,
			stagePct: undefined,
			detail: undefined,
			restartToApply: after.running,
			restorePoints,
		});
		return { key, name: app.name, from, to, result: "updated", ms };
	}

	/** keep: results from the pass a retry continues; the engine keeps them in the summary. */
	/** The run under way's order, which joinRun appends to; null outside a run. */
	let running: string[] | null = null;
	/** A retry's first-pass order, kept on screen. */
	let base: string[] = [];

	async function runQueue(keys: string[], keep: RunResult[] = [], retry = false) {
		attempts++;
		const runId = `run-${Date.now()}`;
		const order = keys.toSorted((a, b) => queueRank(a) - queueRank(b));
		// As the engine does: any run started from the summary keeps the first pass's order on screen.
		const fromSummary = run.phase === "summary";
		for (const key of order) {
			const app = get(key);
			if (app) put({ ...app, status: "queued", detail: undefined });
		}
		setRun({
			id: runId,
			phase: "installing",
			index: 1,
			total: order.length,
			currentKey: order[0] ?? null,
			stopping: false,
			results: keep,
			retry,
			// A retry keeps the first pass's order on screen, as the engine does.
			queue: fromSummary ? [...(run.queue ?? []), ...order.filter((k) => !run.queue?.includes(k))] : [...order],
		});
		base = fromSummary ? (run.queue ?? []) : [];
		running = order;
		log(runId, null, `Run started: ${order.length} apps.`);
		const results: RunResult[] = [...keep];
		for (let i = 0; i < order.length; i++) {
			const key = order[i];
			if (key === undefined) break;
			if (run.stopping && i > 0) {
				for (const rest of order.slice(i)) {
					const app = get(rest);
					if (app) put({ ...app, status: "ready" });
				}
				log(runId, null, "Stopped after the current app.");
				break;
			}
			setRun({ index: i + 1, currentKey: key });
			// oxlint-disable-next-line no-await-in-loop -- the scripted run is sequential on purpose
			const result = await installOne(runId, key);
			results.push(result);
			setRun({ results: [...results] });
			// As the engine does: a kept marker stops the run, so the next app cannot erase it.
			if (kept && KEPT_MARKER.has(key)) {
				for (const rest of order.slice(i + 1)) {
					const app = get(rest);
					if (app) put({ ...app, status: "ready" });
				}
				log(runId, null, REASON_UNRECOVERED);
				break;
			}
			// oxlint-disable-next-line no-await-in-loop -- the scripted run is sequential on purpose
			await sleep(200 / speed);
		}
		const at = iso(Date.now());
		// Newest run first, and within a run the apps in the order they ran.
		// A retry records only what it ran, marked as a retry.
		const ran = results.filter((r) => !keep.includes(r));
		history.unshift(...ran.map((r) => Object.assign({}, r, { runId, at, stages: {}, retry: retry || undefined })));
		log(runId, null, "Run finished.");
		running = null;
		setRun({ phase: "summary", currentKey: null, results });
	}

	/** The engine's addToRun: ready apps go after the apps waiting. */
	function joinRun(order: string[], keys: string[]): Requests["install"]["response"] {
		if (run.stopping)
			return { started: false, reason: "The run stops after the current app, so nothing more can join it." };
		const add = keys.filter((k) => !order.includes(k) && get(k)?.status === "ready");
		if (add.length === 0) return { started: false, reason: "Nothing to install." };
		order.push(...add);
		for (const k of add) {
			const app = get(k);
			if (app) put({ ...app, status: "queued", detail: undefined });
		}
		setRun({ total: order.length, queue: [...base, ...order.filter((k) => !base.includes(k))] });
		return { started: true };
	}

	function queueRank(key: string): number {
		return apps.findIndex((a) => a.key === key);
	}

	async function runCheck(keys?: string[]) {
		const targets = apps.filter((a) => !keys || keys.includes(a.key)).map((a) => a.key);
		const before = new Map(apps.map((a) => [a.key, clone(a)]));
		for (const key of targets) {
			const app = get(key);
			if (app) put({ ...app, status: "checking" });
		}
		setRun({ id: null, phase: "checking", index: 0, total: targets.length, currentKey: null, results: [] });
		for (let i = 0; i < targets.length; i++) {
			// oxlint-disable-next-line no-await-in-loop -- the scripted run is sequential on purpose
			await sleep(45 / speed);
			const key = targets[i];
			const prev = key === undefined ? undefined : before.get(key);
			if (prev) put(resolveCheck(prev));
			setRun({ index: i + 1 });
		}
		checkedAt = iso(Date.now());
		setRun({ phase: "idle", index: 0, total: 0 });
		emit({ type: "meta", rate, checkedAt, settings });
	}

	const handlers: RequestHandlers = {
		snapshot: () =>
			({
				apps: clone(apps),
				run: clone(run),
				settings: clone(settings),
				rate,
				checkedAt,
				version: "0.1.0",
			}) satisfies Snapshot,
		check: ({ keys }) => {
			if (run.phase === "checking" || run.phase === "installing") return { started: false };
			void runCheck(keys);
			return { started: true };
		},
		install: ({ keys }) => {
			if (run.phase === "checking") return { started: false, reason: "A check is running." };
			if (run.phase === "installing")
				return running ? joinRun(running, keys) : { started: false, reason: "A run is already in progress." };
			if (kept) return { started: false, reason: REASON_UNRECOVERED };
			const ok = keys.filter((k) => {
				const s = get(k)?.status;
				return s === "ready" || s === "failed" || s === "rolled_back";
			});
			if (ok.length === 0) return { started: false, reason: "Nothing to install." };
			// A retry from the summary keeps the first pass: done rows stay done and their results stay counted.
			const keep = run.phase === "summary" ? run.results.filter((r) => !ok.includes(r.key)) : [];
			const retry =
				run.phase === "summary" && ok.every((k) => ["failed", "rolled_back"].includes(get(k)?.status ?? ""));
			void runQueue(ok, keep, retry);
			return { started: true };
		},
		stopAfterCurrent: () => {
			if (run.phase !== "installing") return { stopping: false };
			setRun({ stopping: true });
			return { stopping: true };
		},
		dismissSummary: () => {
			for (const app of apps) if (app.status === "done") put({ ...app, status: "fresh" });
			// As the engine does: a failed app is ready to try again and says why its last try ended, until the next check.
			for (const app of apps)
				if (app.status === "failed" || app.status === "rolled_back")
					put({ ...app, status: "ready", detail: app.detail ? lastTryFailed(app.detail) : undefined });
			setRun({
				id: null,
				phase: "idle",
				index: 0,
				total: 0,
				currentKey: null,
				stopping: false,
				results: [],
				retry: false,
			});
			return { ok: true };
		},
		restartApp: ({ key }) => {
			const app = get(key);
			if (!app || run.phase === "installing") return { ok: false, detail: "A run is in progress." };
			put({ ...app, restartToApply: false });
			log(`restart-${Date.now()}`, key, `Restarted ${app.name}.`);
			return { ok: true };
		},
		restore: ({ key, version }) => {
			const app = get(key);
			if (!app || run.phase === "installing") return { ok: false, detail: "Restore is not possible during a run." };
			// The kept marker is put back by restoring its own app; every other restore waits, as Install does.
			if (kept && !KEPT_MARKER.has(key)) return { ok: false, detail: REASON_UNRECOVERED };
			kept = false;
			// A swap, as the engine does it: the replaced version becomes the restore point, and latest is skipped.
			const replaced = app.installed;
			const points = app.restorePoints.filter((p) => p.version !== version);
			const restorePoints = replaced ? [{ version: replaced, at: iso(Date.now()) }, ...points] : points;
			const skip = app.latest && app.latest !== version ? app.latest : undefined;
			put({
				...app,
				installed: version,
				status: skip ? "held" : "fresh",
				skipped: skip,
				detail: undefined,
				restartToApply: app.running,
				restorePoints,
			});
			log(`restore-${Date.now()}`, key, `Restored ${version}.`);
			history.unshift({
				runId: `restore-${Date.now()}`,
				at: iso(Date.now()),
				key,
				name: app.name,
				from: replaced,
				to: version,
				result: "restored",
				ms: 400,
				stages: {},
			});
			return { ok: true };
		},
		setSkip: ({ key, version }) => {
			const app = get(key);
			if (!app) return { ok: false };
			put(
				version
					? { ...app, status: "held", skipped: version }
					: { ...app, status: app.held ? "held" : "ready", skipped: undefined },
			);
			return { ok: true };
		},
		setHold: ({ key, held }) => {
			const app = get(key);
			if (!app) return { ok: false };
			const pending = app.latest !== null && app.latest !== app.installed;
			const status: AppStatus = held ? "held" : app.skipped ? "held" : pending ? "ready" : "fresh";
			put({ ...app, held, status });
			return { ok: true };
		},
		setAuto: ({ key, auto }) => {
			const app = get(key);
			if (!app) return { ok: false };
			put({ ...app, auto });
			return { ok: true };
		},
		setSettings: (patch) => {
			// The real main process rebuilds the window for a new frame or corners; the fixture just re-dresses it.
			if (patch.corners || patch.frame) {
				const frame = patch.frame ?? settings.frame;
				const corners = patch.corners ?? settings.corners;
				chrome = { ...chrome, own: frame === "own", rounded: frame === "own" && corners === "rounded" };
				emit({ type: "chrome", chrome });
			}
			if (patch.buttons && patch.buttons !== "auto") {
				chrome = { ...chrome, side: patch.buttons, order: orderFor(patch.buttons) };
				emit({ type: "chrome", chrome });
			}
			settings = {
				...settings,
				...patch,
				keepBackups: Math.min(5, Math.max(1, patch.keepBackups ?? settings.keepBackups)),
			};
			emit({ type: "meta", rate, checkedAt, settings });
			return clone(settings);
		},
		history: ({ limit }) => clone(history.slice(0, limit)),
		runLog: ({ runId }) => clone(logs.get(runId) ?? []),
		open: ({ what }) => {
			globalThis.upkeepOps?.push(`open ${what}`);
			return { ok: true };
		},
		self: () => clone(selfNow),
		// As the main process: the press is taken at once and the phases arrive as events.
		selfUpdate: () => {
			globalThis.upkeepOps?.push("self update");
			void (async () => {
				setSelf({ phase: "preparing", from: "0.1.0", version: "0.1.1" });
				await sleep(900 / speed);
				setSelf(
					opts.selfTestFails
						? { phase: "failed", from: "0.1.0", version: "0.1.1", why: MESSAGES.selfTestFailed("0.1.1") }
						: { phase: "ready", from: "0.1.0", version: "0.1.1" },
				);
			})();
			return { ok: true };
		},
		selfRestart: () => {
			globalThis.upkeepOps?.push("self restart");
			void (async () => {
				setSelf({ phase: "restarting", from: "0.1.0", version: "0.1.1" });
				await sleep(900 / speed);
				// The real window goes away here and the new version's comes back saying this.
				setSelf({ phase: "updated", from: "0.1.0", version: "0.1.1" });
			})();
			return { ok: true };
		},
		selfDismiss: () => {
			setSelf({ phase: "none" });
			return { ok: true };
		},
		copy: () => ({ ok: true }),
		suggest: async ({ input, asset }) => {
			// An archive is opened to find its programs, so it answers slower than an AppImage.
			await sleep((/ripgrep/i.test(input) ? 1500 : 600) / speed);
			const res = suggestFor(input, asset, (key) => apps.some((a) => a.key === key));
			for (const s of res.suggestions) offered.set(s.spec.key, s);
			return res;
		},
		scan: async () => {
			await sleep(1500 / speed);
			const suggestions = scanResults(opts.scan === "unknown", opts.scan === "also");
			for (const s of suggestions) offered.set(s.spec.key, s);
			return { suggestions };
		},
		addApps: async ({ specs }) => {
			await sleep(400 / speed);
			const added: string[] = [];
			const problems: { key: string; detail: string }[] = [];
			for (const spec of specs) {
				if (apps.some((a) => a.key === spec.key)) {
					problems.push({ key: spec.key, detail: `${spec.key} is already in the list.` });
					continue;
				}
				if (spec.key === "btop") {
					problems.push({ key: spec.key, detail: tomlWriteFailed("permission denied") });
					continue;
				}
				const from = offered.get(spec.key);
				const installed = from?.installed ?? null;
				const latest = from?.latest ?? null;
				const app: AppState = {
					...toApp({ key: spec.key, name: spec.name, kind: spec.kind, repo: spec.repo, installed, dest: spec.dest }),
					latest,
					status: installed === null || installed !== latest ? "ready" : "fresh",
					size: from?.asset?.size,
				};
				apps = [...apps, app];
				emit({ type: "app", app });
				added.push(spec.key);
			}
			return { added, problems };
		},
		removeApp: ({ key }) => {
			if (run.phase === "installing") return { ok: false, detail: "Wait for the run to finish." };
			if (!get(key)) return { ok: false, detail: `No app ${key} in the list.` };
			apps = apps.filter((a) => a.key !== key);
			emit({ type: "removed", key });
			return { ok: true };
		},
		chrome: () => clone(chrome),
		// The browser's languages stand in for the desktop's, so a spec can set them with its locale.
		languages: () => [...(globalThis.navigator?.languages ?? [])],
		window: ({ op }) => {
			// Recorded so specs can see which window op a control sent.
			globalThis.upkeepOps?.push(op);
			// Close hides to the tray in the real window; the fixture has nowhere to hide, so it only answers.
			if (op === "maximize") {
				chrome = { ...chrome, maximized: !chrome.maximized };
				emit({ type: "chrome", chrome });
			}
			return { ok: true };
		},
		extras: () => extrasNow(),
		setExtras: (patch) => {
			const merged = { ...extras.settings, ...patch };
			// As the engine's clamp: installing is on only while the list is shown, developer caches only with Cleanup.
			const next: ExtrasSettings =
				merged.system !== "show"
					? { system: "off" }
					: merged.systemInstall
						? { system: "show", systemInstall: true }
						: { system: "show" };
			if (merged.cleanup) next.cleanup = true;
			if (merged.cleanup && merged.devCaches) next.devCaches = true;
			const turnedOn = next.system === "show" && extras.settings.system !== "show";
			const cleanupWas = extras.settings.cleanup === true;
			extras = { ...extras, settings: next };
			if (next.cleanup !== cleanupWas || merged.devCaches !== undefined) {
				if (!next.cleanup) setCleanup({ phase: "off", items: [], measuredAt: null, last: null });
				else void runMeasure();
			}
			if (next.system === "off") setExtras(systemFor("off", ""));
			else if (turnedOn) void runSystemCheck();
			else setExtras(extras.system);
			return clone(next);
		},
		systemCheck: () => {
			sysOps.push("systemCheck");
			if (extras.settings.system !== "show" || extras.system.phase === "checking") return { started: false };
			void runSystemCheck();
			return { started: true };
		},
		openTool: ({ what }) => {
			sysOps.push(`openTool:${what}`);
			return { ok: true };
		},
		cleanupMeasure: () => {
			sysOps.push("cleanupMeasure");
			if (!extras.settings.cleanup || extras.cleanup.phase !== "idle") return { started: false };
			void runMeasure();
			return { started: true };
		},
		cleanupReview: ({ picks }) => {
			sysOps.push(`cleanupReview:${picks.map((p) => p.id).join(",")}`);
			const r = fixtureReview(extras.cleanup.items, picks);
			return r.parts === 0
				? { bytes: 0, commands: [], reason: MESSAGES.cleanNothing() }
				: { bytes: r.bytes, commands: r.commands };
		},
		cleanupRun: ({ picks, commands, typed }) => {
			sysOps.push(`cleanupRun:${picks.map((p) => p.id).join(",")}`);
			if (extras.cleanup.phase !== "idle") return { started: false, reason: MESSAGES.reasonBusy() };
			const r = fixtureReview(extras.cleanup.items, picks);
			if (JSON.stringify(r.commands) !== JSON.stringify(commands))
				return { started: false, reason: MESSAGES.cleanListChanged() };
			if (r.items.includes("autoremove") && typed?.trim() !== "remove")
				return { started: false, reason: MESSAGES.cleanTypeFirst("remove") };
			void runClean(picks, r.items);
			return { started: true };
		},
		systemPlan: ({ ids }) => {
			sysOps.push(`systemPlan:${ids.join(",")}`);
			const commands = fixturePlan(extras.system, ids);
			return commands.length > 0 ? { commands } : { commands, reason: MESSAGES.systemNothing() };
		},
		systemInstall: ({ ids, commands }) => {
			sysOps.push(`systemInstall:${ids.join(",")}`);
			if (extras.system.phase !== "idle") return { started: false, reason: MESSAGES.reasonBusy() };
			setExtras({ ...extras.system, phase: "installing" });
			void runSystemInstall(ids, commands);
			return { started: true };
		},
		// The file dialogs answer at once in the fixture; the real ones are the desktop's.
		exportSetup: async () => ({ ok: true, file: "/home/you/upkeep-settings-2026-11-12.json" }),
		importSetup: async () => {
			emit({ type: "meta", rate, checkedAt, settings });
			return { ok: true, apps: apps.length };
		},
		pickFile: async () => {
			await sleep(200 / speed);
			return { path: PICKED };
		},
	};

	return {
		async request(name, params) {
			await sleep(0);
			if (opts.fail === name) {
				await sleep(300 / speed);
				throw new Error(`${name} timed out`);
			}
			return handlers[name](params);
		},
		onEvent(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

/** What a row becomes when a re-check finishes. Finished or queued work settles; a row never goes backwards to the stale failure text. */
function resolveCheck(app: AppState): AppState {
	if (app.status === "done") return { ...app, status: "fresh" };
	if (app.status === "ready" && app.detail?.startsWith(lastTryFailed(""))) return { ...app, detail: undefined };
	if (app.status === "queued" || app.status === "working") return { ...app, status: "ready" };
	return app;
}

/** The log line the fixture prints when a stage begins. */
function stageLog(app: AppState, stage: Stage): string {
	switch (stage) {
		case "download":
			return `Downloading ${app.name} ${app.latest ?? ""}.`;
		case "backup":
			return `Copied ${app.installed ?? ""} to restore point.`;
		case "build":
			return "Running the build steps.";
		case "install":
			return `Installing ${app.latest ?? ""}.`;
		case "verify":
			return "Probing the new version.";
	}
}

/** Builds one history row; daysAgo counts back from the fixture's fixed clock. */
const row = (
	runId: string,
	daysAgo: number,
	key: string,
	name: string,
	from: string,
	to: string,
	ms: number,
	result: RunResult["result"] = "updated",
	detail?: string,
): HistoryRow => ({
	runId,
	at: iso(NOW - daysAgo * DAY),
	key,
	name,
	from,
	to,
	result,
	detail,
	ms,
	stages: {},
});

/** The canned runs the History view shows before the person does anything. */
function pastHistory(): HistoryRow[] {
	return [
		row("run-3", 2, "bat", "bat", "0.26.0", "0.26.1", 2400),
		row("run-3", 2, "claude", "Claude Code", "2.4.10", "2.4.12", 21_800),
		row("run-2", 6, "yazi", "Yazi", "25.5.31", "26.1.22", 5100),
		row("run-2", 6, "uv", "uv", "0.10.2", "0.10.4", 3900),
		row("run-2", 6, "ghostty", "Ghostty Terminal", "1.3.0", "1.3.1", 13_600),
		row(
			"run-1",
			9,
			"ghostty",
			"Ghostty Terminal",
			"1.3.0",
			"1.3.1",
			14_200,
			"rolled_back",
			"Would not start after the update. Restored 1.3.0.",
		),
		row("run-1", 9, "fzf", "fzf", "0.67.0", "0.68.0", 2100),
	];
}
