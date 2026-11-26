import { expect, load, sentence, test } from "./helpers";

test("first load shows Install 4 updates with the four ready apps ticked", async ({ page }) => {
	await load(page);
	await expect(page.getByTestId("install")).toHaveText("Install 4 updates");
	await expect(sentence(page)).toHaveText("4 updates ready");
	for (const key of ["zen", "fd", "wrangler", "cursor"]) await expect(page.getByTestId(`tick-${key}`)).toBeChecked();
	await expect(page.locator('input[data-testid^="tick-"]:not([data-testid="tick-all"]):checked')).toHaveCount(4);
	await expect(page.getByTestId("selection")).toHaveText("4 selected · at least 110 MB");
	await expect(page.getByTestId("selection")).toHaveAttribute("title", "Some sizes are not known until they download.");
	await expect(page.getByTestId("checked")).toHaveText("Checked 2 minutes ago");
});

test("a Shift-click ticks or unticks every ready app since the last one clicked", async ({ page }) => {
	await load(page);
	// Ready to install lists Cursor, fd, wrangler, Zen Browser.
	await page.getByTestId("tick-cursor").click();
	await page.getByTestId("tick-wrangler").click({ modifiers: ["Shift"] });
	for (const key of ["cursor", "fd", "wrangler"]) await expect(page.getByTestId(`tick-${key}`)).not.toBeChecked();
	await expect(page.getByTestId("tick-zen")).toBeChecked();
	await page.getByTestId("tick-fd").click();
	await page.getByTestId("tick-cursor").click({ modifiers: ["Shift"] });
	for (const key of ["cursor", "fd", "zen"]) await expect(page.getByTestId(`tick-${key}`)).toBeChecked();
	await expect(page.getByTestId("tick-wrangler")).not.toBeChecked();
	await expect(page.getByTestId("install")).toHaveText("Install 3 updates");
	expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
});

test("Fresh is collapsed on first load and opens in place", async ({ page }) => {
	await load(page);
	const fold = page.getByTestId("group-fresh-toggle");
	await expect(fold).toHaveAttribute("aria-expanded", "false");
	await expect(fold).toContainText("Fresh");
	await expect(fold).toContainText("22");
	await expect(page.getByTestId("row-bat")).toHaveCount(0);
	await fold.click();
	await expect(fold).toHaveAttribute("aria-expanded", "true");
	await expect(page.getByTestId("row-bat")).toBeVisible();
	await page.reload();
	await page.getByTestId("install").waitFor();
	await expect(page.getByTestId("group-fresh-toggle")).toHaveAttribute("aria-expanded", "true");
});

test("group names and the restore column", async ({ page }) => {
	await load(page);
	await expect(page.getByTestId("group-ready")).toHaveText("Ready to install");
	await expect(page.getByTestId("group-manual")).toHaveText("By hand");
	await expect(page.getByTestId("group-problem")).toHaveText("Needs a look");
	await expect(page.getByTestId("row-fd").locator(".restore")).toHaveText("10.5.0");
	await expect(page.getByTestId("row-wrangler").locator(".restore .sr-only")).toHaveText("None");
	await expect(page.getByTestId("status-strata")).toHaveText("strata-update");
	await expect(page.getByTestId("row-zen").getByTestId("chip-running")).toHaveText("In use");
	await expect(page.getByTestId("row-zen").getByTestId("chip-running")).toHaveAttribute(
		"title",
		"In use now. The update applies when you restart it.",
	);
	await expect(page.getByTestId("row-wrangler").locator(".kind")).toHaveText("Updates itself");
	await expect(page.getByTestId("row-cursor").locator(".kind")).toHaveText("AppImage");
});

test("Check again runs a check with a loading bar and ends Checked just now", async ({ page }) => {
	// Slow enough that the Checking sentence holds between the crossfades.
	await load(page, "fixture&speed=0.4");
	await page.getByTestId("check").click();
	await expect(page.getByTestId("state-sentence")).toHaveText(/^Checking \d+ of 32$/);
	await expect(page.getByTestId("check")).toHaveAttribute("aria-disabled", "true");
	await expect(page.getByTestId("state-sentence")).toHaveText("4 updates ready", { timeout: 10_000 });
	await expect(page.getByTestId("checked")).toHaveText("Checked just now");
	await expect(page.getByTestId("check")).toBeFocused();
});

test("a new person's empty list says No apps yet and offers Add app, not Everything is fresh", async ({ page }) => {
	await load(page, "fixture=none");
	await expect(sentence(page)).toHaveText("No apps yet");
	await expect(page.getByTestId("empty-line")).toHaveText(
		"Add the apps you want Upkeep to keep up to date: type a name such as fd, or paste a GitHub repo.",
	);
	await expect(page.getByTestId("all-fresh")).toHaveCount(0);
	await page.getByTestId("add-app").click();
	await expect(page.getByTestId("add-input")).toBeFocused();
});
