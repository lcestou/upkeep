import type { Page } from "playwright/test";
import { expect, load, sentence, test } from "./helpers";

// Every cell sits on its column's head, and every row agrees with the first, in every state.
async function misaligned(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const out: string[] = [];
		const list = document.querySelector('[data-testid="app-list"]');
		if (!list) return ["no list"];
		const left = (el: Element | null) => {
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return r.width > 0 ? r.left : null;
		};
		const rows = [...list.querySelectorAll<HTMLElement>(".row")];
		const first = rows[0];
		for (const col of ["mark", "name", "kind", "ver", "size", "restore", "status"]) {
			const head = left(list.querySelector(`.h-${col}`));
			const base = first ? left(first.querySelector(`.cell.${col}`)) : null;
			for (const row of rows) {
				const cell = row.querySelector(`.cell.${col}`);
				const x = left(cell);
				if (x === null || !cell) continue;
				// A cell pushed to a second grid row draws below its own row.
				const c = cell.getBoundingClientRect();
				const r = row.getBoundingClientRect();
				if (c.top < r.top - 0.5 || c.bottom > r.bottom + 0.5)
					out.push(`${row.dataset.testid} ${col}: outside its row (${c.top.toFixed(1)} to ${c.bottom.toFixed(1)})`);
				// A cell that spans wider on purpose (a reason lending the Kind column) still starts on its own line.
				const ref = head ?? base;
				if (ref !== null && Math.abs(x - ref) > 1)
					out.push(`${row.dataset.testid} ${col}: ${x.toFixed(1)} against ${ref.toFixed(1)}`);
			}
		}
		return out;
	});
}

test("cells stay on their columns through pane opens and closes, a run, the summary and a filter", async ({ page }) => {
	await load(page, "fixture&speed=2");
	expect(await misaligned(page)).toEqual([]);
	for (let round = 0; round < 2; round++) {
		await page.getByTestId("open-zen").click();
		await expect(page.getByTestId("detail-zen")).toBeVisible();
		expect(await misaligned(page)).toEqual([]);
		await page.getByTestId("open-wrangler").click();
		await expect(page.getByTestId("detail-wrangler")).toBeVisible();
		expect(await misaligned(page)).toEqual([]);
		await page.getByTestId("inspector-close").click();
		await expect(page.getByTestId("inspector")).toHaveCount(0);
		expect(await misaligned(page)).toEqual([]);
	}
	await page.getByTestId("open-cursor").click();
	await page.getByTestId("install").click();
	await expect(page.getByTestId("row-fd").getByTestId("stem-fd")).toBeVisible();
	expect(await misaligned(page)).toEqual([]);
	await expect(sentence(page)).toHaveText("3 updated, 1 failed", { timeout: 20_000 });
	expect(await misaligned(page)).toEqual([]);
	await page.getByTestId("inspector-close").click();
	expect(await misaligned(page)).toEqual([]);
	await page.getByTestId("done").click();
	await page.getByTestId("filter").fill("a");
	await expect(page.locator(".row").first()).toBeVisible();
	expect(await misaligned(page)).toEqual([]);
});
