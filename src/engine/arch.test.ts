import { expect, test } from "bun:test";
import { assetField, assetFor, machineArch } from "./arch";

test("the machine's architecture is read from Node's name, and any other CPU is refused", () => {
	expect(machineArch("x64")).toBe("x86_64");
	expect(machineArch("arm64")).toBe("aarch64");
	expect(() => machineArch("ia32")).toThrow("Upkeep runs on x86_64 and aarch64 machines, not ia32.");
});

test("a table's pattern for each architecture, x86_64 when none is named", () => {
	const spec = { asset: "amd64$", asset_aarch64: "arm64$" };
	expect(assetFor(spec)).toBe("amd64$");
	expect(assetFor(spec, "x86_64")).toBe("amd64$");
	expect(assetFor(spec, "aarch64")).toBe("arm64$");
	expect(assetFor({ asset: "amd64$" }, "aarch64")).toBeUndefined();
	expect(assetField()).toBe("asset");
	expect(assetField("aarch64")).toBe("asset_aarch64");
});
