import type { Page } from "playwright/test";
import { expect, load, sentence, test } from "./helpers";

/** Runs the fixture's ticked updates and leaves Zen Browser waiting on a restart. */
async function updateZen(page: Page) {
	await load(page, "fixture&speed=4");
	await page.getByTestId("install").click();
	await expect(sentence(page)).toHaveText(/updated/, { timeout: 20_000 });
	await page.getByTestId("done").click();
	await expect(page.getByTestId("restart-line")).toHaveText("Restart Zen Browser to finish.");
	// The list settles once the run's group has gone; a click before that can land mid-reflow.
	await expect(page.getByTestId("group-run")).toHaveCount(0);
}

test("the pane's Restart now asks before closing a desktop app, and Not now keeps the reminder", async ({ page }) => {
	await updateZen(page);
	await page.getByTestId("open-zen").click();
	await page.getByTestId("restart-now-zen").click();
	await expect(page.getByTestId("restart-ask")).toHaveText(
		"Zen Browser will close and reopen. Unsaved work in it is lost.",
	);
	await expect(page.getByTestId("restart-cancel")).toBeFocused();
	await page.getByTestId("restart-cancel").click();
	await expect(page.getByTestId("restart-ask")).toHaveCount(0);
	await expect(page.getByTestId("restart-line")).toHaveText("Restart Zen Browser to finish.");
	await page.getByTestId("restart-now-zen").click();
	await page.getByTestId("restart-confirm").click();
	await expect(page.getByTestId("notice")).toHaveText("Restarted Zen Browser.");
	await expect(page.getByTestId("restart-now-zen")).toHaveCount(0);
	await expect(page.getByTestId("group-restart")).toHaveCount(0);
});

test("the Restart to finish group restarts every app whose table says how, after asking", async ({ page }) => {
	await updateZen(page);
	await expect(page.getByTestId("restart-all")).toHaveText("Restart Zen Browser now");
	await page.getByTestId("restart-all").click();
	await expect(page.getByTestId("restart-all-ask")).toHaveText(
		"Zen Browser will close and reopen. Unsaved work in it is lost.",
	);
	await page.getByTestId("restart-all-confirm").click();
	await expect(page.getByTestId("notice")).toHaveText("Restarted Zen Browser.");
	await expect(page.getByTestId("group-restart")).toHaveCount(0);
	await expect(page.getByTestId("restart-line")).toHaveCount(0);
});
