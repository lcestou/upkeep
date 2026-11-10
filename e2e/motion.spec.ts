import { expect, load, sentence, test } from "./helpers";

test("with reduced motion every state is still reached", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await load(page, "fixture&speed=4");
	const sweep = await page.evaluate(() => {
		const el = document.createElement("div");
		el.className = "btn";
		document.body.append(el);
		const d = getComputedStyle(el).transitionDuration;
		el.remove();
		return d;
	});
	expect(Number.parseFloat(sweep)).toBeLessThan(0.01);
	await page.getByTestId("open-fd").click();
	await expect(page.getByTestId("detail-fd")).toBeVisible();
	await page.getByTestId("install").click();
	await expect(sentence(page)).toHaveText("3 updated, 1 failed", { timeout: 20_000 });
	await page.getByTestId("retry").click();
	await expect(sentence(page)).toHaveText("4 updated", { timeout: 10_000 });
	await page.getByTestId("done").click();
	await expect(sentence(page)).toHaveText("1 needs a look");
});
