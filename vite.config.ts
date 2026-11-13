import { defineConfig, type PluginOption } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { wuchale } from "wuchale/vite";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { electrobunViteAliases } from "./.hutch/devkit/api/config/electrobun-vite";

/**
 * Bundles the command line into dist/cli after each view build. The app build copies it into the install for the
 * `upkeep` command, and the view build empties dist first, so a view build alone (the real-window scripts run one)
 * would otherwise leave the app build without it. The dev server skips this: it never feeds an app build.
 */
function cliBundle(): PluginOption {
	return {
		name: "upkeep-cli-bundle",
		apply: "build",
		closeBundle() {
			const run = spawnSync("bun", ["build", "src/cli.ts", "--target=bun", "--outfile", "dist/cli/cli.js"], {
				cwd: __dirname,
				stdio: "inherit",
			});
			if (run.status !== 0) throw new Error("bundling src/cli.ts failed");
		},
	};
}

export default defineConfig({
	// wuchale before svelte(): it rewrites the strings in the source, and the Svelte compiler has to see the rewritten form.
	// SAFETY: wuchale types its plugin against Vite 8, whose handleHotUpdate may return false; Vite 7 runs it the same.
	plugins: [wuchale() as PluginOption, svelte(), cliBundle()],
	resolve: {
		alias: electrobunViteAliases(resolve(__dirname, ".hutch/devkit")),
	},
	root: "src/mainview",
	build: {
		outDir: "../../dist",
		emptyOutDir: true,
	},
	server: {
		port: 5182,
		strictPort: true,
	},
});
