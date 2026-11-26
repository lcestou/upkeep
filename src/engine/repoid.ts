import type { AppSpec } from "../shared/types";
import { forgeOf } from "./forge";
import { fetchRepoId, isFailure, type ReleaseOpts } from "./github";
import type { Paths } from "./paths";
import { loadState, updateState } from "./store";

/**
 * Compares the GitHub repo an app's table names with the one its first check saw, against repojacking: a name
 * deleted and made again, or taken by someone else after a rename. Asked only on first sight and when an update is on
 * offer, so a quiet list costs nothing; the answer is revalidated by etag, so asking again while nothing changed costs
 * no budget either. Ids read for another repo field (the table was edited to name another repo) are dropped and
 * read afresh, never compared. The same id under a new name or owner is a rename or a transfer: followed, with a log line. Another
 * id marks the app swapped, which holds its offered update until the person releases the hold. A repo that is not on
 * GitHub, or an answer that does not come (offline, rate limit, gone), changes nothing: the release check says why.
 */
export async function guardRepo(
	spec: Pick<AppSpec, "key" | "repo" | "forge">,
	offered: boolean,
	paths: Paths,
	opts: ReleaseOpts,
	log: (line: string) => void,
): Promise<void> {
	const f = spec.repo ? forgeOf(spec.repo, spec.forge) : null;
	if (f?.kind !== "github") return;
	const repo = spec.repo ?? "";
	const kept = loadState(paths).origin[spec.key];
	const was = kept?.repo === repo ? kept : undefined;
	if (was && !offered) return;
	// Ids and a hold about the repo the table named before go, even when the new repo's answer does not come.
	if (kept && !was)
		updateState(paths, (s) => {
			delete s.origin[spec.key];
			delete s.swapped[spec.key];
		});
	const now = await fetchRepoId(f.path, opts);
	if (isFailure(now)) return;
	if (!was) {
		updateState(paths, (s) => {
			s.origin[spec.key] = { ...now, repo };
		});
		return;
	}
	if (now.id !== was.id) {
		const where = `${f.host}/${f.path}`;
		log(`${where} answers with repository id ${now.id}; Upkeep first saw id ${was.id}. Held.`);
		updateState(paths, (s) => {
			s.swapped[spec.key] = where;
		});
		return;
	}
	if (now.name === was.name && now.owner === was.owner) return;
	log(`Repo moved: ${was.name} is now ${now.name}, the same repository. Upkeep follows the move.`);
	updateState(paths, (s) => {
		s.origin[spec.key] = { ...now, repo };
	});
}
