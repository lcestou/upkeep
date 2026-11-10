import { expect, expectFocusKept, load, sentence, test } from "./helpers";

test("keyboard only, from first focus to the summary and back", async ({ page }) => {
	await load(page, "fixture&speed=4");
	const order: string[] = [];
	for (let i = 0; i < 14; i++) {
		await page.keyboard.press("Tab");
		order.push(await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName ?? ""));
		if (order.at(-1) === "install") break;
	}
	expect(order[0]).toBe("tab-updates");
	expect(order).toContain("check");
	expect(order).toContain("tick-all");
	// The list is one tab stop: exactly one row button is reached.
	expect(order.filter((t) => t.startsWith("open-")).length).toBe(1);
	expect(order.at(-1)).toBe("install");
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("stop")).toBeFocused();
	await expect(sentence(page)).toHaveText("3 updated, 1 failed", { timeout: 20_000 });
	await expectFocusKept(page);
	await expect(page.getByTestId("retry")).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(page.getByTestId("done")).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(sentence(page)).toHaveText("1 needs a look");
	await expectFocusKept(page);
});

test("Home and End walk to the first and last row; Right opens and Left closes", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-wrangler").focus();
	await page.keyboard.press("End");
	await expect(page.getByTestId("open-lrcget")).toBeFocused();
	await page.keyboard.press("Home");
	await expect(page.getByTestId("open-zen")).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(page.getByTestId("detail-zen")).toBeVisible();
	await page.keyboard.press("ArrowLeft");
	await expect(page.getByTestId("inspector")).toHaveCount(0);
	await expect(page.getByTestId("open-zen")).toBeFocused();
});
