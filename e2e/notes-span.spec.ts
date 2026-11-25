import { expect, load, test } from "./helpers";

test("a row several releases behind shows every skipped release's notes, with the lines that read as breaking", async ({
	page,
}) => {
	await load(page);
	await page.getByTestId("open-zen").click();
	const pane = page.getByTestId("detail-zen");
	await expect(pane.getByTestId("breaking-heading")).toHaveText("Breaking changes");
	const lines = pane.getByTestId("breaking-line");
	// The heading "Breaking changes" in the notes is not quoted: the line under it is.
	await expect(lines).toHaveText([
		"1.24.0.1b Workspaces made before 1.20 must be migrated: open Settings, Workspaces once.",
	]);
	await expect(pane.getByTestId("breaking-hint")).toHaveText(
		"Lines in these notes that mention a breaking change or a migration. Read them before you update.",
	);
	// Newest first, each under its version and the day it came out.
	const headings = pane.locator(".notes .nv");
	await expect(headings).toHaveCount(2);
	await expect(headings.first()).toHaveAttribute("data-testid", "notes-version-1.24.1b");
	await expect(pane.getByTestId("notes-version-1.24.1b")).toHaveText(/^1\.24\.1b\s+Released /);
	await expect(pane.getByTestId("notes-version-1.24.0.1b")).toContainText("1.24.0.1b");
	await expect(pane.getByTestId("notes")).toContainText("Fixed the sidebar flicker on Wayland.");
	await expect(pane.getByTestId("notes-older")).toHaveText("1 older release not shown.");
	await expect(pane.getByTestId("notes-more")).toHaveText(
		"Older releases are not listed here. The release page has them all.",
	);
});

test("a row one release behind keeps the latest release's notes alone", async ({ page }) => {
	await load(page);
	await page.getByTestId("open-fd").click();
	const pane = page.getByTestId("detail-fd");
	await expect(pane.getByTestId("notes")).toContainText("Fix --exec-batch when combined with --max-results.");
	await expect(pane.getByTestId("breaking")).toHaveCount(0);
	await expect(pane.locator(".notes .nv")).toHaveCount(0);
	await expect(pane.getByTestId("notes-more")).toHaveCount(0);
});
