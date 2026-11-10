import type { Attachment } from "svelte/attachments";

/** Marks a scroller with data-more-top / data-more-bottom while content lies past that edge. */
export const shade: Attachment<HTMLElement> = (node) => {
	const update = () => {
		node.toggleAttribute("data-more-top", node.scrollTop > 1);
		node.toggleAttribute("data-more-bottom", node.scrollHeight - node.scrollTop - node.clientHeight > 1);
	};
	const ro = new ResizeObserver(update);
	ro.observe(node);
	const mo = new MutationObserver(update);
	mo.observe(node, { childList: true, subtree: true, characterData: true });
	node.addEventListener("scroll", update, { passive: true });
	update();
	return () => {
		ro.disconnect();
		mo.disconnect();
		node.removeEventListener("scroll", update);
	};
};
