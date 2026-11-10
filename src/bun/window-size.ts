import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type WindowSize = { width: number; height: number };

export const DEFAULT_SIZE: WindowSize = { width: 980, height: 720 };
// Below this the layout has nothing left to drop; the view is designed down to 760 by 520.
const MIN: WindowSize = { width: 760, height: 520 };
const MAX: WindowSize = { width: 3840, height: 2160 };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

/**
 * The size the window had last time, or the default. Only the size is kept: a remembered position
 * can land on a monitor that is no longer plugged in, and the window is centred on every open.
 */
export function loadWindowSize(file: string): WindowSize {
	try {
		const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof raw !== "object" || raw === null) return DEFAULT_SIZE;
		const { width, height } = raw as Record<string, unknown>;
		if (typeof width !== "number" || typeof height !== "number") return DEFAULT_SIZE;
		if (!Number.isFinite(width) || !Number.isFinite(height)) return DEFAULT_SIZE;
		return { width: clamp(width, MIN.width, MAX.width), height: clamp(height, MIN.height, MAX.height) };
	} catch {
		return DEFAULT_SIZE;
	}
}

export function saveWindowSize(file: string, size: WindowSize): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify({ width: Math.round(size.width), height: Math.round(size.height) }));
	renameSync(tmp, file);
}
