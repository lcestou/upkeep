import { unlinkSync } from "node:fs";

/**
 * One Upkeep per desktop session. The first process listens on a socket; a later one asks it to
 * show its window and exits.
 * Returns "primary" when this process now owns the socket, "secondary" when another answered.
 */
export async function claimInstance(socketPath: string, onShow: () => void): Promise<"primary" | "secondary"> {
	if (await askToShow(socketPath)) return "secondary";
	// Nobody answered. A file left by a crash would make listen fail with EADDRINUSE.
	try {
		unlinkSync(socketPath);
	} catch {
		// Not there, which is the usual case.
	}
	Bun.listen({
		unix: socketPath,
		socket: {
			data(_socket, data) {
				if (data.toString().includes("show")) onShow();
			},
		},
	});
	return "primary";
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
