/** Upkeep's own home: the repo its changelog, issues and releases live in. Named here and nowhere else. */
export const HOME = "https://github.com/lcestou/upkeep";

/** The pages About can open. */
export type AboutLink = "changelog" | "bug" | "repo";

/** What a bug report says about the machine, read by the main process. */
export type AboutInfo = {
	version: string;
	arch: string;
	/** The text of /etc/os-release, or "" where there is none. */
	osRelease: string;
	env: Record<string, string | undefined>;
};

/** The longest a part of the system line may be: a real name is far shorter, and the line ends up in an address. */
const PART_MAX = 80;

/**
 * One line naming the system: the distribution's own name for itself, the desktop and the session type.
 * A part nobody set is left out, and a system that names none of them is "Linux". Each part is put on one line and
 * cut at 80 characters, since the file and the environment are whatever the machine holds. A backslash escape inside
 * a quoted name is kept as written, not decoded.
 */
export function systemLine(osRelease: string, env: Record<string, string | undefined>): string {
	const pretty = /^PRETTY_NAME=(.*)$/m
		.exec(osRelease)?.[1]
		?.trim()
		.replace(/^(["'])(.*)\1$/, "$2");
	const parts = [pretty, env.XDG_CURRENT_DESKTOP, env.XDG_SESSION_TYPE]
		.map((p) => (p ?? "").replace(/\s+/g, " ").trim().slice(0, PART_MAX))
		.filter((p) => p);
	return parts.length > 0 ? parts.join(", ") : "Linux";
}

/**
 * The address an About link opens. A bug report starts with its two questions and ends with the version and the
 * system, so the person does not have to look them up; nothing else about the machine goes in.
 */
export function aboutUrl(what: AboutLink, info: AboutInfo): string {
	if (what === "repo") return HOME;
	if (what === "changelog") return `${HOME}/blob/main/CHANGELOG.md`;
	const body = [
		"**What happened**",
		"",
		"",
		"**What I expected**",
		"",
		"",
		"---",
		`Upkeep ${info.version} (${info.arch})`,
		systemLine(info.osRelease, info.env),
	].join("\n");
	return `${HOME}/issues/new?body=${encodeURIComponent(body)}`;
}
