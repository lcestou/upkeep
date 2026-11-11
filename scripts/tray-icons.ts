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

// The light drawings, for a dark panel, from the masters fitted by hand at 44 px: 22 at the 2x scale of the owner's
// displays, which the panel scales down on a 1x screen. assets/brand also holds 22 px masters and dark drawings.
// shortcut: one picture set, light at 44 px; pick by panel theme and scale when someone runs a light or 1x panel.
const traySrc = join(brand, "tray-light-44");
mkdirSync(trayOut, { recursive: true });
const names = readdirSync(traySrc).filter((f) => f.endsWith(".svg"));
for (const f of names) {
	render(join(traySrc, f), join(trayOut, f.replace(/\.svg$/, ".png")), 44);
}
render(join(brand, "app-icon-512.svg"), join(import.meta.dir, "../assets/icon/upkeep.png"), 512);
console.log(`tray icons: ${names.length} written to ${trayOut}; launcher icon written`);
