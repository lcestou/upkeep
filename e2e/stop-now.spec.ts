import { expect, load, test } from "./helpers";

test("a working row that has printed nothing for 3 minutes says so, with its step's own limit", async ({ page }) => {
	await load(page, "fixture&speed=2&quiet=cut");
	await page.getByTestId("install").click();
	// The row has room for the short form; the pane says when the step's own limit ends it.
	await expect(page.getByTestId("quiet-zen")).toHaveText("No output for 3 min.");
	// Only the quiet row carries the line; the rows waiting behind it do not.
	await expect(page.getByTestId("quiet-fd")).toHaveCount(0);
	await page.getByTestId("open-zen").click();
	await expect(page.getByTestId("pane-quiet")).toHaveText("No output for 3 min. It stops on its own in 7 min.");
});

test("Stop after this one escalates to Stop now, which puts the current app back and leaves the rest ready", async ({
	page,
}) => {
	await load(page, "fixture&speed=0.5");
	await page.getByTestId("install").click();
	await expect(page.getByTestId("stop-now")).toHaveCount(0);
	await page.getByTestId("stop").click();
	await expect(page.getByTestId("stop")).toHaveText("Stopping after Zen Browser");
	await expect(page.getByTestId("stop-now")).toHaveText("Stop now");
	await page.getByTestId("stop-now").click();
	await expect(page.getByTestId("done")).toBeVisible({ timeout: 10_000 });
	await expect(page.getByTestId("status-zen")).toHaveText("Stopped");
	await expect(page.getByTestId("sentence-zen")).toHaveText("Stopped. 1.24b is back in place.");
	for (const key of ["fd", "wrangler", "cursor"]) await expect(page.getByTestId(`status-${key}`)).toHaveText("Ready");
	// Stopping is not a failure: what was put back reads as a plain note, in the pane and in History.
	await page.getByTestId("open-zen").click();
	await expect(page.getByTestId("pane-detail")).toHaveClass(/\bnote\b/);
	await page.getByTestId("tab-history").click();
	await expect(page.getByTestId("history")).toContainText("Stopped by you");
	await expect(page.getByTestId("history").getByText("Stopped. 1.24b is back in place.").first()).toHaveClass(
		/\bnote\b/,
	);
});

test("once pressed, Stop now says what it is stopping and takes no second press", async ({ page }) => {
	await load(page, "fixture&speed=1&quiet=root");
	await page.getByTestId("install").click();
	await page.getByTestId("stop").click();
	await page.getByTestId("stop-now").click();
	await expect(page.getByTestId("stop-now")).toHaveText("Stopping Zen Browser…");
	await expect(page.getByTestId("stop-now")).toHaveAttribute("aria-disabled", "true");
	await expect(page.getByTestId("stop")).toHaveCount(0);
	// A step Stop now never cuts is waited out, and the row says so.
	await expect(page.getByTestId("wait-zen")).toHaveText("Waiting for dpkg to finish, then putting 1.24b back.");
	await expect(page.getByTestId("status-zen")).toHaveText("Stopped", { timeout: 10_000 });
});

test("a quiet row carries its own Stop now", async ({ page }) => {
	await load(page, "fixture&speed=2&quiet=cut");
	await page.getByTestId("install").click();
	await expect(page.getByTestId("stop-now-zen")).toHaveText("Stop now");
	await expect(page.getByTestId("stop-now-fd")).toHaveCount(0);
	await page.getByTestId("stop-now-zen").click();
	await expect(page.getByTestId("status-zen")).toHaveText("Stopped", { timeout: 10_000 });
	await expect(page.getByTestId("stop-now-zen")).toHaveCount(0);
	await expect(page.getByTestId("status-fd")).toHaveText("Ready");
});

test("a stopped app is not offered as Retry; the apps not started are, and after Done it is ready to tick", async ({
	page,
}) => {
	await load(page, "fixture&speed=2&quiet=cut");
	await page.getByTestId("install").click();
	await page.getByTestId("stop-now-zen").click();
	await expect(page.getByTestId("done")).toBeVisible({ timeout: 10_000 });
	await expect(page.getByTestId("retry")).toHaveCount(0);
	await expect(page.getByTestId("install")).toHaveText("Install 3 updates");
	await page.getByTestId("done").click();
	await expect(page.getByTestId("status-zen")).toHaveText("Ready");
	await expect(page.getByTestId("sentence-zen")).toHaveText("Stopped. 1.24b is back in place.");
	await expect(page.getByTestId("tick-zen")).toBeEnabled();
});
