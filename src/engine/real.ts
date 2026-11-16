import { join } from "node:path";
import { machineArch } from "./arch";
import type { EngineDeps } from "./engine";
import { paths } from "./paths";
import { createRunner } from "./run";

/**
 * The real machine: XDG directories and the person's PATH.
 * The seed manifest's and the catalogue's locations differ between the command line and the bundled app, so the
 * caller names both.
 */
export function realDeps(
	env: Record<string, string | undefined>,
	seedManifest: string,
	catalogueDir: string,
	catalogueUrl?: string,
): EngineDeps {
	const p = paths(env);
	return {
		paths: p,
		seedManifest,
		catalogueDir,
		catalogueUrl,
		fetch: (url, init) => fetch(url, init),
		run: createRunner(p.home, join(p.cache, "tmp"), env.PATH ?? "/usr/local/bin:/usr/bin:/bin"),
		now: () => new Date(),
		arch: machineArch(process.arch),
	};
}
