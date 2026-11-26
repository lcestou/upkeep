import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { FetchLike, ReleaseOpts } from "./github";
import { guardRepo } from "./repoid";
import { loadState } from "./store";
import { tempHome } from "./testkit";

let t: ReturnType<typeof tempHome>;
let lines: string[] = [];
let asked: string[] = [];
/** What GET /repos/o/tool answers: a repo's full name and ids, or a status with no body. */
let answer: { name: string; id: number; owner: number } | number = { name: "o/tool", id: 7, owner: 70 };
beforeEach(() => {
	t = tempHome("repoid");
	lines = [];
	asked = [];
	answer = { name: "o/tool", id: 7, owner: 70 };
});
afterEach(() => t.cleanup());

const fetch: FetchLike = async (url) => {
	asked.push(url);
	if (typeof answer === "number") return new Response("{}", { status: answer });
	return Response.json({ id: answer.id, full_name: answer.name, owner: { id: answer.owner } });
};
const opts = (): ReleaseOpts => ({ cacheDir: join(t.paths.cache, "github"), fetch });
const spec = { key: "tool", repo: "o/tool" };
const guard = (offered: boolean, s: { key: string; repo?: string; forge?: "gitlab" } = spec) =>
	guardRepo(s, offered, t.paths, opts(), (l) => lines.push(l));

test("the first check remembers the repo's ids, and later checks ask again only while an update is on offer", async () => {
	await guard(false);
	expect(asked).toEqual(["https://api.github.com/repos/o/tool"]);
	expect(loadState(t.paths).origin.tool).toEqual({ repo: "o/tool", name: "o/tool", id: 7, owner: 70 });
	await guard(false);
	expect(asked).toHaveLength(1);
	await guard(true);
	expect(asked).toHaveLength(2);
	expect(loadState(t.paths).swapped).toEqual({});
	expect(lines).toEqual([]);
});

test("a rename or a transfer keeps the id: followed with a log line, never held", async () => {
	await guard(false);
	answer = { name: "neworg/tool2", id: 7, owner: 71 };
	await guard(true);
	expect(loadState(t.paths).origin.tool).toEqual({ repo: "o/tool", name: "neworg/tool2", id: 7, owner: 71 });
	expect(loadState(t.paths).swapped).toEqual({});
	expect(lines).toEqual(["Repo moved: o/tool is now neworg/tool2, the same repository. Upkeep follows the move."]);
});

test("another repository under the same name holds the app and keeps the id first seen", async () => {
	await guard(false);
	answer = { name: "o/tool", id: 9, owner: 90 };
	await guard(true);
	expect(loadState(t.paths).swapped).toEqual({ tool: "github.com/o/tool" });
	expect(loadState(t.paths).origin.tool?.id).toBe(7);
	expect(lines).toEqual(["github.com/o/tool answers with repository id 9; Upkeep first saw id 7. Held."]);
});

test("a table edited to name another repo starts afresh: its ids are read anew and an old hold goes", async () => {
	await guard(false);
	answer = { name: "o/tool", id: 9, owner: 90 };
	await guard(true);
	expect(loadState(t.paths).swapped).toEqual({ tool: "github.com/o/tool" });
	// The owner points the table at another repo: never a swap, whatever its id.
	answer = { name: "other/fork", id: 11, owner: 110 };
	await guard(false, { key: "tool", repo: "other/fork" });
	expect(asked.at(-1)).toBe("https://api.github.com/repos/other/fork");
	expect(loadState(t.paths).origin.tool).toEqual({ repo: "other/fork", name: "other/fork", id: 11, owner: 110 });
	expect(loadState(t.paths).swapped).toEqual({});
	// Even when the new repo does not answer, the old repo's ids and hold do not stay.
	answer = 500;
	await guard(true, { key: "tool", repo: "third/one" });
	expect(loadState(t.paths)).toMatchObject({ origin: {}, swapped: {} });
});

test("no answer, another forge or no repo changes nothing", async () => {
	answer = 404;
	await guard(false);
	answer = 500;
	await guard(true);
	expect(loadState(t.paths).origin).toEqual({});
	await guard(false, { key: "gl", repo: "gitlab.com/g/p" });
	await guard(false, { key: "none" });
	expect(asked).toHaveLength(2);
});
