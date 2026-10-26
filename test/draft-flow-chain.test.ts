import { describe, expect, test } from "bun:test";
import type { FlowChain } from "../src/service/draft/contract";
import { parseFlow, renderFlow } from "../src/service/draft/flow";
import { parseSlots } from "../src/service/draft/slot";
import { fence, passiveEdit } from "./draft-helpers";

function chain(text: string, declarations = ""): FlowChain | null {
	const parsed = parseFlow(fence({ args: "", line: 2, lines: text.split("\n") }));
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
	let captured: FlowChain | null = null;
	renderFlow(parsed.value, { id: "flow", view: "changes", slots: parseSlots(declarations).slots, edit: { ...passiveEdit, chain(id, _span, value) { captured = value; return { id, k: "col" }; } }, svg: id => ({ id, k: "image" }), image: id => ({ id, k: "image" }), readFile: () => ({ ok: false, error: "unused" }) });
	return captured;
}

describe("editable flow chains", () => {
	test("walks path order rather than declaration order and resolves declared slot nodes", () => {
		const value = chain("B -> C\n(A) -> B\nC -> [{{mode}}]", "```slot mode\n= Fast\n- Fast\n```\n")!;
		expect(value.nodes.map(node => node.name)).toEqual(["A", "B", "C", "{{mode}}"]);
		expect(value.nodes.at(-1)).toMatchObject({ label: "Fast", slot: "mode" });
	});
	test("rename rewrites valid fence body, preserving shapes, comments and labelled links", () => {
		const value = chain("// retained\n(Start) -> Middle: first\nMiddle --> [(End)]")!;
		const next = value.rename(1, "Renamed")!;
		const reparsed = chain(next)!;
		expect(reparsed.nodes.map(node => [node.name, node.shape])).toEqual([["Start", "round"], ["Renamed", "rect"], ["End", "cylinder"]]);
		expect(reparsed.edges).toEqual([{ dashed: false, label: "first" }, { dashed: true, label: "" }]);
		expect(next).toContain("// retained");
		for (const invalid of ["", "Start", "two\nlines"]) expect(value.rename(1, invalid)).toBeNull();
	});
	test("insertAfter splices a plain edge before the original edge, with a unique name", () => {
		const value = chain("A --> B: labelled\nB -> C")!;
		const next = chain(value.insertAfter(0))!;
		expect(next.nodes).toHaveLength(4);
		expect(next.nodes[0]?.name).toBe("A");
		expect(next.nodes[2]?.name).toBe("B");
		expect(next.edges.slice(0, 2)).toEqual([{ dashed: false, label: "" }, { dashed: true, label: "labelled" }]);
		const twice = chain(next.insertAfter(0))!;
		expect(new Set(twice.nodes.map(node => node.name)).size).toBe(5);
	});
	test("remove rewrites endpoints and middle nodes but never goes below two nodes", () => {
		const value = chain("A -> B: incoming\nB --> C: outgoing\nC -> D")!;
		expect(chain(value.remove(0)!)!.nodes.map(node => node.name)).toEqual(["B", "C", "D"]);
		expect(chain(value.remove(3)!)!.nodes.map(node => node.name)).toEqual(["A", "B", "C"]);
		const middle = chain(value.remove(1)!)!;
		expect(middle.nodes.map(node => node.name)).toEqual(["A", "C", "D"]);
		expect(middle.edges[0]).toEqual({ dashed: false, label: "incoming" });
		expect(chain("A -> B")!.remove(0)).toBeNull();
	});
	for (const source of ["A -> B & C", "A -> B\nB -> A", "A -> B\ngroup G: A, B", "+ A -> B"]) test(`non-chain ${source}`, () => expect(chain(source)).toBeNull());
});
