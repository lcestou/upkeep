import { expect, load, test } from "./helpers";

test("Skip moves the app to Held back and Stop skipping brings it back", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-fd").click();
	await page.getByTestId("skip-fd").click();
	await expect(page.getByTestId("group-held")).toHaveText("Held back");
	await expect(page.getByTestId("status-fd")).toHaveText("Skipping 10.5.2");
	await expect(page.getByTestId("install")).toHaveText("Install 3 updates");
	await expect(page.getByTestId("skip-fd")).toHaveText("Stop skipping 10.5.2");
	await expect(page.getByTestId("skip-fd")).toBeFocused();
	await page.getByTestId("skip-fd").click();
	await expect(page.getByTestId("status-fd")).toHaveText("Ready");
	await expect(page.getByTestId("group-held")).toHaveCount(0);
});

test("Hold updates and Release hold", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-zen").click();
	await page.getByTestId("hold-zen").click();
	await expect(page.getByTestId("status-zen")).toHaveText("Held");
	await expect(page.getByTestId("hold-zen")).toHaveText("Release hold");
	await page.getByTestId("hold-zen").click();
	await expect(page.getByTestId("status-zen")).toHaveText("Ready");
});

test("Restore shows Restored and keeps focus", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-fd").click();
	await page.getByTestId("restore-fd-10.5.0").click();
	await expect(page.getByTestId("restore-result")).toHaveText("Restored 10.5.0.");
	await expect(page.getByTestId("restore-result")).toBeFocused();
});

test("the By hand row copies its command", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-strata").click();
	await expect(page.getByTestId("detail-strata")).toContainText("Run it yourself:");
	await page.getByTestId("copy-strata").click();
	await expect(page.getByTestId("copy-strata")).toHaveText("Copied");
	await expect(page.getByTestId("copy-strata")).toHaveText("Copy", { timeout: 4000 });
});

test("Install automatically adds the Auto chip", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-fd").click();
	await page.getByTestId("auto-fd").check();
	await expect(page.getByTestId("row-fd").getByTestId("chip-auto")).toHaveText("Auto");
	await page.getByTestId("auto-fd").uncheck();
	await expect(page.getByTestId("row-fd").getByTestId("chip-auto")).toHaveCount(0);
});
