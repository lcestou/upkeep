import AxeBuilder from "@axe-core/playwright";
import type { Page } from "playwright/test";
import { expect, load, test } from "./helpers";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * Violations that are on main already and not from Stop now, each excluded as exactly its rule on its selector (axe's
 * own exclude would drop every rule for the element).
 */
const PRE_EXISTING: { rule: string; selector: string }[] = [
	// Pre-existing: History's scroll area (.history) takes no keyboard focus when its runs overflow, as at 760x520.
	// It fires on main with no run at all; the fix belongs to History, not to this branch.
	{ rule: "scrollable-region-focusable", selector: ".history" },
];

/** Runs axe over the page as it is now; each violation not listed in PRE_EXISTING comes back as "screen | rule | target". */
async function scan(page: Page, screen: string): Promise<string[]> {
	// Past any fade still running, so colour contrast reads the settled colours.
	await page.waitForTimeout(400);
	const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
	return r.violations.flatMap((v) =>
		v.nodes
			.filter((n) => !PRE_EXISTING.some((p) => p.rule === v.id && n.target.join(" ") === p.selector))
			.map((n) => `${screen} | ${v.id} | ${n.target.join(" ")}`),
	);
}

for (const locale of ["en-US", "de-DE"])
	for (const colorScheme of ["dark", "light"] as const)
		for (const size of [
			{ width: 980, height: 720 },
			{ width: 760, height: 520 },
		])
			test.describe(`${locale}, ${colorScheme}, ${size.width}x${size.height}`, () => {
				test.use({ locale, colorScheme, viewport: size, contextOptions: { reducedMotion: "reduce" } });

				test("Stop now's screens: quiet row, pane, footer, summary, History", async ({ page }) => {
					const found: string[] = [];
					await load(page, "fixture&speed=2&quiet=cut");
					await page.getByTestId("install").click();
					await page.getByTestId("stop-now-zen").waitFor();
					found.push(...(await scan(page, "quiet row")));
					await page.getByTestId("open-zen").click();
					await page.getByTestId("pane-quiet").waitFor();
					found.push(...(await scan(page, "pane quiet")));
					await page.getByTestId("stop").click();
					await page.getByTestId("stop-now").waitFor();
					found.push(...(await scan(page, "footer Stop now")));
					await page.getByTestId("stop-now").click();
					await page.getByTestId("done").waitFor({ timeout: 10_000 });
					found.push(...(await scan(page, "summary")));
					await page.getByTestId("tab-history").click();
					await page.getByTestId("history").waitFor();
					found.push(...(await scan(page, "History")));
					expect(found).toEqual([]);
				});

				test("Stop now waiting on a step it never cuts", async ({ page }) => {
					await load(page, "fixture&speed=1&quiet=root");
					await page.getByTestId("install").click();
					await page.getByTestId("stop-now-zen").click();
					await page.getByTestId("wait-zen").waitFor();
					const found = await scan(page, "waiting row");
					expect(found).toEqual([]);
				});
			});
