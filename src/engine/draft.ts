/**
 * Build steps drafted from the files at a repo's root, for a release with no file this machine runs. The draft is
 * a guess the person reads before adding it: the Add card shows every step, and nothing runs until they add it.
 * This is the one place the engine names the build tools it drafts for.
 */

/** A drafted source build: the file it was read from, the tools it needs on PATH, its steps and the program it makes. */
export type Draft = {
	file: string;
	tools: string[];
	build: string[];
	bin: string;
	/** The build file named the program; false when it is the repo's name, which the build may not install. */
	named: boolean;
	/** Installs under /usr/local with sudo, rather than into ~/.local/bin. */
	system: boolean;
};

const MAKE = ["make -j$(nproc)", "sudo make install"];

/**
 * The steps for each build system, the most specific first: a repo with Cargo.toml and a Makefile is a Rust
 * project whose Makefile is a convenience. Cargo and Go install into ~/.local/bin; the rest install with sudo.
 */
const SYSTEMS: { file: string; tools: string[]; build: string[]; system: boolean }[] = [
	{ file: "Cargo.toml", tools: ["cargo"], build: ["cargo install --locked --path . --root ~/.local"], system: false },
	{ file: "go.mod", tools: ["go"], build: ["GOBIN=$HOME/.local/bin go install ./..."], system: false },
	{
		file: "meson.build",
		tools: ["meson", "ninja"],
		build: [
			"meson setup build --buildtype=release --prefix=/usr/local",
			"meson compile -C build",
			"sudo meson install -C build",
		],
		system: true,
	},
	{
		file: "CMakeLists.txt",
		tools: ["cmake"],
		build: [
			"cmake -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local",
			"cmake --build build -j$(nproc)",
			"sudo cmake --install build",
		],
		system: true,
	},
	{ file: "configure", tools: ["make"], build: ["./configure", ...MAKE], system: true },
	{ file: "autogen.sh", tools: ["autoreconf", "make"], build: ["sh autogen.sh", "./configure", ...MAKE], system: true },
	{
		file: "configure.ac",
		tools: ["autoreconf", "make"],
		build: ["autoreconf -fi", "./configure", ...MAKE],
		system: true,
	},
	{ file: "Makefile", tools: ["make"], build: MAKE, system: true },
];

/** The program a Cargo.toml builds: its first [[bin]] name, else its package name; null when neither is there. */
export function cargoBin(text: string): string | null {
	let section = "";
	let pkg: string | null = null;
	for (const line of text.split("\n")) {
		const head = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line);
		if (head) {
			section = head[1]?.trim() ?? "";
			continue;
		}
		const name = /^\s*name\s*=\s*"([^"]+)"/.exec(line)?.[1];
		if (!name) continue;
		if (section === "bin") return name;
		if (section === "package") pkg ??= name;
	}
	return pkg;
}

/** The program go install makes from a go.mod: the module path's last part, past a /vN suffix. */
export function goBin(text: string): string | null {
	const path = /^\s*module\s+(\S+)/m.exec(text)?.[1];
	if (!path) return null;
	const parts = path.split("/").filter((p) => !/^v\d+$/.test(p));
	return parts.at(-1) ?? null;
}

/**
 * The draft for a repo whose root holds names, with the program named from the build file's text when it says
 * (Cargo.toml, go.mod), else fallback. Null when no known build file is there.
 */
export function draftFor(names: string[], text: string | null, fallback: string): Draft | null {
	const s = SYSTEMS.find((x) => names.includes(x.file));
	if (!s) return null;
	const named =
		text === null ? null : s.file === "Cargo.toml" ? cargoBin(text) : s.file === "go.mod" ? goBin(text) : null;
	// The name comes from a stranger's file and becomes a path: a plain file name or nothing.
	const safe = named && /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(named) ? named : null;
	return {
		file: s.file,
		tools: s.tools,
		build: s.build,
		bin: safe ?? fallback,
		named: safe !== null,
		system: s.system,
	};
}
