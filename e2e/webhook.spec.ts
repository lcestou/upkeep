import { expect, load, test } from "./helpers";

test("a notice address is refused when it is not one or is plain http to the internet, then kept masked, with its two choices", async ({
	page,
}) => {
	await load(page);
	await page.getByTestId("tab-settings").click();
	await expect(page.getByTestId("setting-webhook-label")).toHaveText("Send a notice to a web address");
	await expect(page.getByTestId("setting-webhook-hint")).toHaveText(
		"Upkeep posts a short JSON message there, such as to an ntfy topic or a home server. The address may hold a token: it is kept on this computer, readable by you alone, and never exported.",
	);
	// The choices of when appear only once an address is kept.
	await expect(page.getByTestId("setting-webhook-ready")).toHaveCount(0);
	const input = page.getByTestId("webhook-input");
	await expect(page.getByTestId("webhook-save")).toHaveText("Save address");
	await input.fill("ntfy.sh/topic");
	await page.getByTestId("webhook-save").click();
	await expect(page.getByTestId("webhook-refused")).toHaveText("That is not a web address. It starts with https://.");
	await input.fill("http://ntfy.sh/topic");
	await page.getByTestId("webhook-save").click();
	await expect(page.getByTestId("webhook-refused")).toHaveText(
		"Plain http only goes to this computer or the home network. Use https for anywhere else.",
	);
	await input.fill("https://ntfy.sh/secret-topic?auth=abc");
	await input.press("Enter");
	await expect(page.getByTestId("webhook-kept")).toHaveText("Notices go to https://ntfy.sh/…");
	await expect(page.getByTestId("webhook-refused")).toHaveCount(0);
	await expect(page.getByTestId("settings")).not.toContainText("secret-topic");
	await expect(page.getByTestId("setting-webhook-ready-label")).toHaveText("When updates are ready");
	await expect(page.getByTestId("setting-webhook-run-label")).toHaveText("After each run, with its result");
	await expect(page.getByTestId("setting-webhook-ready")).toBeChecked();
	await expect(page.getByTestId("setting-webhook-run")).not.toBeChecked();
	await page.getByTestId("setting-webhook-run").check();
	await expect(page.getByTestId("setting-webhook-run")).toBeChecked();
	await expect(page.getByTestId("webhook-remove")).toHaveText("Remove address");
	await page.getByTestId("webhook-remove").click();
	await expect(page.getByTestId("webhook-input")).toHaveValue("");
	// A private 172.16/12 address takes plain http; a bare origin shows with no mask.
	await input.fill("http://172.20.0.5:2586");
	await page.getByTestId("webhook-save").click();
	await expect(page.getByTestId("webhook-kept")).toHaveText("Notices go to http://172.20.0.5:2586/");
	await page.getByTestId("webhook-remove").click();
	await expect(page.getByTestId("setting-webhook-run")).toHaveCount(0);
});

test("an import whose file names a notice address shows its host with the rest masked, and keeps it only on Import", async ({
	page,
}) => {
	await load(page, "fixture&webhook=import");
	await page.getByTestId("tab-settings").click();
	await page.getByTestId("import-setup").click();
	await expect(page.getByTestId("import-webhook")).toHaveText(
		"It sends Upkeep's notices, with the app list, to this address:",
	);
	await expect(page.getByTestId("import-webhook-address")).toHaveText("https://ntfy.example.net/…");
	await expect(page.getByTestId("settings")).not.toContainText("upkeep-home");
	await expect(page.getByTestId("webhook-kept")).toHaveCount(0);
	await page.getByTestId("import-confirm").click();
	await expect(page.getByTestId("import-webhook")).toHaveCount(0);
	// Settings reads the address again on its next visit.
	await page.getByTestId("tab-updates").click();
	await page.getByTestId("tab-settings").click();
	await expect(page.getByTestId("webhook-kept")).toHaveText("Notices go to https://ntfy.example.net/…");
});
