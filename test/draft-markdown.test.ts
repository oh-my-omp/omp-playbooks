import { describe, expect, test } from "bun:test";
import { markdownBlocks } from "../src/service/draft/markdown";
import type { SourceLine } from "../src/service/draft/contract";

function lines(text: string): SourceLine[] {
	let offset = 0;
	return text.split("\n").map(text => { const line = { text, offset }; offset += text.length + 1; return line; });
}

describe("editable Markdown units", () => {
	test("splits multiline paragraphs, headings, comments and ordered/unordered lists", () => {
		const source = "First paragraph\ncontinued.\n\n### Heading\n// comment\n\n3. Third\n4. Fourth\n\n- Bullet\n- Another\n";
		const blocks = markdownBlocks(lines(source));
		expect(blocks.map(block => block.kind)).toEqual(["paragraph", "heading", "comment", "list", "list"]);
		expect(blocks[0]).toMatchObject({ text: "First paragraph\ncontinued." });
		expect(blocks[1]).toMatchObject({ text: "### Heading" });
		expect(blocks[2]).toMatchObject({ text: "comment" });
		const ordered = blocks[3]!;
		if (ordered.kind !== "list") throw new Error("expected ordered list");
		expect(ordered.ordered).toBe(true);
		expect(ordered.start).toBe(3);
		expect(ordered.items.map(item => item.text)).toEqual(["Third", "Fourth"]);
		for (const item of ordered.items) expect(source.slice(item.content.start, item.content.end)).toBe(item.text);
		const unordered = blocks[4]!;
		if (unordered.kind !== "list") throw new Error("expected unordered list");
		expect(unordered.ordered).toBe(false);
		expect(unordered.items.map(item => item.text)).toEqual(["Bullet", "Another"]);
		for (const block of blocks) if (block.kind !== "list") expect(source.slice(block.span.start, block.span.end)).toBe(block.text);
	});
	test("list continuation belongs to its item and stops at a heading or comment", () => {
		const source = "1) First\n   continuation\n2) Second\n# End\n// note\nAfter";
		const blocks = markdownBlocks(lines(source));
		expect(blocks.map(block => block.kind)).toEqual(["list", "heading", "comment", "paragraph"]);
		const list = blocks[0]!;
		if (list.kind !== "list") throw new Error("expected list");
		expect(list.items.map(item => item.text)).toEqual(["First\n   continuation", "Second"]);
		expect(source.slice(list.span.start, list.span.end)).toBe("1) First\n   continuation\n2) Second");
	});
	test("empty lines produce no editable units; source offsets need not begin at zero", () => {
		expect(markdownBlocks(lines("\n  \n"))).toEqual([]);
		expect(markdownBlocks([{ text: "// note", offset: 50 }])).toEqual([{ kind: "comment", span: { start: 53, end: 57 }, text: "note" }]);
	});
});
