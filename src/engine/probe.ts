import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Run } from "./run";
import { extractVersion } from "./version";

export type ProbeResult = { version: string } | { state: "absent" | "broken" | "unknown"; detail?: string };

export type ProbeOpts = { run: Run; timeoutMs?: number };

const BROKEN = /error while loading shared libraries|cannot open shared object file|symbol lookup error/;

// oxlint-disable no-control-regex -- terminal escapes are control characters by definition
export function stripEscapes(text: string): string {
	return text
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[()][0-9A-Za-z]/g, "")
		.replace(/\x1b\][^\x07]*\x07/g, "")
		.replace(/\x1b\][^\x1b]*/g, "");
}
// oxlint-enable no-control-regex

/** Reads a version out of probe output, applying the old script's broken rule first (line 299). */
export function readProbe(code: number, output: string): ProbeResult {
	if (code !== 0 && BROKEN.test(output)) return { state: "broken", detail: output.split("\n")[0]?.trim() ?? "" };
	const text = stripEscapes(output);
	if (!text.trim()) return { state: "unknown", detail: "The version probe printed nothing." };
	const version = extractVersion(text);
	return version ? { version } : { state: "unknown", detail: text.split("\n")[0]?.trim() ?? "" };
}

/** Runs file with args and reads its version. Output goes through a temp file: an AppImage's FUSE daemon would hold a pipe open. */
export async function probeVersion(file: string, args: string[], opts: ProbeOpts): Promise<ProbeResult> {
	if (!existsSync(file)) return { state: "absent" };
	const r = await opts.run([file, ...args], { timeoutMs: opts.timeoutMs ?? 10_000, merge: true });
	return readProbe(r.code, r.stdout);
}

/** The same capture for a command found on PATH. A command that is not there is absent. */
export async function probeCommand(argv: string[], opts: ProbeOpts): Promise<ProbeResult> {
	const r = await opts.run(argv, { timeoutMs: opts.timeoutMs ?? 10_000, merge: true });
	if (r.code === 127) return { state: "absent" };
	return readProbe(r.code, r.stdout + r.stderr);
}

export type MetaOpts = ProbeOpts & { pollMs?: number; polls?: number; stopMs?: number };

/** For an AppImage with no version flag: mount it, read the metainfo, unmount that exact path (old lines 394 to 429). */
export async function probeAppImageMeta(file: string, metaPath: string, opts: MetaOpts): Promise<ProbeResult> {
	if (!existsSync(file)) return { state: "absent" };
	const proc = opts.run.start?.([file, "--appimage-mount"], { stopMs: opts.stopMs });
	let mountDir = "";
	try {
		const polls = opts.polls ?? 12;
		for (let i = 0; i < polls; i++) {
			// The mount point is the first line of the runtime's own stdout, never a glob of /tmp/.mount_*.
			const first = (proc?.output().split("\n")[0] ?? "").trim();
			if (first && existsSync(first) && statSync(first).isDirectory()) {
				mountDir = first;
				break;
			}
			if (!proc) break;
			// oxlint-disable-next-line no-await-in-loop -- polling for the mount point
			await Bun.sleep(opts.pollMs ?? 500);
		}
		if (!proc || !mountDir) return { state: "unknown", detail: `${file} never reported a mount point.` };
		const meta = findCaseless(join(mountDir, metaPath));
		if (!meta) return { state: "unknown", detail: `${metaPath} is missing inside ${file}.` };
		const text = readFileSync(meta, "utf8");
		const match = metaPath.endsWith(".desktop")
			? /^X-AppImage-Version=(.*)$/m.exec(text)
			: /release version="([^"]+)"/.exec(text);
		const version = match?.[1]?.trim();
		return version ? { version } : { state: "unknown", detail: `${metaPath} names no version.` };
	} catch (err) {
		return { state: "unknown", detail: err instanceof Error ? err.message : String(err) };
	} finally {
		await proc?.stop();
		// Killing the runtime does not reliably tear the mount down.
		if (mountDir) await opts.run(["fusermount", "-u", mountDir], { timeoutMs: 10_000 });
	}
}

/** The exact path, or a file in the same directory whose name differs only in case. */
function findCaseless(p: string): string | null {
	if (existsSync(p)) return p;
	const want = basename(p).toLowerCase();
	try {
		const hit = readdirSync(dirname(p)).find((n) => n.toLowerCase() === want);
		return hit ? join(dirname(p), hit) : null;
	} catch {
		return null;
	}
}
