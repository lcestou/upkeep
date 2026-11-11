import { join } from "node:path";

/** Every directory Upkeep writes to. Built from the environment once so a test can point all of them at a temp dir. */
export type Paths = {
	/** apps.toml lives here. */
	config: string;
	/** state.json, run.lock and logs/. */
	state: string;
	/** history.jsonl and backups/. */
	data: string;
	/** Release responses, downloads in flight, source clones, shims. All safe to delete. */
	cache: string;
	/** The single-instance socket. */
	socket: string;
	home: string;
};

type Env = Record<string, string | undefined>;

/** Throws when HOME is unset. An empty XDG variable counts as unset, as the spec says. */
export function paths(env: Env): Paths {
	const home = env.HOME;
	if (!home) throw new Error("HOME is not set.");
	const runtime = env.XDG_RUNTIME_DIR;
	return {
		config: join(env.XDG_CONFIG_HOME || join(home, ".config"), "upkeep"),
		state: join(env.XDG_STATE_HOME || join(home, ".local/state"), "upkeep"),
		data: join(env.XDG_DATA_HOME || join(home, ".local/share"), "upkeep"),
		cache: join(env.XDG_CACHE_HOME || join(home, ".cache"), "upkeep"),
		// Without a runtime directory the socket stays in the owner's own state directory, never in shared /tmp.
		socket: runtime
			? join(runtime, "upkeep.sock")
			: join(env.XDG_STATE_HOME || join(home, ".local/state"), "upkeep", "upkeep.sock"),
		home,
	};
}

/** "~/x" and "~" resolve against home. Anything else is returned as given. */
export function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}
