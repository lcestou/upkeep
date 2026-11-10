// bun test has no Svelte compiler; this compiles *.svelte.ts so the runes in the model run under test.
import { plugin } from "bun";
import { compileModule } from "svelte/compiler";

const ts = new Bun.Transpiler({ loader: "ts" });

plugin({
	name: "svelte-runes",
	setup(build) {
		build.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
			const js = ts.transformSync(await Bun.file(path).text());
			const out = compileModule(js, { filename: path, generate: "client", dev: false });
			return { contents: out.js.code, loader: "js" };
		});
	},
});
