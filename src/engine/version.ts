/** The first version-looking run in the text, as the old script's extract_version found it. */
export function extractVersion(text: string): string | null {
	const match = /[0-9]+(\.[0-9]+)*[a-z]*/.exec(text);
	return match ? match[0] : null;
}

/** A release tag's version. A tag with no dot (b4938) is a build number, not a tracked version. */
export function tagVersion(tag: string): string | null {
	const version = extractVersion(tag);
	return version?.includes(".") ? version : null;
}

const SENTINELS = new Set(["", "unknown", "not_installed", "broken"]);

function isDigit(c: string | undefined): boolean {
	return c !== undefined && c >= "0" && c <= "9";
}

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

/** True when latest is a later release than installed. Ports version_compare (old line 318). */
export function isNewer(installed: string | null, latest: string | null): boolean {
	if (installed === null || latest === null) return false;
	if (SENTINELS.has(installed) || SENTINELS.has(latest)) return false;
	const a = installed.replace(/[a-z]/g, "");
	const b = latest.replace(/[a-z]/g, "");
	if (a !== b) {
		// sort's last-resort byte order decides a -V tie, as it does in the bash pipeline.
		const cmp = sortV(a, b) || (a < b ? -1 : 1);
		return cmp < 0;
	}
	const sa = /[a-z]*$/.exec(installed)?.[0] ?? "";
	const sb = /[a-z]*$/.exec(latest)?.[0] ?? "";
	if (sa === "" && sb !== "") return true;
	if (sb === "" && sa !== "") return false;
	return sa < sb;
}
