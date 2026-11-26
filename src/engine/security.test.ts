import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { FetchLike } from "./github";
import {
	OSV_QUERY,
	advisoryIds,
	advisoryUrl,
	githubRepoOf,
	lookSecurity,
	osvIds,
	osvPackage,
	scanNotes,
} from "./security";
import { tempHome } from "./testkit";

const homes: string[] = [];
afterEach(() => {
	for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

test("notes name CVE and GHSA IDs once each, in one spelling, note by note", () => {
	const r = scanNotes([
		"- Fix a path bug (cve-2026-12345, GHSA-ABCD-2345-wxyz)\n- See CVE-2026-12345 again",
		"Also CVE-2025-1234567.",
	]);
	expect(r.ids).toEqual(["CVE-2026-12345", "GHSA-abcd-2345-wxyz", "CVE-2025-1234567"]);
	expect(r.words).toBe(false);
});

test("the words count only when they clearly mean a security fix", () => {
	for (const line of [
		"This is a security release.",
		"- Security fix for the updater",
		"Fixes a security issue in the web view",
		"Patched a vulnerability in the parser",
		"Several security vulnerabilities fixed",
		"See the security advisory",
		"Important security update",
	])
		expect(scanNotes([line]).words, line).toBe(true);
	for (const line of [
		"## Security",
		"Updated the security policy",
		"Add SECURITY.md",
		"Docs: security headers",
		"Non-security update to the docs",
		"No known vulnerabilities in this release",
		"Works with security software installed",
	])
		expect(scanNotes([line]).words, line).toBe(false);
});

const ADVISORIES = [
	{
		ghsa_id: "GHSA-aaaa-bbbb-cccc",
		cve_id: "CVE-2026-0001",
		vulnerabilities: [{ patched_versions: ">= 1.2.0" }],
	},
	{ ghsa_id: "GHSA-dddd-eeee-ffff", cve_id: null, vulnerabilities: [{ patched_versions: "1.0.5, 2.0.1" }] },
	{ ghsa_id: "GHSA-gggg-hhhh-jjjj", cve_id: null, vulnerabilities: [{ patched_versions: null }] },
	{ ghsa_id: "GHSA-kkkk-mmmm-nnnn", vulnerabilities: [{ patched_versions: "3.0.0" }] },
	"not an advisory",
];

test("an advisory counts when a patched version lies above installed and at or below latest", () => {
	expect(advisoryIds(ADVISORIES, "1.1.0", "1.2.0")).toEqual(["GHSA-aaaa-bbbb-cccc", "CVE-2026-0001"]);
	expect(advisoryIds(ADVISORIES, "2.0.0", "2.0.1")).toEqual(["GHSA-dddd-eeee-ffff"]);
	// Fixed before the installed version, or only after latest: not this update's fix.
	expect(advisoryIds(ADVISORIES, "1.2.0", "1.3.0")).toEqual([]);
	expect(advisoryIds(ADVISORIES, "2.1.0", "2.9.0")).toEqual([]);
});

test("an OSV vulnerability counts when it is fixed at or below latest, and a GIT range is passed over", () => {
	const body = {
		vulns: [
			{
				id: "PYSEC-2026-1",
				affected: [{ ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.4.0" }] }] }],
			},
			{
				id: "PYSEC-2026-2",
				affected: [{ ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "2.0.0" }] }] }],
			},
			{ id: "OSV-GIT", affected: [{ ranges: [{ type: "GIT", events: [{ fixed: "1.3.0" }] }] }] },
			{ id: "NO-RANGES", affected: [{}] },
		],
	};
	expect(osvIds(body, "1.3.0", "1.5.0")).toEqual(["PYSEC-2026-1"]);
	expect(osvIds({}, "1.3.0", "1.5.0")).toEqual([]);
});

test("packages, repos and pages each source answers for", () => {
	expect(osvPackage({ latest: "pypi:httpie" })).toEqual({ ecosystem: "PyPI", name: "httpie" });
	expect(osvPackage({ latest: "npm:wrangler" })).toEqual({ ecosystem: "npm", name: "wrangler" });
	expect(osvPackage({ latest: "npm-tags:@scope/x" })).toEqual({ ecosystem: "npm", name: "@scope/x" });
	expect(osvPackage({ latest: "crates:ripgrep" })).toEqual({ ecosystem: "crates.io", name: "ripgrep" });
	expect(osvPackage({ latest: "github:a/b" })).toBeNull();
	expect(osvPackage({})).toBeNull();
	expect(githubRepoOf({ repo: "sharkdp/fd" })).toBe("sharkdp/fd");
	expect(githubRepoOf({ repo: "gitlab.com/a/b" })).toBeNull();
	expect(githubRepoOf({ latest: "github:astral-sh/uv" })).toBe("astral-sh/uv");
	expect(githubRepoOf({ latest: "pypi:x" })).toBeNull();
	expect(advisoryUrl("CVE-2026-1")).toBe("https://www.cve.org/CVERecord?id=CVE-2026-1");
	expect(advisoryUrl("GHSA-aaaa-bbbb-cccc")).toBe("https://github.com/advisories/GHSA-aaaa-bbbb-cccc");
	expect(advisoryUrl("RUSTSEC-2026-0001")).toBe("https://osv.dev/vulnerability/RUSTSEC-2026-0001");
});

/** A fake network that answers each URL from answers, and records what was asked. */
function fakeFetch(answers: Record<string, () => Response>): { fetch: FetchLike; asked: string[] } {
	const asked: string[] = [];
	const fetch: FetchLike = (url) => {
		asked.push(url);
		const answer = Object.entries(answers).find(([k]) => url.startsWith(k))?.[1];
		return answer ? Promise.resolve(answer()) : Promise.reject(new Error("offline"));
	};
	return { fetch, asked };
}

const API = "https://api.example.test";

/** GitHub's options pointed at the fake, with a cache in a fresh temp dir. */
function github(fetch: FetchLike) {
	const t = tempHome("upkeep-sec-");
	homes.push(t.dir);
	return { cacheDir: t.paths.cache, fetch, api: API };
}

test("the sources combine, with notes first and each ID once", async () => {
	const { fetch, asked } = fakeFetch({
		[`${API}/repos/o/r/security-advisories`]: () => Response.json(ADVISORIES),
	});
	const r = await lookSecurity({ repo: "o/r" }, "1.1.0", "1.2.0", ["Fixes CVE-2026-0001"], {
		fetch,
		github: github(fetch),
	});
	expect(r).toEqual({
		complete: true,
		fix: {
			ids: [
				{ id: "CVE-2026-0001", url: advisoryUrl("CVE-2026-0001") },
				{ id: "GHSA-aaaa-bbbb-cccc", url: advisoryUrl("GHSA-aaaa-bbbb-cccc") },
			],
		},
	});
	expect(asked).toEqual([`${API}/repos/o/r/security-advisories?state=published&per_page=100`]);
});

test("OSV is asked with the installed version for a package source", async () => {
	let sent = "";
	const fetch: FetchLike = (url, init) => {
		sent = `${url} ${String(init?.body)}`;
		return Promise.resolve(
			Response.json({
				vulns: [
					{ id: "GHSA-pppp-qqqq-rrrr", affected: [{ ranges: [{ type: "SEMVER", events: [{ fixed: "4.1.0" }] }] }] },
				],
			}),
		);
	};
	const r = await lookSecurity({ latest: "npm:wrangler" }, "4.0.0", "4.2.0", [], { fetch, github: null });
	expect(sent).toBe(`${OSV_QUERY} {"package":{"ecosystem":"npm","name":"wrangler"},"version":"4.0.0"}`);
	expect(r.fix?.ids.map((i) => i.id)).toEqual(["GHSA-pppp-qqqq-rrrr"]);
	expect(r.complete).toBe(true);
});

test("words alone flag with no ID; nothing found is no flag", async () => {
	const { fetch } = fakeFetch({});
	expect(await lookSecurity({}, "1.0", "1.1", ["A security fix."], { fetch, github: null })).toEqual({
		fix: { ids: [] },
		complete: true,
	});
	expect(await lookSecurity({}, "1.0", "1.1", ["Faster."], { fetch, github: null })).toEqual({
		fix: null,
		complete: true,
	});
});

test("an unreachable source is no flag and an incomplete look; an error answer counts as none", async () => {
	const offline = fakeFetch({});
	expect(
		await lookSecurity({ repo: "o/r", latest: "pypi:x" }, "1.0", "1.1", [], {
			fetch: offline.fetch,
			github: github(offline.fetch),
		}),
	).toEqual({
		fix: null,
		complete: false,
	});
	// GitHub left out for its budget: incomplete, so a later check asks.
	expect(await lookSecurity({ repo: "o/r" }, "1.0", "1.1", [], { fetch: offline.fetch, github: null })).toEqual({
		fix: null,
		complete: false,
	});
	const refused = fakeFetch({
		[`${API}/repos/o/r/`]: () => new Response("Not Found", { status: 404 }),
		[OSV_QUERY]: () => new Response("bad", { status: 400 }),
	});
	expect(
		await lookSecurity({ repo: "o/r", latest: "pypi:x" }, "1.0", "1.1", [], {
			fetch: refused.fetch,
			github: github(refused.fetch),
		}),
	).toEqual({
		fix: null,
		complete: true,
	});
});
