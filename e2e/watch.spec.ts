import { expect, load, test } from "./helpers";

// The fixture's fzf went from 0.67.0 to 0.68.0 a day ago and crashed twice since; its 0.67.0 restore point is kept.

test("an app that crashed since its update shows the sign under Needs a look, with what was seen", async ({ page }) => {
	await load(page);
	await expect(page.getByTestId("group-problem")).toHaveText("Needs a look");
	const chip = page.getByTestId("chip-watch-fzf");
	await expect(chip).toHaveText("Crashed since update");
	await expect(chip).toHaveAttribute(
		"title",
		"Seen since Upkeep updated it. Open the app to go back or to keep this version.",
	);
	await page.getByTestId("open-fzf").click();
	await expect(page.getByTestId("watch-line")).toHaveText(/^Crashed 2 times since 0\.68\.0 was installed .+\.$/);
	await expect(page.getByTestId("watch-no-point")).toHaveCount(0);
	await expect(page.getByTestId("watch-back-fzf")).toHaveText("Go back to 0.67.0");
	await expect(page.getByTestId("watch-fine-fzf")).toHaveText("It's fine");
});

test("Go back restores the version before and takes the sign down", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-fzf").click();
	await page.getByTestId("watch-back-fzf").click();
	await expect(page.getByTestId("restore-result")).toHaveText("Restored 0.67.0.");
	await expect(page.getByTestId("watch-fzf")).toHaveCount(0);
	await expect(page.getByTestId("chip-watch-fzf")).toHaveCount(0);
});

test("It's fine ends the watch and keeps the version", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-fzf").click();
	await page.getByTestId("watch-fine-fzf").click();
	await expect(page.getByTestId("watch-fzf")).toHaveCount(0);
	await expect(page.getByTestId("chip-watch-fzf")).toHaveCount(0);
	await expect(page.getByTestId("pane-status")).toBeVisible();
});

test("Settings has Watch updated apps under Safety, on by default", async ({ page }) => {
	await load(page);
	await page.getByTestId("tab-settings").click();
	await expect(page.getByTestId("setting-watch-label")).toHaveText("Watch updated apps for 3 days");
	await expect(page.getByTestId("setting-watch-hint")).toHaveText(
		"Each check reads crash reports, service state and an app's health address, and flags an app that started failing after its update. It never changes an app.",
	);
	const box = page.getByTestId("setting-watch");
	await expect(box).toBeChecked();
	await box.uncheck();
	await expect(box).not.toBeChecked();
	// Off takes the signs down at once; on again puts them back.
	await page.getByTestId("tab-updates").click();
	await expect(page.getByTestId("chip-watch-fzf")).toHaveCount(0);
	await page.getByTestId("tab-settings").click();
	await page.getByTestId("setting-watch").check();
	await page.getByTestId("tab-updates").click();
	await expect(page.getByTestId("chip-watch-fzf")).toHaveText("Crashed since update");
});

test("with no restore point of the version before, the pane says so and offers only It's fine", async ({ page }) => {
	await load(page);
	await expect(page.getByTestId("chip-watch-bun")).toHaveText("Not answering since update");
	await page.getByTestId("open-bun").click();
	await expect(page.getByTestId("watch-line")).toHaveText(
		/^Its health address has stopped answering since 1\.4\.4 was installed .+\.$/,
	);
	await expect(page.getByTestId("watch-no-point")).toHaveText(
		"No restore point of the version before is left, so there is nothing to go back to.",
	);
	await expect(page.getByTestId("watch-back-bun")).toHaveCount(0);
	await expect(page.getByTestId("watch-fine-bun")).toBeVisible();
});
