import { expect, load, test } from "./helpers";

test("a working row that has printed nothing for 3 minutes says so, with its step's own limit", async ({ page }) => {
	await load(page, "fixture&speed=2&quiet=cut");
	await page.getByTestId("install").click();
	await expect(page.getByTestId("quiet-zen")).toHaveText("No output for 3 min. It stops on its own in 7 min.");
	// Only the quiet row carries the line; the rows waiting behind it do not.
	await expect(page.getByTestId("quiet-fd")).toHaveCount(0);
});
