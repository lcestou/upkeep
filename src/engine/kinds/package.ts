import type { AppKind } from "../../shared/types";
import type { Run } from "../run";

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

/** The mount options of the file system that holds /usr, as util-linux prints them. */
export const USR_MOUNT = ["findmnt", "-n", "-o", "OPTIONS", "--target", "/usr"];

/**
 * True when /usr is mounted read-only: an image-based system (Fedora Silverblue and Kinoite, Bazzite, SteamOS, any
 * ostree or bootc system) whose packages change only as a whole image. A .deb or .rpm cannot install there, and the
 * package tool's own list (dnf on Silverblue) offers updates it cannot apply. A missing findmnt or an answer without
 * "ro" counts as writable, the common case.
 */
export async function readOnlyUsr(run: Run): Promise<boolean> {
	const r = await run(USR_MOUNT, { timeoutMs: 5000 });
	return r.code === 0 && r.stdout.trim().split(",").includes("ro");
}
