// The fixture's half of Add app: canned suggestions shaped like the engine's discover.ts answers.
import type { AppSpec, Suggestion } from "../../shared/types";

const SYSTEM_RG =
	" A copy at /usr/bin/rg comes from the system's packages, so Upkeep will keep its own at ~/.local/bin/rg, which comes first on your PATH.";

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

export const PICKED = "/home/owner/Downloads/Obsidian-1.9.4.AppImage";

export function suggestFor(input: string, asset: string | undefined, has: (key: string) => boolean) {
	const text = input
		.trim()
		.replace(/^https?:\/\/github\.com\//, "")
		.replace(/\/+$/, "");
	if (text === "sharkdp/bat" || has(text.split("/")[1]?.toLowerCase() ?? ""))
		return {
			suggestions: [
				{
					...ripgrep(),
					spec: { ...ripgrep().spec, key: "bat", name: "bat", repo: text },
					problem: "bat is already in the list.",
				},
			],
		};
	if (/^burntsushi\/ripgrep/i.test(text)) return { suggestions: [ripgrep(asset)] };
	if (/^obsidianmd\/obsidian-releases/i.test(text)) return { suggestions: [obsidian(asset)] };
	if (text === "nobody/nothing") return { suggestions: [], problem: "nobody/nothing has no published release." };
	if (/\.AppImage$/i.test(text) && (text.startsWith("/") || text.startsWith("~/") || text.startsWith("file://")))
		return { suggestions: [fromFile(text.replace(/^file:\/\//, ""))] };
	return { suggestions: [], problem: "Give a GitHub repo like owner/name, a github.com link, or a file path." };
}

/** Four files with no source found (the common case on a real box) and two sure ones. */
export function scanResults(): Suggestion[] {
	const btop: Suggestion = {
		spec: {
			key: "btop",
			name: "btop",
			kind: "archive",
			repo: "aristocratic/btop",
			asset: "^btop-x86_64-linux-musl\\.tar\\.gz$",
			dest: "~/.local/bin/btop",
			bins: ["btop"],
		},
		installed: null,
		latest: "1.4.5",
		asset: { name: "btop-x86_64-linux-musl.tar.gz", size: 1_402_210 },
		alternatives: [],
		source: "scan",
		path: "/home/owner/.local/bin/btop",
		confidence: "sure",
		why: "The release names this file. Matched btop-x86_64-linux-musl.tar.gz for this machine. Found it installed at ~/.local/bin/btop.",
	};
	return [
		{ ...fromFile("/home/owner/Applications/Obsidian-1.9.4.AppImage"), source: "scan" },
		btop,
		unknown("/home/owner/.local/bin/mytool"),
		unknown("/home/owner/.local/bin/ytdl"),
		unknown("/home/owner/bin/backup-sync"),
		unknown("/home/owner/Applications/Notes.AppImage"),
	];
}
