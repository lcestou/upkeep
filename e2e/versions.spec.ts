import { expect, load, sentence, test } from "./helpers";

test("Follow pre-releases offers the next candidate, and switching it off goes back to the stable release", async ({
	page,
}) => {
	await load(page);
	// The fresh group starts folded.
	await page.getByTestId("group-fresh-toggle").click();
	await page.getByTestId("open-yazi").click();
	const box = page.getByTestId("prerelease-yazi");
	await expect(box).not.toBeChecked();
	await expect(page.getByTestId("prerelease-label")).toHaveText("Follow pre-releases");
	await expect(page.getByTestId("pane-status")).toHaveText("Fresh");
	await box.check();
	await expect(page.getByTestId("status-yazi")).toHaveText("Ready");
	await expect(page.getByTestId("detail-yazi")).toContainText("26.1.23-rc.1");
	await box.uncheck();
	await expect(page.getByTestId("pane-status")).toHaveText("Fresh");
	// A command app has no release list: no switch and no other versions.
	await page.getByTestId("open-wrangler").click();
	await expect(page.getByTestId("prerelease-wrangler")).toHaveCount(0);
	await expect(page.getByTestId("versions-wrangler")).toHaveCount(0);
});

test("Other versions asks for the releases only on the press, and an older one installs held there", async ({
	page,
}) => {
	await load(page, "fixture&speed=4");
	await page.getByTestId("group-fresh-toggle").click();
	await page.getByTestId("open-yazi").click();
	const block = page.getByTestId("versions-yazi");
	await expect(block.getByTestId("versions-heading")).toHaveText("Other versions");
	await expect(block.getByTestId("versions-hint")).toHaveText(
		"An older release is held once it is in, so checks stop offering the latest until you release the hold.",
	);
	await expect(page.getByTestId("version-yazi-26.1.22")).toHaveCount(0);
	await expect(page.getByTestId("versions-show-yazi")).toHaveText("Show releases");
	await page.getByTestId("versions-show-yazi").click();
	await expect(page.getByTestId("version-pre-26.1.23-rc.1")).toHaveText("pre-release");
	await expect(page.getByTestId("version-installed-26.1.22")).toHaveText("installed");
	await expect(page.getByTestId("install-version-yazi-26.1.22")).toHaveCount(0);
	await expect(page.getByTestId("install-version-yazi-25.5.31")).toHaveText("Install 25.5.31");

	await page.getByTestId("install-version-yazi-25.5.31").click();
	await expect(page.getByTestId("version-yazi-25.5.31")).toHaveCount(0);
	await expect(sentence(page)).toHaveText("1 updated", { timeout: 10_000 });
	await expect(page.getByTestId("pane-status")).toHaveText("Updated to 25.5.31");
	await page.getByTestId("done").click();
	await expect(page.getByTestId("group-held")).toHaveText("Held back");
	await expect(page.getByTestId("status-yazi")).toHaveText("Held");
	await page.getByTestId("open-yazi").click();
	await expect(page.getByTestId("held-at")).toHaveText("Held at 25.5.31.");
	await expect(page.getByTestId("hold-yazi")).toHaveText("Release hold");
	await page.getByTestId("hold-yazi").click();
	await expect(page.getByTestId("status-yazi")).toHaveText("Ready");
	await expect(page.getByTestId("held-at")).toHaveCount(0);
});
