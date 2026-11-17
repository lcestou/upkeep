import { expect, load, sentence, test } from "./helpers";

const PICKED = "/home/owner/Downloads/Obsidian-1.9.4.AppImage";

test("find by repo and add: the row lands ticked in Ready to install and the pane shows it", async ({ page }) => {
	await load(page, "fixture&speed=1");
	await page.getByTestId("add-app").click();
	await expect(page.getByTestId("add-pane")).toContainText("Add an app");
	await expect(page.getByTestId("add-input")).toBeFocused();
	await expect(page.getByTestId("add-input")).toHaveAttribute("placeholder", "fd, or owner/repo");
	await page.getByTestId("add-input").fill("https://github.com/BurntSushi/ripgrep");
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("add-status")).toHaveText("Looking at the latest release");
	await expect(page.getByTestId("add-find")).toHaveText("Finding");
	await expect(page.getByTestId("add-input")).toHaveAttribute("readonly", "");
	const card = page.getByTestId("suggestion-ripgrep");
	await expect(card).toBeVisible({ timeout: 5000 });
	await expect(card.getByTestId("sug-why")).toContainText("It installs rg.");
	await expect(card.getByTestId("sug-why")).toContainText("comes from the system's packages");
	await expect(card.getByTestId("sug-dest")).toHaveValue("~/.local/bin/rg");
	await expect(card.locator(".installed")).toHaveText("Not installed");
	await card.getByTestId("sug-add").click();
	await expect(page.getByTestId("detail-ripgrep")).toBeVisible();
	await expect(page.getByTestId("added-note")).toHaveText("Added ripgrep.");
	await expect(page.getByTestId("tick-ripgrep")).toBeChecked();
	await expect(page.getByTestId("install")).toHaveText("Install 5 updates");
	await expect(page.getByTestId("row-ripgrep")).toBeInViewport();
});

test("the asset select swaps the card", async ({ page }) => {
	await load(page, "fixture&speed=4");
	await page.getByTestId("add-app").click();
	await page.getByTestId("add-input").fill("obsidianmd/obsidian-releases");
	await page.getByTestId("add-find").click();
	const select = page.getByTestId("sug-asset");
	await expect(select).toHaveValue("Obsidian-1.9.4.AppImage");
	await select.selectOption("obsidian_1.9.4_amd64.deb");
	await expect(page.getByTestId("suggestion-obsidian").locator(".kind")).toHaveText(".deb");
	await expect(page.getByTestId("sug-asset")).toHaveValue("obsidian_1.9.4_amd64.deb");
});

test("the asset select on a scanned program swaps its row, and the tick stays", async ({ page }) => {
	await load(page, "fixture&speed=4");
	await page.getByTestId("add-app").click();
	await page.getByTestId("add-scan").click();
	await page.getByTestId("scan-open-btop").click();
	const select = page.getByTestId("suggestion-btop").getByTestId("sug-asset");
	await expect(select).toHaveValue("btop-x86_64-linux-musl.tar.gz");
	await select.selectOption("btop-x86_64-linux-gnu.tar.gz");
	await expect(page.getByTestId("suggestion-btop").getByTestId("sug-why")).toContainText(
		"btop-x86_64-linux-gnu.tar.gz",
	);
	await expect(page.getByTestId("suggestion-btop").getByTestId("sug-asset")).toHaveValue(
		"btop-x86_64-linux-gnu.tar.gz",
	);
	await expect(page.getByTestId("scan-tick-btop")).toBeChecked();
});

test("a problem card has no add button, and a bad input says why", async ({ page }) => {
	await load(page, "fixture&speed=4");
	await page.getByTestId("add-app").click();
	await page.getByTestId("add-input").fill("sharkdp/bat");
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("sug-problem")).toHaveText("bat is already in the list.");
	await expect(page.getByTestId("sug-add")).toHaveCount(0);
	await page.getByTestId("add-input").fill("nobody/nothing");
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("add-problem")).toHaveText("nobody/nothing has no published release.");
	await page.getByTestId("add-input").fill("just some words");
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("add-problem")).toHaveText(
		"Give an app's name, a repo like owner/name or gitlab.com/group/name, a GitHub, GitLab or Codeberg link, or a file path.",
	);
});

test("Choose a file finds the picked file", async ({ page }) => {
	await load(page, "fixture&speed=4");
	await page.getByTestId("add-app").click();
	await page.getByTestId("add-pick").click();
	await expect(page.getByTestId("add-input")).toHaveValue(PICKED);
	await expect(page.getByTestId("suggestion-obsidian").getByTestId("sug-why")).toContainText(
		`Found it installed at ${PICKED}.`,
	);
});

test("scan, add the two sure ones, the failed one stays with its reason", async ({ page }) => {
	await load(page, "fixture&speed=2");
	await page.getByTestId("add-app").click();
	await page.getByTestId("add-scan").click();
	await expect(page.getByTestId("add-scan")).toHaveText("Scanning");
	await expect(page.getByTestId("add-status")).toHaveText("Looking through ~/.local/bin, ~/Applications and ~/bin");
	const list = page.getByTestId("scan-results");
	await expect(list.locator("h3")).toHaveText("Found 6 apps not in the list");
	await expect(page.getByTestId("scan-tick-obsidian")).toBeChecked();
	await expect(page.getByTestId("scan-tick-btop")).toBeChecked();
	await expect(list).toContainText("Could not tell where mytool comes from. Paste its repo or link to add it.");
	await expect(page.getByTestId("scan-add")).toHaveText("Add 2 apps");
	await page.getByTestId("scan-none").click();
	await expect(page.getByTestId("scan-add")).toBeDisabled();
	await expect(page.getByTestId("scan-add")).toHaveAttribute("title", "Tick an app to add it.");
	await page.getByTestId("scan-all").click();
	await page.getByTestId("scan-add").click();
	await expect(page.getByTestId("scan-note")).toHaveText("Added 1 app.");
	await expect(page.getByTestId("scan-fail-btop")).toHaveText(
		"Could not write apps.toml: permission denied. Nothing was changed.",
	);
	await expect(page.getByTestId("row-obsidian")).toHaveCount(1);
});

test("Paste its repo keeps the scanned file as dest", async ({ page }) => {
	await load(page, "fixture&speed=4");
	await page.getByTestId("add-app").click();
	await page.getByTestId("add-scan").click();
	await page.getByTestId("paste-repo-mytool").click();
	await expect(page.getByTestId("add-input")).toBeFocused();
	await expect(page.getByTestId("pending-path")).toHaveText("/home/owner/.local/bin/mytool");
	await page.keyboard.type("BurntSushi/ripgrep");
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("suggestion-ripgrep").getByTestId("sug-dest")).toHaveValue(
		"/home/owner/.local/bin/mytool",
	);
});

test("drop a file URI anywhere on the window", async ({ page }) => {
	await load(page, "fixture&speed=4");
	const fire = (type: string) =>
		page.evaluate((t) => {
			const data = new DataTransfer();
			data.setData("text/uri-list", "file:///home/owner/Downloads/Obsidian-1.9.4.AppImage");
			document.body.dispatchEvent(new DragEvent(t, { dataTransfer: data, bubbles: true, cancelable: true }));
		}, type);
	await fire("dragenter");
	await expect(page.getByTestId("drop-veil")).toContainText("Drop to add it to Upkeep");
	await fire("drop");
	await expect(page.getByTestId("drop-veil")).toHaveCount(0);
	await expect(page.getByTestId("add-pane")).toBeVisible();
	await expect(page.getByTestId("add-input")).toHaveValue(PICKED);
	await expect(page.getByTestId("suggestion-obsidian")).toBeVisible();
});

test("drop a file in the real window: WebKitGTK gives its address only as link text in text/html", async ({ page }) => {
	await load(page, "fixture&speed=4");
	const fire = (type: string) =>
		page.evaluate((t) => {
			// As WebKitGTK delivers a dragged file: an empty uri list, no files, the address as the text of a bare <a>.
			const data = new DataTransfer();
			data.setData(
				"text/html",
				'<a style="caret-color: rgb(0, 0, 0); color: rgb(0, 0, 0);">file:///home/owner/Downloads/Obsidian-1.9.4.AppImage</a>',
			);
			document.body.dispatchEvent(new DragEvent(t, { dataTransfer: data, bubbles: true, cancelable: true }));
		}, type);
	await fire("dragenter");
	await fire("drop");
	await expect(page.getByTestId("add-pane")).toBeVisible();
	await expect(page.getByTestId("add-input")).toHaveValue(PICKED);
	await expect(page.getByTestId("suggestion-obsidian")).toBeVisible();
});

test("a dragged selection keeps its own words; the HTML is read only when nothing else came", async ({ page }) => {
	await load(page, "fixture&speed=4");
	await page.evaluate(() => {
		const data = new DataTransfer();
		data.setData("text/plain", "BurntSushi/ripgrep");
		data.setData("text/html", '<span>BurntSushi/ripgrep <a href="https://example.com/x">notes</a></span>');
		for (const t of ["dragenter", "drop"])
			document.body.dispatchEvent(new DragEvent(t, { dataTransfer: data, bubbles: true, cancelable: true }));
	});
	await expect(page.getByTestId("add-input")).toHaveValue("BurntSushi/ripgrep");
});

test("Remove asks in place, Keep is the default and Escape keeps", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-fd").click();
	await page.getByTestId("remove-app").click();
	await expect(page.getByTestId("remove-ask")).toHaveText("Remove fd from the list? The app itself stays installed.");
	await expect(page.getByTestId("remove-cancel")).toBeFocused();
	await expect(page.getByTestId("remove-cancel")).toHaveText("Keep");
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("remove-ask")).toHaveCount(0);
	await expect(page.getByTestId("remove-app")).toBeFocused();
	await expect(page.getByTestId("detail-fd")).toBeVisible();
});

test("Remove takes the row off the list and the counts follow", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-fd").click();
	await page.getByTestId("remove-app").click();
	await page.getByTestId("remove-confirm").click();
	await expect(page.getByTestId("row-fd")).toHaveCount(0);
	await expect(page.getByTestId("inspector")).toHaveCount(0);
	await expect(page.getByTestId("notice")).toHaveText("Removed fd.");
	await expect(page.getByTestId("count-ready")).toHaveText("3");
	await expect(page.getByTestId("install")).toHaveText("Install 3 updates");
	await expect(sentence(page)).toHaveText("3 updates ready");
});

test("Remove is disabled during a run", async ({ page }) => {
	await load(page, "fixture&speed=1");
	await page.getByTestId("open-strata").click();
	await page.getByTestId("install").click();
	await page.getByTestId("open-strata").click();
	await expect(page.getByTestId("remove-app")).toHaveAttribute("aria-disabled", "true");
	await expect(page.getByTestId("remove-app")).toHaveAttribute("title", "Wait for the run to finish.");
});

test("a find that runs out of time says so and gives the field back", async ({ page }) => {
	await load(page, "fixture&fail=suggest");
	await page.getByTestId("add-app").click();
	await page.getByTestId("add-input").fill("BurntSushi/ripgrep");
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("add-error")).toHaveText("That took too long. Try again.");
	await expect(page.getByTestId("add-input")).not.toHaveAttribute("readonly", "");
});

test("keyboard only: a, type, Enter, Tab to Add to Upkeep, Enter", async ({ page }) => {
	await load(page, "fixture&speed=4");
	// The first row: groups are alphabetical, so Cursor leads Ready to install.
	await expect(page.getByTestId("open-cursor")).toBeFocused();
	await page.keyboard.press("a");
	await expect(page.getByTestId("add-input")).toBeFocused();
	await page.keyboard.type("BurntSushi/ripgrep");
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("suggestion-ripgrep")).toBeVisible();
	for (let i = 0; i < 12; i++) {
		if ((await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "sug-add") break;
		await page.keyboard.press("Tab");
	}
	await expect(page.getByTestId("sug-add")).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("added-note")).toHaveText("Added ripgrep.");
});

test.describe("at 760 by 520", () => {
	test.use({ viewport: { width: 760, height: 520 } });
	test("the add pane is a sheet and nothing in it is clipped", async ({ page }) => {
		await load(page, "fixture&speed=4");
		await page.getByTestId("add-app").click();
		await page.getByTestId("add-scan").click();
		await expect(page.getByTestId("scan-results")).toBeVisible();
		await page.waitForTimeout(300);
		const pane = page.getByTestId("inspector");
		const p = await pane.boundingBox();
		expect(p?.x).toBe(0);
		await expect(page.getByTestId("inspector-close")).toHaveText("Back to list");
		for (const el of await pane.locator("button, input, select").all()) {
			await el.scrollIntoViewIfNeeded();
			const b = await el.boundingBox();
			if (!b || !p) continue;
			expect(b.x).toBeGreaterThanOrEqual(p.x);
			expect(b.x + b.width).toBeLessThanOrEqual(p.x + p.width + 0.5);
		}
		expect(await pane.locator(".scroll").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
	});
});

test("an app's name finds its tested table in the catalogue, and it adds like any other", async ({ page }) => {
	await load(page, "fixture&speed=4");
	await page.getByTestId("add-app").click();
	await page.getByTestId("add-input").fill("glow");
	await page.keyboard.press("Enter");
	const card = page.getByTestId("suggestion-glow");
	await expect(card.getByTestId("sug-why")).toHaveText("From Upkeep's catalogue of tested apps.");
	await expect(card.getByTestId("sug-dest")).toHaveValue("~/.local/bin/glow");
	await card.getByTestId("sug-add").click();
	await expect(page.getByTestId("added-note")).toHaveText("Added Glow.");
	await expect(page.getByTestId("tick-glow")).toBeChecked();
});

test("a catalogue app that updates itself shows the command it runs before it is added", async ({ page }) => {
	await load(page, "fixture&speed=4");
	await page.getByTestId("add-app").click();
	await page.getByTestId("add-input").fill("gh");
	await page.keyboard.press("Enter");
	const card = page.getByTestId("suggestion-gh");
	await expect(card.getByTestId("sug-runs")).toHaveText("Updates by running gh upgrade");
	await expect(page.getByTestId("suggestion-glow")).toHaveCount(0);
});

test("an app something else already updates says so on its card, and Add still works", async ({ page }) => {
	await load(page);
	await page.getByTestId("add-app").first().click();
	await page.getByTestId("add-input").fill("obsidian");
	await page.getByTestId("add-find").click();
	await expect(page.getByTestId("sug-also")).toHaveText(
		"Obsidian is also installed as a Flatpak (md.obsidian.Obsidian), which updates on its own: two copies, each with its own menu entry.",
	);
	await expect(page.getByTestId("sug-add")).toBeEnabled();
});

test("a Shift-click in the scan list ticks every row since the last one clicked", async ({ page }) => {
	await load(page, "fixture&scan=also");
	await page.getByTestId("add-app").first().click();
	await page.getByTestId("add-scan").click();
	await expect(page.getByTestId("scan-tick-btop")).toBeVisible();
	await page.getByTestId("scan-none").click();
	const ticks = page.locator('[data-testid^="scan-tick-"]');
	const n = await ticks.count();
	expect(n).toBeGreaterThan(2);
	await ticks.first().click();
	await ticks.last().click({ modifiers: ["Shift"] });
	for (let i = 0; i < n; i++) await expect(ticks.nth(i)).toBeChecked();
	await expect(page.getByTestId("scan-add")).toHaveText(`Add ${n} apps`);
	expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
});

test("a scanned app that is also a Flatpak says so and starts unticked; the others are ticked", async ({ page }) => {
	await load(page, "fixture&scan=also");
	await page.getByTestId("add-app").first().click();
	await page.getByTestId("add-scan").click();
	const key = (await page.locator('[data-testid^="scan-also-"]').first().getAttribute("data-testid"))?.slice(
		"scan-also-".length,
	);
	expect(key).toBeTruthy();
	await expect(page.getByTestId(`scan-also-${key}`)).toContainText("also installed as a Flatpak");
	await expect(page.getByTestId(`scan-tick-${key}`)).not.toBeChecked();
	await expect(page.getByTestId("scan-tick-btop")).toBeChecked();
});
