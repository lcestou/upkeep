import type { Page } from "playwright/test";
import { expect, load, test } from "./helpers";

/** Opens the System group; the fold is remembered for the session, so a reload may find it open already. */
async function openGroup(page: Page) {
	const toggle = page.getByTestId("group-system-toggle");
	if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

const DBX = "firmware:0000000000000000000000000000000000000003";
const DOCK = "firmware:0000000000000000000000000000000000000004";

test("firmware rows sit under their own heading, last, and a device that needs it says Restart needed", async ({
	page,
}) => {
	await load(page, "fixture&system=firmware");
	await openGroup(page);
	await expect(page.getByTestId("system-checked")).toHaveText(/^From Update Manager and fwupd, checked /);
	await expect(page.getByTestId("system-firmware")).toHaveText("Firmware");
	const ids = await page.locator('[data-testid^="sys-row-"]').evaluateAll((els) => els.map((e) => e.dataset.testid));
	expect(ids.slice(-2)).toEqual([`sys-row-${DBX}`, `sys-row-${DOCK}`]);
	const dbx = page.getByTestId(`sys-row-${DBX}`);
	await expect(dbx.getByTestId("sys-name")).toHaveText("UEFI dbx");
	await expect(dbx.getByTestId("sys-type")).toHaveText("Firmware");
	await expect(dbx.getByTestId("sys-ver")).toHaveAttribute("title", "20230501 → 20260402");
	await expect(dbx.getByTestId("sys-restart")).toHaveText("Restart needed");
	await expect(page.getByTestId(`sys-row-${DOCK}`).getByTestId("sys-restart")).toHaveCount(0);
});

test("no firmware heading where fwupd lists nothing", async ({ page }) => {
	await load(page, "fixture&system=install");
	await openGroup(page);
	await expect(page.getByTestId("system-firmware")).toHaveCount(0);
	await expect(page.getByTestId("system-checked")).toHaveText(/^From Update Manager, checked /);
});

test("a ticked device installs through fwupdmgr, and the result says a restart is needed", async ({ page }) => {
	await load(page, "fixture&system=firmware");
	await openGroup(page);
	await page.getByTestId("select-none").click();
	await page.getByTestId(`sys-tick-${DBX}`).check();
	await page.getByTestId("install").click();
	await expect(page.getByTestId("system-command")).toHaveText([
		"fwupdmgr update 0000000000000000000000000000000000000003 --assume-yes --no-reboot-check --no-metadata-check --no-remote-check --no-unreported-check --no-security-fix --no-device-prompt",
	]);
	await expect(page.getByTestId("system-confirm-firmware")).toHaveText(
		"Firmware updates may ask for your password in the system's own window.",
	);
	await expect(page.getByTestId("system-confirm-root")).toHaveCount(0);
	await page.getByTestId("system-confirm").click();
	await expect(page.getByTestId("system-summary")).toHaveText("Installed 1 of 1.");
	const result = page.getByTestId(`sys-result-${DBX}`);
	await expect(result.getByTestId("sys-result-state")).toHaveText("Installed");
	await expect(result.getByTestId("sys-result-detail")).toHaveText("Restart needed to finish the firmware update.");
});
