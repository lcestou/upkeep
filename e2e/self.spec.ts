import { expect, load, test } from "./helpers";

const ops = (page: import("playwright/test").Page) =>
	page.evaluate(() => (globalThis as { upkeepOps?: string[] }).upkeepOps ?? []);

test("with nothing to say about Upkeep's own update there is no row", async ({ page }) => {
	await load(page);
	await expect(page.getByTestId("self-row")).toHaveCount(0);
});

test("a new version is offered, downloaded and tested, then waits for the restart, and says when it is done", async ({
	page,
}) => {
	await load(page, "fixture&self=available&speed=2");
	const row = page.getByTestId("self-row");
	await expect(row).toBeVisible();
	await expect(page.getByTestId("self-version")).toHaveText("0.1.0 → 0.1.1");
	await expect(page.getByTestId("self-sentence")).toHaveText("A new version of Upkeep is ready.");
	await expect(page.getByTestId("self-update")).toHaveText("Update Upkeep");
	await page.getByTestId("self-notes").click();
	await expect.poll(() => ops(page)).toContain("open self-notes");

	await page.getByTestId("self-update").click();
	await expect(page.getByTestId("self-sentence")).toHaveText("Downloading and testing");
	// While Upkeep is at work on it there is nothing to press.
	await expect(page.getByTestId("self-update")).toHaveCount(0);
	await expect(page.getByTestId("self-sentence")).toHaveText("Restart Upkeep to finish.");
	await expect(page.getByTestId("self-restart")).toHaveText("Restart now");

	await page.getByTestId("self-restart").click();
	await expect(page.getByTestId("self-sentence")).toHaveText("Restarting");
	await expect(page.getByTestId("self-sentence")).toHaveText("Upkeep was updated to 0.1.1.");
	await expect(page.getByTestId("self-version")).toHaveText("0.1.1");
	await page.getByTestId("self-dismiss").click();
	await expect(row).toHaveCount(0);
	expect((await ops(page)).filter((o) => o.startsWith("self "))).toEqual(["self update", "self restart"]);
});

test("a download that failed says nothing was changed and offers to try again", async ({ page }) => {
	await load(page, "fixture&self=failed&speed=4");
	await expect(page.getByTestId("self-sentence")).toHaveText("Could not download the update. Nothing was changed.");
	await expect(page.getByTestId("self-update")).toHaveText("Try again");
	await page.getByTestId("self-update").click();
	await expect(page.getByTestId("self-sentence")).toHaveText("Restart Upkeep to finish.");
});

test("a version that fails its start test never reaches the restart", async ({ page }) => {
	await load(page, "fixture&self=available&selftest=fail&speed=4");
	await page.getByTestId("self-update").click();
	await expect(page.getByTestId("self-sentence")).toHaveText(
		"Upkeep 0.1.1 failed its start test, so nothing was changed.",
	);
	await expect(page.getByTestId("self-restart")).toHaveCount(0);
	await expect(page.getByTestId("self-update")).toHaveText("Try again");
});

test("after a rollback the row says which version would not start and which one is running", async ({ page }) => {
	await load(page, "fixture&self=rolled-back");
	await expect(page.getByTestId("self-sentence")).toHaveText(
		"Upkeep 0.1.1 would not start, so the version before it was put back.",
	);
	await expect(page.getByTestId("self-version")).toHaveText("0.1.0");
	await expect(page.getByTestId("self-update")).toHaveText("Try again");
	await page.getByTestId("self-dismiss").click();
	await expect(page.getByTestId("self-row")).toHaveCount(0);
});

test("Upkeep's own update waits for a run: its button is off and says why", async ({ page }) => {
	await load(page, "fixture&self=ready&speed=0.3");
	await expect(page.getByTestId("self-restart")).toBeEnabled();
	await page.getByTestId("install").click();
	await expect(page.getByTestId("self-restart")).toBeDisabled();
	await expect(page.getByTestId("self-restart")).toHaveAttribute("title", "Finish what is running first.");
});

test("Settings has the switch for updating Upkeep on its own, off until turned on", async ({ page }) => {
	await load(page);
	await page.getByTestId("tab-settings").click();
	const box = page.getByTestId("setting-self-auto");
	await expect(box).not.toBeChecked();
	await expect(page.getByTestId("setting-self-auto-label")).toHaveText("Update Upkeep automatically");
	await expect(page.getByTestId("setting-self-auto-help")).toHaveText(
		"Installs a new version of Upkeep while it sits in the tray, and restarts it. Off: Upkeep tells you and waits.",
	);
	await box.check();
	await expect(box).toBeChecked();
	await page.getByTestId("tab-updates").click();
	await page.getByTestId("tab-settings").click();
	await expect(page.getByTestId("setting-self-auto")).toBeChecked();
});
