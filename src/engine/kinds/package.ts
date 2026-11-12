import type { AppKind } from "../../shared/types";

/** The kinds of app that install a system package from a GitHub release asset. */
export type PackageKind = "deb" | "rpm";

/** Whether an app kind is a system package; a .deb or .rpm needs root and keeps its old version's package as a restore point. */
export const isPackage = (k: AppKind): k is PackageKind => k === "deb" || k === "rpm";

/** The tool each package kind installs with; Add app offers a package only where its tool is on PATH. */
export const PACKAGE_TOOL = { deb: "dpkg", rpm: "rpm" } as const satisfies Record<PackageKind, string>;

/**
 * The argv that installs file as a package of this kind. One argv serves an install, an upgrade and a restore: dpkg -i
 * replaces any version, and rpm needs --oldpackage so a restore may go to an older one. It is not wrapped in sudo here.
 */
export function packageInstall(kind: PackageKind, file: string): string[] {
	return kind === "deb" ? [PACKAGE_TOOL.deb, "-i", file] : [PACKAGE_TOOL.rpm, "-U", "--oldpackage", file];
}
