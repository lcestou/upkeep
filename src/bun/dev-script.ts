import { readFileSync } from "node:fs";

/**
 * Development builds only. Plays scripted steps into the view so the real window, on the real
 * system webview, can be driven and captured without moving the owner's pointer.
 * The file is a JSON list of `{ js, waitMs }`; a step with no string `js` only waits, and a missing
 * `waitMs` waits 300 ms.
 */
export async function playDevScript(
	file: string,
	run: (js: string) => void,
	settled: (index: number) => void = () => {},
): Promise<void> {
	const steps: unknown = JSON.parse(readFileSync(file, "utf8"));
	if (!Array.isArray(steps)) throw new Error("The dev script is not a list of steps.");
	for (const [index, step] of steps.entries()) {
		if (typeof step?.js === "string") run(step.js);
		// oxlint-disable-next-line no-await-in-loop -- the steps are a sequence
		await Bun.sleep(typeof step?.waitMs === "number" ? step.waitMs : 300);
		// Whoever is capturing the window waits for this before taking its picture.
		settled(index);
	}
}

/** True for a build made by `electrobun dev`, whose bundle directory ends in "-dev". */
export function isDevBuild(mainDir: string): boolean {
	return /-dev\/Resources\/app\/bun\/?$/.test(mainDir);
}
