import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { MESSAGES } from "../shared/messages";
import { expandHome } from "./paths";

export type RunOpts = {
	cwd?: string;
	/** Added to the child's environment, after PATH is built. */
	env?: Record<string, string>;
	/** SIGKILL after this many ms. */
	timeoutMs?: number;
	/** On timeout, also kill every descendant, deepest first. */
	killTree?: boolean;
	/**
	 * On timeout, ends the child's whole process group with killGroup (every child leads one of its own). For root commands under sudo: sudo passes the TERM on to the command it runs, which a kill of sudo's
	 * own pid alone would not do, and a grandchild left behind would outlive Upkeep.
	 */
	group?: boolean;
	/** Streams stdout and stderr lines here as they arrive. Without it output is captured through a temp file. */
	onLine?: (line: string) => void;
	/** Without onLine: stderr goes into the same capture file as stdout, in the order written, and stderr comes back empty. */
	merge?: boolean;
	/** Called with the child's pid right after it starts, so a marker can record what is running. */
	onStart?: (pid: number) => void;
	/** The run's Stop now. It ends this step only when the step is also cuttable; any other step runs on to its end. */
	cancel?: AbortSignal;
	/**
	 * This step may be ended at Stop now: TERM to its process group, KILL after 5 s. Never set on a step that runs as
	 * root or on an undo: sudo cannot hand on a KILL, so cutting one only orphans the root command.
	 */
	cuttable?: boolean;
};

/** stopped: the step was cut at Stop now, and its code is 143 whatever the child returned. */
export type ProcessResult = { code: number; stdout: string; stderr: string; timedOut: boolean; stopped?: boolean };

/** A process left running in the background, for one that never ends on its own (an AppImage mount). */
export type Started = {
	/** Everything it has written to stdout so far. */
	output(): string;
	/** SIGTERM, then SIGKILL after stopMs. Never waits without a limit. */
	stop(): Promise<void>;
};

export type StartOpts = { stopMs?: number };

/**
 * Every process the engine starts goes through one of these, so tests can pass a recording fake.
 * start is for a process the caller reads and then stops; a runner without it cannot start one.
 */
export type Run = ((argv: string[], opts?: RunOpts) => Promise<ProcessResult>) & {
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
 * Ends the process group pid leads: TERM to every member, then KILL to what is left after graceMs. A member that runs
 * as root ignores both from here; sudo, which runs as the person, hands the TERM on to the root command it started.
 * A group already gone is not an error.
 */
export function killGroup(pid: number, graceMs = 5000): void {
	const send = (signal: NodeJS.Signals) => {
		try {
			process.kill(-pid, signal);
		} catch {
			// the group is gone, or holds only processes this user may not signal
		}
	};
	send("SIGTERM");
	setTimeout(() => send("SIGKILL"), graceMs).unref();
}

/** True while any process is left in the group pid leads. A group of processes this user may not signal counts too. */
function groupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (err) {
		return err instanceof Error && "code" in err && err.code === "EPERM";
	}
}

/**
 * Ends the process group pid leads and resolves only once it is gone: TERM, then KILL after graceMs, then up to
 * another graceMs for the kernel to reap it (a process stuck in D state may outlast even that; the wait still ends).
 * A cut uses it so a caller never restores files while a member of the cut step can still write them.
 */
export async function endGroup(pid: number, graceMs = 5000): Promise<void> {
	const send = (signal: NodeJS.Signals) => {
		try {
			process.kill(-pid, signal);
		} catch {
			// the group is gone, or holds only processes this user may not signal
		}
	};
	const goneWithin = async (ms: number) => {
		const until = Date.now() + ms;
		while (groupAlive(pid)) {
			if (Date.now() >= until) return false;
			// oxlint-disable-next-line no-await-in-loop -- polling until the group is gone
			await Bun.sleep(50);
		}
		return true;
	};
	send("SIGTERM");
	if (await goneWithin(graceMs)) return;
	send("SIGKILL");
	await goneWithin(graceMs);
}

/**
 * True for a step that runs as root: an argv that starts with sudo, or a shell step whose script calls sudo. Stop now
 * never cuts one: sudo cannot hand a KILL on to the root command, so a cut would only orphan it.
 */
export function runsAsRoot(argv: string[]): boolean {
	if (argv[0] === "sudo") return true;
	const [prog = "", flag, script] = argv;
	return /(^|\/)(ba)?sh$/.test(prog) && flag === "-c" && /\bsudo\b/.test(script ?? "");
}

/**
 * The real runner. Stdin is ignored, ~/ is expanded in every argv element, the owner's bin directories lead PATH,
 * and an argv that starts with sudo gets -n: a child keeps the terminal, so a sudo without it would prompt there
 * and wait out its timeout.
 */
export function createRunner(home: string, tmpDir: string, basePath: string): Run {
	const path = [join(home, ".local/bin"), join(home, ".bun/bin"), basePath].filter(Boolean).join(":");
	let seq = 0;
	const envFor = (extra?: Record<string, string>) => ({ ...process.env, PATH: path, ...extra });
	const start = (argv: string[], opts: StartOpts = {}): Started => {
		mkdirSync(tmpDir, { recursive: true });
		seq += 1;
		const outFile = join(tmpDir, `start-${process.pid}-${seq}.out`);
		const fd = openSync(outFile, "w", 0o600);
		let proc: ReturnType<typeof Bun.spawn> | null = null;
		try {
			proc = Bun.spawn(
				asRootArgv(argv).map((a) => expandHome(a, home)),
				{ env: envFor(), detached: true, stdin: "ignore", stdout: fd, stderr: "ignore" },
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
	const run = async (argv: string[], opts: RunOpts = {}): Promise<ProcessResult> => {
		// A root step is never cut, whatever its caller asked.
		const cut = opts.cuttable === true && !runsAsRoot(argv) ? opts.cancel : undefined;
		if (cut?.aborted) return { code: 143, stdout: "", stderr: "", timedOut: false, stopped: true };
		const cmd = asRootArgv(argv).map((a) => expandHome(a, home));
		const env = envFor(opts.env);
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
				// Every child leads a session and process group of its own, so the terminal's Ctrl-C reaches Upkeep alone
				// and never a sudo dpkg directly, and a cut can end the step's whole group.
				detached: true,
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
						if (opts.group) killGroup(proc.pid);
						else if (opts.killTree) killTree(proc.pid);
						else proc.kill("SIGKILL");
					}, opts.timeoutMs);
		let stopped = false;
		let ending: Promise<void> | null = null;
		const onCancel = () => {
			stopped = true;
			ending = endGroup(proc.pid);
		};
		cut?.addEventListener("abort", onCancel, { once: true });
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
		cut?.removeEventListener("abort", onCancel);
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
		// The leader may exit while a member that ignored TERM still writes: return only once the whole group is gone.
		if (stopped) {
			await ending;
			return { code: 143, stdout, stderr, timedOut, stopped };
		}
		return { code: timedOut ? 137 : code, stdout, stderr, timedOut };
	};
	return Object.assign(run, { start });
}

/** A missing or unreadable capture file reads as empty output. The file is deleted either way. */
async function readAndRemove(file: string): Promise<string> {
	try {
		return await Bun.file(file).text();
	} catch {
		return "";
	} finally {
		rmSync(file, { force: true });
	}
}

/** Hands each finished line to onLine as it arrives and keeps the whole text in sink. A last line without a newline still counts. */
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

/** A table's own argv that begins with sudo gets -n, so a password prompt can never wait. A full path such as /usr/bin/sudo is not seen. */
export function asRootArgv(argv: string[]): string[] {
	if (argv[0] !== "sudo" || argv[1] === "-n") return argv;
	return ["sudo", "-n", ...argv.slice(1)];
}

export const SUDO_PASSWORD = MESSAGES.sudoPassword();

/** True when sudo refused because it would have had to ask for a password. */
export function sudoNeedsPassword(r: ProcessResult): boolean {
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
): Promise<ProcessResult> {
	const next = `${to}.upkeep-new`;
	let r = await run(asRoot(["install", "-m", mode, src, next], sudo), { timeoutMs: 120_000 });
	if (r.code === 0 && !(existsSync(next) && statSync(next).size === statSync(src).size))
		r = { ...r, code: 1, stderr: MESSAGES.sizeDiffersAfterCopy() };
	if (r.code === 0) r = await run(asRoot(["mv", "-f", next, to], sudo), { timeoutMs: 60_000 });
	if (r.code !== 0 && !sudoNeedsPassword(r)) await run(asRoot(["rm", "-f", next], sudo), { timeoutMs: 60_000 });
	return r;
}
