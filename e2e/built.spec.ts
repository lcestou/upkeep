import { expect, load, sentence, test } from "./helpers";

// Chunk 8 of the native-builds plan: what a built app is behind by, its build stage, and how its failures read.

test("a built app's pane lists the commits it is behind by, capped, with the rest counted", async ({ page }) => {
	await load(page, "fixture=built");
	await page.getByTestId("open-llama").click();
	await expect(page.getByTestId("commits-heading-llama")).toHaveText("569 commits since f2918cabb");
	const items = page.getByTestId("commits-list-llama").locator("li");
	await expect(items).toHaveCount(30);
	await expect(items.first()).toContainText("cd959bae9");
	await expect(page.getByTestId("commits-more-llama")).toHaveText("All 569 on GitHub (539 not shown)");
	// The note names the skill that weighs the commits.
	await expect(page.getByTestId("detail-llama")).toContainText("run /llama in a Claude session");
});

test("a list with every commit shown has no All line", async ({ page }) => {
	await load(page, "fixture=built");
	await page.getByTestId("open-whisper").click();
	await expect(page.getByTestId("commits-heading-whisper")).toHaveText("3 commits since v1.8.2");
	await expect(page.getByTestId("commits-list-whisper").locator("li")).toHaveCount(3);
	await expect(page.getByTestId("commits-more-whisper")).toHaveCount(0);
});

test("the commits list is a labelled tab stop, scrolls past twelve lines, and cuts long titles with the whole one in title", async ({
	page,
}) => {
	await load(page, "fixture=built");
	await page.getByTestId("open-llama").click();
	const list = page.getByTestId("commits-list-llama");
	await expect(list).toHaveAttribute("tabindex", "0");
	await expect(list).toHaveAccessibleName("569 commits since f2918cabb");
	await list.focus();
	await expect(list).toBeFocused();
	const box = await list.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
	expect(box.client).toBeLessThanOrEqual(12 * 22 + 1);
	expect(box.scroll).toBeGreaterThan(box.client);
	await page.keyboard.press("End");
	await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
	const long = page.getByTestId("commits-list-llama").locator("li", { hasText: "ggml : fix a race" });
	const title = await long.getAttribute("title");
	expect(title).toMatch(/on two GPUs at once$/);
	const cut = await long.locator(".ct").evaluate((el) => el.scrollWidth > el.clientWidth);
	expect(cut).toBe(true);
	// Nothing in the pane scrolls sideways.
	const side = await page.getByTestId("detail-llama").evaluate((el) => {
		const scroller = el.closest(".scroll") ?? el;
		return scroller.scrollWidth - scroller.clientWidth;
	});
	expect(side).toBeLessThanOrEqual(0);
});

test("a built row's stem has five stages summing to 100, and shows Build while it builds", async ({ page }) => {
	await load(page, "fixture=built&speed=0.4");
	await page.getByTestId("select-none").click();
	await page.getByTestId("tick-llama").check();
	await page.getByTestId("install").click();
	const stem = page.getByTestId("stem-llama");
	const spans = stem.locator(".span");
	await expect(spans).toHaveCount(5);
	const weights = await spans.evaluateAll((els) => els.map((e) => Number(getComputedStyle(e).flexGrow)));
	expect(weights.reduce((a, b) => a + b, 0)).toBe(100);
	await expect(spans.nth(2)).toHaveAttribute("title", "Build");
	await expect(page.getByTestId("row-llama")).toContainText("Building", { timeout: 10_000 });
	await expect(stem.locator('.span.active[title="Build"]')).toHaveCount(1);
	await expect(sentence(page)).toHaveText("1 updated", { timeout: 20_000 });
});

test("each starred failure of the plan reads its decided sentence on its row", async ({ page }) => {
	await load(page, "fixture=built&speed=4");
	await page.getByTestId("install").click();
	// btop's put-back could not stop its unit, so the run stops there and Neovim, queued after it, never starts.
	await expect(sentence(page)).toHaveText("1 updated, 7 failed, 1 not started", { timeout: 30_000 });
	await page.keyboard.press("Escape");
	const said = {
		strata: "sudo needs a password here, so nothing was stopped or changed.",
		comfyui: "The image queue has a job waiting. Nothing was changed.",
		cava: "Build step failed: cmake --build build -j 6. Nothing was changed.",
		dsh: "Would not start after the update. Restored 0.2.2-alpha.3.",
		whisper: "Failed its test after the update: whisper-cli starts. Restored v1.8.2.",
		tmux: "Would not start after the update, and putting 3.6a back failed: tmux did not answer. See the log.",
		btop: "Could not stop btop to put 1.4.3 back. See the log.",
	};
	for (const [key, text] of Object.entries(said)) await expect(page.getByTestId(`sentence-${key}`)).toHaveText(text);
});

test("a put-back that failed stops the run there, and Install waits until that app is restored by hand", async ({
	page,
}) => {
	await load(page, "fixture=built&speed=4");
	await page.getByTestId("select-none").click();
	await page.getByTestId("tick-neovim").check();
	await page.getByTestId("install").click();
	await expect(sentence(page)).toHaveText("0 updated, 1 failed", { timeout: 20_000 });
	await expect(page.getByTestId("sentence-neovim")).toHaveText(
		"Refused /home/you/src/neovim/runtime/link/doc: a link inside it leads outside what this table may change. Nothing was changed.",
	);
	await page.getByTestId("done").click();
	// The summary's controls, with their own Install for a not-started row, fade out while the list's fade in.
	await expect(page.getByTestId("done")).toHaveCount(0);
	await page.getByTestId("select-none").click();
	await page.getByTestId("tick-btop").check();
	await page.getByTestId("tick-neovim").check();
	await page.getByTestId("install").click();
	await expect(sentence(page)).toHaveText("0 updated, 1 failed, 1 not started", { timeout: 20_000 });
	await expect(page.getByTestId("sentence-btop")).toHaveText("Could not stop btop to put 1.4.3 back. See the log.");
	await expect(page.getByTestId("row-neovim")).not.toContainText("Refused");
	await page.getByTestId("done").click();
	// The summary's controls, with their own Install for a not-started row, fade out while the list's fade in.
	await expect(page.getByTestId("done")).toHaveCount(0);
	await expect(page.getByTestId("install")).toHaveCount(1);
	await page.getByTestId("install").click();
	const unrecovered = "An update was interrupted and could not be put back. Restore it from its row first.";
	await expect(page.getByTestId("refusal")).toHaveText(unrecovered);
	await page.getByTestId("row-btop").click();
	await page.getByTestId("restore-btop-1.4.2").click();
	await expect(page.getByTestId("restore-result")).toHaveText("Restored 1.4.2.");
	await page.keyboard.press("Escape");
	// The old button animates out for a moment after the pane closes.
	await expect(page.getByTestId("install")).toHaveCount(1);
	await page.getByTestId("install").click();
	await expect(page.getByTestId("refusal")).toHaveCount(0);
	await expect(sentence(page)).toHaveText(/updated|failed/, { timeout: 20_000 });
});
