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

test("sumIn: an exact name wins, and two paths sharing the base name with different hashes are trusted for neither", () => {
	const b = "b".repeat(64);
	const nested = `${H256}  x86_64/app.tar.gz\n${b}  aarch64/app.tar.gz\n`;
	expect(sumIn(nested, "app.tar.gz", false)).toBeNull();
	expect(sumIn(`${nested}${"c".repeat(64)}  app.tar.gz\n`, "app.tar.gz", false)).toEqual({
		algo: "sha256",
		hex: "c".repeat(64),
	});
	expect(sumIn(`${H256}  x86_64/app.tar.gz\n${H256}  mirror/app.tar.gz\n`, "app.tar.gz", false)).toEqual({
		algo: "sha256",
		hex: H256,
	});
	// The asset's own file with one line: its hash, whatever build path the line names.
	expect(sumIn(`${H256}  build/app.AppImage\n`, "app-1.2-x86_64.AppImage", true)).toEqual({
		algo: "sha256",
		hex: H256,
	});
	expect(sumIn(`${H256}  build/app.AppImage\n`, "app-1.2-x86_64.AppImage", false)).toBeNull();
});

test("sumFiles: own files match in any case, .sha512sum counts, and another asset's own file is never read", () => {
	const names = sumFiles(
		{
			assets: [
				asset("app.AppImage"),
				asset("other.AppImage"),
				asset("other.AppImage.sha256sum"),
				asset("SHA256SUMS"),
				asset("app.AppImage.SHA512SUM"),
			],
		},
		"app.AppImage",
	).map((a) => a.name);
	expect(names).toEqual(["app.AppImage.SHA512SUM", "SHA256SUMS"]);
});

test("releaseSum: a private repo's checksum file is asked again at GitHub's API with the token", async () => {
	const tool = asset("tool.tar.gz");
	const api = "https://api.github.com/repos/me/tool/releases/assets/9";
	const sums = { ...asset("SHA256SUMS"), api };
	const asked: { url: string; auth: string | null }[] = [];
	const fetch: FetchLike = async (url, init) => {
		asked.push({ url, auth: new Headers(init?.headers).get("authorization") });
		return url === api ? new Response(`${H256}  tool.tar.gz\n`) : new Response("no", { status: 404 });
	};
	expect(await releaseSum({ assets: [tool, sums] }, tool, fetch, "tok")).toEqual({
		algo: "sha256",
		hex: H256,
		file: "SHA256SUMS",
	});
	expect(asked).toEqual([
		{ url: "https://dl.example/SHA256SUMS", auth: null },
		{ url: api, auth: "Bearer tok" },
	]);
	// Without a token the API is never asked.
	asked.length = 0;
	expect(await releaseSum({ assets: [tool, sums] }, tool, fetch)).toBeNull();
	expect(asked.map((a) => a.url)).toEqual(["https://dl.example/SHA256SUMS"]);
});

test("releaseSum: Stop now's cancel reaches the checksum file's fetch, which then reads as no file", async () => {
	const tool = asset("tool.tar.gz");
	const stop = new AbortController();
	stop.abort();
	let sawAborted = false;
	const fetch: FetchLike = async (_url, init) => {
		sawAborted = init?.signal?.aborted === true;
		init?.signal?.throwIfAborted();
		return new Response(`${H256}  tool.tar.gz\n`);
	};
	expect(await releaseSum({ assets: [tool, asset("SHA256SUMS")] }, tool, fetch, null, stop.signal)).toBeNull();
	expect(sawAborted).toBe(true);
	expect(await releaseSum({ assets: [tool, asset("SHA256SUMS")] }, tool, fetch)).toMatchObject({ hex: H256 });
});
