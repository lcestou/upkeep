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
