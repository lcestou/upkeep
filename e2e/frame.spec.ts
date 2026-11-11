import type { Page } from "playwright/test";
import { expect, load, test } from "./helpers";

const ops = (page: Page) => page.evaluate(() => (globalThis as { upkeepOps?: string[] }).upkeepOps ?? []);

test("window buttons sit on the left in the desktop's order, and each sends its op", async ({ page }) => {
	await load(page);
	const ids = await page
		.locator('[data-testid^="win-"]')
		.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
	expect(ids).toEqual(["win-close", "win-maximize", "win-minimize"]);
	const close = await page.getByTestId("win-close").boundingBox();
	const mark = await page.locator("header .brand").boundingBox();
	expect(close?.x).toBe(12);
	// The mark keeps at least 20 px of clear space from the last button, with a divider between.
	const last = await page.getByTestId("win-minimize").boundingBox();
	expect((mark?.x ?? 0) - ((last?.x ?? 0) + (last?.width ?? 0))).toBeGreaterThanOrEqual(20);
	await expect(page.locator("header .divider")).toHaveCount(1);
	await expect(page.getByTestId("win-close")).toHaveAttribute("aria-label", "Close");
	await expect(page.getByTestId("win-minimize")).toHaveAttribute("aria-label", "Minimize");
	await expect(page.getByTestId("win-maximize")).toHaveAttribute("aria-label", "Maximize");
	await page.getByTestId("win-maximize").click();
	await expect(page.getByTestId("win-maximize")).toHaveAttribute("aria-label", "Restore");
	await page.getByTestId("win-minimize").click();
	await page.getByTestId("win-close").click();
	await expect.poll(() => ops(page)).toEqual(["maximize", "minimize", "close"]);
	await page.getByTestId("open-fd").focus();
	await page.keyboard.press("Control+w");
	await expect.poll(async () => (await ops(page)).length).toBe(4);
	expect((await ops(page)).at(-1)).toBe("close");
});

test("buttons on the right are mirrored and come last", async ({ page }) => {
	await load(page, "fixture&buttons=right");
	const ids = await page
		.locator('[data-testid^="win-"]')
		.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
	expect(ids).toEqual(["win-minimize", "win-maximize", "win-close"]);
	const close = await page.getByTestId("win-close").boundingBox();
	expect((close?.x ?? 0) + (close?.width ?? 0)).toBe(980 - 12);
	await expect(page.locator("header .divider")).toHaveCount(0);
});

test("the strip is a drag region, every control in it is not, and a double-click maximises only off the controls", async ({
	page,
}) => {
	await load(page);
	const header = page.getByTestId("header");
	await expect(header).toHaveClass(/electrobun-webkit-app-region-drag/);
	const missing = await header.evaluate((h) =>
		[...h.querySelectorAll("button, input, select, a, [role=tab]")]
			.filter((el) => !el.classList.contains("electrobun-webkit-app-region-no-drag"))
			.map((el) => el.outerHTML.slice(0, 60)),
	);
	expect(missing).toEqual([]);
	// WebKit reports the prefixed property only.
	expect(
		await header.evaluate((h) => {
			const st = getComputedStyle(h) as CSSStyleDeclaration & { webkitUserSelect?: string };
			return st.userSelect || st.webkitUserSelect;
		}),
	).toBe("none");
	await page.getByTestId("tab-history").dblclick();
	await page.waitForTimeout(200);
	expect(await ops(page)).toEqual([]);
	const box = await header.boundingBox();
	await page.mouse.dblclick((box?.x ?? 0) + 640, (box?.y ?? 0) + 10);
	await expect.poll(() => ops(page)).toEqual(["maximize"]);
});

test("with the desktop's frame there are no window buttons, no drag class and no edge", async ({ page }) => {
	await load(page, "fixture&frame=system");
	await expect(page.locator('[data-testid^="win-"]')).toHaveCount(0);
	await expect(page.getByTestId("header")).not.toHaveClass(/electrobun-webkit-app-region-drag/);
	await expect(page.locator(".shell.edged")).toHaveCount(0);
	await expect(page.locator("header .brand")).toHaveCount(1);
});

test("rounded corners clip the shell and clear the page; square and maximised do not", async ({ page }) => {
	await load(page);
	const shell = page.locator(".shell");
	await expect(shell).toHaveCSS("border-radius", "8px");
	expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
	await page.getByTestId("win-maximize").click();
	await expect(shell).toHaveCSS("border-radius", "0px");
	expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
	await load(page, "fixture&corners=square");
	await expect(page.locator(".shell")).toHaveCSS("border-radius", "0px");
});

test("Settings: Window frame, buttons and corners send setSettings; buttons and corners only for the built-in frame", async ({
	page,
}) => {
	await load(page);
	await page.getByTestId("tab-settings").click();
	await expect(page.getByTestId("setting-frame")).toContainText("Built in");
	await expect(page.getByTestId("setting-frame-own")).toHaveAttribute("aria-checked", "true");
	await expect(
		page.getByText("Built in puts the title bar inside Upkeep's own header. System uses the desktop's."),
	).toBeVisible();
	await page.getByTestId("setting-buttons-right").click();
	await expect(page.getByTestId("setting-buttons-right")).toHaveAttribute("aria-checked", "true");
	await expect(page.locator('[data-testid^="win-"]').last()).toHaveAttribute("data-testid", "win-close");
	await expect(page.getByText("A rounded window has no shadow from the desktop.")).toBeVisible();
	await page.getByTestId("setting-corners-square").click();
	await expect(page.locator(".shell")).toHaveCSS("border-radius", "0px");
	await page.getByTestId("setting-frame-system").click();
	await expect(page.getByTestId("setting-buttons")).toHaveCount(0);
	await expect(page.getByTestId("setting-corners")).toHaveCount(0);
	await expect(page.locator('[data-testid^="win-"]')).toHaveCount(0);
});

test("About shows the mark, the word and the version", async ({ page }) => {
	await load(page);
	await page.getByTestId("tab-settings").click();
	const about = page.getByTestId("about");
	await expect(about.getByRole("img", { name: "UPKEEP" })).toBeVisible();
	const tall = (await about.locator(".lockup > svg").boundingBox())?.height ?? 0;
	expect(tall).toBe(40);
	await expect(about).toContainText("Version 0.1.0");
	await expect(about).toContainText("Keeps the apps your package manager misses up to date.");
});

test("the identity: the mark in the title bar, the sprout on ready rows drawn crisp at 16 px", async ({ page }) => {
	await load(page);
	const mark = page.locator("header .brand svg.mark");
	await expect(mark).toHaveAttribute("viewBox", "0 0 256 256");
	await expect(mark.locator("g")).toHaveAttribute("transform", "translate(35.38 41.92) scale(0.7526)");
	const sprout = page.getByTestId("row-fd").locator(".mark svg path.lo");
	await expect(sprout).toHaveAttribute("shape-rendering", "crispEdges");
	expect((await page.getByTestId("row-fd").locator(".mark > svg").boundingBox())?.width).toBe(16);
});

test.describe("at 760 by 520", () => {
	test.use({ viewport: { width: 760, height: 520 } });
	test("the title bar fits: nothing runs past the window", async ({ page }) => {
		await load(page);
		expect(await page.evaluate(() => document.querySelector("header")?.scrollWidth)).toBe(760);
		const check = await page.getByTestId("check").boundingBox();
		expect((check?.x ?? 0) + (check?.width ?? 0)).toBeLessThanOrEqual(760);
	});
});
