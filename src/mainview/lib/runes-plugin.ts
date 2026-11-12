// bun test has no Svelte compiler; this compiles *.svelte.ts and *.svelte.js (the model, the language module and
// wuchale's loader) so their runes run under test. bunfig.toml preloads it for every test file.
import { plugin } from "bun";
import { compileModule } from "svelte/compiler";

const ts = new Bun.Transpiler({ loader: "ts" });

plugin({
	name: "svelte-runes",
	setup(build) {
		build.onLoad({ filter: /\.svelte\.[jt]s$/ }, async ({ path }) => {
			const js = ts.transformSync(await Bun.file(path).text());
			const out = compileModule(js, { filename: path, generate: "client", dev: false });
			return { contents: out.js.code, loader: "js" };
		});
	},
});
