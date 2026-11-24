import { mkdirSync, rmSync, statfsSync } from "node:fs";
import type { AppSpec } from "../shared/types";
import { download, type DownloadOpts, type DownloadResult, signedIn, verifyAsset } from "./download";
import type { Asset, FetchLike } from "./github";

/**
 * Early downloads running at once. Two leaves room on the line for whatever the app at its turn fetches itself (a
 * clone, a build's own downloads).
 */
export const AHEAD_AT_ONCE = 2;

/**
 * Free space an early download must leave on the cache's disk, past its own size and the listed sizes of the early
 * downloads under way, so a build running beside it does not run out. A disk with less never downloads ahead and
 * works as before.
 */
export const AHEAD_ROOM = 5 * 1024 ** 3;

/** The kinds whose whole update is one file from a release. */
const EARLY_KINDS = new Set<AppSpec["kind"]>(["appimage", "archive", "file", "deb", "rpm"]);

/**
 * Whether an app's file may come down before its turn: a release kind with a file to fetch, and nothing it builds,
 * stops or pauses. It gets wrong a release app whose turn never comes (Stop pressed, or an earlier app keeps a
 * marker): that download was spent for nothing and is deleted.
 */
export function canFetchEarly(spec: AppSpec, asset: Asset | undefined): asset is Asset {
	return EARLY_KINDS.has(spec.kind) && asset !== undefined && !spec.serve?.length && !spec.pause?.length;
}

/** One app's file to fetch ahead: the release file and where it goes, the same path the app's turn would use. */
export type AheadItem = { key: string; asset: Asset; file: string };

/** A file fetched ahead, as read back from disk at its turn, with how long its download took. */
export type Early = DownloadResult & { ms: number };

export type AheadOpts = {
	/** The run's download folder, measured for room. */
	dir: string;
	fetch: FetchLike;
	token: string | null;
	stallMs?: number;
	retryMs?: number;
	/** Bytes free to this user on dir's disk. Tests pass a fixed number. */
	freeBytes?: (dir: string) => number;
	/** The file is in and matches the release. Not called for one already handed to its turn. */
	onReady: (key: string) => void;
	log: (key: string, text: string) => void;
};

/** What the early downloads offer the run: which apps wait, when the line is free, a handover at the turn, and Stop. */
export type Ahead = {
	/** The apps waiting behind the current one, in run order. Replaces the last list. */
	plan(items: AheadItem[]): void;
	/** Open while the current app is past its own download; closed, nothing new starts. */
	gate(open: boolean): void;
	/**
	 * Hands an app's early file to its turn: waits for one still coming down (its progress then goes to onProgress),
	 * reads the file back and checks it against the release again. Null when there is none, it failed, or it no longer
	 * matches; the turn then downloads as usual.
	 */
	claim(key: string, onProgress: NonNullable<DownloadOpts["onProgress"]>): Promise<Early | null>;
	/** Stops every early download not yet handed over and deletes its file, whole or partial. Later calls get the same promise. */
	cancel(): Promise<void>;
};

type Entry = {
	item: AheadItem;
	ctl: AbortController;
	claimed: boolean;
	report?: DownloadOpts["onProgress"];
	done: Promise<Early | null>;
};

/** Bytes free to this user on dir's filesystem. */
function freeBytesOf(dir: string): number {
	const fs = statfsSync(dir);
	return fs.bavail * fs.bsize;
}

/** The size, SHA-256 and SHA-512 of the file on disk now, read in one pass without holding it in memory. */
async function onDisk(file: string): Promise<DownloadResult> {
	const hasher = new Bun.CryptoHasher("sha256");
	const hasher512 = new Bun.CryptoHasher("sha512");
	let bytes = 0;
	const reader = Bun.file(file).stream().getReader();
	for (;;) {
		// oxlint-disable-next-line no-await-in-loop -- a stream is read one chunk at a time
		const { done, value } = await reader.read();
		if (done) break;
		hasher.update(value);
		hasher512.update(value);
		bytes += value.byteLength;
	}
	return { bytes, sha256: hasher.digest("hex"), sha512: hasher512.digest("hex") };
}

/**
 * Downloads release files for the apps waiting in a run, at most AHEAD_AT_ONCE at once, in run order, while the gate
 * is open. Each app gets one early try: one that fails, or that the disk had no room for, waits for its turn.
 */
export function createAhead(o: AheadOpts): Ahead {
	const freeBytes = o.freeBytes ?? freeBytesOf;
	const entries = new Map<string, Entry>();
	const tried = new Set<string>();
	let waiting: AheadItem[] = [];
	let open = false;
	let running = 0;
	/** Listed bytes of the early downloads under way, which have not reached the disk yet. */
	let reserved = 0;
	let closed: Promise<void> | null = null;

	/**
	 * Bytes free on the download folder's disk. A folder that cannot be made or measured counts as no room, so the
	 * app downloads at its turn and the run goes on.
	 */
	function room(): number {
		try {
			mkdirSync(o.dir, { recursive: true });
			return freeBytes(o.dir);
		} catch {
			return 0;
		}
	}

	/** Starts the next waiting downloads while a slot, the gate and the disk allow. */
	function fill(): void {
		for (const item of waiting) {
			if (running >= AHEAD_AT_ONCE || !open || closed) return;
			if (tried.has(item.key)) continue;
			tried.add(item.key);
			if (room() - reserved - item.asset.size < AHEAD_ROOM)
				o.log(item.key, "Not downloaded ahead: the disk is short of room. It downloads at its turn.");
			else start(item);
		}
	}

	/** One early download. Its promise never rejects: a failure deletes the file and settles as null. */
	function start(item: AheadItem): void {
		running += 1;
		reserved += item.asset.size;
		const ctl = new AbortController();
		const began = Date.now();
		const entry: Entry = { item, ctl, claimed: false, done: Promise.resolve(null) };
		entries.set(item.key, entry);
		entry.done = download(item.asset.url, item.file, {
			fetch: o.fetch,
			signal: ctl.signal,
			stallMs: o.stallMs,
			retryMs: o.retryMs,
			signedIn: signedIn(item.asset, o.token),
			onProgress: (received, total) => entry.report?.(received, total),
		})
			.then((got): Early => {
				verifyAsset(got, item.asset);
				if (!entry.claimed) o.onReady(item.key);
				return { ...got, ms: Date.now() - began };
			})
			.catch((err: Error) => {
				rmSync(item.file, { force: true });
				if (!ctl.signal.aborted)
					o.log(
						item.key,
						`Early download failed, so it downloads at its turn: ${err instanceof Error ? err.message : String(err)}`,
					);
				return null;
			})
			.finally(() => {
				running -= 1;
				reserved -= item.asset.size;
				fill();
			});
		// Logged once the download holds its signal: a Stop this line sets off aborts the download, not a placeholder.
		o.log(item.key, `Downloading ${item.asset.name} ahead of its turn`);
	}

	return {
		plan(items) {
			waiting = items;
			fill();
		},
		gate(next) {
			open = next;
			fill();
		},
		async claim(key, onProgress) {
			tried.add(key);
			const entry = entries.get(key);
			if (!entry) return null;
			entries.delete(key);
			entry.claimed = true;
			entry.report = onProgress;
			const got = await entry.done;
			if (!got) return null;
			// The download is done: the bar shows it full while the file is read back.
			onProgress(got.bytes, got.bytes);
			try {
				const now = await onDisk(entry.item.file);
				verifyAsset(now, entry.item.asset);
				return { ...now, ms: got.ms };
			} catch (err) {
				rmSync(entry.item.file, { force: true });
				o.log(
					key,
					`The file fetched ahead no longer matches, so it downloads again: ${err instanceof Error ? err.message : String(err)}`,
				);
				return null;
			}
		},
		cancel() {
			closed ??= (async () => {
				const left = [...entries.values()];
				entries.clear();
				for (const e of left) e.ctl.abort();
				await Promise.all(left.map((e) => e.done));
				for (const e of left) rmSync(e.item.file, { force: true });
			})();
			return closed;
		},
	};
}
