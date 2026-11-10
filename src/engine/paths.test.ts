import { expect, test } from "bun:test";
import { expandHome, paths } from "./paths";

test("defaults follow the XDG layout under HOME", () => {
	expect(paths({ HOME: "/h" })).toEqual({
		config: "/h/.config/upkeep",
		state: "/h/.local/state/upkeep",
		data: "/h/.local/share/upkeep",
		cache: "/h/.cache/upkeep",
		socket: "/h/.local/state/upkeep/upkeep.sock",
		home: "/h",
	});
});

test("XDG variables win over the defaults", () => {
	const p = paths({
		HOME: "/h",
		XDG_CONFIG_HOME: "/c",
		XDG_STATE_HOME: "/s",
		XDG_DATA_HOME: "/d",
		XDG_CACHE_HOME: "/k",
		XDG_RUNTIME_DIR: "/r",
	});
	expect(p).toEqual({
		config: "/c/upkeep",
		state: "/s/upkeep",
		data: "/d/upkeep",
		cache: "/k/upkeep",
		socket: "/r/upkeep.sock",
		home: "/h",
	});
});

test("a missing HOME is an error, never a write to the filesystem root", () => {
	expect(() => paths({})).toThrow("HOME is not set.");
});

test("expandHome", () => {
	expect(expandHome("~/.local/bin/fd", "/h")).toBe("/h/.local/bin/fd");
	expect(expandHome("~", "/h")).toBe("/h");
	expect(expandHome("/usr/bin/x", "/h")).toBe("/usr/bin/x");
	expect(expandHome("~other/x", "/h")).toBe("~other/x");
});
