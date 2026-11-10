import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Upkeep",
		identifier: "dev.afk.upkeep",
		version: "0.1.0",
	},
	runtime: {
		// Closing the window hides it; the tray keeps the app alive.
		exitOnLastWindowClosed: false,
	},
	build: {
		mainProcess: "bun",
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
			"manifest/apps.toml": "manifest/apps.toml",
		},
		watchIgnore: ["dist/**"],
		mac: { bundleCEF: false },
		linux: { bundleCEF: false },
		win: { bundleCEF: false },
	},
} satisfies ElectrobunConfig;
