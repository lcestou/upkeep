import { expect, load, test } from "./helpers";

// The system webview can report a light scheme on a dark desktop; the window must stay dark regardless.
test.use({ colorScheme: "light" });

test("a light system scheme still renders the dark window", async ({ page }) => {
	await load(page);
	expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: light)").matches)).toBe(true);
	// The engine may report oklch(); paint each colour on a canvas to read it back as sRGB.
	const lum = (el: string) =>
		page.evaluate((selector) => {
			const node = document.querySelector(selector);
			if (!node) return -1;
			const css = selector === "body" ? getComputedStyle(node).backgroundColor : getComputedStyle(node).color;
			const ctx = document.createElement("canvas").getContext("2d");
			if (!ctx) return -1;
			ctx.fillStyle = css;
			ctx.fillRect(0, 0, 1, 1);
			const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
			return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
		}, el);
	expect(await lum("body")).toBeLessThan(0.15);
	expect(await lum('[data-testid="state-sentence"]')).toBeGreaterThan(0.85);
	expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");
});
