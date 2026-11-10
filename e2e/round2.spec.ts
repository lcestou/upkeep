import { expect, load, sentence, test } from "./helpers";

test("one version axis: with nothing installed the installed slot is empty before the arrow", async ({ page }) => {
	await load(page, "fixture=problems", { wait: "sentence" });
	const lrc = page.getByTestId("row-lrcget");
	// Round three: "→ latest" with no left side, not "?".
	await expect(lrc.locator(".installed")).toHaveText("");
	await expect(lrc.locator(".arrow")).toHaveCount(1);
	await expect(page.getByTestId("row-borg").locator(".arrow")).toHaveCount(0);
});

test("controls keep the page's word space", async ({ page }) => {
	await load(page);
	const body = await page.evaluate(() => getComputedStyle(document.body).wordSpacing);
	for (const id of ["check", "filter", "log-toggle"])
		expect(await page.getByTestId(id).evaluate((el) => getComputedStyle(el).wordSpacing), id).toBe(body);
});

test("ArrowDown keeps the focused row fully in view through 60 apps", async ({ page }) => {
	await load(page, "fixture=many", { wait: "sentence" });
	await page.getByTestId("group-fresh-toggle").click();
	await page.getByTestId("open-zen").focus();
	const list = page.getByTestId("app-list");
	for (let i = 0; i < 59; i++) {
		await page.keyboard.press("ArrowDown");
		const inside = await list.evaluate((el) => {
			const row = document.activeElement?.closest(".row");
			if (!row) return "no row";
			const l = el.getBoundingClientRect();
			const r = row.getBoundingClientRect();
			// The sticky column header covers the top 34 px of the list.
			return r.top >= l.top + 34 - 0.5 && r.bottom <= l.bottom + 0.5 ? "ok" : `${r.top}-${r.bottom} in ${l.top}-${l.bottom}`;
		});
		expect(inside, `step ${i}`).toBe("ok");
	}
});

test.describe("at 760 by 520", () => {
	test.use({ viewport: { width: 760, height: 520 } });
	test("the sheet makes the list inert, takes focus, and gives it back", async ({ page }) => {
		await load(page);
		await page.getByTestId("open-fd").click();
		await expect(page.getByTestId("inspector-close")).toBeFocused();
		expect(await page.getByTestId("app-list").evaluate((el) => el.closest("[inert]") !== null)).toBe(true);
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("open-fd")).toBeFocused();
		expect(await page.getByTestId("app-list").evaluate((el) => el.closest("[inert]") !== null)).toBe(false);
	});
});

test("restart reminders outlive Done, in their own group, in the header and in History", async ({ page }) => {
	await load(page, "fixture&speed=4");
	await page.getByTestId("tick-wrangler").click();
	await page.getByTestId("install").click();
	await expect(sentence(page)).toHaveText("3 updated", { timeout: 20_000 });
	await page.getByTestId("done").click();
	await expect(page.getByTestId("group-restart")).toHaveText("Restart to finish");
	await expect(page.getByTestId("status-zen")).toHaveText("Restart Zen Browser to finish");
	await expect(page.getByTestId("restart-line")).toHaveText("Restart Zen Browser to finish.");
	await page.getByTestId("tab-history").click();
	await expect(page.getByTestId("restart-pending")).toHaveText("Restart pending");
});

test("a stopped run leaves the rest ticked and unlocked, with Install as the primary", async ({ page }) => {
	await load(page, "fixture&speed=1");
	await page.getByTestId("install").click();
	await page.getByTestId("stop").click();
	await expect(sentence(page)).toHaveText("1 updated, 3 not started", { timeout: 10_000 });
	await expect(page.getByTestId("tick-fd")).toBeEnabled();
	await expect(page.getByTestId("tick-fd")).toBeChecked();
	await expect(page.getByTestId("install")).toHaveClass(/primary/);
	await page.getByTestId("tick-fd").click();
	await expect(page.getByTestId("install")).toHaveText("Install 2 updates");
});

test("Select all, Select none and the header tick act on what the filter shows", async ({ page }) => {
	await load(page);
	await page.getByTestId("filter").fill("zen");
	await expect(page.getByTestId("tick-all")).toBeChecked();
	await page.getByTestId("select-none").click();
	await expect(page.getByTestId("tick-all")).not.toBeChecked();
	await page.getByTestId("filter").fill("");
	await expect(page.getByTestId("install")).toHaveText("Install 3 updates");
	await expect(page.getByTestId("tick-fd")).toBeChecked();
	await expect(page.getByTestId("tick-all")).toHaveJSProperty("indeterminate", true);
});

test("a failed row keeps its height, and Retry does not shift the list", async ({ page }) => {
	await load(page, "fixture&speed=4");
	await page.getByTestId("install").click();
	await expect(sentence(page)).toHaveText("3 updated, 1 failed", { timeout: 20_000 });
	expect((await page.getByTestId("row-wrangler").boundingBox())?.height).toBe(44);
	const first = page.locator(".row").first();
	const before = await first.boundingBox();
	const scroll = await page.getByTestId("app-list").evaluate((el) => el.scrollTop);
	await page.getByTestId("retry").click();
	await expect(sentence(page)).toHaveText(/^Retrying wrangler/);
	expect((await first.boundingBox())?.y).toBe(before?.y);
	expect(await page.getByTestId("app-list").evaluate((el) => el.scrollTop)).toBe(scroll);
	await expect(sentence(page)).toHaveText("4 updated", { timeout: 10_000 });
	await page.getByTestId("tab-history").click();
	await expect(page.getByTestId("history-retry")).toHaveText("Retry");
});

test("a re-check keeps the Install count and says why it waits", async ({ page }) => {
	await load(page, "fixture&speed=0.4");
	await page.getByTestId("check").click();
	await expect(sentence(page)).toHaveText(/^Checking/);
	const install = page.getByTestId("install");
	for (let i = 0; i < 6; i++) {
		await expect(install).toHaveText("Install 4 updates");
		await page.waitForTimeout(150);
	}
	await expect(install).toBeDisabled();
	await expect(install).toHaveAttribute("title", "Wait for the check to finish.");
});

test("headings clear the sticky column header after an automatic scroll", async ({ page }) => {
	await load(page);
	expect(await page.locator(".ghead").first().evaluate((el) => getComputedStyle(el).scrollMarginTop)).toBe("34px");
});

test("the filter: Clear filter, ArrowDown to the first row, Enter opens the first match, PageDown scrolls", async ({ page }) => {
	await load(page, "fixture=many", { wait: "sentence" });
	await page.getByTestId("filter").fill("nothing-here");
	await page.getByTestId("clear-filter").click();
	await expect(page.getByTestId("filter")).toHaveValue("");
	await expect(page.getByTestId("filter")).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(page.getByTestId("open-zen")).toBeFocused();
	await page.getByTestId("filter").fill("tmux nightly");
	await page.getByTestId("filter").press("Enter");
	await expect(page.getByTestId("detail-tmux-2")).toBeVisible();
	await page.getByTestId("inspector-close").click();
	await page.getByTestId("filter").fill("");
	await page.getByTestId("group-fresh-toggle").click();
	await page.getByTestId("open-zen").focus();
	const list = page.getByTestId("app-list");
	const top = await list.evaluate((el) => el.scrollTop);
	await page.keyboard.press("PageDown");
	// Round three: PageDown on a row moves focus a page of rows, and the list follows it.
	expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(top + 100);
});

test("disabled pane actions during a run say why", async ({ page }) => {
	await load(page, "fixture&speed=1");
	await page.getByTestId("open-fd").click();
	await page.getByTestId("install").click();
	await expect(page.getByTestId("hold-fd")).toHaveAttribute("title", "Wait for the run to finish.");
});

test("the checking dot pulses no lower than 0.85", async ({ page }) => {
	await load(page, "fixture=checking", { wait: "sentence" });
	const low = await page.evaluate(() => {
		for (const sheet of document.styleSheets)
			for (const rule of sheet.cssRules)
				if (rule instanceof CSSKeyframesRule && rule.name.includes("pulse"))
					for (const k of rule.cssRules) if (k instanceof CSSKeyframeRule && k.style.opacity) return Number(k.style.opacity);
		return null;
	});
	expect(low).toBe(0.85);
});

test("Zen's release notes keep their sections", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-zen").click();
	const notes = page.getByTestId("notes");
	await expect(notes.locator(".nh")).toHaveCount(5);
	await expect(notes.locator("ul")).toHaveCount(4);
});

test("a restore writes a line into the pane's log", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-fd").click();
	await page.getByTestId("restore-fd-10.5.0").click();
	await expect(page.getByTestId("pane-log")).toContainText("Restored 10.5.0.");
});

test("History during a first run says one is in progress", async ({ page }) => {
	await load(page, "fixture&speed=1&history=none");
	await page.getByTestId("tab-history").click();
	await expect(page.getByTestId("history-empty")).toHaveText("No runs yet.");
	await page.getByTestId("tab-updates").click();
	await page.getByTestId("install").click();
	await page.getByTestId("tab-history").click();
	await expect(page.getByTestId("history-empty")).toHaveText("A run is in progress.");
});

test("the footer's primary button lives only in Updates", async ({ page }) => {
	await load(page);
	await page.getByTestId("tab-history").click();
	await expect(page.getByTestId("install")).toHaveCount(0);
	await expect(page.getByTestId("log-toggle")).toBeVisible();
});

test("the header's second line mentions by-hand updates", async ({ page }) => {
	await load(page);
	await expect(page.getByTestId("by-hand-line")).toContainText("3 more by hand");
});

test("Tab past the last control comes back to the first", async ({ page }) => {
	await load(page);
	await page.getByTestId("install").focus();
	await page.keyboard.press("Tab");
	await expect(page.getByTestId("win-close")).toBeFocused();
	await page.keyboard.press("Shift+Tab");
	await expect(page.getByTestId("install")).toBeFocused();
});

test("scan paths read from ~ and wrap only at a slash", async ({ page }) => {
	await load(page, "fixture&speed=4");
	await page.getByTestId("add-app").click();
	await page.getByTestId("add-scan").click();
	const path = page.getByTestId("scan-results").locator(".path").first();
	await expect(path).toHaveText("~/Applications/Obsidian-1.9.4.AppImage");
	await expect(path).toHaveAttribute("title", "/home/owner/Applications/Obsidian-1.9.4.AppImage");
});

test("in add mode the footer's Install steps down to the secondary style", async ({ page }) => {
	await load(page);
	await page.getByTestId("add-app").click();
	await expect(page.getByTestId("install")).not.toHaveClass(/primary/);
});

test("the subline's dot has the same gap on both sides", async ({ page }) => {
	await load(page);
	const gaps = await page.evaluate(() => {
		const box = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
		const range = document.createRange();
		const checked = document.querySelector('[data-testid="checked"]');
		if (!checked) return null;
		range.selectNodeContents(checked);
		const a = range.getBoundingClientRect();
		const sep = box("subline-sep");
		const next = box("by-hand-line");
		return sep && next ? [sep.left - a.right, next.left - sep.right] : null;
	});
	expect(gaps).not.toBeNull();
	const [before = 0, after = 0] = gaps ?? [];
	expect(Math.abs(before - after)).toBeLessThanOrEqual(1);
	expect(before).toBeGreaterThan(2);
});

test("History marks a failure in the failure red, not the rust of Needs a look", async ({ page }) => {
	await load(page);
	await page.getByTestId("tab-history").click();
	const rolled = await page.locator("li.r-rolled_back .result").evaluate((el) => getComputedStyle(el).color);
	const fail = await page.evaluate(() => {
		const probe = document.createElement("span");
		probe.style.color = "var(--fail)";
		document.body.append(probe);
		const c = getComputedStyle(probe).color;
		probe.remove();
		return c;
	});
	expect(rolled).toBe(fail);
});

test("on a 2x screen the ready glyph is the vector mark", async ({ page }) => {
	await load(page);
	const glyph = page.getByTestId("row-fd").locator(".mark > svg");
	await expect(glyph.locator("svg.hi")).toBeVisible();
	await expect(glyph.locator("path.lo")).toBeHidden();
});

test.describe("on a 1x screen", () => {
	test.use({ deviceScaleFactor: 1 });
	test("the ready glyph is the 16 px pixel cut, drawn crisp", async ({ page }) => {
		await load(page);
		const glyph = page.getByTestId("row-fd").locator(".mark > svg");
		await expect(glyph.locator("svg.hi")).toBeHidden();
		await expect(glyph.locator("path.lo")).toHaveAttribute("shape-rendering", "crispEdges");
		expect((await glyph.boundingBox())?.width).toBe(16);
	});
});
