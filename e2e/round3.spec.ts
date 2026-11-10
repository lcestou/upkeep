import type { Page } from "playwright/test";
import { expect, load, sentence, test } from "./helpers";

const centreY = (page: Page) =>
	sentence(page).evaluate((el) => {
		const r = el.getBoundingClientRect();
		return r.top + r.height / 2;
	});

// 1. The title never hops between states.
for (const width of [980, 1400]) {
	test(`the state sentence sits on the tabs' centre in every state at ${width}`, async ({ page }) => {
		await page.setViewportSize({ width, height: 720 });
		await load(page, "fixture&speed=0.5");
		const tab = await page.getByTestId("tab-updates").boundingBox();
		const tabs = (tab?.y ?? 0) + (tab?.height ?? 0) / 2;
		const ys: Record<string, number> = { idle: await centreY(page) };
		await page.getByTestId("check").click();
		await expect(sentence(page)).toHaveText(/^Checking/);
		ys.checking = await centreY(page);
		await expect(sentence(page)).toHaveText("4 updates ready", { timeout: 20_000 });
		await page.getByTestId("install").click();
		await expect(sentence(page)).toHaveText(/^Installing/);
		ys.running = await centreY(page);
		await expect(sentence(page)).toHaveText("3 updated, 1 failed", { timeout: 40_000 });
		ys.summary = await centreY(page);
		for (const [state, y] of Object.entries(ys)) expect(Math.abs(y - tabs), state).toBeLessThanOrEqual(1);
	});
}

// 2. At 760 the check time stays whole beside the title, the by-hand count leaves, and title carries the text.
test("at 760 the subline keeps the check time whole on the title's line", async ({ page }) => {
	await page.setViewportSize({ width: 760, height: 520 });
	await load(page);
	const sub = page.getByTestId("subline");
	await expect(sub).toHaveAttribute("title", "Checked 2 minutes ago · 3 more by hand");
	await expect(page.getByTestId("by-hand-line")).toBeHidden();
	const box = await page.getByTestId("checked").evaluate((el) => {
		const r = el.getBoundingClientRect();
		const more = el.parentElement?.getBoundingClientRect();
		return { inside: !!more && r.top >= more.top - 0.5 && r.bottom <= more.bottom + 0.5 && r.right <= more.right + 0.5, w: el.scrollWidth - el.clientWidth };
	});
	expect(box.inside, "the check time is on the visible line").toBe(true);
	expect(box.w, "the check time is not cut").toBeLessThanOrEqual(0);
	const head = await sentence(page).boundingBox();
	const checked = await page.getByTestId("checked").boundingBox();
	expect(Math.abs((checked?.y ?? 0) + (checked?.height ?? 0) - ((head?.y ?? 0) + (head?.height ?? 0)))).toBeLessThanOrEqual(4);
});

// 3. During a run at 760 only the name gives way.
test("at 760 a run's sentence keeps its verb and count, and title is the whole sentence", async ({ page }) => {
	await page.setViewportSize({ width: 760, height: 520 });
	await load(page, "fixture&speed=0.3");
	await page.getByTestId("install").click();
	await expect(sentence(page)).toHaveText(/^Installing .+, 1 of 4$/);
	await expect(sentence(page)).toHaveAttribute("title", (await sentence(page).textContent()) ?? "");
	const cut = await sentence(page).evaluate((h1) =>
		[...h1.querySelectorAll(".fixed")].map((el) => ({ text: el.textContent, clipped: el.scrollWidth > el.clientWidth + 0.5 })),
	);
	expect(cut.map((c) => c.text)).toEqual(["Installing ", ", 1 of 4"]);
	for (const c of cut) expect(c.clipped, c.text ?? "").toBe(false);
	const lead = await page.locator("header .inner > .lead").boundingBox();
	const post = await sentence(page).locator(".fixed").last().boundingBox();
	expect((post?.x ?? 0) + (post?.width ?? 0)).toBeLessThanOrEqual((lead?.x ?? 0) + (lead?.width ?? 0) + 0.5);
});

// 4. Double-clicks select nothing in the title bar or the column header.
test("double-clicking the title bar's text or a column header selects nothing", async ({ page }) => {
	await load(page);
	for (const target of [sentence(page), page.getByTestId("checked"), page.locator(".h-kind"), page.locator(".h-status")]) {
		await target.dblclick();
		expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
	}
});

// 5. The close button's hover keeps its cross readable.
test("the close button's hover cross measures 4.5:1 or better", async ({ page }) => {
	await load(page);
	await page.getByTestId("win-close").hover();
	await page.waitForTimeout(250);
	const ratio = await page.getByTestId("win-close").evaluate((el) => {
		const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
		if (!ctx) return 0;
		const rgb = (css: string) => {
			ctx.clearRect(0, 0, 1, 1);
			ctx.fillStyle = css;
			ctx.fillRect(0, 0, 1, 1);
			return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
		};
		const lum = (c: number[]) =>
			c.map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
		const s = getComputedStyle(el);
		const [a, b] = [lum(rgb(s.color)), lum(rgb(s.backgroundColor))].toSorted((x, y) => y - x);
		return (a + 0.05) / (b + 0.05);
	});
	expect(ratio).toBeGreaterThanOrEqual(4.5);
});

// 6. Each Settings segment is one radio group: one tab stop, the arrows move and select, Home and End.
test("the Settings segments are radio groups with one tab stop and arrow keys", async ({ page }) => {
	await load(page);
	await page.getByTestId("tab-settings").click();
	const frame = page.getByTestId("setting-frame");
	await expect(frame.locator('[tabindex="0"]')).toHaveCount(1);
	await expect(page.getByTestId("setting-buttons").locator('[tabindex="0"]')).toHaveCount(1);
	await expect(page.getByTestId("setting-corners").locator('[tabindex="0"]')).toHaveCount(1);
	const buttons = page.getByTestId("setting-buttons");
	await page.getByTestId("setting-buttons-auto").focus();
	await page.keyboard.press("ArrowRight");
	await expect(page.getByTestId("setting-buttons-left")).toBeFocused();
	await expect(page.getByTestId("setting-buttons-left")).toHaveAttribute("aria-checked", "true");
	await expect(buttons.locator('[tabindex="0"]')).toHaveAttribute("data-testid", "setting-buttons-left");
	await page.keyboard.press("End");
	await expect(page.getByTestId("setting-buttons-right")).toHaveAttribute("aria-checked", "true");
	await page.keyboard.press("ArrowDown");
	await expect(page.getByTestId("setting-buttons-auto")).toHaveAttribute("aria-checked", "true");
	await page.keyboard.press("ArrowUp");
	await expect(page.getByTestId("setting-buttons-right")).toBeFocused();
	await page.keyboard.press("Home");
	await expect(page.getByTestId("setting-buttons-auto")).toHaveAttribute("aria-checked", "true");
	// Tab leaves the group in one step, onto the next group's checked option.
	await page.keyboard.press("Tab");
	await expect(page.getByTestId("setting-corners-rounded")).toBeFocused();
});

// 7. The Add error is announced and tied to the field.
test("the Add pane's error is an alert and describes the field while it shows", async ({ page }) => {
	await load(page, "fixture&fail=suggest");
	await page.getByTestId("add-app").click();
	const input = page.getByTestId("add-input");
	await expect(input).not.toHaveAttribute("aria-invalid", "true");
	await input.fill("sharkdp/bat");
	await input.press("Enter");
	const error = page.getByTestId("add-error");
	await expect(error).toHaveAttribute("role", "alert");
	await expect(input).toHaveAttribute("aria-invalid", "true");
	const ids = ((await input.getAttribute("aria-describedby")) ?? "").split(" ");
	expect(ids).toContain(await error.getAttribute("id"));
	expect(ids).toContain("add-hint");
});

// 8. Focus lands on a row after Add and after Remove, never on the page.
test("after Add focus is on the new row; after Remove on the next row, or the one before for the last", async ({ page }) => {
	await page.setViewportSize({ width: 1200, height: 800 });
	await load(page, "fixture&speed=4");
	await page.getByTestId("add-app").click();
	await page.getByTestId("add-input").fill("BurntSushi/ripgrep");
	await page.keyboard.press("Enter");
	await page.getByTestId("suggestion-ripgrep").getByTestId("sug-add").click();
	await expect(page.getByTestId("open-ripgrep")).toBeFocused();

	const order = () => page.locator("[data-row]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.row));
	const before = await order();
	const victim = before[1] ?? "";
	await page.getByTestId(`open-${victim}`).click();
	await page.getByTestId("remove-app").click();
	await page.getByTestId("remove-confirm").click();
	await expect(page.getByTestId(`open-${before[2]}`)).toBeFocused();

	const ready = await order();
	const last = ready.at(-1) ?? "";
	await page.getByTestId("group-fresh-toggle").click();
	const all = await order();
	const lastAll = all.at(-1) ?? last;
	await page.getByTestId(`open-${lastAll}`).click();
	await page.getByTestId("remove-app").click();
	await page.getByTestId("remove-confirm").click();
	await expect(page.getByTestId(`open-${all.at(-2)}`)).toBeFocused();
});

// 9. PageDown and PageUp move row focus by a page of rows.
test("PageDown and PageUp move row focus by the rows that fit in the list", async ({ page }) => {
	await page.setViewportSize({ width: 980, height: 720 });
	await load(page, "fixture=many", { wait: "sentence" });
	await page.getByTestId("group-fresh-toggle").click();
	const rows = await page.locator("[data-row]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.row));
	const fit = await page
		.getByTestId("app-list")
		.evaluate((el) => Math.max(1, Math.floor((el.clientHeight - 34) / 44)));
	await page.getByTestId(`open-${rows[0]}`).focus();
	await page.keyboard.press("PageDown");
	await expect(page.getByTestId(`open-${rows[fit]}`)).toBeFocused();
	await page.keyboard.press("PageDown");
	await expect(page.getByTestId(`open-${rows[2 * fit]}`)).toBeFocused();
	await page.keyboard.press("PageUp");
	await expect(page.getByTestId(`open-${rows[fit]}`)).toBeFocused();
	await expect(page.getByTestId(`open-${rows[fit]}`)).toBeInViewport({ ratio: 1 });
});
