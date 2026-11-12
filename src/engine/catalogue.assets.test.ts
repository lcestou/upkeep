import { expect, test } from "bun:test";
import { join } from "node:path";
import fixtures from "./fixtures/catalogue-assets.json";
import { loadCatalogue } from "./manifest";

// Names only, fetched from each repo's latest release when the table was written. A pattern that
// matches none or two of them would leave the app under "Needs a look" for everyone who adds it.
const ASSETS: Record<string, { tag: string; assets: string[] }> = fixtures;

test("every catalogue asset pattern matches exactly one asset of its release", () => {
	const { apps } = loadCatalogue(join(import.meta.dir, "../../catalogue"));
	const broken: string[] = [];
	for (const a of apps) {
		if (!a.repo || !a.asset) continue;
		const release = ASSETS[a.key];
		if (!release) {
			broken.push(`${a.key}: no fixture`);
			continue;
		}
		const hits = release.assets.filter((n) => new RegExp(a.asset ?? "").test(n));
		if (hits.length !== 1) broken.push(`${a.key}: ${hits.length} matches (${hits.join(", ")})`);
	}
	expect(broken).toEqual([]);
});
