import { expect, load, sentence, test } from "./helpers";

test("a Ready row ticked during a run joins it before the old script's apps, and the run's group lists the run's order", async ({
	page,
}) => {
	await load(page, "fixture&speed=1");
	await page.getByTestId("tick-zen").click();
	await page.getByTestId("install").click();
	await expect(page.getByTestId("place-cursor")).toHaveText("3");
	// Zen sits first in the list; ticked now, it runs after the apps waiting and before the old script's.
	await page.getByTestId("tick-zen").click();
	await expect(page.getByTestId("place-zen")).toHaveText("3");
	await expect(page.getByTestId("place-cursor")).toHaveText("4");
	const rows = await page.locator("[data-row]").evaluateAll((els) => els.map((e) => e.getAttribute("data-row")));
	expect(rows.filter((k) => ["zen", "fd", "wrangler", "cursor"].includes(k ?? ""))).toEqual([
		"fd",
		"wrangler",
		"zen",
		"cursor",
	]);
	await expect(sentence(page)).toHaveText("3 updated, 1 failed", { timeout: 30_000 });
});

test("once Stop after current is pending a Ready row cannot join the run", async ({ page }) => {
	await load(page, "fixture&speed=1");
	await page.getByTestId("tick-zen").click();
	await page.getByTestId("install").click();
	await expect(page.getByTestId("tick-zen")).toBeEnabled();
	await page.getByTestId("stop").click();
	await expect(page.getByTestId("tick-zen")).toBeDisabled();
});

test("the pane's log is a box of its own that stays on its newest line", async ({ page }) => {
	await load(page, "fixture&speed=4");
	await page.getByTestId("open-fd").click();
	await page.getByTestId("install").click();
	await expect(sentence(page)).toHaveText("3 updated, 1 failed", { timeout: 20_000 });
	const log = page.getByTestId("pane-log");
	await expect(log).toHaveCSS("overflow-y", "auto");
	expect(await log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(24);
});
