import { expect, load, sentence, test } from "./helpers";

test("a partial run splits the groups: the run counts only its apps", async ({ page }) => {
	await load(page, "fixture&speed=2");
	await page.getByTestId("select-none").click();
	await page.getByTestId("tick-fd").click();
	await page.getByTestId("install").click();
	await expect(page.getByTestId("group-run")).toHaveText("Installing");
	await expect(page.getByTestId("count-run")).toHaveText("1");
	await expect(page.getByTestId("group-ready")).toHaveText("Ready to install");
	await expect(page.getByTestId("count-ready")).toHaveText("3");
	await expect(sentence(page)).toHaveText("1 updated", { timeout: 15_000 });
	await expect(page.getByTestId("group-run")).toHaveText("This run");
	await expect(page.getByTestId("count-run")).toHaveText("1");
});

test("a re-check keeps versions, groups and the owner's ticks", async ({ page }) => {
	await load(page, "fixture&speed=0.4");
	await page.getByTestId("tick-fd").click();
	await page.getByTestId("check").click();
	await expect(sentence(page)).toHaveText(/^Checking/);
	await expect(page.getByTestId("status-fd")).toHaveText("Checking");
	await expect(page.getByTestId("row-fd").locator(".installed")).toHaveText("10.5.1");
	await expect(page.getByTestId("row-fd").locator(".skeleton")).toHaveCount(0);
	await expect(page.getByTestId("group-ready")).toBeVisible();
	await expect(sentence(page)).toHaveText("4 updates ready", { timeout: 15_000 });
	await expect(page.getByTestId("tick-fd")).not.toBeChecked();
	await expect(page.getByTestId("tick-zen")).toBeChecked();
	await expect(page.getByTestId("install")).toHaveText("Install 3 updates");
});

test("the filter narrows, keeps hidden ticks counted, says when nothing matches, and Escape clears it", async ({
	page,
}) => {
	await load(page);
	await page.keyboard.press("/");
	await expect(page.getByTestId("filter")).toBeFocused();
	await expect(page.getByTestId("filter")).toHaveAttribute("placeholder", "Filter apps");
	await page.keyboard.type("zen");
	await expect(page.locator('[data-testid^="row-"]')).toHaveCount(1);
	await expect(page.getByTestId("install")).toHaveText("Install 4 updates");
	await expect(page.getByTestId("selection")).toHaveText("4 selected · at least 110 MB · 3 hidden");
	await page.getByTestId("filter").fill("sharkdp");
	await expect(page.getByTestId("row-fd")).toBeVisible();
	await expect(page.getByTestId("row-bat")).toBeVisible();
	await page.getByTestId("filter").fill("nothing-like-this");
	await expect(page.getByTestId("no-match")).toHaveText('No app matches "nothing-like-this".');
	await page.getByTestId("filter").press("Escape");
	await expect(page.getByTestId("filter")).toHaveValue("");
	await expect(page.getByTestId("row-fd")).toBeVisible();
	await page.keyboard.press("Control+f");
	await expect(page.getByTestId("filter")).toBeFocused();
});

test("the disabled Install says why", async ({ page }) => {
	await load(page);
	await page.getByTestId("select-none").click();
	await expect(page.getByTestId("install")).toHaveText("Install updates");
	await expect(page.getByTestId("install")).toHaveAttribute("title", "Tick an update to install.");
	await expect(page.getByTestId("install-why")).toHaveText("Tick an update to install.");
});

test("failure red is not the rust of Needs a look", async ({ page }) => {
	await load(page, "fixture&speed=4");
	await page.getByTestId("install").click();
	await expect(sentence(page)).toHaveText("3 updated, 1 failed", { timeout: 20_000 });
	const failed = await page.getByTestId("status-wrangler").evaluate((el) => getComputedStyle(el).color);
	const rust = await page.getByTestId("status-lrcget").evaluate((el) => getComputedStyle(el).color);
	expect(failed).not.toBe(rust);
});

test("the Log toggle reads Show log and Hide log, and the drawer spans the window", async ({ page }) => {
	await load(page);
	await page.getByTestId("log-toggle").click();
	await expect(page.getByTestId("log-toggle")).toHaveText("Hide log");
	const box = await page.getByTestId("log-drawer").boundingBox();
	expect(box?.x).toBe(0);
	expect(box?.width).toBe(980);
	await page.getByTestId("log-toggle").click();
	await expect(page.getByTestId("log-toggle")).toHaveText("Show log");
});

test("no hand-written three-dot ellipsis anywhere in the window", async ({ page }) => {
	await load(page, "fixture&speed=4");
	await page.getByTestId("open-lrcget").click();
	expect(await page.evaluate(() => document.body.innerText.includes("..."))).toBe(false);
	await page.getByTestId("install").click();
	await expect(sentence(page)).toHaveText("3 updated, 1 failed", { timeout: 20_000 });
	expect(await page.evaluate(() => document.body.innerText.includes("..."))).toBe(false);
});
