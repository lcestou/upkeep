import type { Page } from "playwright/test";
import { expect, load, test } from "./helpers";

const ops = (page: Page) => page.evaluate(() => (globalThis as { upkeepOps?: string[] }).upkeepOps ?? []);

test("an update that fixes a security problem wears a chip, and its pane lists the IDs as links", async ({ page }) => {
	await load(page);
	const chip = page.getByTestId("row-fd").getByTestId("chip-security");
	await expect(chip).toHaveText("Security fix");
	await expect(chip).toHaveAttribute("title", "This update fixes a security problem. Open the row to see which.");
	// Only the row with a fix wears it.
	await expect(page.getByTestId("chip-security")).toHaveCount(1);
	await page.getByTestId("open-fd").click();
	const pane = page.getByTestId("detail-fd");
	await expect(pane.getByTestId("security-heading")).toHaveText("Security fix");
	await expect(pane.getByTestId("security-id")).toHaveText(["CVE-2026-31337", "GHSA-q4w7-2v5m-9xjc"]);
	await expect(pane.getByTestId("security-hint")).toHaveText(
		"Found in the release notes, the project's advisories on GitHub, or OSV.dev. Each opens its page in your browser.",
	);
	await expect(pane.getByTestId("security-notes")).toHaveCount(0);
	await pane.getByTestId("security-id").first().click();
	await expect.poll(() => ops(page)).toContain("open advisory CVE-2026-31337");
	// A row with no fix has no such block.
	await page.getByTestId("open-zen").click();
	await expect(page.getByTestId("detail-zen").getByTestId("security")).toHaveCount(0);
});

test("Except security fixes shows only while there is a wait, and lets a fix through it", async ({ page }) => {
	await load(page);
	await page.getByTestId("tab-settings").click();
	await expect(page.getByTestId("setting-wait-security")).toHaveCount(0);
	await page.getByTestId("setting-wait-days").selectOption("7");
	await expect(page.getByTestId("setting-wait-security-label")).toHaveText("Except security fixes");
	await expect(page.getByTestId("setting-wait-security-hint")).toHaveText(
		"An update that fixes a security problem is offered at once. It installs by itself only for an app set to Auto.",
	);
	await expect(page.getByTestId("setting-wait-security")).toBeChecked();
	await page.getByTestId("tab-updates").click();
	// fd came out three days ago, inside the seven-day wait, but its security fix is offered at once.
	await expect(page.getByTestId("status-fd")).toHaveText("Ready");
	await page.getByTestId("tab-settings").click();
	await page.getByTestId("setting-wait-security").uncheck();
	await page.getByTestId("tab-updates").click();
	await expect(page.getByTestId("status-fd")).toHaveText(/^Offered from /);
	await page.getByTestId("tab-settings").click();
	await page.getByTestId("setting-wait-days").selectOption("0");
	await expect(page.getByTestId("setting-wait-security")).toHaveCount(0);
});
