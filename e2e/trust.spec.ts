import { expect, load, sentence, test } from "./helpers";

test("a release whose file changed is held with its reason, and Release hold offers it again", async ({ page }) => {
	await load(page, "fixture=problems", { wait: "sentence" });
	await page.getByTestId("open-fd").click();
	await expect(page.getByTestId("pane-detail")).toHaveText(
		"The v10.5.2 download changed after Upkeep first saw it. Check the release page before you release the hold.",
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
