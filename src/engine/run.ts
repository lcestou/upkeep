import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
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
	/** Called with the child's pid right after it starts, so a marker can record what is running. */
	onStart?: (pid: number) => void;
	/** Put in front of the runner's PATH, for the shim directory. */
	pathPrefix?: string;
};

export type RunResult = { code: number; stdout: string; stderr: string; timedOut: boolean };

/** A process left running in the background, for one that never ends on its own (an AppImage mount). */
export type Started = {
	/** Everything it has written to stdout so far. */
	output(): string;
	/** SIGTERM, then SIGKILL after stopMs. Never waits without a limit. */
	stop(): Promise<void>;
};

export type StartOpts = { pathPrefix?: string; stopMs?: number };

/**
 * Every process the engine starts goes through one of these, so tests can pass a recording fake.
 * start is for a process the caller reads and then stops; a runner without it cannot start one.
 */
export type Run = ((argv: string[], opts?: RunOpts) => Promise<RunResult>) & {
	start?: (argv: string[], opts?: StartOpts) => Started;
};

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

/**
 * Stops pid and every descendant first, so no parent can spawn again, then kills them deepest first.
 * Never a process group: under autostart that is the whole session.
 */
export function killTree(pid: number, procRoot = "/proc"): void {
	const all: number[] = [];
	const walk = (p: number) => {
		try {
			process.kill(p, "SIGSTOP");
		} catch {
			return;
		}
		all.push(p);
		for (const c of children(p, procRoot)) walk(c);
	};
	walk(pid);
	for (const p of all.toReversed()) {
		try {
			process.kill(p, "SIGKILL");
		} catch {
			// already gone
		}
	}
}

/**
 * The real runner. Stdin is ignored, ~/ is expanded in every argv element, the owner's bin directories lead PATH,
 * and an argv that starts with sudo gets -n: a child keeps the terminal, so a sudo without it would prompt there
 * and wait out its timeout.
 */
export function createRunner(home: string, tmpDir: string, basePath: string): Run {
	const path = [join(home, ".local/bin"), join(home, ".bun/bin"), basePath].filter(Boolean).join(":");
	let seq = 0;
	const envFor = (prefix?: string, extra?: Record<string, string>) => ({
		...process.env,
		PATH: prefix ? `${prefix}:${path}` : path,
		...extra,
	});
	const start = (argv: string[], opts: StartOpts = {}): Started => {
		mkdirSync(tmpDir, { recursive: true });
		seq += 1;
		const outFile = join(tmpDir, `start-${process.pid}-${seq}.out`);
		const fd = openSync(outFile, "w", 0o600);
		let proc: ReturnType<typeof Bun.spawn> | null = null;
		try {
			proc = Bun.spawn(
				asRootArgv(argv).map((a) => expandHome(a, home)),
				{ env: envFor(opts.pathPrefix), stdin: "ignore", stdout: fd, stderr: "ignore" },
			);
		} catch {
			// output() stays empty, so the caller sees a process that said nothing
		} finally {
			closeSync(fd);
		}
		const p = proc;
		const exited = (ms: number) =>
			p ? Promise.race([p.exited.then(() => true), Bun.sleep(ms).then(() => false)]) : Promise.resolve(true);
		return {
			output: () => {
				try {
					return readFileSync(outFile, "utf8");
				} catch {
					return "";
				}
			},
			stop: async () => {
				const ms = opts.stopMs ?? 3000;
				p?.kill("SIGTERM");
				if (!(await exited(ms))) {
					p?.kill("SIGKILL");
					// A process stuck in the kernel (FUSE in D state) may never exit: stop waiting anyway.
					await exited(ms);
				}
				rmSync(outFile, { force: true });
			},
		};
	};
	const run = async (argv: string[], opts: RunOpts = {}): Promise<RunResult> => {
		const cmd = asRootArgv(argv).map((a) => expandHome(a, home));
		const env = envFor(opts.pathPrefix, opts.env);
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
		opts.onStart?.(proc.pid);
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
		// Once the run has returned, a grandchild's late line must not reach the caller.
		let open = true;
		const onLine = (l: string) => {
			if (open) opts.onLine?.(l);
		};
		if (stream) {
			[proc.stdout, proc.stderr].forEach((s, i) => {
				const sink = sinks[i];
				if (s instanceof ReadableStream && sink) readers.push(readLines(s, sink, onLine));
			});
		}
		const code = await proc.exited;
		if (timer) clearTimeout(timer);
		let stdout = "";
		let stderr = "";
		if (stream) {
			// A grandchild that kept the pipe open must not hold the run: give it two seconds.
			await Promise.race([Promise.all(readers), new Promise((r) => setTimeout(r, 2000))]);
			open = false;
			stdout = sinks[0]?.text ?? "";
			stderr = sinks[1]?.text ?? "";
		} else {
			stdout = await readAndRemove(outFile);
			stderr = errFile ? await readAndRemove(errFile) : "";
		}
		return { code: timedOut ? 137 : code, stdout, stderr, timedOut };
	};
	return Object.assign(run, { start });
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

/** A table's own argv that begins with sudo gets -n, so a password prompt can never wait. */
export function asRootArgv(argv: string[]): string[] {
	if (argv[0] !== "sudo" || argv[1] === "-n") return argv;
	return ["sudo", "-n", ...argv.slice(1)];
}

export const SUDO_PASSWORD = "sudo needs a password here. Run the update from a terminal.";

/** True when sudo refused because it would have had to ask for a password. */
export function sudoNeedsPassword(r: RunResult): boolean {
	return r.code !== 0 && /a password is required|a terminal is required/.test(r.stderr + r.stdout);
}

/**
 * Installs src to to through a sibling to.upkeep-new and mv -f, so a full disk or a failed
 * copy leaves the old file whole. The size is checked on the sibling before the move.
 */
export async function installAside(
	run: Run,
	src: string,
	to: string,
	mode: string,
	sudo: boolean | undefined,
): Promise<RunResult> {
	const next = `${to}.upkeep-new`;
	let r = await run(asRoot(["install", "-m", mode, src, next], sudo), { timeoutMs: 120_000 });
	if (r.code === 0 && !(existsSync(next) && statSync(next).size === statSync(src).size))
		r = { ...r, code: 1, stderr: "size differs after copy" };
	if (r.code === 0) r = await run(asRoot(["mv", "-f", next, to], sudo), { timeoutMs: 60_000 });
	if (r.code !== 0 && !sudoNeedsPassword(r)) await run(asRoot(["rm", "-f", next], sudo), { timeoutMs: 60_000 });
	return r;
}
