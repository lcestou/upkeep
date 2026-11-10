import { expect, load, sentence, test } from "./helpers";

test("?fixture=empty shows Everything is fresh", async ({ page }) => {
	await load(page, "fixture=empty", { wait: "sentence" });
	await expect(sentence(page)).toHaveText("Everything is fresh");
	// The block does not repeat the header: no sentence, no Checked line, no second Check again.
	const block = page.getByTestId("all-fresh");
	await expect(block).not.toContainText("Everything is fresh");
	await expect(page.getByTestId("all-fresh-line")).toHaveText("All 32 apps are up to date.");
	await expect(block.getByTestId("add-app")).toHaveText("Add app");
	await expect(page.getByTestId("all-fresh-check")).toHaveCount(0);
	for (const gone of ["install", "tick-all", "selection", "select-all", "filter"])
		await expect(page.getByTestId(gone)).toHaveCount(0);
	await expect(page.getByTestId("log-toggle")).toHaveText("Show log");
	await expect(page.getByTestId("group-fresh-toggle")).toHaveAttribute("aria-expanded", "false");
});

test("?fixture=checking shows Checking 20 of 32", async ({ page }) => {
	await load(page, "fixture=checking");
	await expect(sentence(page)).toHaveText("Checking 20 of 32");
	await expect(page.getByTestId("group-checking")).toHaveText("Checking");
	await expect(page.getByTestId("install")).toBeDisabled();
});

test("?fixture=problems shows 3 need a look", async ({ page }) => {
	await load(page, "fixture=problems");
	await expect(sentence(page)).toHaveText("3 need a look");
	await expect(page.getByTestId("group-held")).toBeVisible();
});

test("?fixture=many renders 60 apps and scrolls", async ({ page }) => {
	await load(page, "fixture=many");
	await page.getByTestId("group-fresh-toggle").click();
	await expect(page.locator('[data-testid^="row-"]')).toHaveCount(60);
	const list = page.getByTestId("app-list");
	expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight * 2)).toBe(true);
	await page.getByTestId("open-omp-plugins-2").scrollIntoViewIfNeeded();
	await expect(page.getByTestId("open-omp-plugins-2")).toBeInViewport();
});
