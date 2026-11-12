import { defineConfig, type PluginOption } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { wuchale } from "wuchale/vite";
import { resolve } from "node:path";
import { electrobunViteAliases } from "./.hutch/devkit/api/config/electrobun-vite";

export default defineConfig({
	// wuchale before svelte(): it rewrites the strings in the source, and the Svelte compiler has to see the rewritten form.
	// SAFETY: wuchale types its plugin against Vite 8, whose handleHotUpdate may return false; Vite 7 runs it the same.
	plugins: [wuchale() as PluginOption, svelte()],
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
