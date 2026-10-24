import { describe, expect, test } from "bun:test";
import { draftDiagnostics, renderDraft, type DraftHost } from "../src/service/draft/components";
import type { TspNode } from "../src/service/tsp-types";

const host: DraftHost = {
	id: "b1.design.view",
	context: { svg: id => ({ id, k: "image" }), image: id => ({ id, k: "image" }), readFile: () => ({ ok: false, error: "absent" }) },
	view: () => "changes",
	viewSwitch: id => ({ id, k: "row" }),
};

function flattenNodes(nodes: readonly TspNode[]): TspNode[] {
	return nodes.flatMap(node => [node, ...flattenNodes(node.c ?? [])]);
}

describe("renderDraft", () => {
	test("a repeated panel ID is a diagnostic, and every node id stays unique so Tern keeps the frame", () => {
		const drawn = renderDraft("## A First\ntext\n\n## A Second\nmore\n", host);
		expect(drawn.diagnostics).toContainEqual(expect.objectContaining({ line: 4, severity: "error", component: "draft" }));
		const all = flattenNodes(drawn.nodes).map(node => node.id);
		expect(new Set(all).size).toBe(all.length);
	});

	test("a sheet uses semantic panels with column spans inside an article", () => {
		const drawn = renderDraft("---\ncols: 2\n---\n## A One\nx\n## B Two {span=2}\ny\n## C Three\nz\n", host);
		expect(drawn.nodes[0]).toMatchObject({ k: "el", p: { tag: "article", class: "am-draft" } });
		const grid = flattenNodes(drawn.nodes).find(node => node.id === "b1.design.view.panels")!;
		expect(grid).toMatchObject({ k: "el", p: { tag: "div", class: "am-sheet am-cols-2" } });
		expect(grid.c!.map(panel => panel.p)).toEqual([
			{ tag: "section", class: "am-panel am-span-1" },
			{ tag: "section", class: "am-panel am-span-2" },
			{ tag: "section", class: "am-panel am-span-1" },
		]);
	});

	test.each([
		["flow", "```flow\nA -> B\n```"],
		["er", "```er\nUser\n```"],
		["sequence", "```sequence\nA -> B: request\n```"],
		["tree", "```tree\nRoot\n  First child\n  Second child\n```"],
		["timeline", "```timeline\nNow | Release\n```"],
		["annot", "```annot\nRead [this]{note}.\n```"],
		["svg", '```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="10" height="10"/></svg>\n```'],
		["image", "![Diagram](example.png)"],
	])("%s drawings occupy wide panels without widening adjacent prose panels", (_kind, source) => {
		const drawn = renderDraft(`---\ncols: 2\n---\n## A Drawing\n${source}\n\n## B Prose\nKeep this readable.\n`, {
			...host, context: { ...host.context, readFile: path => ({ ok: true, path, bytes: new Uint8Array([1, 2, 3]) }) },
		});
		expect(drawn.diagnostics).toEqual([]);
		const grid = flattenNodes(drawn.nodes).find(node => node.id === "b1.design.view.panels")!;
		expect(grid.c?.[0]).toMatchObject({ k: "el", p: { tag: "section", class: "am-panel am-span-1 am-panel-wide" } });
		expect(flattenNodes([grid.c![0]!]).some(node => node.k === "image")).toBe(true);
		expect(grid.c?.[1]).toMatchObject({ k: "el", p: { tag: "section", class: "am-panel am-span-1" } });
	});

	test("doc drafts use a document container rather than a sheet grid", () => {
		const drawn = renderDraft("---\ntemplate: doc\n---\n## A Explanation\nPlain text.\n", host);
		expect(drawn.diagnostics).toEqual([]);
		expect(drawn.nodes[0]).toMatchObject({ k: "el", p: { tag: "article", class: "am-draft" } });
		expect(flattenNodes(drawn.nodes).find(node => node.id === "b1.design.view.panels")).toMatchObject({ k: "el", p: { tag: "div", class: "am-doc" } });
	});

	test.each(["flow", "typescript"])("a %s fence over 1000 lines is diagnosed and not drawn, without hiding other panels", language => {
		const body = Array.from({ length: 1001 }, () => "N0").join("\n");
		const design = `Lead stays visible.\n\n## A Oversized\n\`\`\`${language}\n${body}\n\`\`\`\n\n## B Following\nFollowing stays visible.\n`;
		const drawn = renderDraft(design, host);
		const nodes = flattenNodes(drawn.nodes);

		expect(drawn.diagnostics).toEqual([
			expect.objectContaining({ line: 4, severity: "error", component: language, message: expect.stringContaining("1000") }),
		]);
		expect(draftDiagnostics(design)).toEqual([...drawn.diagnostics]);
		expect(nodes).toContainEqual(expect.objectContaining({
			k: "text",
			p: { text: "第 4 行的组件过大，未绘制", tone: "error" },
		}));
		expect(nodes.some(node => node.k === "image" || node.k === "code")).toBe(false);
		for (const text of ["Lead stays visible.", "Following stays visible."]) {
			expect(nodes).toContainEqual(expect.objectContaining({
				k: "md", p: { text: expect.stringContaining(text) },
			}));
		}
	});

	test("a fence with exactly 1000 body lines still draws", () => {
		const body = Array.from({ length: 1000 }, () => "N0").join("\n");
		const design = `\`\`\`flow\n${body}\n\`\`\`\n`;
		const drawn = renderDraft(design, host);

		expect(drawn.diagnostics).toEqual([]);
		expect(draftDiagnostics(design)).toEqual([]);
		expect(flattenNodes(drawn.nodes)).toContainEqual({ id: "b1.design.view.lead.0.diagram", k: "image" });
	});

	test("a 900-line flow chain draws all its nodes within five seconds and leaves following panels intact", () => {
		const body = Array.from({ length: 900 }, (_, index) => `N${index} -> N${index + 1}`).join("\n");
		const design = `## A Chain\n\`\`\`flow\n${body}\n\`\`\`\n\n## B Following\nFollowing stays visible.\n`;
		let svg = "";
		let alt = "";
		const flowHost: DraftHost = {
			...host,
			context: {
				...host.context,
				svg: (id, source, _size, description) => {
					svg = source;
					alt = description;
					return { id, k: "image" };
				},
			},
		};

		const started = performance.now();
		const drawn = renderDraft(design, flowHost);
		const elapsed = performance.now() - started;
		const nodes = flattenNodes(drawn.nodes);

		expect(elapsed).toBeLessThan(5000);
		expect(drawn.diagnostics).toEqual([]);
		expect(nodes).toContainEqual({ id: "b1.design.view.p0.0.diagram", k: "image" });
		expect(alt.split("、")).toEqual(Array.from({ length: 901 }, (_, index) => `N${index}`));
		expect(svg).toContain(">N0</text>");
		expect(svg).toContain(">N900</text>");
		expect(nodes).toContainEqual(expect.objectContaining({
			k: "md", p: { text: expect.stringContaining("Following stays visible.") },
		}));
	}, 10_000);
});
