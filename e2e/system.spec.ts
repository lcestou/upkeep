import type { Page } from "playwright/test";
import { expect, load, sentence, test } from "./helpers";

const sysOps = (page: Page) => page.evaluate(() => (globalThis as { upkeepSysOps?: string[] }).upkeepSysOps ?? []);
/** Opens the group; the fold is remembered for the session, so a reload may find it open already. */
async function openGroup(page: Page) {
	const toggle = page.getByTestId("group-system-toggle");
	if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

test("the System group is absent while the setting is off, and Settings shows and hides it", async ({ page }) => {
	await load(page);
	await expect(page.getByTestId("group-system-section")).toHaveCount(0);
	await page.getByTestId("tab-settings").click();
	await expect(page.getByTestId("setting-system-help")).toHaveText(
		"Lists your system's own pending updates: Flatpak apps and runtimes, and the packages your package manager would install (Update Manager on Linux Mint, else apt, dnf or pacman). Not counted in the tray number.",
	);
	await expect(page.getByTestId("extras-group")).toHaveText("Extras");
	await page.getByTestId("setting-system").check();
	await page.getByTestId("tab-updates").click();
	await expect(page.getByTestId("group-system")).toHaveText("System");
	// It shows at once in its checking state, then lists.
	await expect(page.getByTestId("system-checked")).toHaveText("From Update Manager, checking");
	await expect(page.getByTestId("system-checked")).toHaveText(/^From Update Manager, checked /);
	await expect(page.getByTestId("count-system")).toHaveText("10");
	await page.getByTestId("tab-settings").click();
	await page.getByTestId("setting-system").uncheck();
	await page.getByTestId("tab-updates").click();
	await expect(page.getByTestId("group-system-section")).toHaveCount(0);
});

test("the group sits last, folded with its count, and opens by click and by keyboard", async ({ page }) => {
	await load(page, "fixture&system=show");
	const heads = await page.locator('h2 [data-testid^="group-"], h2[data-testid^="group-"]').allTextContents();
	expect(heads.at(-1)).toBe("System");
	await expect(page.getByTestId("group-system-toggle")).toHaveAttribute("aria-expanded", "false");
	await expect(page.locator('[data-testid^="sys-row-"]')).toHaveCount(0);
	await openGroup(page);
	await expect(page.locator('[data-testid^="sys-row-"]')).toHaveCount(10);
	await page.getByTestId("group-system-toggle").press("Enter");
	await expect(page.locator('[data-testid^="sys-row-"]')).toHaveCount(0);
	await page.getByTestId("group-system-toggle").press("Space");
	await expect(page.getByTestId("group-system-toggle")).toHaveAttribute("aria-expanded", "true");
});

test("system rows read their type, versions and notes", async ({ page }) => {
	await load(page, "fixture&system=show");
	await openGroup(page);
	const perl = page.getByTestId("sys-row-apt:perl");
	await expect(perl.getByTestId("sys-name")).toHaveText("perl");
	await expect(perl.getByTestId("sys-type")).toHaveText("Security");
	await expect(perl.getByTestId("sys-ver")).toHaveAttribute("title", "5.38.2-3.2ubuntu0.6 → 5.38.2-3.2ubuntu0.7");
	await expect(page.getByTestId("sys-row-apt:google-chrome-stable").getByTestId("sys-type")).toHaveText("Package");
	const kernel = page.getByTestId("sys-row-apt:linux-generic");
	await expect(kernel.getByTestId("sys-type")).toHaveText("Kernel");
	await expect(kernel.getByTestId("sys-note")).toHaveText("Needs a restart after it installs.");
	await expect(page.getByTestId("sys-row-apt:nvidia-driver-580").getByTestId("sys-type")).toHaveText("Driver");
	const discord = page.getByTestId("sys-row-flatpak:com.discordapp.Discord");
	await expect(discord.getByTestId("sys-type")).toHaveText("Flatpak app");
	await expect(discord.getByTestId("sys-chip-running")).toHaveText("In use");
	await expect(perl.getByTestId("sys-note")).toHaveCount(0);
	const gimp = page.getByTestId("sys-row-flatpak:org.gimp.GIMP");
	await expect(gimp.getByTestId("sys-ver")).toHaveAttribute("title", "3.2.8 new build");
	await expect(gimp.getByTestId("sys-newbuild")).toHaveText("new build");
	const platform = page.getByTestId("sys-row-flatpak:org.gnome.Platform");
	await expect(platform.getByTestId("sys-type")).toHaveText("Flatpak runtime");
	// No installed version: the arrow, then latest.
	await expect(platform.getByTestId("sys-ver")).toHaveAttribute("title", "Not installed. 51 is the latest.");
	await expect(platform.getByTestId("sys-old")).toHaveText("");
	await expect(platform.getByTestId("sys-new")).toHaveText("51");
	await expect(platform.locator(".arrow")).toHaveCount(1);
});

test("system rows take no tick, no tab stop and no pane, and never change the counts", async ({ page }) => {
	await load(page);
	const before = { head: await sentence(page).textContent(), foot: await page.getByTestId("install").textContent() };
	await load(page, "fixture&system=show");
	await openGroup(page);
	expect(await sentence(page).textContent()).toBe(before.head);
	expect(await page.getByTestId("install").textContent()).toBe(before.foot);
	const rows = page.locator('[data-testid^="sys-row-"]');
	await expect(rows.locator("input, button, [tabindex]")).toHaveCount(0);
	await rows.first().click();
	await expect(page.locator("#inspector")).toHaveCount(0);
	// Select all ticks app rows only, and the footer still counts app updates only.
	await page.getByTestId("tick-all").click();
	await page.getByTestId("tick-all").click();
	await expect(page.getByTestId("install")).toHaveText(before.foot ?? "");
});

test("the filter narrows system rows, and opens the folded group while it is active", async ({ page }) => {
	await load(page, "fixture&system=show");
	await page.getByTestId("filter").fill("openjdk");
	await expect(page.locator('[data-testid^="sys-row-"]')).toHaveCount(1);
	await expect(page.getByTestId("sys-row-apt:openjdk-21")).toBeVisible();
	await expect(page.getByTestId("no-match")).toHaveCount(0);
	await page.getByTestId("filter").fill("");
	await expect(page.locator('[data-testid^="sys-row-"]')).toHaveCount(0);
});

test("Open Update Manager sends openTool, and Check again sends systemCheck only while shown", async ({ page }) => {
	await load(page);
	await page.getByTestId("check").click();
	await page.waitForTimeout(300);
	expect(await sysOps(page)).toEqual([]);
	await load(page, "fixture&system=show");
	await page.getByTestId("open-update-manager").focus();
	await page.keyboard.press("Enter");
	await expect.poll(() => sysOps(page)).toEqual(["openTool:update-manager"]);
	await page.getByTestId("check").click();
	await expect.poll(() => sysOps(page)).toEqual(["openTool:update-manager", "systemCheck"]);
	await expect(page.getByTestId("system-checked")).toHaveText("From Update Manager, checking");
});

test("each state of the group body says its own line", async ({ page }) => {
	await load(page, "fixture&system=checking");
	await openGroup(page);
	await expect(page.getByTestId("system-checking")).toHaveText("Checking system updates");
	await expect(page.getByTestId("system-checking").locator(".pulse")).toHaveCount(1);

	await load(page, "fixture&system=empty");
	await openGroup(page);
	await expect(page.getByTestId("system-none")).toHaveText("No system updates.");

	await load(page, "fixture&system=missing");
	// A system without Linux Mint's Update Manager is not at fault: no warning, no button for a tool it lacks, Flatpak still listed.
	await expect(page.getByTestId("system-warn")).toHaveCount(0);
	await expect(page.getByTestId("open-update-manager")).toHaveCount(0);
	await expect(page.getByTestId("system-checked")).toHaveText(/^From Flatpak/);
	await openGroup(page);
	await expect(page.getByTestId("system-absent")).toHaveText(
		"No package list Upkeep can read is installed (Update Manager, apt, dnf or pacman). Flatpak updates still show here.",
	);
	await expect(page.getByTestId("system-problem")).toHaveCount(0);
	await expect(page.locator('[data-testid^="sys-row-flatpak:"]')).toHaveCount(3);

	await load(page, "fixture&system=failed");
	// Folded, the group still shows that something needs a look. (The fold is remembered, so fold it again here.)
	await page.getByTestId("group-system-toggle").click();
	await expect(page.getByTestId("group-system-toggle")).toHaveAttribute("aria-expanded", "false");
	await expect(page.getByTestId("system-warn")).toHaveAttribute(
		"aria-label",
		"Could not read Flatpak's list: error: Unable to load summary from remote flathub: Could not resolve host: dl.flathub.org",
	);

	await load(page, "fixture&system=failed");
	await openGroup(page);
	await expect(page.getByTestId("system-problem")).toHaveText(
		"Could not read Flatpak's list: error: Unable to load summary from remote flathub: Could not resolve host: dl.flathub.org",
	);
	await expect(page.locator('[data-testid^="sys-row-apt:"]')).toHaveCount(7);

	await load(page, "fixture&system=gl");
	await openGroup(page);
	await expect(page.getByTestId("system-gl")).toHaveText(
		"Flatpak apps cannot use the GPU until the NVIDIA 580.178.04 runtime is installed. A Flatpak update installs it.",
	);
});

test("system rows share the app rows' column edges", async ({ page }) => {
	for (const width of [1400, 980, 760]) {
		await page.setViewportSize({ width, height: 900 });
		await load(page, "fixture&system=show");
		await openGroup(page);
		const edges = await page.evaluate(() => {
			const box = (el: Element | null) => (el ? Math.round(el.getBoundingClientRect().left * 2) / 2 : null);
			const app = document.querySelector('[data-testid="row-fd"]');
			const sys = document.querySelector('[data-testid="sys-row-apt:perl"]');
			const centre = (el: Element | null | undefined) => {
				const r = el?.getBoundingClientRect();
				return r ? Math.round((r.left + r.width / 2) * 2) / 2 : null;
			};
			return [
				...["mark", "name", "ver"].map((c) => [
					box(app?.querySelector(`.cell.${c}`) ?? null),
					box(sys?.querySelector(`.cell.${c}`) ?? null),
				]),
				[centre(app?.querySelector(".arrow")), centre(sys?.querySelector(".arrow"))],
			];
		});
		for (const [a, s] of edges) expect(s, `width ${width}`).toBe(a);
	}
});

test("on a system with apt and no Update Manager the packages come from apt, with no button for a window it lacks", async ({
	page,
}) => {
	await load(page, "fixture&system=apt");
	await expect(page.getByTestId("system-checked")).toHaveText(/^From apt, checked /);
	await expect(page.getByTestId("open-update-manager")).toHaveCount(0);
	await expect(page.getByTestId("system-absent")).toHaveCount(0);
	await expect(page.getByTestId("count-system")).toHaveText("10");
});
