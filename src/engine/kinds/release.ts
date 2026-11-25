import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { MESSAGES } from "../../shared/messages";
import type { AppSpec, DownloadCheck } from "../../shared/types";
import { packOlder, prune, relink, restoreBackup, swapFolder, takeBackup, takePoint } from "../backup";
import { download, type DownloadResult, hashFile, needsSha512, signedIn, statedSize, verifyAsset } from "../download";
import { assetFor } from "../arch";
import { cachedSum } from "../checksums";
import { forgeRelease, forgeReleases, linksRelease, zsyncRelease } from "../forge";
import { type Asset, type Failure, isFailure, latestFromSource, pickAsset, type Release } from "../github";
import { expandHome } from "../paths";
import { probeAppImageMeta, probeCommand, probeVersion, type ProbeResult } from "../probe";
import { asRoot, installAside, type ProcessResult, SUDO_PASSWORD, sudoNeedsPassword } from "../run";
import { isRunning } from "../running";
import { clearInflight, stampedVersion, stampInstalled, writeInflight } from "../store";
import { isNewer } from "../version";
import { isPackage, PACKAGE_TOOL, packageInstall } from "./package";
import {
	type Checked,
	cuttableRun,
	fromRelease,
	type KindCtx,
	type Outcome,
	probeProblem,
	stageClock,
	stopPressed,
	stoppedOutcome,
	type Target,
} from "./context";

/**
 * Whether an install of this app keeps a restore point. A file kind copies its files; a .deb or .rpm keeps the installed
 * version's package from its release (or its links: page); a command app needs its table's restore argv; a source app keeps one
 * only with a dir or stage (one built in a fresh clone runs make install, which writes many files).
 */
export function canRestore(spec: Pick<AppSpec, "kind" | "dir" | "stage" | "restore">): boolean {
	if (spec.kind === "source") return Boolean(spec.dir || spec.stage);
	if (spec.kind === "command") return (spec.restore?.length ?? 0) > 0;
	return spec.kind === "appimage" || spec.kind === "archive" || spec.kind === "file" || isPackage(spec.kind);
}

/** The app's dest with a leading ~ expanded to the home in paths; an app with no dest gives an empty path. */
export function destOf(spec: AppSpec, ctx: Pick<KindCtx, "paths">): string {
	return expandHome(spec.dest ?? "", ctx.paths.home);
}

/** Every file an install of this app writes: the dest itself, or each of an archive's bins beside it, after a folder app's folder. */
export function installedFiles(spec: AppSpec, dest: string, home: string): string[] {
	if (spec.kind !== "archive") return [dest];
	const bins = (spec.bins ?? []).map((b) => join(dirname(dest), binName(b, dest)));
	return spec.folder ? [expandHome(spec.folder, home), ...bins] : bins;
}

/** The name a bin installs under: its base name, or dest's for one with a * in it (ipatool-*-linux-amd64 is ipatool). */
function binName(bin: string, dest: string): string {
	return basename(bin).includes("*") ? basename(dest) : basename(bin);
}

/**
 * Why tar or unzip could not open an archive, as a sentence: the program it hands xz, bzip2 or zstd to is missing on a minimal
 * system (Ubuntu's cloud image has no xz), which GNU tar reports as "xz: Cannot exec"; unpacker itself (unzip, tar)
 * missing is exit 127 from the runner. Anything else is couldNotExtract.
 */
export function unpackProblem(asset: string, r: ProcessResult, unpacker: string): string {
	const tool = r.code === 127 ? unpacker : /(\w+): Cannot exec/.exec(r.stderr)?.[1];
	return tool ? MESSAGES.archiveNeedsTool(asset, tool) : MESSAGES.couldNotExtract(asset);
}

/** Whether an archive file name is the bin's base name, where a * stands for any run of characters (a version). */
function binMatcher(bin: string): (name: string) => boolean {
	const base = basename(bin);
	if (!base.includes("*")) return (n) => n === base;
	const parts = base.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
	const re = new RegExp(`^${parts.join(".*")}$`);
	return (n) => re.test(n);
}

/**
 * Reads the installed version: a command app by its check argv, else from the AppImage metadata when the table names
 * one, else by running the dest with its version args. A table with probe false never runs it: its version is the one
 * Upkeep recorded at install, while the file is still the one it wrote, and unknown otherwise. Only that table: for
 * one that asks, a program that exits with no version may be a broken install, never one to vouch for.
 */
export function probeInstalled(spec: AppSpec, ctx: KindCtx): Promise<ProbeResult> {
	// A command app has no dest: its own check argv is what reads its version.
	if (spec.kind === "command") return probeCommand(spec.check ?? [], { run: ctx.run });
	const dest = destOf(spec, ctx);
	if (spec.probe === false) {
		if (!existsSync(dest)) return Promise.resolve({ state: "absent" });
		const stamped = stampedVersion(ctx.paths, spec.key, dest);
		return Promise.resolve(stamped ? { version: stamped } : { state: "unknown" });
	}
	if (spec.meta_path) return probeAppImageMeta(dest, spec.meta_path, { run: ctx.run });
	return probeVersion(dest, spec.version_args ?? ["--version"], { run: ctx.run });
}

/** Whether an app's releases can be listed: a file kind whose table names a repo, which a pre-release pick and Install another version both need. */
export function canList(spec: Pick<AppSpec, "kind" | "repo">): boolean {
	return Boolean(spec.repo) && (["appimage", "archive", "file"].includes(spec.kind) || isPackage(spec.kind));
}

/**
 * The newest release of a list by version, pre-releases included; a release whose tag holds no version is passed over.
 * Null when none holds one. The forge's own order is by date, and a backport can be published after a newer release.
 */
export function newestOf(list: Release[]): Release | null {
	let best: Release | null = null;
	for (const r of list) if (r.version && (!best || isNewer(best.version, r.version))) best = r;
	return best;
}

/**
 * The release list of a listable app on its forge, newest first, as a person picks a version from it. Only releases
 * with a file the table's pattern for this machine matches are kept: a file renamed years ago, or another product of
 * a monorepo, is never offered. A table with no pattern for this machine keeps none.
 */
export async function listReleases(spec: AppSpec, ctx: KindCtx): Promise<Release[] | Failure> {
	const list = await allReleases(spec, ctx);
	return isFailure(list) ? list : fitting(list, spec, ctx);
}

/**
 * The newest releases of a listable app on its forge, whether or not they hold a file for this machine. Release notes
 * read this list: a release with no file for this machine still says what changed in the project.
 */
export function allReleases(spec: AppSpec, ctx: KindCtx): Promise<Release[] | Failure> {
	return forgeReleases(spec.repo ?? "", spec.forge, releaseOpts(ctx));
}

/** The releases of list that hold a file matching the table's pattern for this machine. */
function fitting(list: Release[], spec: AppSpec, ctx: KindCtx): Release[] {
	const pattern = assetFor(spec, ctx.arch);
	return pattern === undefined ? [] : list.filter((r) => pickAsset(r, pattern) !== null);
}

/** The options every release lookup of this app passes: its cache, token, fetch and budget callback. */
function releaseOpts(ctx: KindCtx, tag?: string) {
	return {
		cacheDir: join(ctx.paths.cache, "github"),
		token: ctx.token,
		fetch: ctx.fetch,
		onRate: ctx.onRate,
		api: ctx.api,
		tag,
	};
}

/**
 * The release a check compares against, or with tag the release of that tag (a restore point's): the latest of repo
 * on its forge (with prerelease, the newest of its release list), else the page a "links:" latest names, else the file a "zsync:" one names, else what latest names
 * when it carries a download (a "json:" source). A latest that only gives a version has nothing to install, which is a failure here.
 */
export async function releaseOf(spec: AppSpec, ctx: KindCtx, tag?: string): Promise<Release | Failure> {
	const opts = releaseOpts(ctx, tag);
	if (spec.prerelease && tag === undefined && canList(spec)) {
		const list = await forgeReleases(spec.repo ?? "", spec.forge, opts);
		if (isFailure(list)) return list;
		// Ranked by version among the releases this table can install; with none, the newest says why it cannot. A list of
		// only rolling tags (nightly, continuous) holds no version: the forge's latest release is still seen.
		return newestOf(fitting(list, spec, ctx)) ?? newestOf(list) ?? forgeRelease(spec.repo ?? "", spec.forge, opts);
	}
	if (spec.repo || !spec.latest) return forgeRelease(spec.repo ?? "", spec.forge, opts);
	if (spec.latest.startsWith("links:")) return linksRelease(spec.latest.slice(6), assetFor(spec, ctx.arch) ?? "", opts);
	if (spec.latest.startsWith("zsync:")) return zsyncRelease(spec.latest.slice(6), ctx.fetch);
	const r = await latestFromSource(spec.latest, opts);
	if (isFailure(r)) return r;
	return r.release ?? { failure: "http", detail: MESSAGES.sourceGivesNoDownload(spec.latest) };
}

/**
 * Probes the installed copy and looks up the latest release. Source builds pass needAsset false. A table with no asset
 * pattern for this machine's architecture is a problem before any lookup, never another architecture's file.
 */
export async function checkRelease(spec: AppSpec, ctx: KindCtx, needAsset = true): Promise<Checked | null> {
	const dest = destOf(spec, ctx);
	const probe = await probeInstalled(spec, ctx);
	// An app the owner added before installing it is listed as ready, not left out.
	const missing = "state" in probe && probe.state === "absent" && spec.install_if_missing === true;
	if ("state" in probe && probe.state === "absent" && !missing) {
		ctx.log(`${spec.name} is not installed at ${dest}, skipped.`);
		return null;
	}
	const installed = "version" in probe ? probe.version : null;
	// A copy Upkeep did not put there, of an app it never asks: the latest is offered, and installing it records the version.
	const untracked = spec.probe === false && "state" in probe && probe.state === "unknown";
	const pattern = assetFor(spec, ctx.arch);
	// A table written on the other architecture (an apps.toml brought from another machine) names no file for this one.
	if (needAsset && pattern === undefined)
		return {
			installed,
			latest: null,
			status: "problem",
			detail: MESSAGES.noAssetForArch(spec.name, ctx.arch ?? "x86_64"),
		};
	const release = await releaseOf(spec, ctx);
	if (isFailure(release))
		return {
			installed,
			latest: null,
			status: "problem",
			detail: release.detail,
			offline: release.failure === "network",
		};
	const base = { ...fromRelease(release) };
	if (!release.version)
		return {
			installed,
			latest: null,
			status: "problem",
			detail: MESSAGES.latestTagNotTracked(release.tag),
			...base,
		};
	const latest = release.version;
	if (!("version" in probe) && !missing && !untracked) {
		if (!needAsset && probe.state === "broken")
			return {
				installed: latest,
				latest,
				status: "ready",
				detail: MESSAGES.rebuildFixes(),
				target: { from: null, version: latest, tag: release.tag },
				...base,
			};
		return { installed, latest, status: "problem", detail: probeProblem(spec.name, spec.dest ?? dest, probe), ...base };
	}
	const status = missing || untracked || isNewer(installed, latest) ? "ready" : "fresh";
	let target: Target = { from: installed, version: latest, tag: release.tag };
	let size: number | undefined;
	if (needAsset) {
		const pick = pickAsset(release, pattern ?? "");
		if (!pick)
			return { installed, latest, status: "problem", detail: MESSAGES.noAssetMatches(String(pattern)), ...base };
		if (pick.count > 1)
			return {
				installed,
				latest,
				status: "problem",
				detail: MESSAGES.severalAssetsMatch(String(pattern), pick.names.join(", ")),
				...base,
			};
		// Only for an update on offer: a release with no digest is read for its own checksum file, once per check.
		target =
			status === "ready"
				? await checkedTarget(spec, ctx, release, pick.asset, target)
				: { ...target, asset: pick.asset };
		// A fresh row is locked as well, so a check never records its file as one that could change.
		if (release.immutable) target.locked = true;
		// 0 is a source's "not listed" (json:, GitLab, links:): the download server is asked, and only when the row shows it.
		size = pick.asset.size || (status === "ready" ? await statedSize(pick.asset.url, ctx.fetch) : undefined);
	}
	const detail = untracked ? { detail: MESSAGES.versionNotRecorded(spec.name) } : {};
	return { installed, latest, status, size, target, ...detail, ...base };
}

/**
 * The install target for one release of a listable app, by its tag: what Install another version runs. The tag must
 * hold a version, and the app's asset pattern for this machine must match exactly one of its files, as a check asks.
 */
export async function versionTarget(
	spec: AppSpec,
	ctx: KindCtx,
	tag: string,
	installed: string | null,
): Promise<Target | Failure> {
	const pattern = assetFor(spec, ctx.arch);
	if (pattern === undefined)
		return { failure: "http", detail: MESSAGES.noAssetForArch(spec.name, ctx.arch ?? "x86_64") };
	const release = await releaseOf(spec, ctx, tag);
	if (isFailure(release)) return release;
	if (!release.version) return { failure: "http", detail: MESSAGES.latestTagNotTracked(release.tag) };
	const pick = pickAsset(release, pattern);
	if (!pick) return { failure: "http", detail: MESSAGES.noAssetMatches(pattern) };
	if (pick.count > 1) return { failure: "http", detail: MESSAGES.severalAssetsMatch(pattern, pick.names.join(", ")) };
	return checkedTarget(spec, ctx, release, pick.asset, { from: installed, version: release.version, tag: release.tag });
}

/**
 * target with its file, checked as an offered update is: a file with no digest carries the hash its release's own
 * checksum file lists, when one does, and a release the forge marks immutable is locked, so a changed file never holds it.
 */
async function checkedTarget(
	spec: AppSpec,
	ctx: KindCtx,
	release: Release,
	asset: Asset,
	target: Target,
): Promise<Target> {
	const sum = asset.digest
		? null
		: await cachedSum(sumCache(ctx, spec.key), release, asset, ctx.fetch, {
				token: ctx.token,
				cancel: ctx.cancel,
				now: (ctx.now?.() ?? new Date()).getTime(),
			});
	const out: Target = { ...target, asset: sum ? { ...asset, sum } : asset };
	if (release.immutable) out.locked = true;
	return out;
}

/** Depth-first search under dir for a file whose name matches; null when none, and the first match in directory order wins. */
function findFile(dir: string, matches: (name: string) => boolean): string | null {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isFile() && matches(e.name)) return p;
		if (e.isDirectory()) {
			const found = findFile(p, matches);
			if (found) return found;
		}
	}
	return null;
}

/** The file inside a folder app's folder that says Upkeep made it, holding the app's key. */
const OWN_MARK = ".upkeep";

/** Whether folder is free for key's install: not there yet, or made by Upkeep for that same app. */
function folderFree(folder: string, key: string): boolean {
	if (!existsSync(folder)) return true;
	try {
		return readFileSync(join(folder, OWN_MARK), "utf8").trim() === key;
	} catch {
		return false;
	}
}

/** A test for a bin path: whether dir holds it as a regular file. */
const holds = (dir: string) => (b: string) => existsSync(join(dir, b)) && statSync(join(dir, b)).isFile();

/**
 * A folder app: what the archive holds becomes the table's folder, swapped in by rename, and each bin, a path inside
 * it, is linked from dest's directory under its base name. The bins are looked for at the archive's root, then inside
 * its one top folder (kitty-0.44.0/bin/kitty), so an archive holding only bin/ keeps it. A bin missing from the archive
 * is returned before anything moves; null when all is in place.
 */
function placeFolder(spec: AppSpec, dest: string, extract: string, ctx: KindCtx): string | null {
	const bins = spec.bins ?? [];
	const entries = readdirSync(extract);
	const only = entries.length === 1 ? join(extract, entries[0] ?? "") : "";
	const top = bins.every((b) => inFolder(extract, b)) || !only || !statSync(only).isDirectory() ? extract : only;
	const found = bins.map((b) => inFolder(top, b));
	const absent = bins.find((_, i) => !found[i]);
	if (absent) return basename(absent);
	const folder = expandHome(spec.folder ?? "", ctx.paths.home);
	writeFileSync(join(top, OWN_MARK), `${spec.key}\n`);
	swapFolder(top, folder, ctx.paths);
	mkdirSync(dirname(dest), { recursive: true });
	try {
		bins.forEach((b, i) => relink(join(folder, found[i] ?? b), join(dirname(dest), binName(b, dest))));
	} catch (err) {
		ctx.log(`Linking into ${dirname(dest)}: ${err instanceof Error ? err.message : String(err)}`);
		return basename(bins[0] ?? dest);
	}
	ctx.log(`Unpacked into ${folder}, linked ${bins.map((b) => binName(b, dest)).join(", ")}`);
	return null;
}

/** A bin's path inside dir as a regular file, a * in its base name standing for a version; null when it is not there. */
function inFolder(dir: string, bin: string): string | null {
	if (!basename(bin).includes("*")) return holds(dir)(bin) ? bin : null;
	const under = join(dir, dirname(bin));
	const hit = existsSync(under) ? findFile(under, binMatcher(bin)) : null;
	return hit ? hit.slice(dir.length + 1) : null;
}

/** Where a release app's file is downloaded, at its turn or ahead of it. The run's dl folder is emptied when a run starts. */
export function dlPath(paths: KindCtx["paths"], key: string, name: string): string {
	return join(paths.cache, "dl", `${key}-${name}`);
}

/** Where the answer of a release app's checksum files is kept between checks. */
function sumCache(ctx: Pick<KindCtx, "paths">, key: string): string {
	return join(ctx.paths.cache, "sums", `${key}.json`);
}

/**
 * verifyAsset for the target's file. A mismatch against a hash from the release's checksum file reads that file again
 * once, past the cache: a maintainer who re-uploaded the file and its checksum under the same tag is checked against
 * the new line, and the next check sees the changed hash. A checksum file that still disagrees fails as before.
 */
async function verified(
	spec: AppSpec,
	target: Target,
	got: DownloadResult,
	file: string,
	ctx: KindCtx,
): Promise<DownloadCheck> {
	const asset = target.asset;
	if (!asset) throw new Error(MESSAGES.noReleaseAssetFor(spec.name));
	try {
		return verifyAsset(got, asset);
	} catch (err) {
		if (!asset.sum || asset.digest) throw err;
		const release = await releaseOf(spec, ctx, target.tag);
		if (isFailure(release)) throw err;
		const now = (ctx.now?.() ?? new Date()).getTime();
		const opts = { token: ctx.token, cancel: ctx.cancel, now, fresh: true };
		const sum = await cachedSum(sumCache(ctx, spec.key), release, asset, ctx.fetch, opts);
		if (!sum || (sum.algo === asset.sum.algo && sum.hex === asset.sum.hex)) throw err;
		ctx.log(`${sum.file} changed since the check; checking the download against it again`);
		const again = needsSha512({ sum }) && !got.sha512 ? await hashFile(file, true) : got;
		return verifyAsset(again, { ...asset, sum });
	}
}

/** The log's English for how a download was checked. */
const CHECK_LOG = {
	digest: () => "matches the forge's SHA-256 record",
	sums: (a) => `matches ${a.sum?.file ?? "the release's checksum file"}`,
	size: () => "size only, the release lists no checksum",
	none: () => "not checked, the release lists no size or checksum",
} satisfies Record<DownloadCheck, (asset: NonNullable<Target["asset"]>) => string>;

/** A stage of an install that failed with a message fit to show the person; anything else thrown is unexpected and rethrown. */
class StepError extends Error {}

/** The real path of p, or p unchanged when it does not exist yet. */
function resolved(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/** Downloads, backs up, installs and verifies one appimage, archive, file, deb or rpm app. */
export async function installRelease(spec: AppSpec, target: Target, ctx: KindCtx): Promise<Outcome> {
	const asset = target.asset;
	if (!asset) throw new Error(MESSAGES.noReleaseAssetFor(spec.name));
	// A symlinked dest is updated through the link, never replaced by a regular file. A folder app's dest is its own link.
	const dest = spec.folder ? destOf(spec, ctx) : resolved(destOf(spec, ctx));
	const clock = stageClock(ctx);
	const dl = dlPath(ctx.paths, spec.key, asset.name);
	const extract = join(ctx.paths.cache, "dl", `${spec.key}-x`);
	const restorable = canRestore(spec);
	const bins = spec.kind === "archive" ? (spec.bins ?? []) : [];
	const targets = installedFiles(spec, dest, ctx.paths.home);
	let backupVersion: string | null = null;
	// Set once the first change on disk is near: from here Stop now puts the restore point back instead.
	let changing = false;
	// A bin this run added has no restore point, so a failure or Stop now takes it out again.
	const added: string[] = [];
	// A file fetched ahead records its real download time, so the next run's stem keeps the download's width.
	let earlyMs: number | undefined;
	let checked: DownloadCheck | undefined;
	const finish = (o: Omit<Outcome, "stages">): Outcome => {
		const stages = clock.stop();
		return { ...o, checked, stages: earlyMs === undefined ? stages : { ...stages, download: earlyMs } };
	};
	// Before any download or restore point: a folder Upkeep did not make is never copied, renamed or replaced.
	if (spec.folder && !folderFree(expandHome(spec.folder, ctx.paths.home), spec.key))
		return finish({
			result: "failed",
			installed: target.from,
			detail: MESSAGES.folderNotOurs(expandHome(spec.folder, ctx.paths.home)),
			restartToApply: false,
		});
	try {
		clock.start("download", 0);
		const onProgress = (received: number, total: number | null) => {
			const size = total ?? (asset.size || null);
			ctx.stage("download", size ? Math.min(100, Math.round((received / size) * 100)) : null);
		};
		// A file fetched ahead of the turn was read back and checked just now; without one, the turn downloads it.
		const early = await ctx.early?.(onProgress);
		if (early) {
			earlyMs = early.ms;
			ctx.stage("download", 100);
		} else ctx.log(`Downloading ${asset.name}`);
		// A check during the run can give the asset a sha512 sum its early download was not hashed for.
		const got =
			early && needsSha512(asset) && !early.sha512
				? await hashFile(dl, true)
				: (early ??
					(await download(asset.url, dl, {
						fetch: ctx.fetch,
						onProgress,
						stallMs: ctx.stallMs,
						retryMs: ctx.retryMs,
						signedIn: signedIn(asset, ctx.token),
						sha512: needsSha512(asset),
						signal: ctx.cancel,
					})));
		checked = await verified(spec, target, got, dl, ctx);
		ctx.log(`Downloaded ${got.bytes} bytes, sha256 ${got.sha256}, ${CHECK_LOG[checked](asset)}`);

		if (restorable && isPackage(spec.kind) && target.from) {
			clock.start("backup");
			const old = await oldPackage(spec, target, ctx);
			if ("problem" in old)
				ctx.log(stopPressed(ctx) ? "Stopped before the restore point was taken." : `No restore point: ${old.problem}`);
			else {
				takePoint(
					ctx.paths,
					spec,
					target.from,
					{ package: spec.kind, file: old.file },
					(ctx.now?.() ?? new Date()).toISOString(),
					ctx.log,
				);
				rmSync(dirname(old.file), { recursive: true, force: true });
				backupVersion = target.from;
				ctx.log(`Restore point ${target.from} taken`);
			}
		} else if (restorable) {
			clock.start("backup");
			const existing = targets.filter((f) => existsSync(f));
			if (existing.length > 0 && target.from) {
				takeBackup(ctx.paths, spec, target.from, existing, (ctx.now?.() ?? new Date()).toISOString(), ctx.log);
				backupVersion = target.from;
				ctx.log(`Restore point ${target.from} taken`);
			}
		}

		if (stopPressed(ctx)) return finish(stoppedOutcome(target.from));
		const existed = new Set(targets.filter((f) => existsSync(f)));
		const running = isRunning({ ...spec, dest: resolved(dest) }, ctx.procRoot);
		changing = true;
		writeInflight(ctx.paths, { key: spec.key, dest, backupVersion, files: targets });
		clock.start("install");
		if (spec.kind === "appimage" || spec.kind === "file") {
			const mode = existsSync(dest) ? statSync(dest).mode & 0o777 : 0o755;
			if (spec.sudo) {
				const r = await installAside(ctx.run, dl, dest, mode.toString(8), true);
				if (sudoNeedsPassword(r))
					return finish({ result: "failed", installed: target.from, detail: SUDO_PASSWORD, restartToApply: false });
				if (r.code !== 0) throw new StepError(MESSAGES.couldNotInstallFile(basename(dest)));
			} else {
				mkdirSync(dirname(dest), { recursive: true });
				const next = `${dest}.upkeep-new`;
				copyFileSync(dl, next);
				chmodSync(next, mode);
				// Rename keeps the old inode alive for a process that has it open.
				renameSync(next, dest);
			}
		} else if (spec.kind === "archive") {
			if (!spec.sudo) mkdirSync(dirname(dest), { recursive: true });
			rmSync(extract, { recursive: true, force: true });
			mkdirSync(extract, { recursive: true });
			const unpack = asset.name.endsWith(".zip")
				? ["unzip", "-q", dl, "-d", extract]
				: // GNU tar tells gzip, xz, bzip2 and zstd apart on its own when it reads a file.
					["tar", "xf", dl, "-C", extract];
			const x = await ctx.run(unpack, { timeoutMs: 300_000, cuttable: true });
			// Only the cache folder holds anything new yet.
			if (stopPressed(ctx)) return finish(stoppedOutcome(target.from));
			if (x.code !== 0) throw new StepError(unpackProblem(asset.name, x, unpack[0] ?? "tar"));
			if (spec.folder) {
				// A failure after the swap (a link that cannot be made) is put back like a missing bin.
				let missing: string | null;
				try {
					missing = placeFolder(spec, dest, extract, ctx);
				} catch (err) {
					ctx.log(`Placing the folder: ${err instanceof Error ? err.message : String(err)}`);
					missing = basename(spec.folder ?? dest);
				}
				if (missing) {
					const back = backupVersion ? await restoreBackup(ctx.paths, spec, backupVersion, ctx.run) : null;
					const detail = back?.ok
						? MESSAGES.couldNotInstallRestored(missing, String(backupVersion))
						: back
							? MESSAGES.couldNotInstallRestoreFailed(missing, back.detail ?? "")
							: MESSAGES.couldNotInstallNoPoint(missing);
					return finish({ result: "failed", installed: target.from, detail, restartToApply: false });
				}
			}
			for (const bin of spec.folder ? [] : bins) {
				// oxlint-disable-next-line no-await-in-loop -- the loop ends here
				if (stopPressed(ctx)) return finish(await putBack(spec, ctx, backupVersion, added));
				const name = binName(bin, dest);
				const to = join(dirname(dest), name);
				const direct = join(extract, bin);
				// A top folder can share the program's name (btop/bin/btop): only a file at the direct path is the program.
				const src = existsSync(direct) && statSync(direct).isFile() ? direct : findFile(extract, binMatcher(bin));
				let failed = src === null;
				let sudoFail = false;
				if (src) {
					// oxlint-disable-next-line no-await-in-loop -- bins go in one at a time so a failure stops the rest
					const r = await installAside(ctx.run, src, to, "755", spec.sudo);
					sudoFail = sudoNeedsPassword(r);
					failed = r.code !== 0 || !existsSync(to) || statSync(src).size !== statSync(to).size;
					if (r.code !== 0) ctx.log(`install ${name}: ${(r.stderr || r.stdout).trim()}`);
				}
				if (failed) {
					// oxlint-disable-next-line no-await-in-loop -- the loop ends here
					await Promise.all(added.map((f) => ctx.run(asRoot(["rm", "-f", f], spec.sudo), { timeoutMs: 60_000 })));
					// oxlint-disable-next-line no-await-in-loop -- the loop ends here
					const back = backupVersion ? await restoreBackup(ctx.paths, spec, backupVersion, ctx.run) : null;
					const detail = sudoFail
						? SUDO_PASSWORD
						: back?.ok
							? MESSAGES.couldNotInstallRestored(name, String(backupVersion))
							: back
								? MESSAGES.couldNotInstallRestoreFailed(name, back.detail ?? "")
								: MESSAGES.couldNotInstallNoPoint(name);
					return finish({ result: "failed", installed: target.from, detail, restartToApply: false });
				}
				if (!existed.has(to)) added.push(to);
				ctx.log(`Installed ${name} to ${to}`);
			}
		} else if (isPackage(spec.kind)) {
			const tool = PACKAGE_TOOL[spec.kind];
			const r = await ctx.run(asRoot(packageInstall(spec.kind, dl), true), {
				timeoutMs: 600_000,
				onLine: (l) => ctx.log(l),
			});
			if (sudoNeedsPassword(r))
				return finish({ result: "failed", installed: target.from, detail: SUDO_PASSWORD, restartToApply: false });
			if (r.code !== 0) {
				// The tool can leave the new package half unpacked, so the point goes back in.
				const back = backupVersion ? await restoreBackup(ctx.paths, spec, backupVersion, ctx.run) : null;
				if (back?.ok && stopPressed(ctx)) return finish(stoppedOutcome(backupVersion));
				if (back?.ok)
					return finish({
						result: "rolled_back",
						installed: backupVersion,
						detail: MESSAGES.packageRestored(tool, asset.name, String(backupVersion)),
						restartToApply: false,
					});
				if (!back) throw new StepError(MESSAGES.packageSeeLog(tool, asset.name));
				ctx.log(`Restore failed: ${back.detail ?? ""}`);
				return finish({
					result: "failed",
					installed: await installedNow(spec, ctx),
					detail: MESSAGES.packagePutBackFailed(tool, asset.name, String(backupVersion)),
					restartToApply: false,
				});
			}
		}

		// A step Stop now could not cut (dpkg, a root install) was waited out: what it changed goes back now.
		if (stopPressed(ctx)) return finish(await putBack(spec, ctx, backupVersion, added));
		clock.start("verify");
		// Before the probe, so a table with probe false reads back the version just installed.
		stampInstalled(ctx.paths, spec.key, dest, target.version);
		const after = await probeInstalled(spec, { ...ctx, run: cuttableRun(ctx) });
		if (stopPressed(ctx)) return finish(await putBack(spec, ctx, backupVersion, added, true));
		if ("version" in after && after.version === target.from && target.from !== target.version)
			return finish({
				result: "failed",
				installed: after.version,
				detail: MESSAGES.stillAtAfterUpdate(after.version),
				restartToApply: false,
			});
		if ("version" in after) {
			prune(ctx.paths, spec.key, ctx.settings.keepBackups);
			await packOlder(ctx.paths, spec.key, ctx.run, ctx.log);
			const detail = after.version !== target.version ? MESSAGES.reportsVersion(after.version) : undefined;
			return finish({ result: "done", installed: after.version, detail, restartToApply: running });
		}
		ctx.log(`Probe after install: ${after.state}${after.detail ? ` ${after.detail}` : ""}`);
		return finish(await rollBack(spec, ctx, backupVersion, target));
	} catch (err) {
		// A download Stop now aborted throws; nothing outside the cache had changed.
		if (stopPressed(ctx) && !changing) return finish(stoppedOutcome(target.from));
		if (!(err instanceof StepError)) throw err;
		return finish({ result: "failed", installed: target.from, detail: err.message, restartToApply: false });
	} finally {
		// A thrown error is not a crash: the marker is only for a run that never got here.
		clearInflight(ctx.paths);
		rmSync(dl, { force: true });
		rmSync(extract, { recursive: true, force: true });
		rmSync(`${dest}.upkeep-new`, { force: true });
	}
}

/**
 * The installed version's package, from the release whose tag is the new one's with the installed version in its place
 * ("v1.5.3" for 1.5.3 gives "v1.5.1" for 1.5.1), matched with the app's own asset pattern and checked like any
 * download. A tag that does not hold the version, a missing release or no matching asset is a problem, never a throw.
 */
async function oldPackage(
	spec: AppSpec,
	target: Target,
	ctx: KindCtx,
): Promise<{ file: string } | { problem: string }> {
	const from = target.from ?? "";
	if (!target.tag.includes(target.version)) return { problem: `${target.tag} does not name its version.` };
	const tag = target.tag.replace(target.version, from);
	const release = await releaseOf(spec, ctx, tag);
	if (isFailure(release)) return { problem: `${tag}: ${release.detail}` };
	const pattern = assetFor(spec, ctx.arch);
	// An empty pattern would match every asset of the release.
	if (pattern === undefined) return { problem: `${spec.key} has no asset pattern for ${ctx.arch}.` };
	const picked = pickAsset(release, pattern);
	if (!picked) return { problem: `the ${tag} release has no package matching ${pattern}.` };
	if (picked.count > 1) return { problem: `more than one ${tag} asset matches ${pattern}.` };
	// A folder of its own, so the point keeps the package under the name it was released with.
	const file = join(ctx.paths.cache, "dl", `${spec.key}-old`, picked.asset.name);
	try {
		verifyAsset(
			await download(picked.asset.url, file, {
				fetch: ctx.fetch,
				stallMs: ctx.stallMs,
				retryMs: ctx.retryMs,
				signedIn: signedIn(picked.asset, ctx.token),
				signal: ctx.cancel,
			}),
			picked.asset,
		);
	} catch (err) {
		rmSync(file, { force: true });
		return { problem: `could not download ${picked.asset.name}: ${err instanceof Error ? err.message : String(err)}` };
	}
	return { file };
}

/** The version a probe reads now, or null when it reads none; for a row after a putting-back that failed. */
async function installedNow(spec: AppSpec, ctx: KindCtx): Promise<string | null> {
	const p = await probeInstalled(spec, ctx);
	return "version" in p ? p.version : null;
}

/**
 * Stop now after the install changed things: the bins this run added go, and the point this run took goes back. With
 * no point (a first install, a kind without one) the new copy stays, and the row says what a probe reads now. ran:
 * the probe ran the new copy, which may have rewritten its settings, so they go back too; before it they are as saved.
 */
async function putBack(
	spec: AppSpec,
	ctx: KindCtx,
	backupVersion: string | null,
	added: string[],
	ran = false,
): Promise<Omit<Outcome, "stages">> {
	await Promise.all(added.map((f) => ctx.run(asRoot(["rm", "-f", f], spec.sudo), { timeoutMs: 60_000 })));
	if (backupVersion && canRestore(spec)) {
		const r = await restoreBackup(ctx.paths, spec, backupVersion, ctx.run, ran ? spec.keep_with_restore : undefined);
		if (r.ok) return stoppedOutcome(backupVersion);
		ctx.log(`Restore failed: ${r.detail ?? ""}`);
		return { result: "failed", installed: await installedNow(spec, ctx), detail: r.detail, restartToApply: false };
	}
	const now = await installedNow(spec, ctx);
	return {
		result: "stopped",
		installed: now,
		detail: now ? MESSAGES.stoppedStillAt(spec.name, now) : undefined,
		restartToApply: false,
	};
}

/** The new copy would not start: put the restore point back when there is one. */
async function rollBack(
	spec: AppSpec,
	ctx: KindCtx,
	backupVersion: string | null,
	target: Target,
): Promise<Omit<Outcome, "stages">> {
	// Only the point this run took: an older one may be another version or another dest.
	const point = backupVersion;
	if (point && canRestore(spec)) {
		// The probe ran the new copy, which may have rewritten its settings: they go back too.
		const r = await restoreBackup(ctx.paths, spec, point, ctx.run, spec.keep_with_restore);
		if (r.ok)
			return {
				result: "rolled_back",
				installed: point,
				detail: MESSAGES.wouldNotStartRestored(point),
				restartToApply: false,
			};
		ctx.log(`Restore failed: ${r.detail ?? ""}`);
		return {
			result: "failed",
			// The disk may hold the new copy, the old one or neither: the row shows what a probe finds.
			installed: await installedNow(spec, ctx),
			detail: MESSAGES.wouldNotStartPutBackFailed(point),
			restartToApply: false,
		};
	}
	return {
		result: "failed",
		installed: target.from,
		detail: canRestore(spec) ? MESSAGES.wouldNotStartNoPointTaken() : MESSAGES.wouldNotStartNoPointKind(),
		restartToApply: false,
	};
}
