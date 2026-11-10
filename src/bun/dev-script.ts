import { readFileSync } from "node:fs";

type Step = { js?: string; waitMs?: number };

/**
 * Development builds only. Plays scripted steps into the view so the real window, on the real
 * system webview, can be driven and captured without moving the owner's pointer.
 * The file is a JSON list of `{ js, waitMs }`.
 */
export async function playDevScript(file: string, run: (js: string) => void): Promise<void> {
	const steps: unknown = JSON.parse(readFileSync(file, "utf8"));
	if (!Array.isArray(steps)) throw new Error("The dev script is not a list of steps.");
	for (const step of steps as Step[]) {
		if (typeof step.js === "string") run(step.js);
		// oxlint-disable-next-line no-await-in-loop -- the steps are a sequence
		await Bun.sleep(typeof step.waitMs === "number" ? step.waitMs : 300);
	}
}

/** True for a build made by `electrobun dev`, whose bundle directory ends in "-dev". */
export function isDevBuild(mainDir: string): boolean {
	return /-dev\/Resources\/app\/bun\/?$/.test(mainDir);
}
