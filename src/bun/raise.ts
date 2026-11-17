import { dlopen, FFIType, type Library, toArrayBuffer } from "bun:ffi";

const X11_SYMBOLS = {
	// The display is kept as its address, a u64, so 0n is "none".
	XOpenDisplay: { args: [FFIType.ptr], returns: FFIType.u64 },
	XDefaultRootWindow: { args: [FFIType.u64], returns: FFIType.u64 },
	XInternAtom: { args: [FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.u64 },
	XGetWindowProperty: {
		args: [
			FFIType.u64,
			FFIType.u64,
			FFIType.u64,
			FFIType.i64,
			FFIType.i64,
			FFIType.i32,
			FFIType.u64,
			FFIType.ptr,
			FFIType.ptr,
			FFIType.ptr,
			FFIType.ptr,
			FFIType.ptr,
		],
		returns: FFIType.i32,
	},
	XFree: { args: [FFIType.u64], returns: FFIType.i32 },
	XSendEvent: { args: [FFIType.u64, FFIType.u64, FFIType.i32, FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
	XFlush: { args: [FFIType.u64], returns: FFIType.i32 },
} as const;

/** The few Xlib calls a raise needs, as bun:ffi types them. Tests hand in a fake with the same shape. */
export type X11 = Library<typeof X11_SYMBOLS>["symbols"];

/** libX11's calls; null where the library is missing (no X at all), and then the framework's own raise is all there is. */
export function openX11(): X11 | null {
	try {
		return dlopen("libX11.so.6", X11_SYMBOLS).symbols;
	} catch {
		return null;
	}
}

const CLIENT_MESSAGE = 33;
const SUBSTRUCTURE_NOTIFY_AND_REDIRECT = (1 << 19) | (1 << 20);
// EWMH source indication: 1 is an application, 2 a pager. A window manager trusts a pager to move focus.
const SOURCE_PAGER = 2n;

/** A C string for Xlib: the text and its closing zero byte. */
const cstr = (s: string) => Buffer.from(`${s}\0`);

/**
 * The XClientMessageEvent asking the window manager to activate `win`, as a pager would, laid out for a 64-bit
 * little-endian Xlib (x86_64 and aarch64): type at 0, window at 32, message_type at 40, format at 48, data.l from 56.
 * Timestamp (data.l[1]) stays 0, CurrentTime. The buffer is a whole XEvent, 24 longs.
 */
export function activateEvent(win: bigint, atom: bigint): BigUint64Array {
	const ev = new BigUint64Array(24);
	const view = new DataView(ev.buffer);
	view.setInt32(0, CLIENT_MESSAGE, true);
	ev[4] = win;
	ev[5] = atom;
	view.setInt32(48, 32, true);
	ev[7] = SOURCE_PAGER;
	return ev;
}

/** A window property of 32-bit items, which Xlib hands back as longs; empty when it is missing or of another format. */
function longs(x: X11, display: bigint, win: bigint, prop: bigint): bigint[] {
	const type = new BigUint64Array(1);
	const format = new Int32Array(1);
	const count = new BigUint64Array(1);
	const after = new BigUint64Array(1);
	const data = new BigUint64Array(1);
	if (x.XGetWindowProperty(display, win, prop, 0, 4096, 0, 0n, type, format, count, after, data) !== 0) return [];
	if (!data[0]) return [];
	const n = format[0] === 32 ? Number(count[0]) : 0;
	// Copied out before XFree: the view reads Xlib's memory.
	const out = n ? [...new BigUint64Array(toArrayBuffer(data[0], 0, n * 8))] : [];
	x.XFree(data[0]);
	return out;
}

/**
 * Brings this process's window to the front through the window manager, as a pager does. GNOME's mutter refuses the
 * framework's own activate (an application's request with an old user time) whenever another app has focus: Upkeep
 * stays behind it and GNOME shows "Upkeep is ready" instead. Cinnamon lets it through, Wayland changes nothing, since
 * the window is an X11 one under XWayland. The window is the managed one whose _NET_WM_PID is `pid`. Returns false
 * when there is no X display or no such window yet: a window just shown is not managed until the window manager maps
 * it, so the caller tries again shortly.
 */
export function createRaiser(x: X11 | null): (pid: number) => boolean {
	let display = 0n;
	return (pid) => {
		if (!x) return false;
		if (!display) display = x.XOpenDisplay(null);
		const d = display;
		if (!d) return false;
		const atom = (name: string) => x.XInternAtom(d, cstr(name), 0);
		const root = x.XDefaultRootWindow(d);
		const pidAtom = atom("_NET_WM_PID");
		const win = longs(x, d, root, atom("_NET_CLIENT_LIST")).findLast((w) => longs(x, d, w, pidAtom)[0] === BigInt(pid));
		if (win === undefined) return false;
		x.XSendEvent(d, root, 0, SUBSTRUCTURE_NOTIFY_AND_REDIRECT, activateEvent(win, atom("_NET_ACTIVE_WINDOW")));
		x.XFlush(d);
		return true;
	};
}
