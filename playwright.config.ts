import { defineConfig } from "playwright/test";

export default defineConfig({
	testDir: "e2e",
	workers: 1,
	fullyParallel: false,
	retries: 0,
	timeout: 60_000,
	reporter: [["list"]],
	// Kept under node_modules, which git already ignores, so a run leaves the worktree clean.
	outputDir: "node_modules/.cache/e2e-results",
	use: {
		baseURL: "http://127.0.0.1:5182",
		browserName: "chromium",
		viewport: { width: 980, height: 720 },
		deviceScaleFactor: 2,
		colorScheme: "dark",
	},
	webServer: {
		command: "node node_modules/vite/bin/vite.js --port 5182 --strictPort",
		url: "http://127.0.0.1:5182/",
		reuseExistingServer: false,
		timeout: 30_000,
	},
});
