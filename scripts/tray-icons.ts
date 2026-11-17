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

// From the masters fitted by hand at 44 px: 22 at the 2x scale of the owner's displays, which the panel scales down on
// a 1x screen. The light drawings are for a dark panel (<name>.png), the dark ones for a light panel (<name>-dark.png);
// src/bun/panel.ts picks the set. assets/brand also holds 22 px masters.
mkdirSync(trayOut, { recursive: true });
let count = 0;
const SETS: [string, string][] = [
	["tray-light-44", ""],
	["tray-dark-44", "-dark"],
];
for (const [dir, suffix] of SETS) {
	const src = join(brand, dir);
	for (const f of readdirSync(src).filter((name) => name.endsWith(".svg"))) {
		render(join(src, f), join(trayOut, f.replace(/\.svg$/, `${suffix}.png`)), 44);
		count++;
	}
}
render(join(brand, "app-icon-512.svg"), join(import.meta.dir, "../assets/icon/upkeep.png"), 512);
console.log(`tray icons: ${count} written to ${trayOut}; launcher icon written`);
