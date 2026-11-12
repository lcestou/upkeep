import { CString, dlopen, FFIType } from "bun:ffi";
import { existsSync, readdirSync, statSync } from "node:fs";

/** glibc's own functions; null where there is no libc.so.6 (a musl system), and then ICU_DATA is left as it is. */
function openLibc() {
	try {
		return dlopen("libc.so.6", {
			unsetenv: { args: [FFIType.cstring], returns: FFIType.i32 },
			getenv: { args: [FFIType.cstring], returns: FFIType.ptr },
		});
	} catch {
		return null;
	}
}
const libc = openLibc();

/** A C string for libc: the text and its closing zero byte. */
const cstr = (s: string) => Buffer.from(`${s}\0`);

/** The variable as libc sees it, which is what a process the webview starts inherits; null when unset. */
export function cEnv(name: string): string | null {
	const p = libc?.symbols.getenv(cstr(name));
	return p ? new CString(p).toString() : null;
}

/**
 * True when the folder holds an ICU data file (icudt<version><l|b>.dat); a missing folder holds none. A folder that
 * cannot be listed counts as holding data: it may be someone's own, and Upkeep cannot tell, so it is left alone.
 */
export function holdsIcuData(dir: string): boolean {
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
	try {
		return readdirSync(dir).some((f) => /^icudt\d+[lb]\.dat$/.test(f));
	} catch {
		return true;
	}
}

/**
 * The framework's launcher sets ICU_DATA to the app's own bin folder, which holds no ICU data. WebKit's processes
 * inherit it, and where the system's ICU keeps its data in a file rather than built into the library (openSUSE's
 * libicu-ledata), ICU then finds none: the page process aborts in its time zone setup and the window stays blank.
 * So ICU_DATA is cleared, before any window opens, when the folder it names has no data file. A value that does
 * point at ICU data is someone's own choice and stays. Clearing process.env alone does not reach libc, so the
 * variable goes through unsetenv. Returns true when it was cleared.
 */
export function dropStrayIcuData(): boolean {
	const dir = cEnv("ICU_DATA");
	if (!libc || dir === null || holdsIcuData(dir)) return false;
	libc.symbols.unsetenv(cstr("ICU_DATA"));
	delete process.env.ICU_DATA;
	return true;
}
