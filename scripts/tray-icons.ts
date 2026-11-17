// Renders the tray pictures and the launcher icon from the drawings in assets/brand.
// Run with `bun scripts/tray-icons.ts` after a drawing changes. The PNGs are committed, so a build never needs a renderer.
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const brand = join(import.meta.dir, "../assets/brand");
const trayOut = join(import.meta.dir, "../assets/tray");

// librsvg through GdkPixbuf, the renderer the desktop itself uses for icons. ImageMagick's own SVG reader
// fills the knocked-out digits of the count badges wrongly.
const PY = `import sys, gi
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf
src, dst, px = sys.argv[1], sys.argv[2], int(sys.argv[3])
GdkPixbuf.Pixbuf.new_from_file_at_size(src, px, px).savev(dst, "png", [], [])`;

/** Draws one SVG to a PNG of px by px through GdkPixbuf, because rsvg and Inkscape fill the knocked-out digits wrongly. Throws with Python's stderr on failure. */
function render(svg: string, png: string, px: number): void {
	const done = Bun.spawnSync(["python3", "-c", PY, svg, png, String(px)]);
	if (done.exitCode !== 0) throw new Error(`render failed for ${svg}: ${done.stderr.toString()}`);
}

// From the masters fitted by hand: 44 px for a 2x screen (<name>.png), 22 px for a 1x one (<name>-22.png), where the
// 44 px pictures scaled down go soft. The light drawings are for a dark panel, the dark ones for a light panel
// (<name>-dark.png, <name>-dark-22.png); src/bun/panel.ts picks the tone, src/bun/index.ts the size.
mkdirSync(trayOut, { recursive: true });
let count = 0;
const SETS: [string, string, number][] = [
	["tray-light-44", "", 44],
	["tray-dark-44", "-dark", 44],
	["tray-light", "-22", 22],
	["tray-dark", "-dark-22", 22],
];
for (const [dir, suffix, px] of SETS) {
	const src = join(brand, dir);
	for (const f of readdirSync(src).filter((name) => name.endsWith(".svg"))) {
		render(join(src, f), join(trayOut, f.replace(/\.svg$/, `${suffix}.png`)), px);
		count++;
	}
}
render(join(brand, "app-icon-512.svg"), join(import.meta.dir, "../assets/icon/upkeep.png"), 512);
console.log(`tray icons: ${count} written to ${trayOut}; launcher icon written`);
