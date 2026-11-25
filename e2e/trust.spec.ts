import { expect, load, sentence, test } from "./helpers";

test("a release whose file changed is held with its reason, and Release hold offers it again", async ({ page }) => {
	await load(page, "fixture=problems", { wait: "sentence" });
	await page.getByTestId("open-fd").click();
	await expect(page.getByTestId("pane-detail")).toHaveText(
		"The file behind v10.5.2 changed after Upkeep first saw it. Check the release page before you release the hold.",
	);
	await expect(page.getByTestId("hold-fd")).toHaveText("Release hold");
	await page.getByTestId("hold-fd").click();
	await expect(page.getByTestId("status-fd")).toHaveText("Ready");
	await expect(page.getByTestId("pane-detail")).toHaveCount(0);
});

test("after an update the pane says how each download was checked", async ({ page }) => {
	await load(page, "fixture&speed=4");
	await page.getByTestId("tick-wrangler").click();
	await page.getByTestId("install").click();
	await expect(sentence(page)).toHaveText("3 updated", { timeout: 20_000 });
	const checked = {
		zen: "Download checked: SHA-256 matches the forge's record.",
		fd: "Download checked: matches the release's checksum file.",
		cursor: "Download not checked: the release lists no size or checksum.",
	};
	for (const [key, text] of Object.entries(checked)) {
		await page.getByTestId(`open-${key}`).click();
		await expect(page.getByTestId(`detail-${key}`).getByTestId("pane-checked")).toHaveText(text);
		await page.getByTestId("inspector-close").click();
	}
});

test("an app updated from a release that lists only a size says so in its pane", async ({ page }) => {
	await load(page, "fixture=problems", { wait: "sentence" });
	await page.getByTestId("group-fresh-toggle").click();
	await page.getByTestId("open-bat").click();
	await expect(page.getByTestId("detail-bat").getByTestId("pane-checked")).toHaveText("Download checked: size only.");
});

test("History says how each download was checked, under its row", async ({ page }) => {
	await load(page, "fixture&speed=4");
	await page.getByTestId("tick-wrangler").click();
	await page.getByTestId("install").click();
	await expect(sentence(page)).toHaveText("3 updated", { timeout: 20_000 });
	await page.getByTestId("tab-history").click();
	const lines = page.getByTestId("history-checked");
	// This run's three updates, then an older run's bat, whose release listed only a size.
	for (const text of [
		"SHA-256 matches the forge",
		"Matches the checksum file",
		"Download not checked",
		"Size checked only",
	])
		await expect(lines.filter({ hasText: new RegExp(`^${text}$`) })).toHaveCount(1);
	await expect(lines).toHaveCount(4);
});
