import type { AppSpec } from "../shared/types";

/** The machine architectures Upkeep picks release files for, as release names spell them. */
export type Arch = "x86_64" | "aarch64";

/**
 * Node's name for this CPU as release files spell it: x64 is x86_64, arm64 is aarch64. Any other CPU throws, since
 * Upkeep itself is only built for those two and no release file it picks would run there.
 */
export function machineArch(cpu: string): Arch {
	if (cpu === "x64") return "x86_64";
	if (cpu === "arm64") return "aarch64";
	throw new Error(`Upkeep runs on x86_64 and aarch64 machines, not ${cpu}.`);
}

/** The table field that holds the asset pattern for arch: asset for x86_64, the first and default arch. */
export const assetField = (arch: Arch = "x86_64") => (arch === "aarch64" ? "asset_aarch64" : "asset");

/** The asset pattern a table gives for arch; undefined when it names none for that machine, which is never a guess. */
export const assetFor = (spec: Pick<AppSpec, "asset" | "asset_aarch64">, arch: Arch = "x86_64") =>
	spec[assetField(arch)];
