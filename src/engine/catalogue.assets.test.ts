import { expect, test } from "bun:test";
import { join } from "node:path";
import { kindOf, machineAssets } from "./discover";
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

// An aarch64 pattern must also pick a file an arm64 machine takes, of the table's own kind: Add app offers only those.
test("every catalogue aarch64 pattern matches exactly one aarch64 asset of the table's kind", () => {
	const { apps } = loadCatalogue(join(import.meta.dir, "../../catalogue"));
	const broken: string[] = [];
	let checked = 0;
	for (const a of apps) {
		if (!a.repo || !a.asset_aarch64) continue;
		const release = ASSETS[a.key];
		if (!release) {
			broken.push(`${a.key}: no fixture`);
			continue;
		}
		checked++;
		const re = new RegExp(a.asset_aarch64);
		const hits = release.assets.filter((n) => re.test(n));
		if (hits.length !== 1) broken.push(`${a.key}: ${hits.length} matches (${hits.join(", ")})`);
		const offered = new Set(
			machineAssets(
				release.assets.map((name) => ({ name, size: 1, url: "", digest: null })),
				[],
				"aarch64",
			).candidates.map((c) => c.asset.name),
		);
		for (const h of hits) {
			if (!offered.has(h)) broken.push(`${a.key}: ${h} is not offered on aarch64`);
			if (kindOf(h) !== a.kind) broken.push(`${a.key}: ${h} is not kind ${a.kind}`);
		}
	}
	expect(broken).toEqual([]);
	expect(checked).toBe(37);
});
