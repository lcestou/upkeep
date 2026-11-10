import { expect, load, sentence, test } from "./helpers";

test("the three tabs, with arrow keys", async ({ page }) => {
	await load(page);
	await page.getByTestId("tab-history").click();
	await expect(page.getByTestId("tab-history")).toHaveAttribute("aria-selected", "true");
	await expect(page.getByTestId("history")).toContainText("Ghostty Terminal");
	await expect(page.getByTestId("history")).toContainText("Rolled back");
	await page.keyboard.press("ArrowRight");
	await expect(page.getByTestId("tab-settings")).toBeFocused();
	await expect(page.getByTestId("settings")).toBeVisible();
	await page.keyboard.press("Home");
	await expect(page.getByTestId("tab-updates")).toHaveAttribute("aria-selected", "true");
	await expect(page.getByTestId("app-list")).toBeVisible();
});

test("each Settings control", async ({ page }) => {
	await load(page);
	await page.getByTestId("tab-settings").click();
	const notify = page.getByTestId("setting-notify");
	await expect(notify).toBeChecked();
	await notify.uncheck();
	await expect(notify).not.toBeChecked();
	const login = page.getByTestId("setting-login");
	await login.check();
	await expect(login).toBeChecked();
	await page.getByTestId("setting-keep").selectOption("3");
	await expect(page.getByTestId("setting-keep")).toHaveValue("3");
	await page.getByTestId("open-manifest").click();
	await expect(page.getByTestId("rate")).toHaveText("GitHub requests left this hour: 4977 of 5000");
	await expect(page.getByTestId("version")).toHaveText("Version 0.1.0");
});

test("the Log drawer fills during a run and History gains the run", async ({ page }) => {
	await load(page, "fixture&speed=4");
	await page.getByTestId("log-toggle").click();
	await expect(page.getByTestId("log-drawer")).toContainText("No log lines yet.");
	await page.getByTestId("install").click();
	await expect(page.getByTestId("log-drawer")).toContainText("Run started: 4 apps.");
	await expect(page.getByTestId("log-drawer")).toContainText("Downloading Zen Browser 1.24.1b.");
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("log-drawer")).toHaveCount(0);
	await expect(page.getByTestId("log-toggle")).toBeFocused();
	await expect(sentence(page)).toHaveText("3 updated, 1 failed", { timeout: 20_000 });
	await page.getByTestId("tab-history").click();
	await expect(page.getByTestId("history").locator("section").first()).toContainText("3 updated, 1 failed");
});
