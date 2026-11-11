import type { Attachment } from "svelte/attachments";

/** Shows as many whole words of text as fit the node's width, then an ellipsis; never cuts inside a word. */
export function fitWords(text: string): Attachment<HTMLElement> {
	return (node) => {
		const fit = () => {
			node.textContent = text;
			if (node.scrollWidth <= node.clientWidth) return;
			const words = text.split(" ");
			for (let n = words.length - 1; n > 0; n--) {
				node.textContent = `${words.slice(0, n).join(" ")}…`;
				if (node.scrollWidth <= node.clientWidth) return;
			}
			// shortcut: one word wider than the cell is clipped, not hyphenated; fine for shell commands.
			node.textContent = `${words[0] ?? ""}…`;
		};
		const ro = new ResizeObserver(fit);
		ro.observe(node);
		fit();
		return () => ro.disconnect();
	};
}

/** A row's name line: hide the repo when the line overflows, then shrink chips to their glyphs. */
export const fitLine: Attachment<HTMLElement> = (node) => {
	const over = () => node.scrollWidth > node.clientWidth + 0.5;
	const fit = () => {
		node.classList.remove("no-repo", "compact");
		if (!over()) return;
		node.classList.add("no-repo");
		if (over()) node.classList.add("compact");
	};
	const ro = new ResizeObserver(fit);
	ro.observe(node);
	const mo = new MutationObserver(fit);
	mo.observe(node, { childList: true, subtree: true, characterData: true });
	fit();
	return () => {
		ro.disconnect();
		mo.disconnect();
	};
};
