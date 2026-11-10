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

function render(svg: string, png: string, px: number): void {
	const done = Bun.spawnSync(["python3", "-c", PY, svg, png, String(px)]);
	if (done.exitCode !== 0) throw new Error(`render failed for ${svg}: ${done.stderr.toString()}`);
}

// The light drawings, for a dark panel. shortcut: a light panel would need assets/brand/tray-dark; pick by the desktop theme when someone runs one.
const traySrc = join(brand, "tray-light");
mkdirSync(trayOut, { recursive: true });
const names = readdirSync(traySrc).filter((f) => f.endsWith(".svg"));
for (const f of names) {
	// 44 px is 22 at the 2x scale of the owner's displays; the panel scales it down on a 1x screen.
	render(join(traySrc, f), join(trayOut, f.replace(/\.svg$/, ".png")), 44);
}
render(join(brand, "app-icon-512.svg"), join(import.meta.dir, "../assets/icon/upkeep.png"), 512);
console.log(`tray icons: ${names.length} written to ${trayOut}; launcher icon written`);
