import type { Page } from "playwright/test";
import { expect, load, test } from "./helpers";

const ops = (page: Page) => page.evaluate(() => (globalThis as { upkeepSysOps?: string[] }).upkeepSysOps ?? []);

/** Opens the Cleanup tab and waits for the fake measure to land. */
async function openCleanup(page: Page) {
	await load(page, "fixture&cleanup=on");
	await page.getByTestId("tab-cleanup").click();
	await expect(page.getByTestId("cleanup-measured")).toHaveText(/^Measured /);
}

test("the Cleanup tab is absent until switched on, and sits between History and Settings", async ({ page }) => {
	await load(page);
	await expect(page.getByTestId("tab-cleanup")).toHaveCount(0);
	await page.getByTestId("tab-settings").click();
	await expect(page.getByTestId("setting-cleanup-help")).toHaveText(
		"Adds a Cleanup tab. It measures caches and leftovers, and deletes only what you tick and then confirm.",
	);
	await expect(page.getByTestId("setting-cleanup")).not.toBeChecked();
	await expect(page.getByTestId("setting-cleanup-dev")).toHaveCount(0);
	await page.getByTestId("setting-cleanup").check();
	await expect(page.getByRole("tab")).toHaveText(["Updates", "History", "Cleanup", "Settings"]);
	await expect(page.getByTestId("setting-cleanup-dev-help")).toHaveText(
		"The uv, bun, npm and pip download caches. They come back as downloads the next time a build needs them.",
	);
	await page.getByTestId("tab-cleanup").click();
	await expect(page.getByTestId("cleanup-intro")).toHaveText("Upkeep deletes only what you tick, after one more look.");
	await expect(page.getByTestId("cleanup-measured")).toHaveText(/^Measured /);
	await expect(page.getByTestId("cleanup-item-uv")).toHaveCount(0);
	await page.getByTestId("tab-settings").click();
	await page.getByTestId("setting-cleanup-dev").check();
	await page.getByTestId("tab-cleanup").click();
	await expect(page.getByTestId("cleanup-size-uv")).toHaveText("4.0 GB");
	await expect(page.getByTestId("cleanup-tick-uv")).not.toBeChecked();
	await page.getByTestId("tab-settings").click();
	await page.getByTestId("setting-cleanup").uncheck();
	await expect(page.getByTestId("tab-cleanup")).toHaveCount(0);
});

test("items read their size, what they are and their badges; a show-only row has no tick", async ({ page }) => {
	await openCleanup(page);
	await expect(page.getByTestId("cleanup-group-safe")).toHaveText("Safe to clear");
	await expect(page.getByTestId("cleanup-group-choice")).toHaveText("Your call");
	await expect(page.getByTestId("cleanup-group-shown")).toHaveText("Shown only");
	await expect(page.getByTestId("cleanup-size-thumbnails")).toHaveText("39 MB");
	await expect(page.getByTestId("cleanup-what-thumbnails")).toHaveText(
		"Small previews of pictures and videos. The file manager makes them again when it needs them.",
	);
	await expect(page.getByTestId("cleanup-undo-thumbnails")).toHaveText("Comes back on its own");
	await expect(page.getByTestId("cleanup-root-apt-cache")).toHaveText("Needs administrator");
	await expect(page.getByTestId("cleanup-undo-restore-points")).toHaveText("Cannot be undone");
	await expect(page.getByTestId("cleanup-tick-restore-points")).not.toBeChecked();
	// A leftover newer than its live file starts unticked and says why.
	await expect(page.getByTestId("cleanup-note-leftovers-1")).toHaveText("This copy is newer than the installed file.");
	await expect(page.getByTestId("cleanup-part-leftovers-1").getByRole("checkbox")).not.toBeChecked();

	const tmp = page.getByTestId("cleanup-item-tmp");
	await expect(tmp.getByRole("checkbox")).toHaveCount(0);
	await expect(page.getByTestId("cleanup-tick-tmp")).toHaveCount(0);
	await expect(page.getByTestId("cleanup-size-tmp")).toHaveText("2.5 GB");
	await expect(page.getByTestId("cleanup-what-tmp")).toHaveText(
		"Cleared at every restart, and the system removes anything untouched for 30 days.",
	);
	await expect(page.getByTestId("cleanup-info-kernels")).toHaveText(
		"Running 6.8.0-147-generic, newest installed 6.8.0-149-generic.",
	);
	await expect(page.getByTestId("cleanup-info-timeshift")).toHaveText("3 snapshots. Newest 2026-11-12_14-11-59.");
	await expect(page.getByTestId("cleanup-info-hand-backups")).toHaveText("39 copies.");
});

test("the review sheet names the total before anything runs", async ({ page }) => {
	await openCleanup(page);
	await expect(page.getByTestId("cleanup-review")).toHaveText("Review 2.4 GB");
	await page.getByTestId("cleanup-review").click();
	await expect(page.getByTestId("cleanup-review-title")).toHaveText("Delete these?");
	await expect(page.getByTestId("cleanup-total")).toHaveText("2.4 GB in all.");
	await expect(page.getByTestId("cleanup-confirm")).toHaveText("Delete 2.4 GB");
	await expect(page.getByTestId("cleanup-final")).toHaveText("Cannot be undone: Upkeep's leftover copies.");
	await expect(page.getByTestId("cleanup-command")).toHaveText([
		"sudo -n apt-get clean",
		"flatpak uninstall --system -y --noninteractive org.freedesktop.Platform.GL.nvidia-580-159-03/x86_64/1.4",
		"flatpak uninstall --system -y --noninteractive org.freedesktop.Platform.GL.nvidia-580-173-02/x86_64/1.4",
	]);
	await expect(page.getByTestId("cleanup-type")).toHaveCount(0);
	// Only the review was asked for; nothing ran.
	expect((await ops(page)).filter((op) => op.startsWith("cleanupRun"))).toEqual([]);
	await page.getByTestId("cleanup-back").click();
	await expect(page.getByTestId("cleanup-sheet")).toHaveCount(0);
	expect((await ops(page)).filter((op) => op.startsWith("cleanupRun"))).toEqual([]);
	// Unticking everything leaves nothing to review.
	for (const id of ["thumbnails", "apt-cache", "flatpak-gl"]) await page.getByTestId(`cleanup-tick-${id}`).uncheck();
	// Leftovers is half ticked: one copy is newer than its live file. Its other part is unticked on its own.
	await page.getByTestId("cleanup-part-leftovers-0").getByRole("checkbox").uncheck();
	await expect(page.getByTestId("cleanup-review")).toBeDisabled();
	await expect(page.getByTestId("cleanup-why-review")).toHaveText("Tick something to clean.");
});

test("removing packages needs the word typed before Delete works", async ({ page }) => {
	await openCleanup(page);
	await expect(page.getByTestId("cleanup-packages")).toHaveText("libfoo1, libbar2");
	await page.getByTestId("cleanup-tick-autoremove").check();
	await page.getByTestId("cleanup-review").click();
	await expect(page.getByTestId("cleanup-type-label")).toHaveText("Type remove to also remove packages");
	await expect(page.getByTestId("cleanup-command")).toContainText([
		"sudo -n env DEBIAN_FRONTEND=noninteractive apt-get autoremove -y",
	]);
	await expect(page.getByTestId("cleanup-confirm")).toBeDisabled();
	await page.getByTestId("cleanup-type").fill("remov");
	await expect(page.getByTestId("cleanup-confirm")).toBeDisabled();
	await page.getByTestId("cleanup-type").fill("remove");
	await expect(page.getByTestId("cleanup-confirm")).toBeEnabled();
	// apt does not say what autoremove freed, so its result shows no size rather than 0 B.
	await page.getByTestId("cleanup-confirm").click();
	const removed = page.getByTestId("cleanup-result-autoremove");
	await expect(removed.getByTestId("cleanup-result-state")).toHaveText("Cleaned");
	await expect(removed.getByTestId("cleanup-result-size")).toHaveCount(0);
});

test("a confirmed cleanup shows each item's result and what it freed, and History lists it", async ({ page }) => {
	await openCleanup(page);
	await page.getByTestId("cleanup-tick-flatpak-gl").uncheck();
	await page.getByTestId("cleanup-tick-apt-cache").uncheck();
	await page.getByTestId("cleanup-review").click();
	await page.getByTestId("cleanup-confirm").click();
	await expect(page.getByTestId("cleanup-state-thumbnails")).toHaveText(/^(Cleaning|Waiting|Cleaned)$/);
	await expect(page.getByTestId("cleanup-freed")).toHaveText("Freed 43 MB.");
	const thumbs = page.getByTestId("cleanup-result-thumbnails");
	await expect(thumbs.getByTestId("cleanup-result-state")).toHaveText("Cleaned");
	await expect(thumbs.getByTestId("cleanup-result-size")).toBeVisible();
	await expect(page.getByTestId("cleanup-result-leftovers").getByTestId("cleanup-result-state")).toHaveText("Cleaned");
	expect(await ops(page)).toContain("cleanupRun:thumbnails,leftovers");
	// The cleaned item left the list; the newer copy it kept stays.
	await expect(page.getByTestId("cleanup-item-thumbnails")).toHaveCount(0);
	await expect(page.getByTestId("cleanup-part-leftovers-0")).toContainText("rg.upkeep-tmp");
	await page.getByTestId("cleanup-dismiss").click();
	await expect(page.getByTestId("cleanup-summary")).toHaveCount(0);
	await page.getByTestId("tab-history").click();
	await expect(page.getByTestId("history-freed").first()).toHaveText(/ freed$/);
	await expect(page.getByTestId("history").getByText("Thumbnails")).toBeVisible();
});
