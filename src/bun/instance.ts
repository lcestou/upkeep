import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One Upkeep per desktop session. The first process listens on a socket; a later one asks it to
 * show its window and exits.
 * Returns "primary" when this process now owns the socket, "secondary" when another answered.
 */
export async function claimInstance(socketPath: string, onShow: () => void): Promise<"primary" | "secondary"> {
	mkdirSync(dirname(socketPath), { recursive: true });
	// Binding is the claim: the kernel lets one process own the path, so two starts cannot both win here.
	if (listen(socketPath, onShow)) return "primary";
	if (await askToShow(socketPath)) return "secondary";

	// The path exists and nobody answers: a crash left it. Only one process may clear it, or two
	// starting together would each remove the other's fresh socket and both end up primary.
	const claim = `${socketPath}.claim`;
	for (let attempt = 0; attempt < 10; attempt++) {
		if (takeClaim(claim)) {
			try {
				// Whoever held the claim before us may have bound the path in the meantime.
				// oxlint-disable-next-line no-await-in-loop -- asked once per claim
				if (await askToShow(socketPath)) return "secondary";
				remove(socketPath);
				if (listen(socketPath, onShow)) return "primary";
			} finally {
				remove(claim);
			}
		}
		// oxlint-disable-next-line no-await-in-loop -- each try waits for the other starter to finish
		await Bun.sleep(100);
		// oxlint-disable-next-line no-await-in-loop -- same
		if (await askToShow(socketPath)) return "secondary";
	}
	// shortcut: after a second of contention this start goes ahead without the socket; a later launch would then open a second window. Upgrade if that is ever seen.
	return "primary";
}

let server: { stop(closeActiveConnections?: boolean): void } | null = null;

/** Stops answering later launches and removes the socket, so a launch during shutdown starts a fresh Upkeep. */
export function releaseInstance(socketPath: string): void {
	if (!server) return;
	server.stop(true);
	server = null;
	remove(socketPath);
}

function listen(socketPath: string, onShow: () => void): boolean {
	try {
		server = Bun.listen({
			unix: socketPath,
			socket: {
				data(_socket, data) {
					if (data.toString().includes("show")) onShow();
				},
			},
		});
		return true;
	} catch {
		return false;
	}
}

function takeClaim(file: string): boolean {
	try {
		closeSync(openSync(file, "wx"));
		return true;
	} catch {
		// A claim file older than five seconds was left by a process that died holding it.
		try {
			if (Date.now() - statSync(file).mtimeMs > 5000) remove(file);
		} catch {
			// Gone already.
		}
		return false;
	}
}

function remove(file: string): void {
	try {
		unlinkSync(file);
	} catch {
		// Not there.
	}
}

function askToShow(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		Bun.connect({
			unix: socketPath,
			socket: {
				open(socket) {
					socket.write("show\n");
					socket.flush();
					socket.end();
					resolve(true);
				},
				data() {},
				connectError() {
					resolve(false);
				},
			},
		}).catch(() => resolve(false));
	});
}
