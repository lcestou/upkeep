import { expect, test } from "bun:test";
import { MAX_SUM_BYTES, releaseSum, sumFiles, sumIn, sumInYml } from "./checksums";
import type { Asset, FetchLike } from "./github";

const H256 = "a".repeat(64);
const H512 = "b".repeat(128);
const asset = (name: string, size = 100): Asset => ({ name, url: `https://dl.example/${name}`, size, digest: null });

test("sumFiles: the asset's own file first, then lists, then electron-builder's yml; others and big ones left out", () => {
	const names = sumFiles(
		{
			assets: [
				asset("latest-linux.yml"),
				asset("tool_1.2.0_checksums.txt"),
				asset("tool.AppImage"),
				asset("tool.AppImage.sha256"),
				asset("SHA256SUMS"),
				asset("SHA256SUMS.asc"),
				asset("other.AppImage.sha256"),
				asset("checksums.txt", MAX_SUM_BYTES + 1),
			],
		},
		"tool.AppImage",
	).map((a) => a.name);
	expect(names).toEqual(["tool.AppImage.sha256", "tool_1.2.0_checksums.txt", "SHA256SUMS", "latest-linux.yml"]);
});

test("sumIn reads GNU, binary-mode, path-prefixed and BSD lines, and a bare hash only in the asset's own file", () => {
	const text = ["# comment", `${"c".repeat(64)}  other.tar.gz`, `${H256.toUpperCase()} *./dist/tool.tar.gz`].join("\n");
	expect(sumIn(text, "tool.tar.gz", false)).toEqual({ algo: "sha256", hex: H256 });
	expect(sumIn(`SHA512 (tool.tar.gz) = ${H512}\r\n`, "tool.tar.gz", false)).toEqual({ algo: "sha512", hex: H512 });
	expect(sumIn(`${H256}\n`, "tool.tar.gz", true)).toEqual({ algo: "sha256", hex: H256 });
	expect(sumIn(`${H256}\n`, "tool.tar.gz", false)).toBeNull();
	expect(sumIn(`${"z".repeat(64)}  tool.tar.gz`, "tool.tar.gz", false)).toBeNull();
	expect(sumIn(`${"a".repeat(40)}  tool.tar.gz`, "tool.tar.gz", false)).toBeNull();
	expect(sumIn(text, "missing.tar.gz", false)).toBeNull();
});

test("sumInYml takes the sha512 after the url or path naming the file, as hex", () => {
	const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");
	const other = "d".repeat(128);
	const yml = [
		"version: 1.2.0",
		"files:",
		"  - url: Tool-1.2.0.AppImage",
		`    sha512: ${b64(H512)}`,
		"    size: 100",
		"  - url: Tool-1.2.0.deb",
		`    sha512: '${b64(other)}'`,
		"path: Tool-1.2.0.AppImage",
		`sha512: ${b64(H512)}`,
	].join("\n");
	expect(sumInYml(yml, "Tool-1.2.0.AppImage")).toEqual({ algo: "sha512", hex: H512 });
	expect(sumInYml(yml, "Tool-1.2.0.deb")).toEqual({ algo: "sha512", hex: other });
	expect(sumInYml(yml, "Tool.rpm")).toBeNull();
	expect(sumInYml("  - url: a.AppImage\n    sha512: c2hvcnQ=\n", "a.AppImage")).toBeNull();
});

/** Answers each checksum file's address from a table; an address not in it is a 404. */
function served(files: Record<string, string>, asked: string[] = []): FetchLike {
	return async (url) => {
		asked.push(url);
		const body = files[url];
		return body === undefined ? new Response("no", { status: 404 }) : new Response(body);
	};
}

test("releaseSum reads the best file that names the asset, and falls through ones that cannot be read or do not", async () => {
	const tool = asset("tool.tar.gz");
	const release = { assets: [tool, asset("tool.tar.gz.sha256"), asset("checksums.txt"), asset("SHA256SUMS")] };
	const asked: string[] = [];
	const fetch = served(
		{
			"https://dl.example/checksums.txt": `${"c".repeat(64)}  other.tar.gz\n`,
			"https://dl.example/SHA256SUMS": `${H256}  tool.tar.gz\n`,
		},
		asked,
	);
	expect(await releaseSum(release, tool, fetch)).toEqual({ algo: "sha256", hex: H256, file: "SHA256SUMS" });
	expect(asked).toEqual([
		"https://dl.example/tool.tar.gz.sha256",
		"https://dl.example/checksums.txt",
		"https://dl.example/SHA256SUMS",
	]);
	expect(await releaseSum({ assets: [tool] }, tool, fetch)).toBeNull();
});

test("releaseSum leaves alone a file that is not https, redirects off https, grows too big or throws", async () => {
	const tool = asset("tool.tar.gz");
	const plain = { ...asset("SHA256SUMS"), url: "http://dl.example/SHA256SUMS" };
	const never: FetchLike = async () => {
		throw new Error("asked");
	};
	expect(await releaseSum({ assets: [plain] }, tool, never)).toBeNull();
	expect(await releaseSum({ assets: [asset("SHA256SUMS")] }, tool, never)).toBeNull();
	const off: FetchLike = async () => {
		const res = new Response(`${H256}  tool.tar.gz\n`);
		Object.defineProperty(res, "url", { value: "http://mirror.example/SHA256SUMS" });
		Object.defineProperty(res, "redirected", { value: true });
		return res;
	};
	expect(await releaseSum({ assets: [asset("SHA256SUMS")] }, tool, off)).toBeNull();
	const huge: FetchLike = async () => new Response(`${H256}  tool.tar.gz\n${"x".repeat(MAX_SUM_BYTES)}`);
	expect(await releaseSum({ assets: [asset("SHA256SUMS", 0)] }, tool, huge)).toBeNull();
});

test("releaseSum reads electron-builder's yml for a sha512", async () => {
	const app = asset("Tool-1.2.0.AppImage");
	const yml = `files:\n  - url: Tool-1.2.0.AppImage\n    sha512: ${Buffer.from(H512, "hex").toString("base64")}\n`;
	const fetch = served({ "https://dl.example/latest-linux.yml": yml });
	expect(await releaseSum({ assets: [app, asset("latest-linux.yml")] }, app, fetch)).toEqual({
		algo: "sha512",
		hex: H512,
		file: "latest-linux.yml",
	});
});
