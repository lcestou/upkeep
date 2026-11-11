import { expect, load, sentence, test } from "./helpers";

test("a row click opens the pane and the list does not move under the pointer", async ({ page }) => {
	await load(page);
	const row = page.getByTestId("row-fd");
	const before = await row.boundingBox();
	const scroll = await page.getByTestId("app-list").evaluate((el) => el.scrollTop);
	await page.getByTestId("open-fd").click();
	await expect(page.getByTestId("detail-fd")).toBeVisible();
	const after = await row.boundingBox();
	expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);
	expect(await page.getByTestId("app-list").evaluate((el) => el.scrollTop)).toBe(scroll);
	await expect(page.getByTestId("open-fd")).toHaveAttribute("aria-current", "true");
	await expect(page.getByTestId("open-fd")).toHaveAttribute("aria-expanded", "true");
	// Clicking the open row again, or double clicking it, leaves it open.
	await page.getByTestId("open-fd").click();
	await expect(page.getByTestId("detail-fd")).toBeVisible();
	await page.getByTestId("open-wrangler").dblclick();
	await expect(page.getByTestId("detail-wrangler")).toBeVisible();
});

test("Enter opens, Down moves the selection and the pane follows, Escape closes onto the row", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-fd").focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("detail-fd")).toBeVisible();
	await page.keyboard.press("ArrowDown");
	await expect(page.getByTestId("open-wrangler")).toBeFocused();
	await expect(page.getByTestId("detail-wrangler")).toBeVisible();
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("ArrowDown");
	await expect(page.getByTestId("detail-llama")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("inspector")).toHaveCount(0);
	await expect(page.getByTestId("open-llama")).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("detail-llama")).toBeVisible();
	await page.getByTestId("inspector-close").click();
	await expect(page.getByTestId("inspector")).toHaveCount(0);
	await expect(page.getByTestId("open-llama")).toBeFocused();
});

test("the pane follows the run while open, and a pick during the run pins it", async ({ page }) => {
	await load(page, "fixture&speed=1");
	await page.getByTestId("open-bat").count();
	await page.getByTestId("open-llama").click();
	await page.getByTestId("install").click();
	await expect(page.getByTestId("detail-zen")).toBeVisible();
	await expect(page.getByTestId("detail-fd")).toBeVisible({ timeout: 8000 });
	await page.getByTestId("open-strata").click();
	await expect(sentence(page)).toHaveText(/wrangler/, { timeout: 8000 });
	await expect(page.getByTestId("detail-strata")).toBeVisible();
	await expect(sentence(page)).toHaveText("3 updated, 1 failed", { timeout: 20_000 });
	await expect(page.getByTestId("detail-wrangler")).toBeVisible();
});

test("at 760 by 520 the pane is a sheet with a close button and nothing in it is clipped", async ({ page }) => {
	await page.setViewportSize({ width: 760, height: 520 });
	await load(page);
	await page.getByTestId("open-fd").click();
	const pane = page.getByTestId("inspector");
	await expect(pane).toBeVisible();
	await page.waitForTimeout(300);
	const box = await pane.boundingBox();
	expect(box?.x).toBe(0);
	expect(box?.width).toBe(760);
	await expect(page.getByTestId("inspector-close")).toBeVisible();
	await expect(page.getByTestId("inspector-close")).toHaveText("Back to list");
	for (const button of await pane.locator("button, label").all()) {
		await button.scrollIntoViewIfNeeded();
		const b = await button.boundingBox();
		const p = await pane.boundingBox();
		if (!b || !p) throw new Error("no box");
		expect(b.x).toBeGreaterThanOrEqual(p.x);
		expect(b.x + b.width).toBeLessThanOrEqual(p.x + p.width + 0.5);
		expect(b.y).toBeGreaterThanOrEqual(p.y - 0.5);
		expect(b.y + b.height).toBeLessThanOrEqual(p.y + p.height + 0.5);
		expect(await button.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
	}
});

test("closing the pane never squeezes the list: it keeps its height while the pane flies out, then widens once", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 900 });
	await load(page);
	await page.locator("[data-row]").first().click();
	await expect(page.getByTestId("inspector")).toBeVisible();
	const list = () =>
		page.evaluate(() => {
			const b = document.querySelector(".listbox")?.getBoundingClientRect();
			return { width: Math.round(b?.width ?? 0), height: Math.round(b?.height ?? 0) };
		});
	const open = await list();
	expect(open.height).toBeGreaterThan(300);
	await page.keyboard.press("Escape");
	const heights: number[] = [];
	for (let i = 0; i < 10; i++) {
		heights.push((await list()).height);
		await page.waitForTimeout(25);
	}
	expect(heights.every((h) => h === open.height)).toBe(true);
	await expect(page.getByTestId("inspector")).toHaveCount(0);
	expect((await list()).width).toBeGreaterThan(open.width);
});
