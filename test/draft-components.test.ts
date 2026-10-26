import { describe, expect, test } from "bun:test";
import { renderDraft, draftDiagnostics, type DraftHost } from "../src/service/draft/components";
import type { TspNode } from "../src/service/tsp-types";
import { passiveEdit } from "./draft-helpers";

const host: DraftHost = {
	id: "b1.design", edit: passiveEdit,
	context: { svg: (id, _source, _size, alt) => ({ id, k: "image", p: { alt } }), image: (id, _bytes, _mime, alt) => ({ id, k: "image", p: { alt } }), readFile: () => ({ ok: false, error: "missing" }) },
	view: () => "changes", viewSwitch: id => ({ id, k: "text", p: { text: "switch" } }),
};
function flatten(nodes: readonly TspNode[]): TspNode[] { return nodes.flatMap(node => [node, ...flatten(node.c ?? [])]); }

describe("whole-text draft rendering", () => {
	test("duplicate panel ids diagnose the document without emitting duplicate node ids", () => {
		const drawn = renderDraft("## A First\ntext\n\n## A Second\nmore\n", host);
		expect(drawn.diagnostics).toContainEqual(expect.objectContaining({ line: 4, severity: "error", component: "draft" }));
		const ids = flatten(drawn.nodes).map(node => node.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
	test("header, lead and following sections remain visible when one component cannot parse", () => {
		const drawn = renderDraft("---\ntitle: Plan\n---\nLead text.\n\n## A Broken\n```flow\nA ->\n```\n\n## B Following\nFollowing text.\n", host);
		expect(drawn.diagnostics.some(item => item.severity === "error")).toBe(true);
		const texts = flatten(drawn.nodes).map(node => node.p?.text).filter(value => typeof value === "string");
		expect(texts).toContain("Plan");
		expect(texts).toContain("Lead text.");
		expect(texts).toContain("Following text.");
	});
	test("slot declarations are hidden and uses are delegated to the editing host", () => {
		const uses: string[] = [];
		const drawn = renderDraft("```slot mode\n= Fast\n* Fast | default\n- Safe\n```\nUse {{mode}}.\n", { ...host, edit: { ...passiveEdit, slot(id, name) { uses.push(name); return { id, k: "text", p: { text: "Fast" } }; } } });
		expect(drawn.diagnostics).toEqual([]);
		expect(uses).toEqual(["mode"]);
		expect(flatten(drawn.nodes).some(node => node.p?.text === "Fast")).toBe(true);
	});
	test("oversized components do not hide following content", () => {
		const drawn = renderDraft("```flow\n" + Array.from({ length: 1001 }, () => "A").join("\n") + "\n```\n\nAfter.\n", host);
		expect(drawn.diagnostics.some(item => item.component === "flow" && item.severity === "error")).toBe(true);
		expect(flatten(drawn.nodes).some(node => node.p?.text === "After.")).toBe(true);
	});
	test("a renderer failure is isolated to its component", () => {
		const drawn = renderDraft("```er\nA -> B\n```\n\nAfter.\n", { ...host, context: { ...host.context, svg() { throw new Error("renderer failed"); } } });
		expect(drawn.diagnostics.some(item => item.severity === "error")).toBe(true);
		expect(flatten(drawn.nodes).some(node => node.p?.text === "After.")).toBe(true);
	});
	test("diagnostics and rendering agree on malformed slot declarations", () => {
		const source = "```slot choice\n- no current value\n```";
		expect(draftDiagnostics(source).some(item => item.component === "slot" && item.severity === "error")).toBe(true);
		expect(renderDraft(source, host).diagnostics.some(item => item.component === "slot" && item.severity === "error")).toBe(true);
	});
});
