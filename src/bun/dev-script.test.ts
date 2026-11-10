import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDevBuild, playDevScript } from "./dev-script";

test("only a development bundle counts as a dev build", () => {
	expect(isDevBuild("/p/build/dev-linux-x64/Upkeep-dev/Resources/app/bun")).toBe(true);
	expect(isDevBuild("/h/.local/share/dev.afk.upkeep/stable/app/Resources/app/bun")).toBe(false);
	expect(isDevBuild("/p/src/bun")).toBe(false);
});

test("steps play in order and a file that is not a list is refused", async () => {
	const dir = mkdtempSync(join(tmpdir(), "upkeep-devscript-"));
	try {
		const file = join(dir, "steps.json");
		writeFileSync(file, JSON.stringify([{ js: "a()", waitMs: 1 }, { waitMs: 1 }, { js: "b()", waitMs: 1 }]));
		const ran: string[] = [];
		await playDevScript(file, (js) => ran.push(js));
		expect(ran).toEqual(["a()", "b()"]);
		writeFileSync(file, '{"js":"x()"}');
		expect(playDevScript(file, () => {})).rejects.toThrow("The dev script is not a list of steps.");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
