import { expect, load, test } from "./helpers";

// Zen's release came out two days before the fixture's clock, so a three-day wait offers it a day later.
const ZEN_DAY = "(Nov 11|11 Nov)";

test("Wait before offering a new release holds a young release back, says when, and Install now anyway takes it", async ({
	page,
}) => {
	await load(page);
	await page.getByTestId("tab-settings").click();
	await expect(page.getByTestId("setting-wait-label")).toHaveText("Wait before offering a new release");
	await expect(page.getByTestId("setting-wait-hint")).toHaveText(
		"A new release often gets a quick fix in its first days. Counted from when it came out.",
	);
	const wait = page.getByTestId("setting-wait");
	await expect(wait).toHaveValue("0");
	await expect(wait.locator("option")).toHaveText(["Off", "1 day", "3 days", "7 days"]);
	await wait.selectOption("3");
	await expect(wait).toHaveValue("3");
	await page.getByTestId("tab-updates").click();
	// Zen (two days old) and Wrangler (one day old) wait; fd (three days old) and Cursor (no date) are offered.
	await expect(page.getByTestId("status-zen")).toHaveText(new RegExp(`^Offered from ${ZEN_DAY}$`));
	await expect(page.getByTestId("group-held")).toHaveText("Held back");
	await expect(page.getByTestId("status-fd")).toHaveText("Ready");
	await expect(page.getByTestId("install")).toHaveText("Install 2 updates");
	await page.getByTestId("open-zen").click();
	await expect(page.getByTestId("settles-line")).toHaveText(
		new RegExp(`^1\\.24\\.1b is offered from ${ZEN_DAY}, after the wait set in Settings\\.$`),
	);
	await expect(page.getByTestId("install-now-zen")).toHaveText("Install now anyway");
	await page.getByTestId("install-now-zen").click();
	await expect(page.getByTestId("settles-line")).toHaveCount(0);
	await expect(page.getByTestId("status-zen")).not.toHaveText(/^Offered from/);
});

test("turning the wait off offers a settling release again", async ({ page }) => {
	await load(page);
	await page.getByTestId("tab-settings").click();
	await page.getByTestId("setting-wait").selectOption("7");
	await page.getByTestId("tab-updates").click();
	await expect(page.getByTestId("status-fd")).toHaveText(/^Offered from /);
	await page.getByTestId("tab-settings").click();
	await page.getByTestId("setting-wait").selectOption("0");
	await page.getByTestId("tab-updates").click();
	await expect(page.getByTestId("status-fd")).toHaveText("Ready");
	await expect(page.getByTestId("status-zen")).toHaveText("Ready");
});

test("a pasted GitHub token shows only its last four characters, a wrong paste is refused, and Remove forgets it", async ({
	page,
}) => {
	await load(page);
	await page.getByTestId("tab-settings").click();
	await expect(page.getByTestId("setting-token-label")).toHaveText("GitHub token");
	await expect(page.getByTestId("setting-token-hint")).toHaveText(
		"Raises GitHub's limit from 60 to 5,000 requests an hour and reaches private repos. Used before gh's own sign-in. Kept on this computer, readable by you alone.",
	);
	const input = page.getByTestId("token-input");
	await expect(input).toHaveAttribute("type", "password");
	await input.fill("not a token");
	await page.getByTestId("token-save").click();
	await expect(page.getByTestId("token-refused")).toHaveText("That does not look like a GitHub token.");
	await input.fill(`ghp_${"a".repeat(32)}wxyz`);
	await input.press("Enter");
	await expect(page.getByTestId("token-kept")).toHaveText("A token ending in wxyz is saved.");
	await expect(page.getByTestId("token-refused")).toHaveCount(0);
	await expect(page.getByTestId("settings")).not.toContainText("aaaa");
	await expect(page.getByTestId("token-remove")).toHaveText("Remove token");
	await page.getByTestId("token-remove").click();
	await expect(page.getByTestId("token-input")).toHaveValue("");
	await expect(page.getByTestId("token-save")).toHaveText("Save token");
});
