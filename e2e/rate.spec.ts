import { expect, load, test } from "./helpers";

test("a used-up GitHub budget shows a bar with when checks resume and how gh raises it, until dismissed", async ({
	page,
}) => {
	await load(page, "fixture&rate=out");
	await expect(page.getByTestId("rate-out")).toHaveText(
		/^GitHub's hourly limit for this network is used up\. Checks resume at \d\d:\d\d\.$/,
	);
	await expect(page.getByTestId("rate-signin")).toHaveText(
		"Run gh auth login in a terminal to raise it to 5,000 an hour.",
	);
	// The list stays below the bar, not under it.
	const bar = await page.getByTestId("rate-bar").boundingBox();
	const list = await page.getByTestId("app-list").boundingBox();
	expect(bar && list && list.y >= bar.y + bar.height).toBe(true);
	await page.getByTestId("rate-dismiss").click();
	await expect(page.getByTestId("rate-bar")).toHaveCount(0);
});

test("signed in to GitHub, the bar only says when checks resume; with budget left there is no bar", async ({
	page,
}) => {
	await load(page, "fixture&rate=signed");
	await expect(page.getByTestId("rate-out")).toBeVisible();
	await expect(page.getByTestId("rate-signin")).toHaveCount(0);
	await load(page);
	await expect(page.getByTestId("rate-bar")).toHaveCount(0);
});
