// A small reader for the markdown GitHub release bodies use. It returns plain data, never HTML, so nothing in a body can run.

export type Inline =
	| { t: "text"; s: string }
	| { t: "bold"; s: string }
	| { t: "code"; s: string }
	| { t: "url"; s: string };

export type Block =
	| { t: "heading"; inline: Inline[] }
	| { t: "list"; items: Inline[][] }
	| { t: "para"; inline: Inline[] };

const TAG = /<\/?[a-zA-Z][^>]*>/g;
// Order matters: code first so nothing inside backticks is read as bold or a link.
const INLINE =
	/`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/** Splits one line into text, bold, code and url runs. Link syntax keeps only its label, and a bare link ends before trailing punctuation. */
export function inline(text: string): Inline[] {
	const out: Inline[] = [];
	const push = (part: Inline) => {
		const last = out.at(-1);
		if (part.t === "text" && last?.t === "text") last.s += part.s;
		else if (part.s) out.push(part);
	};
	let at = 0;
	for (const m of text.matchAll(INLINE)) {
		const i = m.index ?? 0;
		push({ t: "text", s: text.slice(at, i) });
		if (m[1] !== undefined) push({ t: "code", s: m[1] });
		else if (m[2] !== undefined || m[3] !== undefined) push({ t: "bold", s: m[2] ?? m[3] ?? "" });
		else if (m[4] !== undefined) push({ t: "text", s: m[4] });
		else if (m[6] !== undefined) push({ t: "url", s: m[6] });
		at = i + m[0].length;
	}
	push({ t: "text", s: text.slice(at) });
	return out;
}

/** Reads a release body into headings, lists and paragraphs. HTML tags are dropped, not rendered; a list ends at the next blank line or non-item line. */
export function parseNotes(body: string): Block[] {
	const blocks: Block[] = [];
	let para: string[] = [];
	let list: Inline[][] | null = null;
	const flush = () => {
		if (para.length > 0) blocks.push({ t: "para", inline: inline(para.join(" ")) });
		para = [];
		if (list) blocks.push({ t: "list", items: list });
		list = null;
	};
	for (const raw of body.replace(TAG, "").split(/\r?\n/)) {
		const line = raw.trim();
		const heading = /^#{1,6}\s+(.*)$/.exec(line);
		const item = /^[-*+]\s+(.*)$/.exec(line);
		if (!line) flush();
		else if (heading) {
			flush();
			blocks.push({ t: "heading", inline: inline(heading[1] ?? "") });
		} else if (item) {
			if (para.length > 0) blocks.push({ t: "para", inline: inline(para.join(" ")) });
			para = [];
			(list ??= []).push(inline(item[1] ?? ""));
		} else if (list) {
			flush();
			para.push(line);
		} else para.push(line);
	}
	flush();
	return blocks;
}
