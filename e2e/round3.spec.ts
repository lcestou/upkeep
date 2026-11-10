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

// 10. Problem rows use the same cells as every row.
test("problem rows show their kind and keep the version column", async ({ page }) => {
	await load(page, "fixture=problems", { wait: "sentence" });
	const borg = page.getByTestId("row-borg");
	await expect(borg.locator(".cell.kind")).toBeVisible();
	await expect(borg.locator(".cell.kind")).toHaveText("Binary");
	const ver = async (key: string) => page.getByTestId(`row-${key}`).locator(".cell.ver").boundingBox();
	const [b, z] = [await ver("borg"), await ver("zen")];
	expect(b?.x).toBe(z?.x);
	expect(b?.width).toBe(z?.width);
	const name = await borg.locator(".cell.name").boundingBox();
	const kind = await borg.locator(".cell.kind").boundingBox();
	expect((name?.x ?? 0) + (name?.width ?? 0)).toBeLessThanOrEqual((kind?.x ?? 0) + 0.5);
});

// 11. Nothing installed reads "→ 15.2.0" with a sentence for assistive tech, and History says Installed.
test("a row with nothing installed reads an arrow and the latest, and History says Installed", async ({ page }) => {
	await page.setViewportSize({ width: 1200, height: 800 });
	await load(page, "fixture&speed=4");
	await page.getByTestId("add-app").click();
	await page.getByTestId("add-input").fill("BurntSushi/ripgrep");
	await page.keyboard.press("Enter");
	await page.getByTestId("suggestion-ripgrep").getByTestId("sug-add").click();
	const ver = page.getByTestId("row-ripgrep").locator(".cell.ver");
	await expect(ver.locator(".installed")).toHaveText("");
	await expect(ver.locator(".arrow")).toHaveCount(1);
	await expect(ver.locator(".latest")).toHaveText("15.2.0");
	await expect(ver.locator(".sr-only")).toHaveText("Not installed. 15.2.0 is the latest.");
	await expect(ver).not.toContainText("?");
	await page.keyboard.press("Escape");
	await page.getByTestId("select-none").click();
	await page.getByTestId("tick-ripgrep").check();
	await page.getByTestId("install").click();
	await expect(sentence(page)).toHaveText("1 updated", { timeout: 20_000 });
	await page.getByTestId("tab-history").click();
	const row = page.getByTestId("history").locator("li", { hasText: "ripgrep" }).first();
	await expect(row.getByTestId("history-vers")).toHaveText("Installed 15.2.0");
});

// 12. A re-checked row keeps its versions and its tick, disabled, until its answer arrives.
test("rows being re-checked keep their versions and their ticks", async ({ page }) => {
	await load(page, "fixture&speed=0.05");
	await expect(page.getByTestId("tick-cursor")).toBeChecked();
	await page.getByTestId("check").click();
	// Cursor is answered last of the four ready rows, so it is still being checked here.
	await expect(page.getByTestId("status-cursor")).toHaveText("Checking");
	await expect(page.getByTestId("tick-cursor")).toBeChecked({ timeout: 1000 });
	await expect(page.getByTestId("tick-cursor")).toBeDisabled({ timeout: 1000 });
	await expect(page.getByTestId("row-cursor").locator(".arrow")).toHaveCount(1, { timeout: 1000 });
	await expect(page.getByTestId("status-cursor")).toHaveText("Checking");
});

// 13. After Done a failed app is ready again, ticked, and says why its last try ended.
test("after Done a failed app is back in Ready to install with its last try's reason", async ({ page }) => {
	await load(page, "fixture&speed=4");
	await page.getByTestId("install").click();
	await expect(sentence(page)).toHaveText("3 updated, 1 failed", { timeout: 20_000 });
	await page.getByTestId("done").click();
	const row = page.getByTestId("row-wrangler");
	await expect(page.getByTestId("tick-wrangler")).toBeChecked();
	await expect(page.getByTestId("sentence-wrangler")).toHaveText(/^Last try failed\. .+/);
	await expect(sentence(page)).toHaveText("1 update ready");
	await expect.poll(async () => (await row.boundingBox())?.height).toBe(56);
	const group = await row.evaluate((el) => {
		let n: Element | null = el.closest(".item");
		while (n && !n.classList.contains("head")) n = n.previousElementSibling;
		return n?.textContent?.trim() ?? "";
	});
	// Ready to install, not Needs a look, which means it could not be checked.
	expect(group).toMatch(/^Ready to install/);
});

// 14. A restore point not made yet says so; a kind that cannot have one stays blank.
test("an app that can have a restore point but has none reads none yet", async ({ page }) => {
	await load(page);
	await page.getByTestId("group-fresh-toggle").click();
	await expect(page.getByTestId("none-yet-zoxide")).toHaveText("none yet");
	await expect(page.getByTestId("none-yet-cursor")).toHaveCount(0);
	await expect(page.getByTestId("none-yet-wrangler")).toHaveCount(0);
	await expect(page.getByTestId("row-wrangler").locator(".restore")).toHaveText("None");
	await expect(page.getByTestId("row-wrangler").locator(".restore .sr-only")).toHaveCount(1);
});

// 15. In use keeps its name when only its dot shows.
test("a narrowed In use chip keeps its dot, its title and its words for assistive tech", async ({ page }) => {
	await page.setViewportSize({ width: 920, height: 720 });
	await load(page);
	await page.getByTestId("open-fd").click();
	await expect(page.getByTestId("row-zen").locator(".line")).toHaveClass(/compact/);
	const chip = page.getByTestId("row-zen").getByTestId("chip-running");
	await expect(chip).toHaveAttribute("title", "In use");
	await expect(chip.locator(".dot")).toBeVisible();
	const ct = await chip.locator(".ct").evaluate((el) => ({ display: getComputedStyle(el).display, text: el.textContent }));
	expect(ct.text).toBe("In use");
	expect(ct.display).not.toBe("none");
});

// 16. Working and done differ by shape: the working glyph is three rising dashes.
test("the working glyph is three dashes, not the leaf", async ({ page }) => {
	await load(page, "fixture&speed=0.3");
	await page.getByTestId("install").click();
	const working = page.locator(".row.s-working .mark svg path");
	await expect(working).toHaveAttribute("d", "M4.5 13h7M5.75 8.5h4.5M7 4h2");
});

// 25. A system row's new version is never cut, at 980 and 760.
for (const width of [980, 760]) {
	test(`system rows never cut the new version at ${width}`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		await load(page, "fixture&system=show");
		const toggle = page.getByTestId("group-system-toggle");
		if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
		const news = page.locator('[data-testid="sys-new"]');
		await expect(news.first()).toBeVisible();
		// Whole inside its own cell, and its cell inside the row: nothing clips it.
		const cut = await news.evaluateAll((els) =>
			els.flatMap((el) => {
				const r = el.getBoundingClientRect();
				const cell = el.closest(".cell")?.getBoundingClientRect();
				const row = el.closest(".row")?.getBoundingClientRect();
				const whole = el.scrollWidth <= el.clientWidth && r.width > 0;
				const inside = !!cell && !!row && r.right <= cell.right + 0.5 && r.right <= row.right + 0.5;
				return whole && inside ? [] : [el.textContent];
			}),
		);
		expect(cut).toEqual([]);
		await expect(page.getByTestId("sys-row-apt:openjdk-21").getByTestId("sys-new")).toHaveText("21.0.13.0.3+1-1~24.04.1");
		// The kernel note starts after the new version with a gap, or sits under it.
		const kernel = page.getByTestId("sys-row-apt:linux-generic");
		const n = await kernel.getByTestId("sys-new").boundingBox();
		const note = await kernel.getByTestId("sys-note").boundingBox();
		const after = (note?.x ?? 0) >= (n?.x ?? 0) + (n?.width ?? 0) + 8;
		const under = (note?.y ?? 0) >= (n?.y ?? 0) + (n?.height ?? 0) - 0.5;
		expect(after || under).toBe(true);
	});
}

// 26. Flatpak rows carry display names, not ids.
test("Flatpak system rows read their display names", async ({ page }) => {
	await load(page, "fixture&system=show");
	const toggle = page.getByTestId("group-system-toggle");
	if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
	await expect(page.getByTestId("sys-row-flatpak:com.discordapp.Discord").getByTestId("sys-name")).toHaveText("Discord");
	await expect(page.getByTestId("sys-row-flatpak:org.gnome.Platform").getByTestId("sys-name")).toHaveText(
		"GNOME Application Platform",
	);
});
