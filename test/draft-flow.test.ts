import { fence, renderDefaults } from "./draft-helpers";
import { describe, expect, test } from "bun:test";
import type { ChangeView, RenderContext } from "../src/service/draft/contract";
import { parseFlow, renderFlow, type FlowSpec } from "../src/service/draft/flow";

const example = ["(User) -> Gateway: HTTPS", "Gateway -> Auth & *Service", "Service -> [(Database)]", "group Backend: Auth, Service"];
const marked = ["Client -> Gateway", "+ Gateway -> [(Cache)]: lookup", "+ Cache -> Service: miss", "- Gateway -> Service", "~ *Service"];
function parse(lines: readonly string[], args = "", line = 10): FlowSpec {
	const result = parseFlow(fence({ lines, args, line }));
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.value;
}
function drawing(spec: FlowSpec, view: ChangeView = "changes") {
	let source = "";
	let size = { w: 0, h: 0 };
	const ctx: RenderContext = { ...renderDefaults,
		id: "test.flow", view,
		svg(id, svg, dimensions, alt) { source = svg; size = dimensions; return { id, k: "image", p: { alt } }; },
		image() { throw new Error("unexpected raster image"); },
		readFile() { throw new Error("unexpected file read"); },
	};
	return { result: renderFlow(spec, ctx), get source() { return source; }, get size() { return size; } };
}

describe("flow syntax", () => {
	test("am example preserves identity, shapes, fanout, highlight and groups", () => {
		const spec = parse(example, "LR");
		expect(spec.direction).toBe("LR");
		expect(spec.marked).toBe(false);
		expect(spec.nodes.map(n => [n.id, n.shape, n.highlighted])).toEqual([
			["User", "round", false], ["Gateway", "rect", false], ["Auth", "rect", false], ["Service", "rect", true], ["Database", "cylinder", false],
		]);
		expect(spec.edges.map(e => [e.from, e.to, e.label])).toEqual([["User", "Gateway", "HTTPS"], ["Gateway", "Auth", ""], ["Gateway", "Service", ""], ["Service", "Database", ""]]);
		expect(spec.groups).toEqual([{ name: "Backend", members: ["Auth", "Service"], change: "same", line: 13 }]);
	});
	test("all directions and default", () => {
		for (const direction of ["TB", "LR", "BT", "RL"] as const) expect(parse(["A -> B"], direction).direction).toBe(direction);
		expect(parse(["A"]).direction).toBe("TB");
		expect(parse(["A"], "lr").direction).toBe("LR");
	});
	test("chains cross-product fanouts and only label final links", () => {
		const spec = parse(["A & B -> C & D --> E & F: final: label"]);
		expect(spec.edges).toHaveLength(8);
		expect(spec.edges.slice(0, 4).map(e => [e.dashed, e.label])).toEqual(Array(4).fill([false, ""]));
		expect(spec.edges.slice(4).map(e => [e.dashed, e.label])).toEqual(Array(4).fill([true, "final: label"]));
	});
	test("brackets protect delimiters and marker-like names, explicit later shape wins", () => {
		const spec = parse(["[- Gateway] -> [text with: colon]", "(Start) -> {Valid?}", "[(Database)]", "*Start", "[Start]"]);
		expect(spec.nodes.map(n => [n.id, n.shape])).toEqual([["- Gateway", "rect"], ["text with: colon", "rect"], ["Start", "rect"], ["Valid?", "diamond"], ["Database", "cylinder"]]);
		expect(spec.nodes.find(n => n.id === "Start")?.highlighted).toBe(true);
		expect(spec.marked).toBe(false);
		expect(parse(["[A -> B & C] -> [目标：带冒号]：中文标签"]).edges[0]?.label).toBe("中文标签");
	});
	test("blank lines and whole-line comments retain source line numbers", () => {
		const spec = parse(["", " // comment", " A -> B "], "", 30);
		expect(spec.nodes[0]?.line).toBe(32);
	});
});

describe("flow diagnostics", () => {
	const errors: readonly { readonly lines: readonly string[]; readonly offset: number; readonly message: string }[] = [
		{ lines: ["~ A -> B"], offset: 0, message: "~ 不能标记连线" },
		{ lines: ["A -> B", "+ A --> B: changed"], offset: 1, message: "统一" },
		{ lines: ["- A -> B", "A -> B"], offset: 0, message: "统一" },
		{ lines: ["A", "~ group G: A"], offset: 1, message: "~ 只能标记节点" },
		{ lines: ["A", "group G: A, missing"], offset: 1, message: "不存在" },
		{ lines: ["(A"], offset: 0, message: "补上 )" },
		{ lines: ["[(A]"], offset: 0, message: "补上 )]" },
		{ lines: ["{}"], offset: 0, message: "为空" },
		{ lines: ["A ->"], offset: 0, message: "为空" },
		{ lines: ["A &"], offset: 0, message: "为空" },
		{ lines: ["[A] junk"], offset: 0, message: "无法解析" },
		{ lines: ["group G:"], offset: 0, message: "分组格式" },
		{ lines: ["group G: ,"], offset: 0, message: "分组不能为空" },
		{ lines: ["", "// blank"], offset: 0, message: "流程图为空" },
	];
	for (const entry of errors) test(entry.lines.join(" / "), () => {
		const result = parseFlow(fence({ args: "", lines: entry.lines, line: 42 }));
		expect(result.ok).toBe(false);
		expect(result.diagnostics).toContainEqual(expect.objectContaining({ line: 42 + entry.offset, severity: "error", component: "flow", message: expect.stringContaining(entry.message) }));
	});
	test("invalid direction points to opening fence", () => {
		const result = parseFlow(fence({ args: "UP", lines: ["A"], line: 42 }));
		expect(result.ok).toBe(false);
		expect(result.diagnostics[0]?.line).toBe(41);
	});
	test("only-removed members warn for plain and added groups, not removed groups", () => {
		for (const prefix of ["", "+ "]) {
			const result = parseFlow(fence({ args: "", lines: ["- A -> B", `${prefix}group G: A, B`], line: 20 }));
			expect(result.ok).toBe(true);
			expect(result.diagnostics).toEqual([expect.objectContaining({ line: 21, severity: "warning", message: expect.stringContaining("- group G: A, B") })]);
		}
		expect(parseFlow(fence({ args: "", lines: ["- A -> B", "- group G: A, B"], line: 20 })).diagnostics).toEqual([]);
	});
});

describe("flow changes", () => {
	test("am marked example settles node existence and tilde", () => {
		const spec = parse(marked, "LR");
		expect(spec.marked).toBe(true);
		expect(spec.nodes.map(n => [n.id, n.change])).toEqual([["Client", "same"], ["Gateway", "same"], ["Cache", "added"], ["Service", "changed"]]);
		expect(spec.edges.map(e => e.change)).toEqual(["same", "added", "added", "removed"]);
	});
	test("sightings merge; +/- nodes exist in both views; markers affect every chain edge", () => {
		const spec = parse(["+ *[(New)] -> A & B --> C: final", "- New", "A", "~ B", "- (Old)", "+ group Added: A, B", "- group Removed: Old"]);
		expect(spec.nodes.map(n => [n.id, n.change, n.shape, n.highlighted])).toEqual([
			["New", "same", "cylinder", true], ["A", "same", "rect", false], ["B", "changed", "rect", false], ["C", "added", "rect", false], ["Old", "removed", "round", false],
		]);
		expect(spec.edges.every(e => e.change === "added")).toBe(true);
		expect(spec.groups.map(g => g.change)).toEqual(["added", "removed"]);
	});
	test("replacement labels use removed and added links, never changed links", () => {
		const spec = parse(["A", "B", "- A -> B: old", "+ A -> B: new"]);
		expect(spec.edges.map(e => [e.change, e.label])).toEqual([["removed", "old"], ["added", "new"]]);
		expect(drawing(spec, "before").source).toContain("old");
		expect(drawing(spec, "before").source).not.toContain(">new<");
		expect(drawing(spec, "after").source).not.toContain(">old<");
		expect(drawing(spec, "after").source).toContain("new");
	});
	test("views filter nodes, links, groups and draw plain before/after", () => {
		const spec = parse(["Hub", "- Hub -> Old: old link", "+ Hub -> New: new link", "~ Hub", "- group Former: Old", "+ group Future: New"]);
		const before = drawing(spec, "before");
		const after = drawing(spec, "after");
		const changes = drawing(spec);
		expect(before.source).toContain("Old");
		expect(before.source).not.toContain("New");
		expect(before.source).toContain("Former");
		expect(before.source).not.toContain("Future");
		expect(after.source).not.toContain("Old");
		expect(after.source).toContain("New");
		expect(after.source).not.toContain("Former");
		expect(after.source).toContain("Future");
		for (const plain of [before, after]) { expect(plain.source).not.toContain("line-through"); expect(plain.source).not.toContain("var(--warning)"); expect(plain.result.nodes).toHaveLength(1); }
		expect(changes.source).toContain('opacity="0.45"');
		expect(changes.source).toContain('text-decoration="line-through"');
		expect(changes.source).toContain("var(--success)");
		expect(changes.source).toContain("var(--warning)");
		expect(changes.source).toContain(">+<");
		expect(changes.source).toContain(">−<");
		expect(changes.source).toContain(">~<");
		
	});
	test("multiple spaces after markers work for groups and shape declarations", () => {
		const spec = parse(["+   *[(Cache)]", "-   (Old)", "+   group New: Cache", "-   group Former: Old"]);
		expect(spec.nodes.map(n => [n.id, n.change, n.shape])).toEqual([["Cache", "added", "cylinder"], ["Old", "removed", "round"]]);
		expect(spec.groups.map(g => g.change)).toEqual(["added", "removed"]);
	});
	test("marked stays true even when all node changes cancel", () => { expect(parse(["+ A", "- A"]).marked).toBe(true); });
	test("empty filtered view is still a valid image", () => {
		expect(drawing(parse(["+ A"]), "before").source).toContain("此视图没有节点");
		expect(drawing(parse(["- A"]), "after").size.w).toBeGreaterThan(0);
	});
});

describe("flow SVG", () => {
	test("unique namespaced ids, measured dimensions, shape rendering and arrowheads", () => {
		const rendered = drawing(parse([...example, "~ Service"], "LR"));
		const tspIds = rendered.result.nodes.map(n => n.id);
		expect(new Set(tspIds).size).toBe(tspIds.length);
		expect(tspIds.every(id => id.startsWith("test.flow."))).toBe(true);
		const svgIds = [...rendered.source.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]!);
		expect(new Set(svgIds).size).toBe(svgIds.length);
		expect(svgIds.every(id => id.startsWith("test.flow."))).toBe(true);
		expect(rendered.source.match(/marker-end=/g)).toHaveLength(4);
		expect(rendered.size.w).toBeLessThanOrEqual(1000);
		expect(rendered.size.h).toBeGreaterThan(0);
	});
	test("cycles, self links, disconnected nodes and long CJK labels terminate deterministically", () => {
		const spec = parse(["{入口是否有效？} -> [(数据库)]: 很长的中文标签需要完整显示而且不应覆盖任何节点", "数据库 --> 入口是否有效？", "数据库 -> 数据库: 重试", "[一个很长的没有空格的LongUnbrokenIdentifierThatMustBeWrapped]"], "RL");
		const a = drawing(spec);
		expect(a.source).toBe(drawing(spec).source);
		expect(a.source).toContain('stroke-dasharray="6 4"');
		expect(a.source.match(/marker-end=/g)).toHaveLength(3);
		expect(a.source).toContain("很长的中文标签");
		expect(a.size.w).toBeLessThanOrEqual(1000);
	});
	test("back edges, self links and labeled fanout stay outside node rectangles in all directions", () => {
		for (const direction of ["TB", "LR", "BT", "RL"]) {
			const source = drawing(parse(["A -> B & C", "B -> D: 很长的标签需要预留空间", "C -> D: another label", "D -> A", "D -> D: retry", "[Disconnected]"], direction)).source;
			const boxes = [...source.matchAll(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" rx="4"\/>/g)].map(m => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) }));
			const paths = [...source.matchAll(/<path d="([^"]+)" fill="none" stroke=/g)];
			expect(boxes).toHaveLength(5);
			expect(paths).toHaveLength(6);
			for (const path of paths) {
				const points = [...path[1]!.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map(m => ({ x: Number(m[1]), y: Number(m[2]) }));
				for (let i = 1; i < points.length; i++) {
					const a = points[i - 1]!;
					const b = points[i]!;
					for (const box of boxes) {
						const crosses = a.x === b.x
							? a.x > box.x && a.x < box.x + box.w && Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < box.y + box.h
							: a.y > box.y && a.y < box.y + box.h && Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < box.x + box.w;
						expect(crosses).toBe(false);
					}
				}
			}
			const labels = [...source.matchAll(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" rx="4" fill=/g)].map(m => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) }));
			for (const label of labels) for (const box of boxes) expect(label.x < box.x + box.w && label.x + label.w > box.x && label.y < box.y + box.h && label.y + label.h > box.y).toBe(false);
		}
	});
	test("XML escapes labels and node ids without rendering markup", () => {
		const source = drawing(parse(['[<script> & "node"] -> B & C: <&>'])).source;
		expect(source).toContain("&lt;script&gt; &amp; &quot;node&quot;");
		expect(source).toContain("&lt;&amp;&gt;");
		expect(source).not.toContain("<script>");
	});
});
