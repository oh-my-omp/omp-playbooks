// Markdown runs of a drawn text, split into the units a person edits one at a time: paragraphs,
// headings, `//` comment lines and list items, each with the range of text it came from.
import type { TspNode } from "../tsp-types";
import type { ListItem, RenderContext, SourceLine, Span } from "./contract";
import { slotParts } from "./slot";

type Block =
	| { readonly kind: "paragraph"; readonly span: Span; readonly text: string }
	| { readonly kind: "heading"; readonly span: Span; readonly text: string }
	/** `// note` lines: `span` and `text` are the note after the marker. */
	| { readonly kind: "comment"; readonly span: Span; readonly text: string }
	| {
			readonly kind: "list";
			readonly ordered: boolean;
			/** First number of an ordered list. */
			readonly start: number;
			readonly span: Span;
			/** `span`: the item's lines; `content`: its text after the marker. */
			readonly items: readonly { readonly span: Span; readonly content: Span; readonly text: string }[];
	  };

const ITEM = /^( {0,3})([-*+]|(\d{1,9})[.)])([ \t]+|$)/;
const HEADING = /^ {0,3}#{1,6}([ \t]|$)/;
const COMMENT = /^[ \t]*\/\/ ?/;

function end(line: SourceLine): number {
	return line.offset + line.text.length;
}

/** The editable units of one Markdown run, in order. */
export function markdownBlocks(lines: readonly SourceLine[]): Block[] {
	const blocks: Block[] = [];
	let index = 0;
	const blank = (line: SourceLine | undefined): boolean => line === undefined || line.text.trim() === "";
	while (index < lines.length) {
		const line = lines[index]!;
		if (blank(line)) { index++; continue; }
		if (HEADING.test(line.text)) {
			blocks.push({ kind: "heading", span: { start: line.offset, end: end(line) }, text: line.text });
			index++;
			continue;
		}
		const comment = COMMENT.exec(line.text);
		if (comment) {
			const start = line.offset + comment[0].length;
			blocks.push({ kind: "comment", span: { start, end: end(line) }, text: line.text.slice(comment[0].length) });
			index++;
			continue;
		}
		const item = ITEM.exec(line.text);
		if (item) {
			const ordered = item[3] !== undefined;
			const items: { span: Span; content: Span; text: string }[] = [];
			while (index < lines.length) {
				const head = lines[index]!;
				const marker = ITEM.exec(head.text);
				if (!marker || (marker[3] !== undefined) !== ordered) break;
				const contentStart = head.offset + marker[0].length;
				let last = head;
				index++;
				// An item runs on through indented lines, and through unindented ones until a blank line or the next item.
				while (index < lines.length) {
					const next = lines[index]!;
					if (blank(next)) {
						if (!blank(lines[index + 1]) && /^[ \t]{2,}/.test(lines[index + 1]!.text)) { index++; continue; }
						break;
					}
					if (ITEM.exec(next.text) && !/^[ \t]{2,}/.test(next.text)) break;
					if (HEADING.test(next.text) || COMMENT.test(next.text)) break;
					last = next;
					index++;
				}
				const content = { start: Math.min(contentStart, end(last)), end: end(last) };
				items.push({ span: { start: head.offset, end: end(last) }, content, text: lines.slice(lines.indexOf(head), lines.indexOf(last) + 1).map(part => part.text).join("\n").slice(marker[0].length) });
			}
			blocks.push({ kind: "list", ordered, start: ordered ? Number(item[3]) : 1, span: { start: items[0]!.span.start, end: items.at(-1)!.span.end }, items });
			continue;
		}
		const first = line;
		let last = line;
		index++;
		while (index < lines.length && !blank(lines[index]) && !HEADING.test(lines[index]!.text) && !COMMENT.test(lines[index]!.text) && !ITEM.exec(lines[index]!.text)) last = lines[index++]!;
		blocks.push({ kind: "paragraph", span: { start: first.offset, end: end(last) }, text: lines.slice(lines.indexOf(first), lines.indexOf(last) + 1).map(part => part.text).join("\n") });
	}
	return blocks;
}

/** Inline Markdown a node can carry beside slot controls: `**strong**`, `*em*`, `` `code` `` and plain text. */
function inlineNodes(id: string, text: string): TspNode[] {
	const nodes: TspNode[] = [];
	let index = 0;
	for (const match of text.matchAll(/\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*/g)) {
		if (match.index > index) nodes.push({ id: `${id}.${nodes.length}`, k: "el", p: { tag: "span", text: text.slice(index, match.index) } });
		const [tag, value] = match[1] !== undefined ? ["strong", match[1]] : match[2] !== undefined ? ["code", match[2]] : ["em", match[3]!];
		nodes.push({ id: `${id}.${nodes.length}`, k: "el", p: { tag, text: value } });
		index = match.index + match[0].length;
	}
	if (index < text.length) nodes.push({ id: `${id}.${nodes.length}`, k: "el", p: { tag: "span", text: text.slice(index) } });
	return nodes;
}

/**
 * Text drawn as Markdown, or, when it uses declared slots, as inline runs with each slot's control
 * in its place (a `md` node cannot hold controls).
 */
export function inlineText(ctx: RenderContext, id: string, text: string, tag: "div" | "span" = "div"): TspNode {
	const parts = slotParts(text, ctx.slots);
	if (!parts.some(part => part.kind === "slot")) return tag === "div" ? { id, k: "md", p: { text } } : { id, k: "el", p: { tag, class: "pb-inline", text } };
	return {
		id, k: "el", p: { tag, class: "pb-inline" },
		c: parts.flatMap((part, index): TspNode[] => part.kind === "slot" ? [ctx.edit.slot(`${id}.s${index}`, part.name)] : inlineNodes(`${id}.t${index}`, part.text)),
	};
}

/** A Markdown run as its editable units. */
export function renderMarkdown(ctx: RenderContext, lines: readonly SourceLine[]): TspNode[] {
	return markdownBlocks(lines).map((block, index): TspNode => {
		const id = `${ctx.id}.b${index}`;
		switch (block.kind) {
			case "paragraph": return ctx.edit.text(id, block.span, true, inlineText(ctx, `${id}.view`, block.text));
			case "heading": return ctx.edit.text(id, block.span, false, { id: `${id}.view`, k: "md", p: { text: block.text } });
			case "comment": return {
				id, k: "el", p: { tag: "div", class: "pb-comment" },
				c: [{ id: `${id}.slash`, k: "el", p: { tag: "span", class: "pb-comment-slash", text: "//" } }, ctx.edit.text(`${id}.text`, block.span, true, inlineText(ctx, `${id}.view`, block.text))],
			};
			case "list": {
				const items: ListItem[] = block.items.map((item, position) => ({
					span: item.span,
					node: ctx.edit.text(`${id}.i${position}`, item.content, true, inlineText(ctx, `${id}.i${position}.view`, item.text)),
				}));
				return ctx.edit.list(id, block.span, block.ordered, block.start, items);
			}
		}
	});
}
