import { expect, load, test } from "./helpers";

test("Skip moves the app to Held back and Stop skipping brings it back", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-fd").click();
	await page.getByTestId("skip-fd").click();
	await expect(page.getByTestId("group-held")).toHaveText("Held back");
	await expect(page.getByTestId("status-fd")).toHaveText("Skipping 10.5.2");
	await expect(page.getByTestId("install")).toHaveText("Install 3 updates");
	await expect(page.getByTestId("skip-fd")).toHaveText("Stop skipping 10.5.2");
	await expect(page.getByTestId("skip-fd")).toBeFocused();
	await page.getByTestId("skip-fd").click();
	await expect(page.getByTestId("status-fd")).toHaveText("Ready");
	await expect(page.getByTestId("group-held")).toHaveCount(0);
});

test("Hold updates and Release hold", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-zen").click();
	await page.getByTestId("hold-zen").click();
	await expect(page.getByTestId("status-zen")).toHaveText("Held");
	await expect(page.getByTestId("hold-zen")).toHaveText("Release hold");
	await page.getByTestId("hold-zen").click();
	await expect(page.getByTestId("status-zen")).toHaveText("Ready");
});

test("Restore swaps the point, lands in Held back unticked, and the pane stays open", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-fd").click();
	await page.getByTestId("restore-fd-10.5.0").click();
	await expect(page.getByTestId("restore-result")).toHaveText("Restored 10.5.0.");
	await expect(page.getByTestId("restore-result")).toBeFocused();
	await expect(page.getByTestId("detail-fd")).toBeVisible();
	await expect(page.getByTestId("group-held")).toHaveText("Held back");
	await expect(page.getByTestId("status-fd")).toHaveText("Skipping 10.5.2");
	await expect(page.getByTestId("tick-fd")).toHaveCount(0);
	await expect(page.getByTestId("install")).toHaveText("Install 3 updates");
	await expect(page.getByTestId("row-fd")).toBeInViewport();
	// The replaced version is now the restore point, and the same button undoes the restore.
	await expect(page.getByTestId("restore-fd-10.5.1")).toHaveText("Restore 10.5.1");
	await page.getByTestId("tab-history").click();
	await expect(page.getByTestId("history").locator("section").first()).toContainText("Restored");
});

test("a restore point that holds settings says so, and the swap keeps them with the replaced version", async ({
	page,
}) => {
	await load(page);
	// Both are up to date, so their rows sit in the folded group.
	await page.getByTestId("group-fresh-toggle").click();
	await page.getByTestId("open-yazi").click();
	const tag = page.getByTestId("point-config-yazi-25.5.31");
	await expect(tag).toHaveText("with settings");
	await expect(tag).toHaveAttribute(
		"title",
		"Restoring puts its saved settings back too. The settings it replaces are kept aside.",
	);
	await page.getByTestId("restore-yazi-25.5.31").click();
	await expect(page.getByTestId("restore-result")).toHaveText("Restored 25.5.31.");
	await expect(page.getByTestId("point-config-yazi-26.1.22")).toHaveText("with settings");
});

test("a running app's settings are not swapped under it: the restore asks to close it first", async ({ page }) => {
	await load(page);
	await page.getByTestId("group-fresh-toggle").click();
	await page.getByTestId("open-ghostty").click();
	await expect(page.getByTestId("point-config-ghostty-1.3.0")).toHaveText("with settings");
	await page.getByTestId("restore-ghostty-1.3.0").click();
	await expect(page.getByTestId("restore-result")).toHaveText(
		"Close Ghostty Terminal first: its settings go back with this restore, and it could write over them when it quits.",
	);
	await expect(page.getByTestId("restore-ghostty-1.3.0")).toBeVisible();
});

test("a kind with no restore point says why in the pane", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-wrangler").click();
	await expect(page.getByTestId("no-restore")).toHaveText("It updates itself, and its table has no restore command.");
	await page.getByTestId("group-fresh-toggle").click();
	await page.getByTestId("open-claude-plugins").click();
	await expect(page.getByTestId("no-restore")).toHaveText("Claude Code keeps no older plugin to go back to.");
});

test("release notes are rendered: headings, lists and code, no markdown marks", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-fd").click();
	const notes = page.getByTestId("notes");
	await expect(notes.locator("li")).toHaveCount(3);
	await expect(notes.locator(".nh, p").first()).toHaveText("Bugfixes");
	expect(await notes.textContent()).not.toContain("- ");
});

test("the By hand row copies its command", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-strata").click();
	await expect(page.getByTestId("detail-strata")).toContainText("Run it yourself:");
	await page.getByTestId("copy-strata").click();
	await expect(page.getByTestId("copy-strata")).toHaveText("Copied");
	await expect(page.getByTestId("copy-strata")).toHaveText("Copy", { timeout: 4000 });
});

test("Install automatically adds the Auto chip", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-fd").click();
	await page.getByTestId("auto-fd").check();
	await expect(page.getByTestId("row-fd").getByTestId("chip-auto")).toHaveText("Auto");
	await page.getByTestId("auto-fd").uncheck();
	await expect(page.getByTestId("row-fd").getByTestId("chip-auto")).toHaveCount(0);
});

test("Show in the app menu is offered on an AppImage row, says why it is refused, and not on other kinds", async ({
	page,
}) => {
	await load(page);
	await page.getByTestId("open-cursor").click();
	await expect(page.getByTestId("menu-switch-cursor")).toHaveText("Show in the app menu");
	await expect(page.getByTestId("menu-cursor")).not.toBeChecked();
	await page.getByTestId("menu-cursor").check();
	await expect(page.getByTestId("menu-cursor")).toBeChecked();
	await page.getByTestId("menu-cursor").uncheck();
	await expect(page.getByTestId("menu-cursor")).not.toBeChecked();
	await page.getByTestId("inspector-close").click();
	// Nothing installed: the box goes back and the engine's reason shows.
	await page.getByTestId("open-lrcget").click();
	await page.getByTestId("menu-lrcget").click();
	await expect(page.getByTestId("menu-lrcget")).not.toBeChecked();
	await expect(page.getByTestId("menu-result-lrcget")).toHaveText(
		"Nothing is installed at ~/.local/bin/lrcget yet, so there is no menu entry to read. Install it first.",
	);
	await page.getByTestId("inspector-close").click();
	// Another tool's entry: no switch, the row says where the entry is. Ghostty is up to date, so its group is folded.
	await page.getByTestId("group-fresh-toggle").click();
	await page.getByTestId("open-ghostty").click();
	await expect(page.getByTestId("menu-ghostty")).toHaveCount(0);
	await expect(page.getByTestId("menu-elsewhere-ghostty")).toHaveText(
		"Already in the app menu through ~/.local/share/applications/appimagekit_ghostty.desktop, so Upkeep adds no second entry.",
	);
	await page.getByTestId("inspector-close").click();
	await page.getByTestId("open-fd").click();
	await expect(page.getByTestId("menu-switch-fd")).toHaveCount(0);
});

test("a restore that runs out of time leaves the buttons usable and says nothing false", async ({ page }) => {
	await load(page, "fixture&fail=restore");
	await page.getByTestId("open-fd").click();
	const button = page.getByTestId("restore-fd-10.5.0");
	await button.click();
	await expect(button).toBeDisabled();
	await expect(button).toBeEnabled();
	await expect(page.getByTestId("restore-result")).toHaveText("");
	await expect(page.getByTestId("status-fd")).toHaveText("Ready");
});

// Native builds, chunk 8: a source row without a checkout or a stage is built in a fresh clone.
test("a source app without a restore point says it is built in a fresh clone", async ({ page }) => {
	await load(page);
	await page.getByTestId("group-fresh-toggle").click();
	await page.getByTestId("open-tmux").click();
	await expect(page.getByTestId("no-restore")).toHaveText("Built in a fresh clone, so there is no restore point.");
});

test("an app's pane says what else keeps it up to date, as the Add card did", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-zen").click();
	await expect(page.getByTestId("detail-also")).toHaveText(
		"Zen Browser is also installed as a Flatpak (app.zen_browser.zen), which updates on its own: two copies, each with its own menu entry.",
	);
	await page.getByTestId("open-fd").click();
	await expect(page.getByTestId("detail-also")).toHaveCount(0);
});
