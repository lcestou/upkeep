import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AppSpec } from "../../shared/types";
import { prune, restoreBackup, takeBackup, takePoint } from "../backup";
import { download, verifyAsset } from "../download";
import { fetchRelease, isFailure, pickAsset } from "../github";
import { expandHome } from "../paths";
import { probeAppImageMeta, probeCommand, probeVersion, type ProbeResult } from "../probe";
import { asRoot, installAside, SUDO_PASSWORD, sudoNeedsPassword } from "../run";
import { isRunning } from "../running";
import { clearInflight, writeInflight } from "../store";
import { isNewer } from "../version";
import {
	type Checked,
	fromRelease,
	type KindCtx,
	type Outcome,
	probeProblem,
	stageClock,
	type Target,
} from "./context";

/**
 * Whether an install of this app keeps a restore point. A file kind copies its files; a .deb keeps the installed
 * version's package from its GitHub release; a command app needs its table's restore argv; a source app keeps one
 * only with a dir or stage (one built in a fresh clone runs make install, which writes many files).
 */
export function canRestore(spec: Pick<AppSpec, "kind" | "dir" | "stage" | "restore">): boolean {
	if (spec.kind === "source") return Boolean(spec.dir || spec.stage);
	if (spec.kind === "command") return (spec.restore?.length ?? 0) > 0;
	return spec.kind === "appimage" || spec.kind === "archive" || spec.kind === "file" || spec.kind === "deb";
}

/** The app's dest with a leading ~ expanded to the home in paths; an app with no dest gives an empty path. */
export function destOf(spec: AppSpec, ctx: Pick<KindCtx, "paths">): string {
	return expandHome(spec.dest ?? "", ctx.paths.home);
}

/** Every file an install of this app writes: the dest itself, or each of an archive's bins beside it. */
export function installedFiles(spec: AppSpec, dest: string): string[] {
	if (spec.kind !== "archive") return [dest];
	return (spec.bins ?? []).map((b) => join(dirname(dest), basename(b)));
}

/** Reads the installed version: a command app by its check argv, else from the AppImage metadata when the table names one, else by running the dest with its version args. */
export function probeInstalled(spec: AppSpec, ctx: KindCtx): Promise<ProbeResult> {
	// A command app has no dest: its own check argv is what reads its version.
	if (spec.kind === "command") return probeCommand(spec.check ?? [], { run: ctx.run });
	const dest = destOf(spec, ctx);
	if (spec.meta_path) return probeAppImageMeta(dest, spec.meta_path, { run: ctx.run });
	return probeVersion(dest, spec.version_args ?? ["--version"], { run: ctx.run });
}

/** Probes the installed copy and looks up the latest release. Source builds pass needAsset false. */
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
	const release = await fetchRelease(spec.repo ?? "", {
		cacheDir: join(ctx.paths.cache, "github"),
		token: ctx.token,
		fetch: ctx.fetch,
		onRate: ctx.onRate,
		api: ctx.api,
	});
	if (isFailure(release)) return { installed, latest: null, status: "problem", detail: release.detail };
	const base = { ...fromRelease(release) };
	if (!release.version)
		return {
			installed,
			latest: null,
			status: "problem",
			detail: `The latest tag ${release.tag} is not a tracked version.`,
			...base,
		};
	const latest = release.version;
	if (!("version" in probe) && !missing) {
		if (!needAsset && probe.state === "broken")
			return {
				installed: latest,
				latest,
				status: "ready",
				detail: "Will not start. A rebuild against the current libraries fixes it.",
				target: { from: null, version: latest, tag: release.tag },
				...base,
			};
		return { installed, latest, status: "problem", detail: probeProblem(spec.name, dest, probe), ...base };
	}
	let target: Target = { from: installed, version: latest, tag: release.tag };
	let size: number | undefined;
	if (needAsset) {
		const pick = pickAsset(release, spec.asset ?? "");
		if (!pick)
			return { installed, latest, status: "problem", detail: `No release asset matches ${spec.asset}.`, ...base };
		if (pick.count > 1)
			return {
				installed,
				latest,
				status: "problem",
				detail: `More than one release asset matches ${spec.asset}: ${pick.names.join(", ")}. Narrow the pattern in apps.toml.`,
				...base,
			};
		target = { ...target, asset: pick.asset };
		size = pick.asset.size;
	}
	const status = missing || isNewer(installed, latest) ? "ready" : "fresh";
	return { installed, latest, status, size, target, ...base };
}

/** Depth-first search under dir for a file called name; null when none, and the first match in directory order wins. */
function findFile(dir: string, name: string): string | null {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isFile() && e.name === name) return p;
		if (e.isDirectory()) {
			const found = findFile(p, name);
			if (found) return found;
		}
	}
	return null;
}

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

/** Downloads, backs up, installs and verifies one appimage, archive, file or deb app. */
export async function installRelease(spec: AppSpec, target: Target, ctx: KindCtx): Promise<Outcome> {
	const asset = target.asset;
	if (!asset) throw new Error(`No release asset for ${spec.name}.`);
	// A symlinked dest is updated through the link, never replaced by a regular file.
	const dest = resolved(destOf(spec, ctx));
	const clock = stageClock(ctx);
	const dl = join(ctx.paths.cache, "dl", `${spec.key}-${asset.name}`);
	const extract = join(ctx.paths.cache, "dl", `${spec.key}-x`);
	const restorable = canRestore(spec);
	const bins = spec.kind === "archive" ? (spec.bins ?? []) : [];
	const targets = installedFiles(spec, dest);
	let backupVersion: string | null = null;
	const finish = (o: Omit<Outcome, "stages">): Outcome => ({ ...o, stages: clock.stop() });
	try {
		clock.start("download", 0);
		ctx.log(`Downloading ${asset.name}`);
		const got = await download(asset.url, dl, {
			fetch: ctx.fetch,
			onProgress: (received, total) => {
				const size = total ?? (asset.size || null);
				ctx.stage("download", size ? Math.min(100, Math.round((received / size) * 100)) : null);
			},
			stallMs: ctx.stallMs,
			retryMs: ctx.retryMs,
		});
		verifyAsset(got, asset);
		ctx.log(`Downloaded ${got.bytes} bytes, sha256 ${got.sha256}`);

		if (restorable && spec.kind === "deb" && target.from) {
			clock.start("backup");
			const old = await oldDeb(spec, target, ctx);
			if ("problem" in old) ctx.log(`No restore point: ${old.problem}`);
			else {
				takePoint(ctx.paths, spec, target.from, { deb: old.file }, (ctx.now?.() ?? new Date()).toISOString());
				rmSync(dirname(old.file), { recursive: true, force: true });
				backupVersion = target.from;
				ctx.log(`Restore point ${target.from} taken`);
			}
		} else if (restorable) {
			clock.start("backup");
			const existing = targets.filter((f) => existsSync(f));
			if (existing.length > 0 && target.from) {
				takeBackup(ctx.paths, spec, target.from, existing, (ctx.now?.() ?? new Date()).toISOString());
				backupVersion = target.from;
				ctx.log(`Restore point ${target.from} taken`);
			}
		}

		const existed = new Set(targets.filter((f) => existsSync(f)));
		const running = isRunning({ ...spec, dest }, ctx.procRoot);
		writeInflight(ctx.paths, { key: spec.key, dest, backupVersion });
		clock.start("install");
		if (spec.kind === "appimage" || spec.kind === "file") {
			const mode = existsSync(dest) ? statSync(dest).mode & 0o777 : 0o755;
			if (spec.sudo) {
				const r = await installAside(ctx.run, dl, dest, mode.toString(8), true);
				if (sudoNeedsPassword(r))
					return finish({ result: "failed", installed: target.from, detail: SUDO_PASSWORD, restartToApply: false });
				if (r.code !== 0) throw new StepError(`Could not install ${basename(dest)}.`);
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
				: ["tar", "xzf", dl, "-C", extract];
			const x = await ctx.run(unpack, { timeoutMs: 300_000 });
			if (x.code !== 0) throw new StepError(`Could not extract ${asset.name}.`);
			// A bin this run added has no restore point, so a failure takes it out again.
			const added: string[] = [];
			for (const bin of bins) {
				const name = basename(bin);
				const to = join(dirname(dest), name);
				const direct = join(extract, bin);
				const src = existsSync(direct) ? direct : findFile(extract, name);
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
							? `Could not install ${name}. Restored ${backupVersion}.`
							: back
								? `Could not install ${name}. Restore failed: ${back.detail ?? ""}`
								: `Could not install ${name}. No restore point was taken.`;
					return finish({ result: "failed", installed: target.from, detail, restartToApply: false });
				}
				if (!existed.has(to)) added.push(to);
				ctx.log(`Installed ${name} to ${to}`);
			}
		} else if (spec.kind === "deb") {
			const r = await ctx.run(asRoot(["dpkg", "-i", dl], true), { timeoutMs: 600_000, onLine: (l) => ctx.log(l) });
			if (sudoNeedsPassword(r))
				return finish({ result: "failed", installed: target.from, detail: SUDO_PASSWORD, restartToApply: false });
			if (r.code !== 0) {
				// dpkg can leave the new package half unpacked, so the point goes back in.
				const back = backupVersion ? await restoreBackup(ctx.paths, spec, backupVersion, ctx.run) : null;
				if (back?.ok)
					return finish({
						result: "rolled_back",
						installed: backupVersion,
						detail: `dpkg could not install ${asset.name}. Restored ${backupVersion}.`,
						restartToApply: false,
					});
				if (back) ctx.log(`Restore failed: ${back.detail ?? ""}`);
				throw new StepError(`dpkg could not install ${asset.name}. See the log.`);
			}
		}

		clock.start("verify");
		const after = await probeInstalled(spec, ctx);
		if ("version" in after && after.version === target.from && target.from !== target.version)
			return finish({
				result: "failed",
				installed: after.version,
				detail: `Still at ${after.version} after the update.`,
				restartToApply: false,
			});
		if ("version" in after) {
			prune(ctx.paths, spec.key, ctx.settings.keepBackups);
			const detail = after.version !== target.version ? `Reports ${after.version}.` : undefined;
			return finish({ result: "done", installed: after.version, detail, restartToApply: running });
		}
		ctx.log(`Probe after install: ${after.state}${after.detail ? ` ${after.detail}` : ""}`);
		return finish(await rollBack(spec, ctx, backupVersion, target));
	} catch (err) {
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
 * The installed version's .deb, from the release whose tag is the new one's with the installed version in its place
 * ("v1.5.3" for 1.5.3 gives "v1.5.1" for 1.5.1), matched with the app's own asset pattern and checked like any
 * download. A tag that does not hold the version, a missing release or no matching asset is a problem, never a throw.
 */
async function oldDeb(spec: AppSpec, target: Target, ctx: KindCtx): Promise<{ file: string } | { problem: string }> {
	const from = target.from ?? "";
	if (!target.tag.includes(target.version)) return { problem: `${target.tag} does not name its version.` };
	const tag = target.tag.replace(target.version, from);
	const release = await fetchRelease(spec.repo ?? "", {
		cacheDir: join(ctx.paths.cache, "github"),
		token: ctx.token,
		fetch: ctx.fetch,
		onRate: ctx.onRate,
		api: ctx.api,
		tag,
	});
	if (isFailure(release)) return { problem: `${tag}: ${release.detail}` };
	const picked = pickAsset(release, spec.asset ?? "");
	if (!picked) return { problem: `the ${tag} release has no .deb matching ${spec.asset ?? ""}.` };
	if (picked.count > 1) return { problem: `more than one ${tag} asset matches ${spec.asset ?? ""}.` };
	// A folder of its own, so the point keeps the package under the name it was released with.
	const file = join(ctx.paths.cache, "dl", `${spec.key}-old`, picked.asset.name);
	try {
		verifyAsset(
			await download(picked.asset.url, file, { fetch: ctx.fetch, stallMs: ctx.stallMs, retryMs: ctx.retryMs }),
			picked.asset,
		);
	} catch (err) {
		rmSync(file, { force: true });
		return { problem: `could not download ${picked.asset.name}: ${err instanceof Error ? err.message : String(err)}` };
	}
	return { file };
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
		const r = await restoreBackup(ctx.paths, spec, point, ctx.run);
		if (r.ok)
			return {
				result: "rolled_back",
				installed: point,
				detail: `Would not start after the update. Restored ${point}.`,
				restartToApply: false,
			};
		ctx.log(`Restore failed: ${r.detail ?? ""}`);
		return {
			result: "failed",
			installed: target.from,
			detail: `Would not start after the update, and putting ${point} back failed. See the log.`,
			restartToApply: false,
		};
	}
	return {
		result: "failed",
		installed: target.from,
		detail: canRestore(spec)
			? "Would not start after the update. No restore point was taken."
			: "Would not start after the update. No restore point for this kind.",
		restartToApply: false,
	};
}
