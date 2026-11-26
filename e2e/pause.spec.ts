import { expect, load, test } from "./helpers";

// The fixture's clock is 2026-11-10, so two weeks ends on Nov 24 and one week on Nov 17.
const day = (d: string) => new RegExp(`(Nov ${d}|${d} Nov)`);

test("Pause for holds a ready app until its day, says so on the row and in the pane, and Resume now ends it", async ({
	page,
}) => {
	await load(page);
	await expect(page.getByTestId("status-fd")).toHaveText("Ready");
	await page.getByTestId("open-fd").click();
	const pause = page.getByTestId("pause-fd");
	await expect(pause).toHaveAccessibleName("Pause for…");
	await expect(pause.locator("option")).toHaveText(["Pause for…", "1 week", "2 weeks", "1 month"]);
	await pause.selectOption("14");
	await expect(page.getByTestId("status-fd")).toHaveText(new RegExp(`^Paused until ${day("24").source}$`));
	await expect(page.getByTestId("pane-status")).toHaveText(new RegExp(`^Paused until ${day("24").source}$`));
	await expect(page.getByTestId("paused-line")).toHaveText(
		new RegExp(`^Paused until ${day("24").source}, then offered again by itself\\.$`),
	);
	await expect(page.getByTestId("group-held")).toHaveText("Held back");
	await expect(page.getByTestId("pause-fd")).toHaveCount(0);
	await expect(page.getByTestId("resume-fd")).toHaveText("Resume now");
	await page.getByTestId("resume-fd").click();
	await expect(page.getByTestId("status-fd")).toHaveText("Ready");
	await expect(page.getByTestId("paused-line")).toHaveCount(0);
	await expect(page.getByTestId("pause-fd")).toHaveValue("");
});

test("Hold updates takes the place of a pause, and Release hold leaves the app ready", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-fd").click();
	await page.getByTestId("pause-fd").selectOption("7");
	await expect(page.getByTestId("status-fd")).toHaveText(new RegExp(`^Paused until ${day("17").source}$`));
	await page.getByTestId("hold-fd").click();
	await expect(page.getByTestId("hold-fd")).toHaveText("Release hold");
	await expect(page.getByTestId("paused-line")).toHaveCount(0);
	// A held app offers neither a pause nor Resume now; the hold says it all.
	await expect(page.getByTestId("pause-fd")).toHaveCount(0);
	await expect(page.getByTestId("resume-fd")).toHaveCount(0);
	await page.getByTestId("hold-fd").click();
	await expect(page.getByTestId("status-fd")).toHaveText("Ready");
});
