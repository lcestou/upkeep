import { join } from "node:path";
import type { EngineDeps } from "./engine";
import { paths } from "./paths";
import { createRunner } from "./run";

/**
 * The real box: XDG directories, the owner's PATH, and the first owner's retired updater's lock, which Install waits
 * on while that updater's own login run still holds it. On any other machine the lock never exists.
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
		oldLock: { file: "/tmp/lutechi-updater.lock", name: "lutechi-updater" },
	};
}
