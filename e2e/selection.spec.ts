import { expect, expectFocusKept, load, test } from "./helpers";

test("untick and tick update the count and the size", async ({ page }) => {
	await load(page);
	await page.getByTestId("tick-zen").click();
	await expect(page.getByTestId("install")).toHaveText("Install 3 updates");
	await expect(page.getByTestId("selection")).toHaveText("3 selected · at least 1.2 MB");
	await expect(page.getByTestId("tick-all")).toHaveJSProperty("indeterminate", true);
	await page.getByTestId("tick-fd").click();
	await expect(page.getByTestId("selection")).toHaveText("2 selected");
	await page.getByTestId("tick-zen").click();
	await expect(page.getByTestId("install")).toHaveText("Install 3 updates");
});

test("Select none disables Install and Select all brings the four back", async ({ page }) => {
	await load(page);
	await page.getByTestId("select-none").click();
	await expect(page.getByTestId("selection")).toHaveText("Nothing selected");
	await expect(page.getByTestId("install")).toBeDisabled();
	await expect(page.getByTestId("install")).toHaveText("Install updates");
	await expect(page.getByTestId("select-none")).toBeDisabled();
	await expectFocusKept(page);
	await expect(page.getByTestId("select-all")).toBeFocused();
	await page.getByTestId("select-all").click();
	await expect(page.getByTestId("install")).toHaveText("Install 4 updates");
	await expect(page.getByTestId("select-all")).toBeDisabled();
});

test("the header checkbox and Ctrl+A select all", async ({ page }) => {
	await load(page);
	await page.getByTestId("tick-all").click();
	await expect(page.getByTestId("selection")).toHaveText("Nothing selected");
	await page.getByTestId("open-fd").focus();
	await page.keyboard.press("Control+a");
	await expect(page.getByTestId("install")).toHaveText("Install 4 updates");
});
