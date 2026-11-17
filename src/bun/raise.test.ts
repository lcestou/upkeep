import { expect, test } from "bun:test";
import { ptr } from "bun:ffi";
import { activateEvent, createRaiser, openX11, type X11 } from "./raise";

const CLIENT_LIST = 101n;
const WM_PID = 102n;
const ACTIVE_WINDOW = 103n;
const ATOMS = new Map([
	["_NET_CLIENT_LIST", CLIENT_LIST],
	["_NET_WM_PID", WM_PID],
	["_NET_ACTIVE_WINDOW", ACTIVE_WINDOW],
]);
const ROOT = 1n;

/** A fake Xlib: windows and their 32-bit properties, served from real memory the way Xlib hands them back. */
function fakeX(props: Map<string, bigint[]>, display = true) {
	const kept: BigUint64Array[] = [];
	const sent: { win: bigint; mask: number; ev: BigUint64Array }[] = [];
	const freed: bigint[] = [];
	const x = {
		XOpenDisplay: () => (display ? 7n : 0n),
		XDefaultRootWindow: () => ROOT,
		XInternAtom: (_d: unknown, name: Uint8Array) => ATOMS.get(Buffer.from(name).toString().replace("\0", "")) ?? 0n,
		XGetWindowProperty: (...a: unknown[]) => {
			const [win, prop] = [a[1] as bigint, a[2] as bigint];
			const items = props.get(`${win}:${prop}`);
			if (!items) return 1;
			const buf = new BigUint64Array(items);
			kept.push(buf);
			(a[8] as Int32Array)[0] = 32;
			(a[9] as BigUint64Array)[0] = BigInt(items.length);
			(a[11] as BigUint64Array)[0] = BigInt(ptr(buf));
			return 0;
		},
		XFree: (p: bigint) => (freed.push(p), 1),
		XSendEvent: (_d: unknown, win: bigint, _p: number, mask: number, ev: BigUint64Array) => (
			sent.push({ win, mask, ev }),
			1
		),
		XFlush: () => 1,
	};
	return { x: x as unknown as X11, sent, freed };
}

const props = (pids: [bigint, number][]) =>
	new Map<string, bigint[]>([
		[`${ROOT}:${CLIENT_LIST}`, pids.map(([w]) => w)],
		...pids.map(([w, pid]): [string, bigint[]] => [`${w}:${WM_PID}`, [BigInt(pid)]]),
	]);

test("the event is a pager's _NET_ACTIVE_WINDOW request for the window", () => {
	const ev = activateEvent(0xe00003n, 103n);
	const view = new DataView(ev.buffer);
	expect(ev.byteLength).toBe(192);
	expect(view.getInt32(0, true)).toBe(33);
	expect(ev[4]).toBe(0xe00003n);
	expect(ev[5]).toBe(103n);
	expect(view.getInt32(48, true)).toBe(32);
	expect([ev[7], ev[8], ev[9]]).toEqual([2n, 0n, 0n]);
});

test("raises the managed window whose pid is this process's, through the root window", () => {
	const { x, sent, freed } = fakeX(
		props([
			[10n, 999],
			[11n, 1234],
		]),
	);
	expect(createRaiser(x)(1234)).toBe(true);
	expect(sent).toHaveLength(1);
	expect(sent[0]?.win).toBe(ROOT);
	expect(sent[0]?.mask).toBe((1 << 19) | (1 << 20));
	expect(sent[0]?.ev[4]).toBe(11n);
	expect(sent[0]?.ev[5]).toBe(ACTIVE_WINDOW);
	// The list, then window 11 (searched from the end) matches at once.
	expect(freed).toHaveLength(2);
});

test("no window of this process yet: nothing is sent, and the caller is told to try again", () => {
	const { x, sent } = fakeX(props([[10n, 999]]));
	expect(createRaiser(x)(1234)).toBe(false);
	expect(sent).toHaveLength(0);
});

test("a property Xlib cannot read counts as missing", () => {
	const { x, sent } = fakeX(new Map());
	expect(createRaiser(x)(1234)).toBe(false);
	expect(sent).toHaveLength(0);
});

test("no libX11 or no X display: false, and nothing is tried", () => {
	expect(createRaiser(null)(1234)).toBe(false);
	expect(createRaiser(fakeX(props([[11n, 1234]]), false).x)(1234)).toBe(false);
});

test("libX11 opens or is reported missing, without throwing", () => {
	const x = openX11();
	expect(x === null || typeof x.XOpenDisplay === "function").toBe(true);
});
