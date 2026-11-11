import type { Page } from "playwright/test";
import { expect, load, sentence, test } from "./helpers";

test.use({ viewport: { width: 760, height: 520 } });

async function noClipping(page: Page) {
	const bad = await page.evaluate(() => {
		const out: string[] = [];
		if (document.documentElement.scrollWidth > innerWidth) out.push("horizontal scroll");
		// Row buttons are composite; the drive measures their cells one by one.
		for (const b of document.querySelectorAll("button:not([data-row])")) {
			const r = b.getBoundingClientRect();
			if (r.width === 0) continue;
			if (b.scrollWidth > b.clientWidth + 1) out.push(`clipped: ${b.textContent?.trim()}`);
		}
		return out;
	});
	expect(bad).toEqual([]);
}

test("760 by 520 has no horizontal scroll and no clipped button label in any state", async ({ page }) => {
	await load(page, "fixture&speed=4");
	await noClipping(page);
	await page.getByTestId("open-fd").click();
	await noClipping(page);
	await page.getByTestId("inspector-close").click();
	await page.getByTestId("install").click();
	await page.getByTestId("row-zen").getByTestId("stem-zen").waitFor();
	await noClipping(page);
	await expect(sentence(page)).toHaveText("3 updated, 1 failed", { timeout: 20_000 });
	await noClipping(page);
	await page.getByTestId("tab-history").click();
	await noClipping(page);
	await page.getByTestId("tab-settings").click();
	await noClipping(page);
});
