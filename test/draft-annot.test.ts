import { fence, passiveEdit, renderDefaults } from "./draft-helpers";
import { describe, expect, test } from "bun:test";
import { parseAnnot, renderAnnot, type AnnotSpec } from "../src/service/draft/annot";
import type { RenderContext } from "../src/service/draft/contract";

const example = [
	"# 1 Procedural sentence | 13 words, limit 20",
	'Make sure that [the hydraulic reservoir]{Technical name} is [full]{!Not "replenished"}.',
	"> Write one instruction per sentence",
];

function parsed(lines: readonly string[]): AnnotSpec {
	const result = parseAnnot(fence({ args: "", lines, line: 10 }));
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.value;
}

function rendered(lines: readonly string[]): { readonly svgs: string[]; readonly sizes: { w: number; h: number }[]; readonly ids: string[]; readonly alts: string[] } {
	const svgs: string[] = [];
	const sizes: { w: number; h: number }[] = [];
	const ids: string[] = [];
	const alts: string[] = [];
	const ctx: RenderContext = { ...renderDefaults,
		id: "draft.annot", view: "changes",
		svg(id, svg, size, alt) {
			svgs.push(svg); sizes.push(size); ids.push(id); alts.push(alt);
			return { id, k: "image", p: { alt } };
		},
		image() { throw new Error("Unexpected raster image"); },
		readFile() { throw new Error("Unexpected file access"); },
	};
	const result = renderAnnot(parsed(lines), ctx);
	expect(result.diagnostics).toEqual([]);
	expect(result.nodes.map(node => node.id)).toEqual(ids);
	return { svgs, sizes, ids, alts };
}

function textPositions(svg: string): { text: string; x: number; y: number; width: number; fill: string }[] {
	return [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)" font-size="[\d.]+" fill="([^"]+)"(?: textLength="([\d.]+)" lengthAdjust="spacingAndGlyphs")?[^>]*>(.*?)<\/text>/g)].map(match => ({ text: match[5]!, x: Number(match[1]), y: Number(match[2]), width: Number(match[4] ?? 0), fill: match[3]! }));
}

describe("annot syntax", () => {
	test("parses the authoritative example into plain text and exact span offsets", () => {
		const spec = parsed(example);
		expect(spec.groups).toHaveLength(1);
		const group = spec.groups[0]!;
		expect(group.heading).toBe("1 Procedural sentence");
		expect(group.rightNote).toBe("13 words, limit 20");
		expect(group.captions).toEqual(["Write one instruction per sentence"]);
		const sentence = group.sentences[0]!;
		expect(sentence.text).toBe("Make sure that the hydraulic reservoir is full.");
		expect(sentence.annotations.map(annotation => ({ span: sentence.text.slice(annotation.start, annotation.end), note: annotation.note, tone: annotation.tone }))).toEqual([
			{ span: "the hydraulic reservoir", note: "Technical name", tone: "accent" },
			{ span: "full", note: 'Not "replenished"', tone: "error" },
		]);
	});

	test("supports implicit groups, multiple sentences and captions, and new headings", () => {
		const spec = parsed(["Intro [span]{note}", "> Intro caption", "# Next", "First sentence.", "Second [one]{}.", "> Caption one", "> Caption two", "## Last | meta", "Plain sentence."]);
		expect(spec.groups.map(group => [group.heading, group.rightNote, group.sentences.length, group.captions.length])).toEqual([["", "", 1, 1], ["Next", "", 2, 2], ["Last", "meta", 1, 0]]);
		expect(spec.groups[1]!.sentences[1]!.annotations[0]!.note).toBe("");
	});

	test("preserves ordinary punctuation and UTF-16 offsets for CJK and emoji", () => {
		const sentence = parsed(["😀 请确认[液压油箱]{技术名称}已[加满]{!不要写补充}。[普通括号] {原样}"]).groups[0]!.sentences[0]!;
		expect(sentence.text).toBe("😀 请确认液压油箱已加满。[普通括号] {原样}");
		expect(sentence.annotations.map(annotation => sentence.text.slice(annotation.start, annotation.end))).toEqual(["液压油箱", "加满"]);
	});

	test.each([
		["Before [unclosed", "右方括号"],
		["Before [span]{unclosed", "右花括号"],
		["Before [span{note}", "右方括号"],
		["Before []{note}", "片段不能为空"],
	])("diagnoses malformed annotation %s on its design-text source line", (source, message) => {
		const result = parseAnnot(fence({ args: "", lines: ["# Group", "", source], line: 25 }));
		expect(result.ok).toBe(false);
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]).toMatchObject({ line: 27, severity: "error", component: "annot" });
		expect(result.diagnostics[0]!.message).toContain(message);
		expect(result.diagnostics[0]!.message).toContain("[片段]{说明}");
	});

	test("reports each malformed sentence and rejects empty input", () => {
		const errors = parseAnnot(fence({ args: "", lines: ["[one", "[two]{note"], line: 4 }));
		expect(errors.ok).toBe(false);
		expect(errors.diagnostics.map(item => item.line)).toEqual([4, 5]);
		const empty = parseAnnot(fence({ args: "", lines: ["", "  "], line: 19 }));
		expect(empty.ok).toBe(false);
		expect(empty.diagnostics[0]!.line).toBe(19);
	});
});

describe("annot SVG", () => {
	test("renders brackets, heading, right note, caption and red note via SVG with unique ids", () => {
		const result = rendered([...example, "# Second", "[more]{notes}"]);
		expect(result.svgs).toHaveLength(2);
		expect(new Set(result.ids).size).toBe(result.ids.length);
		expect(result.ids.every(id => id.startsWith("draft.annot."))).toBe(true);
		const labels = textPositions(result.svgs[0]!);
		expect(labels.map(item => item.text)).toContain("1 Procedural sentence");
		expect(labels.map(item => item.text)).toContain("13 words, limit 20");
		expect(labels.map(item => item.text)).toContain("Write one instruction per sentence");
		expect(labels.find(item => item.text === "Not &quot;replenished&quot;")!.fill).toBe("var(--error)");
		expect(result.svgs[0]).toContain('stroke="var(--error)"');
		expect(result.alts[0]).toContain("Technical name");
	});

	test("overlapping notes use different rows, and non-overlapping ones share a row", () => {
		const crowded = textPositions(rendered(["[a]{A long first description} [b]{Another lengthy description}"]).svgs[0]!).filter(item => item.fill === "var(--accent)");
		expect(crowded).toHaveLength(2);
		expect(crowded[0]!.y).not.toBe(crowded[1]!.y);
		const spaced = textPositions(rendered(["[a]{one}                 [b]{two}"]).svgs[0]!).filter(item => item.fill === "var(--accent)");
		expect(spaced[0]!.y).toBe(spaced[1]!.y);
		expect(spaced[0]!.x + spaced[0]!.width).toBeLessThan(spaced[1]!.x);
	});

	test("wraps an annotated span across rows but draws its note only once", () => {
		const sentence = `[${"repeat words ".repeat(22).trim()}]{A single note} [tail]{Another note}`;
		const { svgs, sizes } = rendered([sentence]);
		const labels = textPositions(svgs[0]!);
		expect(labels.filter(item => item.fill === "var(--fg)").length).toBeGreaterThan(1);
		expect(labels.filter(item => item.text === "A single note")).toHaveLength(1);
		expect(labels.filter(item => item.text === "Another note")).toHaveLength(1);
		expect(labels.every(item => item.x >= 24 && item.x + item.width <= sizes[0]!.w - 24.0000001 + 0.001)).toBe(true);
		expect(labels.every(item => item.y < sizes[0]!.h)).toBe(true);
	});

	test("CJK and extremely long words and notes fit the canvas", () => {
		const { svgs, sizes } = rendered([`请确认[${"液压油箱的状态".repeat(18)}]{${"这是很长的中文说明，".repeat(20)}}已经[加满]{!错误说明}`, "x".repeat(240)]);
		const labels = textPositions(svgs[0]!);
		expect(labels.filter(item => item.fill === "var(--fg)").length).toBeGreaterThan(3);
		expect(labels.filter(item => item.fill === "var(--accent)").length).toBeGreaterThan(1);
		expect(labels.every(item => item.x + item.width <= sizes[0]!.w - 24 + 0.001)).toBe(true);
		expect(sizes[0]!.w).toBeLessThanOrEqual(1000);
	});

	test("retains notes when annotation whitespace is trimmed at a wrap boundary", () => {
		const { svgs } = rendered([`[${"word ".repeat(30)}]{Keep this note}next`, "[tail ]{Trailing note}"]);
		const labels = textPositions(svgs[0]!);
		expect(labels.filter(item => item.text === "Keep this note")).toHaveLength(1);
		expect(labels.filter(item => item.text === "Trailing note")).toHaveLength(1);
	});

	test("maps leading annotation whitespace without shifting later brackets", () => {
		const { svgs } = rendered(["[ leading]{First note} [after]{Second note}"]);
		const labels = textPositions(svgs[0]!);
		const first = labels.find(item => item.text === "First note")!;
		const second = labels.find(item => item.text === "Second note")!;
		expect(first.x).toBe(24);
		expect(second.x).toBeCloseTo(24 + " leading ".length * 16 * 0.6);
	});

	test("wraps headers and captions without collisions and escapes XML text", () => {
		const { svgs, sizes } = rendered([`# ${"Heading ".repeat(30)} | ${"metadata ".repeat(30)}`, '[<&>]{!"quoted" & <safe>}', `> ${"Caption ".repeat(30)}`]);
		const labels = textPositions(svgs[0]!);
		expect(svgs[0]).toContain("&lt;&amp;&gt;");
		expect(svgs[0]).toContain("&quot;quoted&quot; &amp; &lt;safe&gt;");
		expect(labels.every(item => item.x + item.width <= sizes[0]!.w - 24 + 0.001)).toBe(true);
		for (const left of labels) for (const right of labels) {
			if (left === right || left.y !== right.y) continue;
			expect(left.x + left.width <= right.x || right.x + right.width <= left.x).toBe(true);
		}
	});
});
