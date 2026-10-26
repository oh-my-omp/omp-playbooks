import { fence, passiveEdit, renderDefaults } from "./draft-helpers";
import { describe, expect, test } from "bun:test";
import type { RenderContext } from "../src/service/draft/contract";
import { parseTimeline, renderTimeline, type TimelineSpec } from "../src/service/draft/timeline";
import { textWidth } from "../src/service/draft/text";
import type { TspNode } from "../src/service/tsp-types";

interface SvgCapture {
	readonly id: string;
	readonly source: string;
	readonly size: { readonly w: number; readonly h: number };
	readonly alt: string;
}

function context(): { ctx: RenderContext; captures: SvgCapture[] } {
	const captures: SvgCapture[] = [];
	return {
		captures,
		ctx: { ...renderDefaults,
			id: "draft.timeline", view: "changes",
			svg(id, source, size, alt) {
				captures.push({ id, source, size, alt });
				return { id, k: "image", p: { alt, w: size.w, h: size.h } };
			},
			image() { throw new Error("timeline must not load raster images"); },
			readFile() { throw new Error("timeline must not read files"); },
		},
	};
}

function spec(lines: readonly string[], args = ""): TimelineSpec {
	const parsed = parseTimeline(fence({ lines, args, line: 10 }));
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
	return parsed.value;
}

function flatten(nodes: readonly TspNode[]): TspNode[] {
	return nodes.flatMap(node => [node, ...flatten(node.c ?? [])]);
}

const example = ["1979 | AECMA starts the study", "1986 | First guide published", "*Now | Free download | Maintained by ASD STEMG"];

describe("timeline parsing", () => {
	test("accepts the complete help example and strips only the highlight marker", () => {
		expect(spec(example)).toEqual({ direction: "horizontal", items: [
			{ time: "1979", title: "AECMA starts the study", note: "", highlight: false },
			{ time: "1986", title: "First guide published", note: "", highlight: false },
			{ time: "Now", title: "Free download", note: "Maintained by ASD STEMG", highlight: true },
		] });
	});

	test("trims fields, skips blank/comment lines, preserves inline content and reference field semantics", () => {
		const parsed = spec([" ", "  // ignored", " * 现在 | **上线** | `release` | extra", " | 没有日期也可用", "* | 高亮空日期"]);
		expect(parsed.items).toEqual([
			{ time: "现在", title: "**上线**", note: "`release`", highlight: true },
			{ time: "", title: "没有日期也可用", note: "", highlight: false },
			{ time: "", title: "高亮空日期", note: "", highlight: true },
		]);
	});

	test("defaults to horizontal through six items, then vertical", () => {
		expect(spec(Array.from({ length: 6 }, (_, i) => `${i} | 阶段`)).direction).toBe("horizontal");
		expect(spec(Array.from({ length: 7 }, (_, i) => `${i} | 阶段`)).direction).toBe("vertical");
	});

	test("explicit directions override the item count, with reference aliases and vertical priority", () => {
		const seven = Array.from({ length: 7 }, (_, i) => `${i} | 阶段`);
		for (const args of ["h", "horizontal"]) expect(spec(seven, args).direction).toBe("horizontal");
		for (const args of ["v", "vertical", "h v"]) expect(spec(example, args).direction).toBe("vertical");
		expect(spec(seven, "not-horizontal").direction).toBe("horizontal");
		expect(spec(seven, "H").direction).toBe("vertical");
	});

	test("reports missing pipes and blank titles at their original source lines", () => {
		const parsed = parseTimeline(fence({ args: "", line: 21, lines: ["// comment", "", "missing separator", "Now |  ", "Then | Good", "Now || note"] }));
		expect(parsed.ok).toBe(false);
		expect(parsed.diagnostics.map(d => [d.component, d.line, d.severity])).toEqual([
			["timeline", 23, "error"], ["timeline", 24, "error"], ["timeline", 26, "error"],
		]);
		for (const d of parsed.diagnostics) expect(d.message).toContain("时间 | 标题");
	});

	test("rejects empty timelines with an actionable source-line diagnostic", () => {
		for (const lines of [[], ["", " // comment"]]) {
			const parsed = parseTimeline(fence({ args: "v", line: 38, lines }));
			expect(parsed.ok).toBe(false);
			expect(parsed.diagnostics).toEqual([{ component: "timeline", line: 38, severity: "error", message: "时间线至少需要一项，例如：现在 | 发布 | 已上线" }]);
		}
	});
});

describe("timeline rendering", () => {
	test("draws a horizontal axis, every event and the highlighted event through ctx.svg", () => {
		const { ctx, captures } = context();
		const rendered = renderTimeline(spec(example), ctx);
		expect(rendered.diagnostics).toEqual([]);
		expect(rendered.nodes).toHaveLength(1);
		expect(rendered.nodes[0]?.k).toBe("image");
		expect(captures).toHaveLength(1);
		const svg = captures[0]!;
		expect(svg.source).toContain("<line ");
		expect(svg.source.match(/<circle /g)).toHaveLength(4);
		expect(svg.source).toContain("var(--accent)");
		expect(svg.alt).toContain("★ Now: Free download");
		expect(svg.alt).toContain("Maintained by ASD STEMG");
		expect(svg.size.w).toBeLessThanOrEqual(1000);
		expect(svg.size.h).toBeGreaterThan(0);
	});

	test("escapes XML, treats time literally and renders Markdown labels as plain SVG text", () => {
		const { ctx, captures } = context();
		renderTimeline(spec(["at **Now** | **A&B** <title> | `say \"yes\"` & <note>"]), ctx);
		const svg = captures[0]!.source;
		expect(svg).toContain("**Now**");
		expect(svg).toContain("A&amp;B");
		expect(svg).toContain("&lt;title&gt;");
		expect(svg).toContain("&quot;yes&quot;");
		expect(svg).toContain("&lt;note&gt;");
		expect(svg).not.toContain("**A");
		expect(svg).not.toContain("<foreignObject");
	});

	test("wraps forced-horizontal CJK and unspaced labels within their cells without losing text", () => {
		const lines = Array.from({ length: 7 }, (_, i) => `${i === 3 ? "*" : ""}阶段${i} | 很长的中文标题需要完整显示${i} | extraordinarilyLongUnspacedIdentifier${i}`);
		const { ctx, captures } = context();
		renderTimeline(spec(lines, "h"), ctx);
		const svg = captures[0]!;
		const cellWidth = (svg.size.w - 32) / 7;
		const labelWidth = cellWidth - 20;
		expect(svg.size.w).toBeLessThanOrEqual(1000);
		const textNodes = [...svg.source.matchAll(/<text x="([^"]+)" y="([^"]+)"[^>]*font-size="([^"]+)"[^>]*>(.*?)<\/text>/g)];
		// Each wrapped line is its own <text> (Tern draws no <tspan>); lines of one item share its x.
		expect(svg.source).not.toContain("<tspan");
		for (const text of textNodes) {
			const fontSize = Number(text[3]);
			expect(Number(text[1])).toBeGreaterThan(0);
			expect(Number(text[1])).toBeLessThan(svg.size.w);
			expect(textWidth(text[4]!, fontSize)).toBeLessThanOrEqual(labelWidth);
			expect(Number(text[2])).toBeLessThan(svg.size.h);
		}
		const byItem = new Map<string, string>();
		for (const text of textNodes) byItem.set(text[1]!, (byItem.get(text[1]!) ?? "") + text[4]!);
		expect([...byItem.values()]).toEqual(Array.from({ length: 7 }, (_, i) => `阶段${i}很长的中文标题需要完整显示${i}extraordinarilyLongUnspacedIdentifier${i}`));
	});

	test("renders vertical rows with time badges, strong titles, muted notes and accent highlight", () => {
		const { ctx, captures } = context();
		const rendered = renderTimeline(spec(["Before | **Study**", "*Now | Ship *today* | Keep `updated`"], "v"), ctx);
		expect(captures).toHaveLength(0);
		expect(rendered.diagnostics).toEqual([]);
		const rows = rendered.nodes[0]!.c!;
		expect(rows.map(row => row.k)).toEqual(["row", "row"]);
		expect(rows[0]!.c![0]!.p).toEqual({ text: "Before", tone: "muted" });
		expect(rows[1]!.c![0]!.p).toEqual({ text: "Now", tone: "accent" });
		const content = rows[1]!.c![1]!.c!;
		expect(content[0]!.p?.spans).toEqual([{ t: "Ship ", s: "strong accent" }, { t: "today", s: "strong accent em" }]);
		expect(content[1]!.p?.spans).toEqual([{ t: "Keep ", s: "muted" }, { t: "updated", s: "muted code" }]);
		expect(rows[0]!.c![1]!.c).toHaveLength(1);
	});

	test("every generated node id is unique and belongs to the render context", () => {
		for (const args of ["h", "v"]) {
			const { ctx } = context();
			const nodes = flatten(renderTimeline(spec(example, args), ctx).nodes);
			const ids = nodes.map(node => node.id);
			expect(new Set(ids).size).toBe(ids.length);
			for (const id of ids) expect(id.startsWith(`${ctx.id}.`)).toBe(true);
		}
	});
});
