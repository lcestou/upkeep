import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expandHome } from "./paths";

export type RunOpts = {
	cwd?: string;
	/** Added to the child's environment, after PATH is built. */
	env?: Record<string, string>;
	/** SIGKILL after this many ms. */
	timeoutMs?: number;
	/** On timeout, also kill every descendant, deepest first. */
	killTree?: boolean;
	/** Streams stdout and stderr lines here as they arrive. Without it output is captured through a temp file. */
	onLine?: (line: string) => void;
	/** Without onLine: stderr goes into the same capture file as stdout, in the order written, and stderr comes back empty. */
	merge?: boolean;
};

export type RunResult = { code: number; stdout: string; stderr: string; timedOut: boolean };

/** Every process the engine starts goes through one of these, so tests can pass a recording fake. */
export type Run = (argv: string[], opts?: RunOpts) => Promise<RunResult>;

/** Child pids of every process under procRoot whose parent is pid. */
function children(pid: number, procRoot: string): number[] {
	const out: number[] = [];
	let entries: string[];
	try {
		entries = readdirSync(procRoot);
	} catch {
		return out;
	}
	for (const e of entries) {
		if (!/^\d+$/.test(e)) continue;
		try {
			const stat = readFileSync(join(procRoot, e, "stat"), "utf8");
			// comm may hold spaces and parens, so fields are counted from the last ")".
			const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
			if (ppid === pid) out.push(Number(e));
		} catch {
			// the process ended while we read
		}
	}
	return out;
}

/** Kills pid's descendants depth first, then pid. Never a process group: under autostart that is the whole session. */
export function killTree(pid: number, procRoot = "/proc"): void {
	for (const child of children(pid, procRoot)) killTree(child, procRoot);
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// already gone
	}
}

/** The real runner. Stdin is ignored, ~/ is expanded in every argv element, and the owner's bin directories lead PATH. */
export function createRunner(home: string, tmpDir: string, basePath: string): Run {
	const path = [join(home, ".local/bin"), join(home, ".bun/bin"), basePath].filter(Boolean).join(":");
	let seq = 0;
	return async (argv, opts = {}) => {
		const cmd = argv.map((a) => expandHome(a, home));
		const env = { ...process.env, PATH: path, ...opts.env };
		const stream = opts.onLine !== undefined;
		let outFile = "";
		let errFile = "";
		const fds: number[] = [];
		if (!stream) {
			mkdirSync(tmpDir, { recursive: true });
			seq += 1;
			outFile = join(tmpDir, `run-${process.pid}-${seq}.out`);
			fds.push(openSync(outFile, "w", 0o600));
			if (!opts.merge) {
				errFile = join(tmpDir, `run-${process.pid}-${seq}.err`);
				fds.push(openSync(errFile, "w", 0o600));
			}
		}
		let proc: ReturnType<typeof Bun.spawn>;
		try {
			proc = Bun.spawn(cmd, {
				cwd: opts.cwd,
				env,
				stdin: "ignore",
				stdout: stream ? "pipe" : (fds[0] ?? "ignore"),
				stderr: stream ? "pipe" : (fds[1] ?? fds[0] ?? "ignore"),
			});
		} catch (err) {
			if (outFile) rmSync(outFile, { force: true });
			if (errFile) rmSync(errFile, { force: true });
			return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err), timedOut: false };
		} finally {
			// The child holds its own copies; ours would only keep the files open.
			for (const fd of fds) closeSync(fd);
		}
		let timedOut = false;
		const timer =
			opts.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						timedOut = true;
						if (opts.killTree) killTree(proc.pid);
						else proc.kill("SIGKILL");
					}, opts.timeoutMs);
		const sinks = [{ text: "" }, { text: "" }];
		const readers: Promise<void>[] = [];
		if (stream) {
			[proc.stdout, proc.stderr].forEach((s, i) => {
				const sink = sinks[i];
				if (s instanceof ReadableStream && sink) readers.push(readLines(s, sink, opts.onLine ?? (() => {})));
			});
		}
		const code = await proc.exited;
		if (timer) clearTimeout(timer);
		let stdout = "";
		let stderr = "";
		if (stream) {
			// A grandchild that kept the pipe open must not hold the run: give it two seconds.
			await Promise.race([Promise.all(readers), new Promise((r) => setTimeout(r, 2000))]);
			stdout = sinks[0]?.text ?? "";
			stderr = sinks[1]?.text ?? "";
		} else {
			stdout = await readAndRemove(outFile);
			stderr = errFile ? await readAndRemove(errFile) : "";
		}
		return { code: timedOut ? 137 : code, stdout, stderr, timedOut };
	};
}

async function readAndRemove(file: string): Promise<string> {
	try {
		return await Bun.file(file).text();
	} catch {
		return "";
	} finally {
		rmSync(file, { force: true });
	}
}

async function readLines(
	stream: ReadableStream<Uint8Array>,
	sink: { text: string },
	onLine: (line: string) => void,
): Promise<void> {
	const decoder = new TextDecoder();
	let rest = "";
	const reader = stream.getReader();
	for (;;) {
		// oxlint-disable-next-line no-await-in-loop -- a stream is read one chunk at a time
		const { done, value } = await reader.read();
		if (done) break;
		const text = decoder.decode(value, { stream: true });
		sink.text += text;
		rest += text;
		const lines = rest.split("\n");
		rest = lines.pop() ?? "";
		for (const l of lines) onLine(l);
	}
	if (rest) onLine(rest);
}

/** Prefixes sudo -n when the step needs root, so a password prompt can never wait. */
export function asRoot(argv: string[], sudo: boolean | undefined): string[] {
	return sudo ? ["sudo", "-n", ...argv] : argv;
}

export const SUDO_PASSWORD = "sudo needs a password here. Run the update from a terminal.";

/** True when sudo refused because it would have had to ask for a password. */
export function sudoNeedsPassword(r: RunResult): boolean {
	return r.code !== 0 && /a password is required|a terminal is required/.test(r.stderr + r.stdout);
}
