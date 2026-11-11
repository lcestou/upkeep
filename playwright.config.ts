import { defineConfig } from "playwright/test";

// The main checkout and a worktree can run their specs side by side on different ports.
const port = Number(process.env.UPKEEP_E2E_PORT) || 5182;

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
		baseURL: `http://127.0.0.1:${port}`,
		viewport: { width: 980, height: 720 },
		deviceScaleFactor: 2,
		colorScheme: "dark",
	},
	// WebKit as well as Chromium: the real window is WebKitGTK.
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
		{ name: "webkit", use: { browserName: "webkit" } },
	],
	webServer: {
		command: `node node_modules/vite/bin/vite.js --port ${port} --strictPort`,
		url: `http://127.0.0.1:${port}/`,
		reuseExistingServer: false,
		timeout: 30_000,
	},
});
