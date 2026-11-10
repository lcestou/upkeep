import { test as base, expect, type Page } from "playwright/test";

/** Every spec fails on a console error, an uncaught exception or a failed request. */
export const test = base.extend<{ errors: string[] }>({
	errors: [
		async ({ page }, use) => {
			const errors: string[] = [];
			page.on("console", (m) => {
				if (m.type() === "error") errors.push(`console: ${m.text()}`);
			});
			page.on("pageerror", (e) => errors.push(`page: ${e.message}`));
			page.on("requestfailed", (r) => errors.push(`request: ${r.url()}`));
			await use(errors);
			expect(errors).toEqual([]);
		},
		{ auto: true },
	],
});

export { expect };

export async function load(page: Page, query = "fixture", opts: { wait?: "install" | "sentence" } = {}) {
	await page.goto(`/?${query}`);
	await page.getByTestId(opts.wait === "sentence" ? "state-sentence" : "install").waitFor();
	await page.evaluate(() => document.fonts.ready);
}

export const sentence = (page: Page) => page.getByTestId("state-sentence");

/** Records every status and stem caption text the rows show, so a spec can assert the states a run walked. */
export async function recordStatuses(page: Page) {
	await page.evaluate(() => {
		const seen = new Set<string>();
		(window as unknown as { __seen: Set<string> }).__seen = seen;
		const grab = () => {
			for (const el of document.querySelectorAll('[data-testid^="status-"], [data-testid^="stem-"] .caption'))
				seen.add(el.textContent?.trim() ?? "");
		};
		new MutationObserver(grab).observe(document.body, { subtree: true, childList: true, characterData: true });
	});
	return () => page.evaluate(() => [...(window as unknown as { __seen: Set<string> }).__seen]);
}

/** The element that has focus is never the page itself after an action. */
export async function expectFocusKept(page: Page) {
	await page.waitForTimeout(350);
	const tag = await page.evaluate(() => document.activeElement?.tagName ?? "NONE");
	expect(tag, "focus fell to the page").not.toBe("BODY");
}
