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
import { prune, restoreBackup, takeBackup } from "../backup";
import { download, verifyAsset } from "../download";
import { fetchRelease, isFailure, pickAsset } from "../github";
import { expandHome } from "../paths";
import { probeAppImageMeta, probeVersion, type ProbeResult } from "../probe";
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

/** appimage, archive and file keep a restore point; deb is owned by dpkg. */
export function canRestore(kind: AppSpec["kind"]): boolean {
	return kind === "appimage" || kind === "archive" || kind === "file";
}

export function destOf(spec: AppSpec, ctx: Pick<KindCtx, "paths">): string {
	return expandHome(spec.dest ?? "", ctx.paths.home);
}

export function probeInstalled(spec: AppSpec, ctx: KindCtx): Promise<ProbeResult> {
	const dest = destOf(spec, ctx);
	if (spec.meta_path) return probeAppImageMeta(dest, spec.meta_path, { run: ctx.run });
	return probeVersion(dest, spec.version_args ?? ["--version"], { run: ctx.run });
}

/** Probes the installed copy and looks up the latest release. Source builds pass needAsset false. */
export async function checkRelease(spec: AppSpec, ctx: KindCtx, needAsset = true): Promise<Checked | null> {
	const dest = destOf(spec, ctx);
	const probe = await probeInstalled(spec, ctx);
	if ("state" in probe && probe.state === "absent") {
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
	if (!("version" in probe)) {
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
	return { installed, latest, status: isNewer(installed, latest) ? "ready" : "fresh", size, target, ...base };
}

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

class StepError extends Error {}

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
	const restorable = canRestore(spec.kind);
	const bins = spec.kind === "archive" ? (spec.bins ?? []) : [];
	const targets = spec.kind === "archive" ? bins.map((b) => join(dirname(dest), basename(b))) : [dest];
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

		if (restorable) {
			clock.start("backup");
			const existing = targets.filter((f) => existsSync(f));
			if (existing.length > 0 && target.from) {
				takeBackup(ctx.paths, spec, target.from, existing, (ctx.now?.() ?? new Date()).toISOString());
				backupVersion = target.from;
				ctx.log(`Restore point ${target.from} taken`);
			}
		}

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
			rmSync(extract, { recursive: true, force: true });
			mkdirSync(extract, { recursive: true });
			const unpack = asset.name.endsWith(".zip")
				? ["unzip", "-q", dl, "-d", extract]
				: ["tar", "xzf", dl, "-C", extract];
			const x = await ctx.run(unpack, { timeoutMs: 300_000 });
			if (x.code !== 0) throw new StepError(`Could not extract ${asset.name}.`);
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
				ctx.log(`Installed ${name} to ${to}`);
			}
		} else if (spec.kind === "deb") {
			const r = await ctx.run(asRoot(["dpkg", "-i", dl], true), { timeoutMs: 600_000, onLine: (l) => ctx.log(l) });
			if (sudoNeedsPassword(r))
				return finish({ result: "failed", installed: target.from, detail: SUDO_PASSWORD, restartToApply: false });
			if (r.code !== 0) throw new StepError(`dpkg could not install ${asset.name}. See the log.`);
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

/** The new copy would not start: put the restore point back when there is one. */
async function rollBack(
	spec: AppSpec,
	ctx: KindCtx,
	backupVersion: string | null,
	target: Target,
): Promise<Omit<Outcome, "stages">> {
	// Only the point this run took: an older one may be another version or another dest.
	const point = backupVersion;
	if (point && canRestore(spec.kind)) {
		const r = await restoreBackup(ctx.paths, spec, point, ctx.run);
		if (r.ok)
			return {
				result: "rolled_back",
				installed: point,
				detail: `Would not start after the update. Restored ${point}.`,
				restartToApply: false,
			};
		ctx.log(`Restore failed: ${r.detail ?? ""}`);
	}
	return {
		result: "failed",
		installed: target.from,
		detail: canRestore(spec.kind)
			? "Would not start after the update. No restore point was taken."
			: "Would not start after the update. No restore point for this kind.",
		restartToApply: false,
	};
}
