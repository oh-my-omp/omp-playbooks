import { fence, passiveEdit, renderDefaults } from "./draft-helpers";
import { describe, expect, test } from "bun:test";
import type { ChangeView, RenderContext } from "../src/service/draft/contract";
import { parseTree, renderTree, type TreeSpec } from "../src/service/draft/tree";
import type { Span } from "../src/service/draft/text";
import type { TspNode } from "../src/service/tsp-types";

function tree(text: string, args = "", line = 10): TreeSpec {
	const parsed = parseTree(fence({ lines: text.split("\n"), args, line }));
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
	return parsed.value;
}

interface SvgCapture {
	readonly text: string;
	readonly w: number;
	readonly h: number;
	readonly alt: string;
}

function context(view: ChangeView = "changes") {
	const svgs: SvgCapture[] = [];
	const ctx: RenderContext = { ...renderDefaults,
		id: "draft.tree", view,
		svg(id, text, size, alt) {
			svgs.push({ text, ...size, alt });
			return { id, k: "image", p: { alt, w: size.w, h: size.h } };
		},
		image() { throw new Error("Tree must not load images"); },
		readFile() { throw new Error("Tree must not read files"); },
	};
	return { ctx, svgs };
}

interface SurfaceItem {
	readonly id: string;
	readonly label: readonly Span[];
	readonly open: boolean;
	readonly children: readonly SurfaceItem[];
}

function items(nodes: readonly TspNode[]): SurfaceItem[] {
	const result: SurfaceItem[] = [];
	const visitItem = (item: SurfaceItem): void => { result.push(item); item.children.forEach(visitItem); };
	const visit = (node: TspNode): void => {
		if (node.k === "tree") (node.p?.nodes as readonly SurfaceItem[]).forEach(visitItem);
		node.c?.forEach(visit);
	};
	nodes.forEach(visit);
	return result;
}

function renderedLabels(spec: TreeSpec, view: ChangeView): string[] {
	const { ctx } = context(view);
	return items(renderTree(spec, ctx).nodes).map(item => item.label.map(span => span.t).join(""));
}

describe("draft tree parser", () => {
	test("spaces and two-space tabs determine relative hierarchy, not fixed levels", () => {
		const spec = tree("\n Root | subtitle\n\tChild\n    Grandchild | note\n  *Highlighted child\n Other root\n   Leaf");
		expect(spec.roots).toHaveLength(2);
		expect(spec.roots[0]).toMatchObject({ line: 11, label: "Root", note: "subtitle", change: "same" });
		expect(spec.roots[0]!.children.map(node => node.label)).toEqual(["Child", "Highlighted child"]);
		expect(spec.roots[0]!.children[0]!.children[0]).toMatchObject({ label: "Grandchild", note: "note", line: 13 });
		expect(spec.roots[0]!.children[1]!.highlight).toBe(true);
		expect(spec.roots[1]!.children[0]!.label).toBe("Leaf");
		expect(spec.marked).toBe(false);
	});

	test("the am example selects an org chart", () => {
		const spec = tree("ASD-STE100 | Simplified Technical English\n  Part 1: Writing rules\n    `Section 1` Words\n  Part 2: Dictionary\n    Approved words | one word, one meaning");
		expect(spec.layout).toBe("org");
		expect(spec.roots[0]!.children[0]!.children[0]!.label).toBe("`Section 1` Words");
	});

	test("layout boundaries, explicit list, and several roots", () => {
		for (const count of [0, 1, 2, 3, 4, 5]) {
			const text = ["Root", ...Array.from({ length: count }, (_, index) => `  Child ${index}`)].join("\n");
			expect(tree(text).layout).toBe(count >= 2 && count <= 4 ? "org" : "list");
			expect(tree(text, "list").layout).toBe("list");
		}
		expect(tree("One\nTwo\nThree\nFour\nFive").layout).toBe("columns");
		expect(tree("One\nTwo", "list").layout).toBe("list");
	});

	test("marker, highlight and note precedence follows tree syntax", () => {
		const spec = tree("Root\n  + *New **child** | *note*\n  -Old\n  \\- item\n  \\+ item\n  \\~ item", "list");
		expect(spec.roots[0]!.children[0]).toMatchObject({ label: "New **child**", note: "*note*", highlight: true, change: "added" });
		expect(spec.roots[0]!.children.slice(1).map(node => [node.label, node.change])).toEqual([
			["-Old", "same"], ["- item", "same"], ["+ item", "same"], ["~ item", "same"],
		]);
		expect(spec.marked).toBe(true);
		expect(tree("\\- item\n  *Highlight").marked).toBe(false);
	});

	test("added and removed markers inherit through all descendants; changed does not", () => {
		const spec = tree("Root\n  + Added\n    Inherited\n      + Explicit same\n  - Removed\n    Inherited\n      - Explicit same\n  ~ Changed\n    Unchanged\n      + Added inside change", "list");
		const [added, removed, changed] = spec.roots[0]!.children;
		expect([added!.change, added!.children[0]!.change, added!.children[0]!.children[0]!.change]).toEqual(["added", "added", "added"]);
		expect([removed!.change, removed!.children[0]!.change, removed!.children[0]!.children[0]!.change]).toEqual(["removed", "removed", "removed"]);
		expect([changed!.change, changed!.children[0]!.change, changed!.children[0]!.children[0]!.change]).toEqual(["changed", "same", "added"]);
	});

	test("all contradictory explicit markers report the offending absolute source line", () => {
		for (const [parent, child] of [["+", "-"], ["+", "~"], ["-", "+"], ["-", "~"]]) {
			const parsed = parseTree(fence({ args: "", line: 30, lines: [`${parent} Parent`, "  Inherited", `    ${child} Bad child`] }));
			expect(parsed.ok).toBe(false);
			expect(parsed.diagnostics).toHaveLength(1);
			expect(parsed.diagnostics[0]).toMatchObject({ line: 32, component: "tree", severity: "error" });
			expect(parsed.diagnostics[0]!.message).toContain("删除子节点标记");
		}
	});

	test("empty trees cannot be drawn and report the opening content line", () => {
		const parsed = parseTree(fence({ args: "", line: 42, lines: ["", "  ", "\t"] }));
		expect(parsed.ok).toBe(false);
		expect(parsed.diagnostics).toEqual([{ component: "tree", line: 42, severity: "error", message: "树至少需要一个节点，例如：Root。" }]);
	});
});

describe("draft tree rendering", () => {
	const text = "Root\n  + Added\n    Added leaf\n  - Removed\n    Removed leaf\n  ~ Changed\n    Same leaf\n  *Highlighted `code` | **muted note**";

	test("one parsed tree yields changes, before and after, without mutation", () => {
		const spec = tree(text, "list");
		const snapshot = JSON.stringify(spec);
		expect(renderedLabels(spec, "changes")).toEqual(["Root", "+ Added", "+ Added leaf", "− Removed", "− Removed leaf", "~ Changed", "Same leaf", "Highlighted code · muted note"]);
		expect(renderedLabels(spec, "before")).toEqual(["Root", "Removed", "Removed leaf", "Changed", "Same leaf", "Highlighted code · muted note"]);
		expect(renderedLabels(spec, "after")).toEqual(["Root", "Added", "Added leaf", "Changed", "Same leaf", "Highlighted code · muted note"]);
		expect(JSON.stringify(spec)).toBe(snapshot);
	});

	test("Markdown, highlight, note and change tokens are native label spans", () => {
		const { ctx } = context();
		const rendered = renderTree(tree(text, "list"), ctx);
		const all = items(rendered.nodes);
		expect(all.find(item => item.label.some(span => span.t === "Added"))!.label.some(span => span.s?.includes("ins"))).toBe(true);
		expect(all.find(item => item.label.some(span => span.t === "Removed"))!.label.some(span => span.s?.includes("del"))).toBe(true);
		expect(all.find(item => item.label.some(span => span.t === "Changed"))!.label.some(span => span.s?.includes("warning"))).toBe(true);
		const highlighted = all[all.length - 1]!;
		expect(highlighted.label).toContainEqual({ t: "code", s: "accent strong code" });
		expect(highlighted.label).toContainEqual({ t: "muted note", s: "muted strong" });
		expect(all.every(item => item.open)).toBe(true);
	});

	test("count row counts inherited nodes and appears only in changes view", () => {
		const spec = tree(text, "list");
		const { ctx } = context();
		const row = renderTree(spec, ctx).nodes.find(node => node.id.endsWith(".counts"));
		expect(row?.c?.map(node => node.p?.text)).toEqual(["+ 2 新增", "− 2 删除", "~ 1 修改"]);
		for (const view of ["before", "after"] as const) {
			expect(renderTree(spec, context(view).ctx).nodes.some(node => node.id.endsWith(".counts"))).toBe(false);
		}
		expect(renderTree(tree("Root"), ctx).nodes).toHaveLength(1);
	});

	test("multiple roots draw side by side unless list is requested", () => {
		const { ctx } = context();
		const result = renderTree(tree("One\n  A\nTwo\n  B"), ctx);
		expect(result.nodes[0]!.k).toBe("row");
		expect(result.nodes[0]!.c?.map(node => node.k)).toEqual(["tree", "tree"]);
		expect(items(result.nodes).map(node => node.label.map(span => span.t).join(""))).toEqual(["One", "A", "Two", "B"]);
		expect(renderTree(tree("One\nTwo", "list"), ctx).nodes[0]!.k).toBe("tree");
	});

	test("node ids, including native tree items, are unique and namespaced in every view", () => {
		for (const view of ["changes", "before", "after"] as const) {
			for (const args of ["", "list"]) {
				const spec = tree("First\n  + Duplicate\n  ~ Duplicate\nSecond\n  - Duplicate", args);
				const rendered = renderTree(spec, context(view).ctx);
				const ids: string[] = [];
				const visit = (node: TspNode): void => { ids.push(node.id); node.c?.forEach(visit); };
				rendered.nodes.forEach(visit);
				ids.push(...items(rendered.nodes).map(item => item.id));
				expect(new Set(ids).size).toBe(ids.length);
				expect(ids.every(id => id.startsWith("draft.tree."))).toBe(true);
			}
		}
	});

	test("org SVG preserves inline formatting, escapes XML, follows theme and filters views", () => {
		const spec = tree("Root & <tree> | 中文备注\n  + Added **strong**\n    Added child\n  - Removed *emphasis*\n  ~ Changed `code`\n  *Highlighted | muted");
		expect(spec.layout).toBe("org");
		for (const view of ["changes", "before", "after"] as const) {
			const { ctx, svgs } = context(view);
			const rendered = renderTree(spec, ctx);
			expect(rendered.nodes[0]).toMatchObject({ k: "image", id: "draft.tree.org" });
			expect(svgs).toHaveLength(1);
			const svg = svgs[0]!;
			expect(svg.w).toBeLessThanOrEqual(1000);
			expect(svg.h).toBeGreaterThan(100);
			expect(svg.text).toContain("Root &amp; &lt;tree&gt;");
			expect(svg.text).toContain("中文备注");
			expect(svg.text).toContain('font-family="monospace"');
			expect(svg.text).toContain("var(--accent)");
			expect(svg.alt.includes("Added")).toBe(view !== "before");
			expect(svg.alt.includes("Removed")).toBe(view !== "after");
			if (view === "changes") {
				expect(svg.text).toContain("var(--success)");
				expect(svg.text).toContain("var(--warning)");
				expect(svg.text).toContain('text-decoration="line-through"');
				expect(svg.text).toContain('opacity="0.48"');
			} else {
				expect(svg.text).not.toContain('opacity="0.48"');
				expect(svg.text).not.toContain("var(--warning)");
			}
		}
	});

	test("org views with no visible children remove their connectors", () => {
		const spec = tree("Root\n  + A\n  + B");
		const { ctx, svgs } = context("before");
		renderTree(spec, ctx);
		expect(svgs[0]!.alt).toBe("Root");
		expect(svgs[0]!.text).not.toContain("<path");
	});

	test("a hidden root removes its inherited subtree, including org charts", () => {
		for (const marker of ["+", "-"]) {
			const spec = tree(`${marker} Root\n  Child one\n  Child two`);
			const view = marker === "+" ? "before" : "after";
			const { ctx, svgs } = context(view);
			expect(renderTree(spec, ctx).nodes).toEqual([]);
			expect(svgs).toEqual([]);
		}
	});
});
