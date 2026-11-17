/**
 * Keeps the last tick box clicked in one list, so a Shift-click can reach back to it as in a file manager.
 * The returned function gives the ids one click changes, in list order: with `range` every id from the last one
 * clicked to this one, either way up; without it, with no earlier click, or when the earlier row has left `ids`,
 * only this one. Each list needs its own keeper, or a Shift-click would reach into another list.
 */
export function rangeClicks(): (ids: readonly string[], id: string, range: boolean) => string[] {
	let last: string | null = null;
	return (ids, id, range) => {
		const from = range && last !== null ? ids.indexOf(last) : -1;
		const to = ids.indexOf(id);
		last = id;
		return from >= 0 && to >= 0 ? ids.slice(Math.min(from, to), Math.max(from, to) + 1) : [id];
	};
}
