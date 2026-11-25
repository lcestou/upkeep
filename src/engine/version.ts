/**
 * The first dotted version in the text, else its first number-looking run. A pre-release suffix stays on
 * ("2.0.0-rc.1", "1.3.0-beta2"), so it is never read as the release it comes before; a word that only starts like one
 * ("1.2.3-prebuilt") is no suffix.
 */
export function extractVersion(text: string): string | null {
	// A dotted version wins over an earlier bare number: lazygit prints "commit=0fbfd…, version=0.66.3".
	const match =
		/[0-9]+(\.[0-9]+)+(?:[-.~_]?(?i:alpha|beta|preview|pre|rc)(?:[-.]?[0-9]+)?(?![A-Za-z])|[a-z]*)/.exec(text) ??
		/[0-9]+[a-z]*/.exec(text);
	return match ? match[0] : null;
}

/** A release tag's version. A tag with no dot (b4938) is a build number, not a tracked version. */
export function tagVersion(tag: string): string | null {
	const version = extractVersion(tag);
	return version?.includes(".") ? version : null;
}

const SENTINELS = new Set(["", "unknown", "not_installed", "broken"]);

/** False past the end of the string, where indexing gives undefined. ASCII digits only. */
function isDigit(c: string | undefined): boolean {
	return c !== undefined && c >= "0" && c <= "9";
}

/** A character's weight in verrevcmp: "~" sorts before the end of a string, letters before other symbols. */
function order(c: string): number {
	if (isDigit(c)) return 0;
	if (/[A-Za-z]/.test(c)) return c.charCodeAt(0);
	if (c === "~") return -1;
	return c.charCodeAt(0) + 256;
}

/** GNU verrevcmp, the comparison behind `sort -V`. */
function sortV(a: string, b: string): number {
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		let firstDiff = 0;
		while ((i < a.length && !isDigit(a[i])) || (j < b.length && !isDigit(b[j]))) {
			const ac = i >= a.length ? 0 : order(a.charAt(i));
			const bc = j >= b.length ? 0 : order(b.charAt(j));
			if (ac !== bc) return ac - bc;
			i++;
			j++;
		}
		while (a[i] === "0") i++;
		while (b[j] === "0") j++;
		while (isDigit(a[i]) && isDigit(b[j])) {
			if (!firstDiff) firstDiff = a.charCodeAt(i) - b.charCodeAt(j);
			i++;
			j++;
		}
		if (isDigit(a[i])) return 1;
		if (isDigit(b[j])) return -1;
		if (firstDiff) return firstDiff;
	}
	return 0;
}

/** A pre-release suffix at the end of a version, in the forms extractVersion keeps, in any case (0.7.2-Beta, 1.0.0-RC1). */
const PRE = /[-.~_]?((?i:alpha|beta|preview|pre|rc))(?:[-.]?([0-9]+))?$/;
/** Pre-release words from earliest to latest: a beta comes after an alpha and before a release candidate. */
const PRE_RANK = ["alpha", "beta", "pre", "preview", "rc"];

type Split = { base: string; pre: { rank: number; n: number } | null };

/** A version cut into its release part and its pre-release part; pre is null for a release (3.6a is one). */
function splitPre(v: string): Split {
	const m = PRE.exec(v);
	const base = m ? v.slice(0, m.index) : v;
	if (!m || !/[0-9]$/.test(base)) return { base: v, pre: null };
	return { base, pre: { rank: PRE_RANK.indexOf((m[1] ?? "").toLowerCase()), n: Number(m[2] ?? 0) } };
}

/**
 * Whether two release parts name the same release once the shorter is padded with zero parts (2.0 and 2.0.0). Only
 * the pre-release comparison asks: between two releases isNewer keeps sort -V's order, where 2.0.0 is after 2.0.
 */
function samePadded(a: string, b: string): boolean {
	const pa = a.split(".");
	const pb = b.split(".");
	const n = Math.max(pa.length, pb.length);
	for (let i = 0; i < n; i++) {
		const x = pa[i] ?? "0";
		const y = pb[i] ?? "0";
		if (x !== y && !(/^\d+$/.test(x) && /^\d+$/.test(y) && Number(x) === Number(y))) return false;
	}
	return true;
}

/** Whether a version carries a pre-release suffix (2.0.0-rc.1, 0.7.2-Beta); 3.6a is a release. */
export function isPrerelease(v: string): boolean {
	return splitPre(v).pre !== null;
}

/**
 * True when latest is a later release than installed. Compares number by number, part by part. A pre-release comes
 * before its own release and after the release before it: 2.0.0-rc.1 is newer than 1.9.0 and older than 2.0.0.
 */
export function isNewer(installed: string | null, latest: string | null): boolean {
	if (installed === null || latest === null) return false;
	if (SENTINELS.has(installed) || SENTINELS.has(latest)) return false;
	const pa = splitPre(installed);
	const pb = splitPre(latest);
	if (pa.pre || pb.pre) {
		// 2.0 and 2.0.0 are one release here, so a candidate of it never reads as newer than the release itself.
		if (!samePadded(pa.base, pb.base)) return isNewer(pa.base, pb.base);
		if (!pa.pre) return false;
		if (!pb.pre) return true;
		return pb.pre.rank !== pa.pre.rank ? pb.pre.rank > pa.pre.rank : pb.pre.n > pa.pre.n;
	}
	const a = installed.replace(/[a-z]/g, "");
	const b = latest.replace(/[a-z]/g, "");
	if (a !== b) {
		// sort's last-resort byte order decides a -V tie, as GNU sort does.
		const cmp = sortV(a, b) || (a < b ? -1 : 1);
		return cmp < 0;
	}
	const sa = /[a-z]*$/.exec(installed)?.[0] ?? "";
	const sb = /[a-z]*$/.exec(latest)?.[0] ?? "";
	if (sa === "" && sb !== "") return true;
	if (sb === "" && sa !== "") return false;
	return sa < sb;
}
