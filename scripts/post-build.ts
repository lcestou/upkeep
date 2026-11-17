// Electrobun's postBuild hook (electrobun.config.ts): runs after the app folder is built and before it is packed.
// It puts the tray library Upkeep carries, and what it links, beside the launcher (scripts/tray-libs.sh fetches them).
// Electrobun's native library links libayatana-appindicator3.so.1 by name and the launcher loads it before any app
// code runs, so on a system without it (Fedora Workstation, Silverblue, Bazzite) Upkeep would not start at all. The
// launcher's LD_LIBRARY_PATH is its own bin folder, which is why they go there and not in the app's resources. Copy
// targets outside the app's resources are refused by the build, hence a hook.
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const buildDir = process.env.ELECTROBUN_BUILD_DIR ?? "";
const arch = process.env.ELECTROBUN_ARCH === "arm64" ? "arm64" : "x64";
const libs = join(import.meta.dir, "../vendor/tray-libs", `linux-${arch}`);
// The app folder is the one holding the launcher: Upkeep, or Upkeep-dev for a dev build.
const bins = readdirSync(buildDir)
	.map((d) => join(buildDir, d, "bin"))
	.filter((b) => existsSync(join(b, "launcher")));
if (bins.length === 0) throw new Error(`post-build: no app folder with bin/launcher in ${buildDir}`);
for (const bin of bins) for (const lib of readdirSync(libs)) copyFileSync(join(libs, lib), join(bin, lib));
console.log(`post-build: tray libraries (${arch}) copied to ${bins.join(", ")}`);
