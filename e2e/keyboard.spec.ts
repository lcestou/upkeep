import { expect, expectFocusKept, load, sentence, test } from "./helpers";

const focused = (page: import("playwright/test").Page) =>
	page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName ?? "");

test("first focus is the list, and Install is at most six Tab presses away", async ({ page }) => {
	await load(page);
	expect(await focused(page)).toBe("open-zen");
	let presses = 0;
	while ((await focused(page)) !== "install" && presses < 10) {
		await page.keyboard.press("Tab");
		presses++;
	}
	expect(await focused(page)).toBe("install");
	expect(presses).toBeLessThanOrEqual(6);
	// The list is one tab stop: no second row button and no row tick on the way.
	await page.getByTestId("open-zen").focus();
	const stops: string[] = [];
	for (let i = 0; i < presses; i++) {
		await page.keyboard.press("Tab");
		stops.push(await focused(page));
	}
	expect(stops.filter((s) => s.startsWith("open-") || s.startsWith("tick-"))).toEqual([]);
});

test("keyboard only, from first focus to the summary and back", async ({ page }) => {
	await load(page, "fixture&speed=4");
	for (let i = 0; i < 8 && (await focused(page)) !== "install"; i++) await page.keyboard.press("Tab");
	await expect(page.getByTestId("install")).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("stop")).toBeFocused();
	await expect(sentence(page)).toHaveText("3 updated, 1 failed", { timeout: 20_000 });
	await expectFocusKept(page);
	await expect(page.getByTestId("retry")).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(page.getByTestId("done")).toBeFocused();
	await page.keyboard.press("Enter");
	// Round three: the failed app is ready again after Done.
	await expect(sentence(page)).toHaveText("1 update ready");
	await expectFocusKept(page);
});

test("Space ticks the focused row, Enter and Right open it, Left closes it, Home and End jump", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-fd").focus();
	await page.keyboard.press(" ");
	await expect(page.getByTestId("tick-fd")).not.toBeChecked();
	await expect(page.getByTestId("inspector")).toHaveCount(0);
	await page.keyboard.press(" ");
	await expect(page.getByTestId("tick-fd")).toBeChecked();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("detail-fd")).toBeVisible();
	await page.keyboard.press("ArrowLeft");
	await expect(page.getByTestId("inspector")).toHaveCount(0);
	await page.keyboard.press("ArrowRight");
	await expect(page.getByTestId("detail-fd")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("open-fd")).toBeFocused();
	await page.keyboard.press("End");
	await expect(page.getByTestId("open-lrcget")).toBeFocused();
	await page.keyboard.press("Home");
	await expect(page.getByTestId("open-zen")).toBeFocused();
	await expect(page.getByTestId("tick-zen")).toHaveAttribute("tabindex", "-1");
});
