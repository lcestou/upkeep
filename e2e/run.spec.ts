import { expect, expectFocusKept, load, recordStatuses, sentence, test } from "./helpers";

test("a full run walks every stage to 3 updated, 1 failed and opens the pane on the failure", async ({ page }) => {
	await load(page, "fixture&speed=3");
	const seen = await recordStatuses(page);
	await page.getByTestId("install").click();
	await expect(sentence(page)).toHaveText(/^Installing Zen Browser, 1 of 4$/);
	await expect(sentence(page)).toHaveText("3 updated, 1 failed", { timeout: 20_000 });
	const texts = await seen();
	for (const word of [
		"Queued",
		"Backing up",
		"Installing",
		"Verifying",
		"Restart Zen Browser to finish",
		"Updated to 10.5.2",
		"Failed",
	])
		expect(texts, word).toContain(word);
	expect(texts.some((t) => /^Downloading [\d.]+ of [\d.]+ (kB|MB)$/.test(t))).toBe(true);
	await expect(page.getByTestId("group-run")).toHaveText("This run");
	await expect(page.getByTestId("restart-line")).toHaveText("Restart Zen Browser to finish.");
	await expect(sentence(page).locator(".failed")).toHaveText("1 failed");
	await expect(page.getByTestId("inspector")).toBeVisible();
	await expect(page.getByTestId("detail-wrangler")).toBeVisible();
	await expect(page.getByTestId("pane-detail")).toHaveText("Still at 4.157.0 after the update.");
	await expect(page.getByTestId("row-wrangler").locator(".latest")).toHaveCSS("text-decoration-line", "line-through");
});

test("the pane's Retry reruns only the failed app and keeps the first pass", async ({ page }) => {
	await load(page, "fixture&speed=4");
	await page.getByTestId("install").click();
	await expect(sentence(page)).toHaveText("3 updated, 1 failed", { timeout: 20_000 });
	await page.getByTestId("retry-one").click();
	await expect(sentence(page)).toHaveText("Retrying wrangler, 1 of 1");
	await expect(page.getByTestId("status-fd")).toHaveCount(0);
	await expectFocusKept(page);
	await expect(sentence(page)).toHaveText("4 updated", { timeout: 10_000 });
	await expect(page.getByTestId("runbar").locator("li")).toHaveCount(4);
	await expect(page.getByTestId("count-run")).toHaveText("4");
});

test("footer Retry 1 failed reruns only the failed app, Done returns to the list", async ({ page }) => {
	await load(page, "fixture&speed=4");
	await page.getByTestId("install").click();
	await expect(page.getByTestId("retry")).toHaveText("Retry 1 failed", { timeout: 20_000 });
	await page.getByTestId("retry").click();
	await expect(sentence(page)).toHaveText("4 updated", { timeout: 10_000 });
	await page.getByTestId("done").click();
	await expect(sentence(page)).toHaveText("1 needs a look");
	await expect(page.getByTestId("group-run")).toHaveCount(0);
	await expectFocusKept(page);
});

test("a clean run does not open the pane", async ({ page }) => {
	await load(page, "fixture&speed=4");
	await page.getByTestId("tick-wrangler").click();
	await page.getByTestId("install").click();
	await expect(sentence(page)).toHaveText("3 updated", { timeout: 20_000 });
	await expect(page.getByTestId("inspector")).toHaveCount(0);
});

test("Stop after this one returns the rest to ready", async ({ page }) => {
	await load(page, "fixture&speed=1");
	await page.getByTestId("install").click();
	await expect(page.getByTestId("stop")).toHaveText("Stop after this one");
	await expect(page.getByTestId("stop")).toBeFocused();
	await page.getByTestId("stop").click();
	await expect(page.getByTestId("stop")).toHaveText("Stopping after Zen Browser");
	await expect(sentence(page)).toHaveText("1 updated, 3 not started", { timeout: 10_000 });
	await expect(page.getByTestId("install")).toHaveText("Install 3 updates");
	await expect(page.getByTestId("done")).not.toHaveClass(/primary/);
	for (const key of ["fd", "wrangler", "cursor"]) {
		await expect(page.getByTestId(`status-${key}`)).toHaveText("Ready");
		await expect(page.getByTestId(`tick-${key}`)).toBeChecked();
	}
});

test("queued rows show their place and the rows outside the run step back", async ({ page }) => {
	await load(page, "fixture&speed=1");
	await page.getByTestId("install").click();
	await expect(page.getByTestId("place-cursor")).toHaveText("4");
	await expect(page.getByTestId("place-wrangler")).toHaveText("3");
	await expect(page.getByTestId("row-strata")).toHaveCSS("opacity", "0.72");
	await expect(page.getByTestId("group-run")).toHaveText("Installing");
});
