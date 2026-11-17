import type { ElectrobunConfig } from "electrobun";
import pkg from "./package.json";
import { RELEASE_BASE_URL } from "./src/bun/about";

export default {
	app: {
		name: "Upkeep",
		identifier: "dev.afk.upkeep",
		// One source for the version: package.json. UPKEEP_VERSION exists for the self-update trial's builds only.
		version: process.env.UPKEEP_VERSION ?? pkg.version,
	},
	// Where an installed Upkeep looks for its own updates: this repo's latest release, whose files have flat names.
	// UPKEEP_RELEASE_BASE_URL exists for the self-update trial, which serves builds from 127.0.0.1; scripts/release.sh
	// refuses to build with it set, since an install with a local address would take an update from any local user.
	release: { baseUrl: process.env.UPKEEP_RELEASE_BASE_URL ?? RELEASE_BASE_URL },
	runtime: {
		// Closing the window hides it; the tray keeps the app alive.
		exitOnLastWindowClosed: false,
	},
	// Puts the tray library Upkeep carries beside the launcher, before the app is packed (scripts/post-build.ts).
	scripts: { postBuild: "scripts/post-build.ts" },
	build: {
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			// The command line, bundled by the view build (vite.config.ts); the `upkeep` command runs it with the install's Bun.
			"dist/cli/cli.js": "cli/cli.js",
			"manifest/apps.toml": "manifest/apps.toml",
			catalogue: "catalogue",
			"assets/tray": "views/tray",
		},
		watchIgnore: ["dist/**"],
		mac: { bundleCEF: false },
		linux: { bundleCEF: false, icon: "assets/icon/upkeep.png" },
		win: { bundleCEF: false },
	},
} satisfies ElectrobunConfig;
