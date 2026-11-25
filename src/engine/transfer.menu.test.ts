import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadState, updateState } from "./store";
import { tempHome } from "./testkit";
import { importSetup } from "./transfer";

let t: ReturnType<typeof tempHome>;
beforeEach(() => {
	t = tempHome("transfer-menu");
});
afterEach(() => t.cleanup());

/** An AppImage table under key with dest. */
const table = (key: string, dest: string) =>
	`[apps.${key}]\nname = "${key}"\nkind = "appimage"\nrepo = "o/${key}"\nasset = '${key}$'\ndest = "${dest}"\n`;

test("import keeps the menu entry of an app it leaves as it was, and switches off and deletes the others'", () => {
	mkdirSync(t.paths.config, { recursive: true });
	writeFileSync(
		join(t.paths.config, "apps.toml"),
		[table("a", "~/a"), table("b", "~/b"), table("c", "~/c")].join("\n"),
	);
	const share = dirname(t.paths.data);
	const files = (k: string) => [join(share, `icons/upkeep-${k}.svg`), join(share, `applications/upkeep-${k}.desktop`)];
	for (const f of ["a", "b", "c"].flatMap(files)) {
		mkdirSync(dirname(f), { recursive: true });
		writeFileSync(f, "x");
	}
	updateState(t.paths, (s) => {
		s.menu = { a: files("a"), b: files("b"), c: files("c") };
	});
	// a is the same table, b moved its dest, c is not in the file.
	const doc = JSON.stringify({ upkeep: 1, apps: [table("a", "~/a"), table("b", "~/elsewhere/b")].join("\n") });
	const seed = join(t.dir, "seed.toml");
	writeFileSync(seed, "");
	expect(importSetup(t.paths, seed, doc, new Date(), true)).toMatchObject({ ok: true, apps: 2 });
	expect(loadState(t.paths).menu).toEqual({ a: files("a") });
	expect(["a", "b", "c"].flatMap(files).map((f) => existsSync(f))).toEqual([true, true, false, false, false, false]);
});
