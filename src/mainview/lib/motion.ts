/** Svelte transitions run in JS, so the reduced-motion setting is read here as well as in CSS. */
export function ms(duration: number): number {
	if (typeof matchMedia !== "function") return duration;
	return matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : duration;
}
