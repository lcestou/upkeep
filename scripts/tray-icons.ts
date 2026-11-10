// Renders the tray pictures. Run with `bun scripts/tray-icons.ts` after changing a shape or a colour;
// both the SVG sources and the PNGs are committed, so a build never needs ImageMagick.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "../assets/tray");
const TAG_WHITE = "#e8f0e4";
const SUN = "#f2d24a";
const WATER = "#6db7e8";
const RUST = "#e0714a";
const INK = "#16201b";

// A sprout: one stem, two leaves. Drawn on a 22 unit grid, the size a panel icon gets.
const sprout = `<path d="M11 20V10M11 10C11 6 8 3 3 3c0 5 3 7 8 7Zm0 3c0-3 2.500-5 8-5 0 4-3 6-8 5Z" fill="none" stroke="${TAG_WHITE}" stroke-width="1.800" stroke-linecap="round" stroke-linejoin="round"/>`;

function badge(fill: string, text: string): string {
	const size = text.length > 1 ? 7 : 9;
	const y = text.length > 1 ? 18.6 : 19.3;
	return `<circle cx="16" cy="16" r="6" fill="${fill}"/><text x="16" y="${y}" font-family="DejaVu Sans" font-weight="700" font-size="${size}" text-anchor="middle" fill="${INK}">${text}</text>`;
}

const icons: Record<string, string> = {
	idle: sprout,
	working: `${sprout}<circle cx="16.500" cy="16.500" r="4.500" fill="${WATER}"/>`,
	failed: sprout + badge(RUST, "!"),
	"count-9plus": sprout + badge(SUN, "9+"),
};
for (let n = 1; n <= 9; n++) icons[`count-${n}`] = sprout + badge(SUN, String(n));

mkdirSync(dir, { recursive: true });
for (const [name, body] of Object.entries(icons)) {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">${body}</svg>\n`;
	const svgFile = join(dir, `${name}.svg`);
	writeFileSync(svgFile, svg);
	// 44 px is 22 at the 2x scale of the owner's displays; the panel scales it down on a 1x screen.
	const done = Bun.spawnSync([
		"convert",
		"-background",
		"none",
		"-density",
		"384",
		svgFile,
		"-resize",
		"44x44",
		join(dir, `${name}.png`),
	]);
	if (done.exitCode !== 0) throw new Error(`convert failed for ${name}: ${done.stderr.toString()}`);
}
console.log(`tray icons: ${Object.keys(icons).length} written to ${dir}`);
