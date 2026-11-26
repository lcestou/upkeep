/**
 * Whether a waiting update fixes a security problem, from three sources combined: the release notes between the
 * installed version and the latest, the GitHub repo's published advisories, and OSV.dev for a package on PyPI, npm or
 * crates.io. Plain rules, no model. The one place that names OSV.dev, and the pages an ID links to. A source that
 * cannot be reached adds nothing: a flag is never a guess, and its absence is never an error.
 */
import type { Advisory, AppSpec, SecurityFix } from "../shared/types";
import { forgeOf } from "./forge";
import { type FetchLike, type ReleaseOpts, fetchAdvisories, isFailure, record, str } from "./github";
import { isNewer } from "./version";

/** OSV.dev's query endpoint: one package and version in, the known vulnerabilities that affect it out. */
export const OSV_QUERY = "https://api.osv.dev/v1/query";

/**
 * The words that mark a line of release notes as a security fix, matched case-insensitively. "security" alone is
 * not enough: it is also "security policy", "SECURITY.md" or "security headers docs". "Non-security" says the opposite.
 * Keep the list in docs/window.md in step with this one.
 */
export const SECURITY_WORDS: readonly RegExp[] = [
	/(?<!non-)\bsecurity (fix|fixes|issue|issues|vulnerability|vulnerabilities|advisory|advisories|release|update|updates)\b/i,
	/(?<!no known )\bvulnerabilit(y|ies)\b/i,
];

/** A CVE ID: the year, then four digits or more. */
const CVE = /\bCVE-\d{4}-\d{4,}\b/gi;
/** A GitHub advisory ID: three groups of four after GHSA. */
const GHSA = /\bGHSA(?:-[0-9a-z]{4}){3}\b/gi;

/** An ID in the one spelling each database uses: CVE in capitals, GHSA's groups in lower case. */
function canonical(id: string): string {
	return /^ghsa/i.test(id) ? `GHSA${id.slice(4).toLowerCase()}` : id.toUpperCase();
}

/** The page that describes an ID: cve.org for a CVE, GitHub's advisory database for a GHSA, OSV.dev for any other. */
export function advisoryUrl(id: string): string {
	if (id.startsWith("CVE-")) return `https://www.cve.org/CVERecord?id=${encodeURIComponent(id)}`;
	if (id.startsWith("GHSA-")) return `https://github.com/advisories/${encodeURIComponent(id)}`;
	return `https://osv.dev/vulnerability/${encodeURIComponent(id)}`;
}

/**
 * The CVE and GHSA IDs that release notes name, in the order they first appear, and whether a line says in words that
 * it fixes a security problem. A bare "security" never counts; an ID counts wherever it appears.
 */
export function scanNotes(notes: string[]): { ids: string[]; words: boolean } {
	const ids = new Set<string>();
	let words = false;
	for (const text of notes) {
		for (const m of text.matchAll(CVE)) ids.add(canonical(m[0]));
		for (const m of text.matchAll(GHSA)) ids.add(canonical(m[0]));
		if (!words) words = text.split("\n").some((line) => SECURITY_WORDS.some((w) => w.test(line)));
	}
	return { ids: [...ids], words };
}

/** Whether v is a version above installed and at or below latest: one the update brings in. */
const inSpan = (v: string, installed: string, latest: string) => isNewer(installed, v) && !isNewer(latest, v);

/**
 * The IDs of the advisories in a repository advisories list (GitHub's shape) that the update fixes: one of a
 * vulnerability's patched versions lies above installed and at or below latest. patched_versions is free text ("1.2.3",
 * ">= 1.2.3", "1.2.3, 2.0.1"); every version in it is tried. An advisory with no patched version never counts. Both
 * its GHSA and its CVE are named, when it has both.
 */
export function advisoryIds(list: unknown[], installed: string, latest: string): string[] {
	const ids: string[] = [];
	for (const item of list) {
		const a = record(item);
		const vulns = Array.isArray(a.vulnerabilities) ? a.vulnerabilities : [];
		const fixed = vulns.some((v) =>
			(str(record(v).patched_versions).match(/\d+(?:\.\d+)*(?:[-+][\w.]+)?/g) ?? []).some((p) =>
				inSpan(p, installed, latest),
			),
		);
		// shortcut: a repo that publishes several packages may flag another package's fix, since the release table names no package; filter by vulnerabilities[].package once a table can name one.
		if (!fixed) continue;
		for (const id of [str(a.ghsa_id), str(a.cve_id)]) if (id) ids.push(canonical(id));
	}
	return ids;
}

/**
 * The IDs of the vulnerabilities in an OSV.dev answer for the installed version that the update fixes: a range's
 * "fixed" event at or below latest (and above installed). A GIT range's events are commits, not versions, and are
 * passed over.
 */
export function osvIds(body: unknown, installed: string, latest: string): string[] {
	const vulns = record(body).vulns;
	if (!Array.isArray(vulns)) return [];
	return vulns.flatMap((item) => {
		const v = record(item);
		const affected = Array.isArray(v.affected) ? v.affected : [];
		const fixed = affected.some((a) => {
			const ranges = record(a).ranges;
			return (
				Array.isArray(ranges) &&
				ranges.some((r) => {
					const range = record(r);
					const events = Array.isArray(range.events) ? range.events : [];
					return range.type !== "GIT" && events.some((e) => inSpan(str(record(e).fixed), installed, latest));
				})
			);
		});
		const id = str(v.id);
		return fixed && id ? [canonical(id)] : [];
	});
}

/** OSV.dev's ecosystem for an app's latest source and the package it names, or null for a source OSV does not cover. */
export function osvPackage(spec: Pick<AppSpec, "latest">): { ecosystem: string; name: string } | null {
	const [, scheme, name] = /^(pypi|npm|npm-tags|crates):(.+)$/.exec(spec.latest ?? "") ?? [];
	if (!scheme || !name) return null;
	const ecosystem = scheme === "pypi" ? "PyPI" : scheme === "crates" ? "crates.io" : "npm";
	return { ecosystem, name };
}

/** The GitHub owner/repo whose advisories an app's updates answer to: its repo on GitHub, or a "github:" latest. */
export function githubRepoOf(spec: Pick<AppSpec, "repo" | "forge" | "latest">): string | null {
	if (spec.repo) {
		const f = forgeOf(spec.repo, spec.forge);
		return f?.kind === "github" ? f.path : null;
	}
	return spec.latest?.startsWith("github:") ? spec.latest.slice("github:".length) : null;
}

/** What a security look needs: the network, and GitHub's options, or null to leave GitHub out (its budget is low). */
export type SecurityDeps = { fetch: FetchLike; github: ReleaseOpts | null };

/**
 * Asks OSV.dev for package at installed. Null when it could not be asked or did not answer with JSON; any answer
 * other than 2xx is read as no vulnerabilities, so a package OSV does not know is not asked again and again.
 */
async function askOsv(
	pkg: { ecosystem: string; name: string },
	installed: string,
	fetch: FetchLike,
): Promise<unknown | null> {
	try {
		const res = await fetch(OSV_QUERY, {
			method: "POST",
			headers: { "Content-Type": "application/json", "User-Agent": "upkeep" },
			body: JSON.stringify({ package: pkg, version: installed }),
		});
		return res.ok ? await res.json() : {};
	} catch {
		return null;
	}
}

/**
 * Whether the update from installed to latest fixes a security problem: the notes (the release notes the update
 * brings in), then the GitHub repo's advisories when the app lives on GitHub, then OSV.dev when its latest comes from
 * PyPI, npm or crates.io. fix is null when none of them says so; ids are deduplicated across sources, notes first.
 * complete is false when a source could not be reached (or GitHub was left out), so the caller asks again later; an
 * answer that is not a list (a repo with advisories turned off) counts as none.
 */
export async function lookSecurity(
	spec: Pick<AppSpec, "repo" | "forge" | "latest">,
	installed: string,
	latest: string,
	notes: string[],
	deps: SecurityDeps,
): Promise<{ fix: SecurityFix | null; complete: boolean }> {
	const found = scanNotes(notes);
	const ids = [...found.ids];
	let complete = true;
	const repo = githubRepoOf(spec);
	if (repo && deps.github === null) complete = false;
	else if (repo && deps.github) {
		const list = await fetchAdvisories(repo, deps.github);
		if (!isFailure(list)) ids.push(...advisoryIds(list, installed, latest));
		else if (list.failure !== "http") complete = false;
	}
	const pkg = osvPackage(spec);
	if (pkg) {
		const body = await askOsv(pkg, installed, deps.fetch);
		if (body === null) complete = false;
		else ids.push(...osvIds(body, installed, latest));
	}
	const unique = [...new Set(ids)];
	if (unique.length === 0 && !found.words) return { fix: null, complete };
	const advisories: Advisory[] = unique.map((id) => ({ id, url: advisoryUrl(id) }));
	return { fix: { ids: advisories }, complete };
}
