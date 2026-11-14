import type { Page } from "playwright/test";
import { expect, load, test } from "./helpers";

/** What the fixture recorded of the window's presses. */
const ops = (page: Page) => page.evaluate(() => (globalThis as { upkeepOps?: string[] }).upkeepOps ?? []);

test("Uninstall asks first, says what goes and what stays, and keeps the data unless ticked", async ({ page }) => {
	await load(page);
	await page.getByTestId("tab-settings").click();
	await page.getByTestId("uninstall").click();
	await expect(page.getByTestId("uninstall-ask")).toHaveText(
		"Uninstall Upkeep? Its menu entry, its login entry and the upkeep command go with it. The apps it keeps up to date stay installed.",
	);
	await expect(page.getByTestId("uninstall-purge-label")).toHaveText(
		"Also delete Upkeep's settings, app list, history and restore points",
	);
	await expect(page.getByTestId("uninstall-purge")).not.toBeChecked();
	await page.getByTestId("uninstall-cancel").click();
	await expect(page.getByTestId("uninstall-ask")).toHaveCount(0);
	expect(await ops(page)).not.toContain("uninstall false");
	await page.getByTestId("uninstall").click();
	await page.getByTestId("uninstall-purge").check();
	await page.getByTestId("uninstall-confirm").click();
	await expect(page.getByTestId("uninstall-closing")).toHaveText("Uninstalling. Upkeep closes now.");
	expect(await ops(page)).toContain("uninstall true");
});
