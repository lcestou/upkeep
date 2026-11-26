import type { Page } from "playwright/test";
import { expect, load, test } from "./helpers";

/** What the fixture recorded of the window's presses; a power action at zero only lands here. */
const ops = (page: Page) => page.evaluate(() => (globalThis as { upkeepOps?: string[] }).upkeepOps ?? []);

/** The labels the when-done box offers, in order. */
const offered = (page: Page) => page.getByTestId("when-done").locator("option").allTextContents();

test("during a run the When done choice offers every action logind allows, and lasts that run only", async ({
	page,
}) => {
	await load(page, "fixture&speed=2");
	// Not before a run: there is nothing for it to wait on.
	await expect(page.getByTestId("when-done")).toHaveCount(0);
	await page.getByTestId("install").click();
	await expect(page.getByTestId("when-done")).toHaveValue("nothing");
	await expect(page.getByText("When done", { exact: true })).toBeVisible();
	expect(await offered(page)).toEqual(["Nothing", "Quit Upkeep", "Suspend", "Shut down"]);
	await page.getByTestId("when-done").selectOption("poweroff");
	await expect(page.getByTestId("when-done")).toHaveValue("poweroff");
	// wrangler fails on the first pass: the PC is not shut down, and the window says why.
	await expect(page.getByTestId("when-note")).toHaveText("The PC was not shut down. An app did not update.", {
		timeout: 20_000,
	});
	await expect(page.getByTestId("when-countdown")).toHaveCount(0);
	// The summary's own Done takes the note with it.
	await expect(page.getByTestId("when-note-done")).toHaveCount(0);
	await page.getByTestId("retry").click();
	// The next run starts at Nothing again.
	await expect(page.getByTestId("when-done")).toHaveValue("nothing");
	expect(await ops(page)).not.toContain("poweroff");
});

test("a run where every app updated counts down, and Cancel stops it", async ({ page }) => {
	await load(page, "fixture&speed=2");
	await page.getByTestId("install").click();
	await expect(page.getByTestId("retry")).toBeVisible({ timeout: 20_000 });
	await page.getByTestId("retry").click();
	await page.getByTestId("when-done").selectOption("suspend");
	await expect(page.getByTestId("when-countdown")).toHaveText(/^Suspending in \d+ s$/, { timeout: 20_000 });
	await expect(page.getByTestId("when-cancel")).toHaveText("Cancel");
	await page.getByTestId("when-cancel").click();
	await expect(page.getByTestId("when-countdown")).toHaveCount(0);
	await expect(page.getByTestId("when-note")).toHaveCount(0);
	expect(await ops(page)).not.toContain("suspend");
	await page.getByTestId("done").click();
	await expect(page.getByTestId("when-note")).toHaveCount(0);
});

test("a shut-down counts down too, in its own words", async ({ page }) => {
	await load(page, "fixture&speed=2");
	await page.getByTestId("install").click();
	await expect(page.getByTestId("retry")).toBeVisible({ timeout: 20_000 });
	await page.getByTestId("retry").click();
	await page.getByTestId("when-done").selectOption("poweroff");
	await expect(page.getByTestId("when-countdown")).toHaveText(/^Shutting down in \d+ s$/, { timeout: 20_000 });
	await page.getByTestId("when-cancel").click();
	await expect(page.getByTestId("when-countdown")).toHaveCount(0);
	expect(await ops(page)).not.toContain("poweroff");
});

test("where logind allows neither, Suspend and Shut down are not offered", async ({ page }) => {
	await load(page, "fixture&speed=2&power=no");
	await page.getByTestId("install").click();
	await expect(page.getByTestId("when-done")).toBeVisible();
	expect(await offered(page)).toEqual(["Nothing", "Quit Upkeep"]);
});

test("Stop now cancels a power action, and the summary's Done takes the note away", async ({ page }) => {
	await load(page, "fixture&speed=0.5");
	await page.getByTestId("install").click();
	await page.getByTestId("when-done").selectOption("suspend");
	await page.getByTestId("stop").click();
	await page.getByTestId("stop-now").click();
	await expect(page.getByTestId("when-note")).toHaveText("The PC was not suspended. The run was stopped.", {
		timeout: 10_000,
	});
	expect(await ops(page)).not.toContain("suspend");
	await page.getByTestId("done").click();
	await expect(page.getByTestId("when-note")).toHaveCount(0);
});
