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
		"Lists your system's own pending updates: Flatpak apps and runtimes, Snaps, Cinnamon's applets, desklets, extensions and themes, and the packages your package manager would install (Update Manager on Linux Mint, else apt, dnf, pacman or zypper). Not counted in the tray number.",
	);
	await expect(page.getByTestId("extras-group")).toHaveText("Extras");
	await page.getByTestId("setting-system").check();
	await page.getByTestId("tab-updates").click();
	await expect(page.getByTestId("group-system")).toHaveText("System");
	// It shows at once in its checking state, then lists.
	await expect(page.getByTestId("system-checked")).toHaveText("From Update Manager, checking");
	await expect(page.getByTestId("system-checked")).toHaveText(/^From Update Manager, checked /);
	await expect(page.getByTestId("count-system")).toHaveText("11");
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
	await expect(page.locator('[data-testid^="sys-row-"]')).toHaveCount(11);
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
	// A Cinnamon spice, as Update Manager lists it too.
	const spice = page.getByTestId("sys-row-cinnamon:extension:CinnamonBurnMyWindows@klangman");
	await expect(spice.getByTestId("sys-name")).toHaveText("Burn My Windows");
	await expect(spice.getByTestId("sys-type")).toHaveText("Cinnamon extension");
	await expect(spice.getByTestId("sys-ver")).toHaveAttribute("title", "2026.11.11 → 2026.11.12");
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
		"No package list Upkeep can read is installed (Update Manager, apt, dnf, pacman or zypper). Flatpak updates still show here.",
	);
	await expect(page.getByTestId("system-problem")).toHaveCount(0);
	await expect(page.locator('[data-testid^="sys-row-flatpak:"]')).toHaveCount(3);

	await load(page, "fixture&system=failed");
	// Folded, the group still shows that something needs a look. (The fold is remembered, so fold it again here.)
	await page.getByTestId("group-system-toggle").click();
	await expect(page.getByTestId("group-system-toggle")).toHaveAttribute("aria-expanded", "false");
	await expect(page.getByTestId("system-warn")).toHaveAttribute(
		"aria-label",
		"Could not read the Flatpak list: error: Unable to load summary from remote flathub: Could not resolve host: dl.flathub.org",
	);

	await load(page, "fixture&system=failed");
	await openGroup(page);
	await expect(page.getByTestId("system-problem")).toHaveText(
		"Could not read the Flatpak list: error: Unable to load summary from remote flathub: Could not resolve host: dl.flathub.org",
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

test("installing is a second switch, off by default and shown only while the list is", async ({ page }) => {
	await load(page, "fixture&system=show");
	await page.getByTestId("tab-settings").click();
	const install = page.getByTestId("setting-system-install");
	await expect(install).not.toBeChecked();
	await expect(page.getByTestId("setting-system-install-help")).toHaveText(
		"Tick rows in the System group and install them from there. Kernels and the NVIDIA driver stay with the system's own updater, because both need a restart. Packages and Snaps install through sudo, which must not ask for a password.",
	);
	await page.getByTestId("tab-updates").click();
	await openGroup(page);
	// Off: the group stays read-only, with no tick and no Install.
	await expect(page.locator('[data-testid^="sys-tick-"]')).toHaveCount(0);
	await expect(page.getByTestId("system-install")).toHaveCount(0);
	await page.getByTestId("tab-settings").click();
	await install.check();
	await page.getByTestId("tab-updates").click();
	await expect(page.getByTestId("sys-tick-apt:perl")).toBeVisible();
	await page.getByTestId("tab-settings").click();
	await page.getByTestId("setting-system").uncheck();
	await expect(page.getByTestId("setting-system-install")).toHaveCount(0);
	await page.getByTestId("setting-system").check();
	await expect(page.getByTestId("setting-system-install")).not.toBeChecked();
});

test("kernel and driver rows have no tick; the rows Upkeep installs do", async ({ page }) => {
	await load(page, "fixture&system=install");
	await openGroup(page);
	await expect(page.getByTestId("sys-tick-apt:linux-generic")).toHaveCount(0);
	await expect(page.getByTestId("sys-tick-apt:nvidia-driver-580")).toHaveCount(0);
	await expect(page.getByTestId("sys-row-apt:linux-generic").getByTestId("sys-note")).toHaveText(
		"Needs a restart after it installs.",
	);
	await expect(page.locator('[data-testid^="sys-tick-"]')).toHaveCount(9);
	for (const id of ["apt:perl", "flatpak:com.discordapp.Discord", "cinnamon:extension:CinnamonBurnMyWindows@klangman"])
		await expect(page.getByTestId(`sys-tick-${id}`)).not.toBeChecked();
	await expect(
		page.getByTestId("sys-row-cinnamon:extension:CinnamonBurnMyWindows@klangman").getByTestId("sys-note"),
	).toHaveText("Installs with every Cinnamon extension that has an update.");
	await expect(page.getByTestId("system-install")).toBeDisabled();
	await expect(page.getByTestId("system-install")).toHaveText("Install system updates");
});

test("the confirm sheet names the commands before anything runs, and a finished install shows each row's result", async ({
	page,
}) => {
	await load(page, "fixture&system=install");
	await openGroup(page);
	for (const id of ["apt:perl", "apt:libsoup3", "flatpak:com.discordapp.Discord"])
		await page.getByTestId(`sys-tick-${id}`).check();
	await expect(page.getByTestId("system-install")).toHaveText("Install 3 system updates");
	await page.getByTestId("system-install").click();
	await expect(page.getByTestId("system-confirm-ask")).toHaveText("Upkeep runs these commands, in this order:");
	await expect(page.getByTestId("system-command")).toHaveText([
		"sudo -n mintupdate-cli upgrade -y --keep-configuration -i linux,linux-signed*,linux-meta*,linux-hwe*,nvidia-graphics-drivers-*,google-chrome-stable,libgphoto2,openjdk-21,linux-generic,nvidia-driver-580",
		"flatpak update -y --noninteractive com.discordapp.Discord",
	]);
	await expect(page.getByTestId("system-confirm-root")).toHaveText(
		"The commands that start with sudo need administrator rights and run as root.",
	);
	// Nothing ran yet: only the plan was asked for.
	expect((await sysOps(page)).filter((op) => op.startsWith("systemInstall"))).toEqual([]);
	await page.getByTestId("system-cancel").click();
	await expect(page.getByTestId("system-confirm-sheet")).toHaveCount(0);
	expect((await sysOps(page)).filter((op) => op.startsWith("systemInstall"))).toEqual([]);

	await page.getByTestId("system-install").click();
	await page.getByTestId("system-confirm").click();
	await expect(page.getByTestId("sys-row-apt:perl").getByTestId("sys-state")).toHaveText("Installing");
	expect(await sysOps(page)).toContain("systemInstall:apt:libsoup3,apt:perl,flatpak:com.discordapp.Discord");
	await expect(page.getByTestId("system-summary")).toHaveText("Installed 2 of 3.");
	await expect(page.getByTestId("sys-result-apt:perl").getByTestId("sys-result-state")).toHaveText("Installed");
	const soup = page.getByTestId("sys-result-apt:libsoup3");
	await expect(soup.getByTestId("sys-result-state")).toHaveText("Failed");
	await expect(soup.getByTestId("sys-result-detail")).toHaveText("Still pending after the install. See the log.");
	// The installed rows left the list; the failed one stays, unticked.
	await expect(page.getByTestId("sys-row-apt:perl")).toHaveCount(0);
	await expect(page.getByTestId("sys-tick-apt:libsoup3")).not.toBeChecked();
	await page.getByTestId("system-dismiss").click();
	await expect(page.getByTestId("system-results")).toHaveCount(0);
});

test("a refused pre-check shows its reason and nothing installs", async ({ page }) => {
	await load(page, "fixture&system=refuse");
	await openGroup(page);
	await page.getByTestId("sys-tick-apt:perl").check();
	await page.getByTestId("system-install").click();
	await page.getByTestId("system-confirm").click();
	await expect(page.getByTestId("system-refused")).toHaveText(
		"sudo needs a password here, so nothing was installed. Install these from the system's own updater.",
	);
	await expect(page.getByTestId("sys-row-apt:perl")).toBeVisible();
	await expect(page.getByTestId("system-results")).toHaveCount(0);
});

test("on plain apt, package rows tick and install through apt-get --only-upgrade, never a kernel or driver", async ({
	page,
}) => {
	await load(page, "fixture&system=apt");
	await page.getByTestId("tab-settings").click();
	await page.getByTestId("setting-system-install").check();
	await page.getByTestId("tab-updates").click();
	await openGroup(page);
	await page.getByTestId("sys-tick-apt:perl").check();
	await expect(page.getByTestId("sys-tick-apt:linux-generic")).toHaveCount(0);
	await expect(page.getByTestId("sys-tick-apt:nvidia-driver-580")).toHaveCount(0);
	await expect(page.getByTestId("sys-row-apt:perl").getByTestId("sys-note")).toHaveCount(0);
	await page.getByTestId("system-install").click();
	await expect(page.getByTestId("system-command")).toContainText([
		"sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install --only-upgrade -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold perl",
	]);
});

test("with dnf, package rows tick and install through dnf upgrade, never a kernel or driver row", async ({ page }) => {
	await load(page, "fixture&system=dnf");
	await page.getByTestId("tab-settings").click();
	await page.getByTestId("setting-system-install").check();
	await page.getByTestId("tab-updates").click();
	await openGroup(page);
	await expect(page.getByTestId("sys-row-dnf:perl").getByTestId("sys-note")).toHaveCount(0);
	await page.getByTestId("sys-tick-dnf:perl").check();
	await expect(page.getByTestId("sys-tick-dnf:linux-generic")).toHaveCount(0);
	await expect(page.getByTestId("sys-row-dnf:linux-generic").getByTestId("sys-note")).toHaveText(
		"Install it with dnf.",
	);
	await page.getByTestId("system-install").click();
	await expect(page.getByTestId("system-command")).toContainText([
		"sudo -n dnf upgrade -y --exclude=kernel* --exclude=*nvidia* perl",
	]);
});

test("with pacman, package rows have no tick and name the system's own tool", async ({ page }) => {
	await load(page, "fixture&system=pacman");
	await page.getByTestId("tab-settings").click();
	await page.getByTestId("setting-system-install").check();
	await page.getByTestId("tab-updates").click();
	await openGroup(page);
	const perl = page.getByTestId("sys-row-pacman:perl");
	await expect(perl.getByTestId("sys-tick-pacman:perl")).toHaveCount(0);
	await expect(perl.getByTestId("sys-note")).toHaveText("Install it with pacman.");
	await expect(page.getByTestId("sys-tick-flatpak:com.discordapp.Discord")).toBeVisible();
	// A row Upkeep installs is not sent to apt.
	await expect(page.getByTestId("sys-row-flatpak:com.discordapp.Discord").getByTestId("sys-note")).toHaveCount(0);
});
