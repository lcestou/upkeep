import type { Page } from "playwright/test";
import { expect, load, test } from "./helpers";

async function audit(page: Page) {
	return page.evaluate(() => {
		const problems: string[] = [];
		const nameOf = (el: Element): string => {
			const label = el.getAttribute("aria-label");
			if (label) return label;
			const by = el.getAttribute("aria-labelledby");
			if (by) return by.split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
			if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
				const l = el.closest("label") ?? (el.id ? document.querySelector(`label[for="${el.id}"]`) : null);
				if (l) return l.textContent?.trim() ?? "";
			}
			return el.textContent?.trim() ?? "";
		};
		for (const el of document.querySelectorAll("button, input, select, a[href], [role=tab], [tabindex]:not([tabindex='-1'])")) {
			if (!nameOf(el)) problems.push(`no name: ${el.outerHTML.slice(0, 90)}`);
			const t = Number(el.getAttribute("tabindex") ?? "0");
			if (t > 0) problems.push(`positive tabindex: ${el.outerHTML.slice(0, 90)}`);
		}
		for (const svg of document.querySelectorAll("svg")) {
			const hidden = svg.closest("[aria-hidden='true']") !== null;
			const labelled = svg.getAttribute("role") === "img" && svg.getAttribute("aria-label");
			if (!hidden && !labelled) problems.push(`svg not hidden: ${svg.outerHTML.slice(0, 90)}`);
		}
		const ids = new Map<string, number>();
		for (const el of document.querySelectorAll("[id]")) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
		for (const [id, n] of ids) if (n > 1) problems.push(`duplicate id ${id}`);
		return problems;
	});
}

test("names, hidden glyphs and no positive tabindex in every main state", async ({ page }) => {
	await load(page, "fixture&speed=4");
	expect(await audit(page)).toEqual([]);
	await page.getByTestId("open-fd").click();
	expect(await audit(page)).toEqual([]);
	await page.getByTestId("log-toggle").click();
	expect(await audit(page)).toEqual([]);
	await page.keyboard.press("Escape");
	await page.getByTestId("install").click();
	await page.getByTestId("row-zen").getByTestId("stem-zen").waitFor();
	expect(await audit(page)).toEqual([]);
	await page.getByTestId("tab-history").click();
	expect(await audit(page)).toEqual([]);
	await page.getByTestId("tab-settings").click();
	expect(await audit(page)).toEqual([]);
});

test("tab order follows reading order across the header, list and footer", async ({ page }) => {
	await load(page);
	const tops: { id: string; y: number; region: number }[] = [];
	for (let i = 0; i < 12; i++) {
		await page.keyboard.press("Tab");
		const info = await page.evaluate(() => {
			const el = document.activeElement;
			if (!el || el === document.body) return null;
			const r = el.getBoundingClientRect();
			const region = el.closest("header") ? 0 : el.closest("footer") ? 2 : 1;
			return { id: el.getAttribute("data-testid") ?? el.tagName, y: r.top + r.height / 2, region };
		});
		expect(info, "focus fell to the page").not.toBeNull();
		if (info) tops.push(info);
	}
	for (let i = 1; i < tops.length; i++) {
		const a = tops[i - 1];
		const b = tops[i];
		if (!a || !b) continue;
		expect(b.region, `${a.id} then ${b.id}`).toBeGreaterThanOrEqual(a.region);
		if (a.region === b.region && a.region === 1) expect(b.y, `${a.id} then ${b.id}`).toBeGreaterThanOrEqual(a.y - 1);
	}
});
