// The fixture's half of Add app: canned suggestions shaped like the engine's discover.ts answers.
import type { AppSpec, Suggestion } from "../../shared/types";

const SYSTEM_RG =
	" A copy at /usr/bin/rg comes from the system's packages, so Upkeep will keep its own at ~/.local/bin/rg, which comes first on your PATH.";

/** The canned ripgrep card. An asset name containing musl picks that build, anything else the gnu one; the other is listed as an alternative. */
function ripgrep(asset?: string): Suggestion {
	const musl = asset?.includes("musl") ?? false;
	const name = musl
		? "ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz"
		: "ripgrep-15.2.0-x86_64-unknown-linux-gnu.tar.gz";
	const other = musl
		? "ripgrep-15.2.0-x86_64-unknown-linux-gnu.tar.gz"
		: "ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz";
	return {
		spec: {
			key: "ripgrep",
			name: "ripgrep",
			kind: "archive",
			repo: "BurntSushi/ripgrep",
			asset: musl
				? "^ripgrep-.*-x86_64-unknown-linux-musl\\.tar\\.gz$"
				: "^ripgrep-.*-x86_64-unknown-linux-gnu\\.tar\\.gz$",
			dest: "~/.local/bin/rg",
			bins: ["rg"],
			install_if_missing: true,
		},
		installed: null,
		latest: "15.2.0",
		asset: { name, size: musl ? 2_840_113 : 2_611_405 },
		alternatives: [other],
		source: "repo",
		confidence: "sure",
		why: `Matched ${name} for this machine. It installs rg. Nothing is installed at ~/.local/bin/rg yet, so Install will put it there.${SYSTEM_RG}`,
	};
}

/** The canned Obsidian card. A .deb asset picks the system package (needs sudo); anything else picks the AppImage, and the card lists the other as its alternative. */
function obsidian(asset?: string): Suggestion {
	const deb = asset?.endsWith(".deb") ?? false;
	const name = deb ? "obsidian_1.9.4_amd64.deb" : "Obsidian-1.9.4.AppImage";
	return {
		spec: {
			key: "obsidian",
			name: "Obsidian",
			kind: deb ? "deb" : "appimage",
			repo: "obsidianmd/obsidian-releases",
			asset: deb ? "^obsidian_.*_amd64\\.deb$" : "^Obsidian-.*\\.AppImage$",
			dest: deb ? "/usr/bin/obsidian" : "~/.local/bin/obsidian.AppImage",
			sudo: deb ? true : undefined,
			install_if_missing: true,
		},
		installed: null,
		latest: "1.9.4",
		asset: { name, size: deb ? 98_221_004 : 121_640_448 },
		alternatives: [deb ? "Obsidian-1.9.4.AppImage" : "obsidian_1.9.4_amd64.deb"],
		source: "repo",
		confidence: "sure",
		why: `Matched ${name} for this machine. Nothing is installed at ${deb ? "/usr/bin/obsidian" : "~/.local/bin/obsidian.AppImage"} yet, so Install will put it there.`,
	};
}

/** The canned card for a file picked from disk; the app's key and name come from the file name. */
function fromFile(path: string): Suggestion {
	const spec: AppSpec = {
		key: "obsidian",
		name: "Obsidian",
		kind: "appimage",
		repo: "obsidianmd/obsidian-releases",
		asset: "^Obsidian-.*\\.AppImage$",
		dest: path,
	};
	return {
		spec,
		installed: "1.9.4",
		latest: "1.9.4",
		asset: { name: "Obsidian-1.9.4.AppImage", size: 121_640_448 },
		alternatives: [],
		source: "file",
		path,
		confidence: "sure",
		why: `The AppImage names its own release source. Matched Obsidian-1.9.4.AppImage for this machine. Found it installed at ${path}.`,
	};
}

/** The card for a file the fixture has no recipe for: kind file, nothing installed, nothing to compare. */
const unknown = (path: string): Suggestion => {
	const base = path.split("/").pop() ?? path;
	return {
		spec: { key: base.toLowerCase().replace(/[^a-z0-9-]/g, "-"), name: base, kind: "file", dest: path },
		installed: null,
		latest: null,
		asset: null,
		alternatives: [],
		source: "scan",
		path,
		confidence: "guess",
		why: "",
		problem: `Could not tell where ${base} comes from. Paste its GitHub repo to add it.`,
	};
};

const BTOP_PATH = "/home/owner/.local/bin/btop";

/** The scanned program with a second asset to pick: the card's select asks for it again by its path. */
function btop(asset?: string): Suggestion {
	const gnu = asset?.includes("gnu") ?? false;
	const name = gnu ? "btop-x86_64-linux-gnu.tar.gz" : "btop-x86_64-linux-musl.tar.gz";
	return {
		spec: {
			key: "btop",
			name: "btop",
			kind: "archive",
			repo: "aristocratic/btop",
			asset: gnu ? "^btop-x86_64-linux-gnu\\.tar\\.gz$" : "^btop-x86_64-linux-musl\\.tar\\.gz$",
			dest: "~/.local/bin/btop",
			bins: ["btop"],
		},
		installed: null,
		latest: "1.4.5",
		asset: { name, size: gnu ? 1_511_904 : 1_402_210 },
		alternatives: [gnu ? "btop-x86_64-linux-musl.tar.gz" : "btop-x86_64-linux-gnu.tar.gz"],
		source: "scan",
		path: BTOP_PATH,
		confidence: "sure",
		why: `The release names this file. Matched ${name} for this machine. Found it installed at ~/.local/bin/btop.`,
	};
}

/** A catalogue answer: the tested table as written, with today's release looked up. */
function glow(): Suggestion {
	return {
		spec: {
			key: "glow",
			name: "Glow",
			kind: "archive",
			repo: "charmbracelet/glow",
			asset: "Linux_x86_64\\.tar\\.gz$",
			dest: "~/.local/bin/glow",
			bins: ["glow"],
		},
		installed: null,
		latest: "2.1.1",
		asset: { name: "glow_2.1.1_Linux_x86_64.tar.gz", size: 5_212_160 },
		alternatives: [],
		source: "catalogue",
		confidence: "sure",
		why: "From Upkeep's catalogue of tested apps.",
	};
}

export const PICKED = "/home/owner/Downloads/Obsidian-1.9.4.AppImage";

/** Answers the Add app field the way the engine's discover would. A repo already in the list gets a card under its own name rather than another app's assets. */
export function suggestFor(input: string, asset: string | undefined, has: (key: string) => boolean) {
	const text = input
		.trim()
		.replace(/^https?:\/\/github\.com\//, "")
		.replace(/\/+$/, "");
	// A repo already in the list answers with a card of its own name, not another app's assets.
	const name = text.split("/")[1] ?? "";
	if (name && has(name.toLowerCase())) {
		const key = name.toLowerCase();
		return {
			suggestions: [
				{
					spec: { key, name, kind: "archive", repo: text, dest: `~/.local/bin/${key}` },
					installed: null,
					latest: null,
					asset: null,
					alternatives: [],
					source: "repo",
					confidence: "sure",
					why: "",
					problem: `${name} is already in the list.`,
				} satisfies Suggestion,
			],
		};
	}
	if (text === "example/mac-only")
		return { suggestions: [], problem: "No asset of example/mac-only's latest release runs on this machine." };
	if (/^burntsushi\/ripgrep/i.test(text)) return { suggestions: [ripgrep(asset)] };
	if (/^obsidianmd\/obsidian-releases/i.test(text)) return { suggestions: [obsidian(asset)] };
	if (text === BTOP_PATH) return { suggestions: [btop(asset)] };
	if (text === "nobody/nothing") return { suggestions: [], problem: "nobody/nothing has no published release." };
	if (/\.AppImage$/i.test(text) && (text.startsWith("/") || text.startsWith("~/") || text.startsWith("file://")))
		return { suggestions: [fromFile(text.replace(/^file:\/\//, ""))] };
	if (/^(glow|charmbracelet\/glow)$/i.test(text)) return { suggestions: [glow()] };
	if (/^gh$/i.test(text))
		return {
			suggestions: [
				{
					spec: {
						key: "gh",
						name: "GitHub CLI",
						kind: "command",
						check: ["gh", "--version"],
						latest: "github:cli/cli",
						update: ["gh", "upgrade"],
					},
					installed: null,
					latest: null,
					asset: null,
					alternatives: [],
					source: "catalogue",
					confidence: "sure",
					why: "From Upkeep's catalogue of tested apps.",
				} satisfies Suggestion,
			],
		};
	return {
		suggestions: [],
		problem: "Give an app's name, a GitHub repo like owner/name, a github.com link, or a file path.",
	};
}

/** Four files with no source found (the common case on a real box) and two sure ones. */
export function scanResults(onlyUnknown = false): Suggestion[] {
	if (onlyUnknown) return [unknown("/home/owner/.local/bin/mytool"), unknown("/home/owner/bin/backup-sync")];
	return [
		{ ...fromFile("/home/owner/Applications/Obsidian-1.9.4.AppImage"), source: "scan" },
		btop(),
		unknown("/home/owner/.local/bin/mytool"),
		unknown("/home/owner/.local/bin/ytdl"),
		unknown("/home/owner/bin/backup-sync"),
		unknown("/home/owner/Applications/Notes.AppImage"),
	];
}
