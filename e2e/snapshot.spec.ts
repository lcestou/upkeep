import type { Page } from "playwright/test";
import { expect, load, test } from "./helpers";

const sysOps = (page: Page) => page.evaluate(() => (globalThis as { upkeepSysOps?: string[] }).upkeepSysOps ?? []);
/** Opens the System group; the fold is remembered for the session, so a reload may find it open already. */
async function openGroup(page: Page) {
	const toggle = page.getByTestId("group-system-toggle");
	if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

/** Ticks perl alone and opens the command sheet. */
async function tickPerl(page: Page) {
	await openGroup(page);
	await page.getByTestId("select-none").click();
	await page.getByTestId("sys-tick-apt:perl").check();
	await page.getByTestId("install").click();
}

test("the snapshot setting shows only while installing is on and a snapshot tool is set up", async ({ page }) => {
	await load(page, "fixture&system=firmware");
	await page.getByTestId("tab-settings").click();
	const row = page.getByTestId("setting-system-snapshot");
	await expect(row).not.toBeChecked();
	await expect(page.getByTestId("setting-system-snapshot-help")).toHaveText(
		"Uses Timeshift. One is taken before system updates install, unless the newest snapshot is under 6 hours old; in btrfs mode, always. Upkeep keeps its own 3 newest and never deletes yours.",
	);
	await row.check();
	// Installing off takes the snapshot setting with it; back on, it is off until turned on again.
	await page.getByTestId("setting-system-install").uncheck();
	await expect(row).toHaveCount(0);
	await page.getByTestId("setting-system-install").check();
	await expect(row).not.toBeChecked();
});

test("no snapshot setting where no snapshot tool is set up", async ({ page }) => {
	await load(page, "fixture&system=install");
	await page.getByTestId("tab-settings").click();
	await expect(page.getByTestId("setting-system-install")).toBeChecked();
	await expect(page.getByTestId("setting-system-snapshot")).toHaveCount(0);
});

test("with the snapshot on, the sheet says so and the run shows Taking a snapshot before the steps", async ({
	page,
}) => {
	await load(page, "fixture&system=firmware");
	await page.getByTestId("tab-settings").click();
	await page.getByTestId("setting-system-snapshot").check();
	await page.getByTestId("tab-updates").click();
	await tickPerl(page);
	await expect(page.getByTestId("system-confirm-snapshot")).toHaveText(
		"Upkeep takes a Timeshift snapshot first, unless one is under 6 hours old.",
	);
	await page.getByTestId("system-confirm").click();
	await expect(page.getByTestId("system-snapshot-step")).toHaveText("Taking a snapshot");
	await expect(page.getByTestId("sys-row-apt:perl").getByTestId("sys-state")).toHaveText("Waiting");
	await expect(page.getByTestId("system-summary")).toHaveText("Installed 1 of 1.");
	await expect(page.getByTestId("system-snapshot-step")).toHaveCount(0);
	// History names the snapshot; it reads as Taken and is not counted as an update.
	await page.getByTestId("tab-history").click();
	const row = page.locator("li", { hasText: "Snapshot 2026-11-26_10-00-00 taken before the system updates." });
	await expect(row.getByTestId("history-result")).toHaveText("Taken");
	await expect(row.getByTestId("history-vers")).toHaveCount(0);
});

test("no snapshot line in the sheet while the setting is off", async ({ page }) => {
	await load(page, "fixture&system=firmware");
	await tickPerl(page);
	await expect(page.getByTestId("system-command")).toHaveCount(1);
	await expect(page.getByTestId("system-confirm-snapshot")).toHaveCount(0);
});

test("a failed snapshot asks; Install anyway goes on", async ({ page }) => {
	await load(page, "fixture&system=snapshot-fail");
	await tickPerl(page);
	await page.getByTestId("system-confirm").click();
	await expect(page.getByTestId("system-snapshot-reason")).toHaveText(
		"The snapshot did not finish: E: Not enough disk space on the backup device",
	);
	await expect(page.getByTestId("system-snapshot-question")).toHaveText("Install the system updates anyway?");
	await expect(page.getByTestId("system-snapshot-go")).toHaveText("Install anyway");
	await expect(page.getByTestId("system-snapshot-stop")).toHaveText("Stop");
	await page.getByTestId("system-snapshot-go").click();
	await expect(page.getByTestId("system-snapshot-ask")).toHaveCount(0);
	await expect(page.getByTestId("system-summary")).toHaveText("Installed 1 of 1.");
	expect(await sysOps(page)).toContain("systemSnapshotAnswer:true");
});

test("a failed snapshot asks; Stop installs nothing and says why", async ({ page }) => {
	await load(page, "fixture&system=snapshot-fail");
	await tickPerl(page);
	await page.getByTestId("system-confirm").click();
	await page.getByTestId("system-snapshot-stop").click();
	await expect(page.getByTestId("system-refused")).toHaveText("The snapshot did not finish, so nothing was installed.");
	await expect(page.getByTestId("system-results")).toHaveCount(0);
	await expect(page.getByTestId("sys-row-apt:perl")).toBeVisible();
	expect(await sysOps(page)).toContain("systemSnapshotAnswer:false");
});
