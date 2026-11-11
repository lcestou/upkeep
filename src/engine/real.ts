import { join } from "node:path";
import type { EngineDeps } from "./engine";
import { paths } from "./paths";
import { createRunner } from "./run";

/**
 * The real box: XDG directories, the owner's PATH, the old script where it lives.
 * The seed manifest's and the catalogue's locations differ between the command line and the bundled app, so the
 * caller names both.
 */
export function realDeps(
	env: Record<string, string | undefined>,
	seedManifest: string,
	catalogueDir: string,
): EngineDeps {
	const p = paths(env);
	return {
		paths: p,
		seedManifest,
		catalogueDir,
		fetch: (url, init) => fetch(url, init),
		run: createRunner(p.home, join(p.cache, "tmp"), env.PATH ?? "/usr/local/bin:/usr/bin:/bin"),
		now: () => new Date(),
		oldScript: join(p.home, ".local/bin/lutechi-updater"),
		oldLock: "/tmp/lutechi-updater.lock",
		oldLog: join(p.home, ".local/share/lutechi-updater.log"),
	};
}
