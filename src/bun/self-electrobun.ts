import { appendFileSync, existsSync, mkdirSync, readFileSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Updater } from "electrobun/main";
import type { Engine, EngineDeps } from "../engine/engine";
import type { Extras } from "../engine/extras/extras";
import { loadManifest } from "../engine/manifest";
import { appendHistory, loadState, lockHeld, updateState } from "../engine/store";
import { treeBytes } from "./self-shim";
import { runStartTest, stagedLauncher } from "./self-starttest";
import { applyAndWait, type SelfPorts } from "./self-update";

/** How many apps the list at this config folder holds, counted the same way by the running Upkeep and a test start. */
export const countApps = (config: string) => loadManifest(join(config, "apps.toml")).apps.length;

/** How long a staged build has to come up as a test. */
const START_TEST_MS = 60_000;
/** The self-update log is kept under this size; past it, the older half is dropped. */
const LOG_MAX = 200_000;

/** What the binding needs from the main process. */
export type SelfHost = {
	engine: Engine;
	extras: Extras;
	deps: EngineDeps;
	env: Record<string, string | undefined>;
	windowOpen: () => boolean;
	stayUp: () => Promise<void>;
};

/**
 * Self-update's ports over the framework's updater and the real machine. Thin on purpose: what decides anything
 * lives in self-update.ts, self-starttest.ts and self-shim.ts, which are tested; the trial covers this file.
 */
export function selfPorts(host: SelfHost): SelfPorts {
	const { paths } = host.deps;
	const logFile = join(paths.state, "self-update.log");
	/** One line in the self-update log, which a bug report can carry. */
	const log = (line: string) => {
		try {
			mkdirSync(paths.state, { recursive: true });
			if (existsSync(logFile) && statSync(logFile).size > LOG_MAX) {
				const text = readFileSync(logFile, "utf8");
				writeFileSync(logFile, text.slice(text.indexOf("\n", text.length / 2) + 1));
			}
			appendFileSync(logFile, `${host.deps.now().toISOString()} ${line}\n`);
		} catch {
			// A log that cannot be written must not stop an update or a start.
		}
	};
	// The framework has one listener slot. Every status is logged, and the one waiting on an apply hears them too.
	let waiting: ((status: string) => void) | null = null;
	Updater.onStatusChange((entry) => {
		log(`framework: ${entry.status}: ${entry.message}`);
		waiting?.(entry.status);
	});
	// The channel root, learned at the first local(): where the framework keeps its record of a staged build.
	let stagedRoot = "";
	return {
		async local() {
			try {
				const info = await Updater.getLocalInfo();
				// A dev build, or one built before Upkeep had an address to update from.
				if (info.channel === "dev" || !info.baseUrl) return null;
				stagedRoot = await Updater.appDataFolder();
				return { version: info.version, hash: info.hash, root: stagedRoot };
			} catch {
				// Not started from a managed install.
				return null;
			}
		},
		async check() {
			const found = await Updater.checkForUpdate();
			return { version: found.version, hash: found.hash, available: found.updateAvailable, error: found.error };
		},
		async download() {
			await Updater.downloadUpdate();
			const info = Updater.updateInfo();
			return { ready: info.updateReady, error: info.error };
		},
		stagedHash() {
			// The record the framework's swap reads, not its last check's answer: a check that could not reach the
			// address forgets what was staged, and the staged build is still there.
			try {
				const record = readFileSync(join(stagedRoot, "self-extraction", ".electrobun-prepared-update.json"), "utf8");
				const hash = /"hash"\s*:\s*"([a-z0-9]{1,13})"/.exec(record)?.[1];
				if (hash && existsSync(join(stagedRoot, `app.prepared-${hash}`))) return hash;
			} catch {
				// No record: nothing is staged, unless the framework says otherwise below.
			}
			const info = Updater.updateInfo();
			return info.updateReady ? info.hash : null;
		},
		async startTest(root, hash) {
			const launcher = stagedLauncher(root, hash);
			if (!launcher) return null;
			return runStartTest({
				launcher,
				env: host.env,
				real: { config: paths.config, state: paths.state },
				scratch: join(paths.cache, "tmp"),
				timeoutMs: START_TEST_MS,
			});
		},
		apply: () =>
			applyAndWait(
				() => Updater.applyUpdate(),
				(heard) => {
					waiting = heard;
					return () => {
						waiting = null;
					};
				},
			),
		stayUp: host.stayUp,
		hasShell: () => existsSync("/bin/sh"),
		freeBytes(dir) {
			const fs = statfsSync(dir);
			return fs.bavail * fs.bsize;
		},
		appBytes: treeBytes,
		now: host.deps.now,
		busy() {
			const run = host.engine.snapshot().run.phase;
			const extras = host.extras.snapshot();
			return (
				run === "checking" ||
				run === "installing" ||
				host.extras.installing() ||
				extras.cleanup.phase === "cleaning" ||
				// A restore, an import, an add, or an install from the command line: each holds the run lock.
				lockHeld(paths)
			);
		},
		windowOpen: host.windowOpen,
		appCount: () => countApps(paths.config),
		configFiles: () => [
			join(paths.config, "apps.toml"),
			join(paths.state, "state.json"),
			join(paths.state, "extras.json"),
		],
		autoOn: () => loadState(paths).settings.selfAuto,
		failedHash: () => loadState(paths).selfFailed,
		setFailedHash(hash) {
			updateState(paths, (s) => {
				s.selfFailed = hash;
			});
		},
		notifiedHash: () => loadState(paths).selfNotified,
		setNotifiedHash(hash) {
			updateState(paths, (s) => {
				s.selfNotified = hash;
			});
		},
		history(row) {
			const at = host.deps.now().toISOString();
			appendHistory(paths, [
				{
					key: "upkeep",
					name: "Upkeep",
					from: row.from,
					to: row.to,
					result: row.result,
					ms: 0,
					runId: `self-${at}`,
					at,
					stages: {},
				},
			]);
		},
		log,
	};
}
