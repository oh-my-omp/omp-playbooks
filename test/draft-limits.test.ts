import { fence, passiveEdit, renderDefaults } from "./draft-helpers";
import { describe, expect, test } from "bun:test";
import type { RenderContext } from "../src/service/draft/contract";
import { parseLimits, renderLimits } from "../src/service/draft/limits";
import type { TspNode } from "../src/service/tsp-types";

const ctx: RenderContext = { ...renderDefaults,
	id: "limits-test",
	view: "changes",
	svg() { throw new Error("limits must render native nodes"); },
	image() { throw new Error("limits must render native nodes"); },
	readFile() { throw new Error("limits must not read files"); },
};

function parse(lines: readonly string[], line = 10) {
	return parseLimits(fence({ args: "", lines, line }));
}

function nodesOfKind(nodes: readonly TspNode[], kind: string): TspNode[] {
	return nodes.flatMap(node => [...(node.k === kind ? [node] : []), ...nodesOfKind(node.c ?? [], kind)]);
}

function allNodes(nodes: readonly TspNode[]): TspNode[] {
	return nodes.flatMap(node => [node, ...allNodes(node.c ?? [])]);
}

describe("draft limits", () => {
	test("parses and renders the complete authoritative example", () => {
		const parsed = parse([
			"Procedural sentence | 13 / 20 | words",
			"Descriptive sentence | max 25 | words",
			"Noun cluster | 4 / 3 | words | over",
		]);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error("example did not parse");
		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.value.rows).toEqual([
			{ kind: "measured", label: "Procedural sentence", value: 13, limit: 20, unit: "words", note: "" },
			{ kind: "limit", label: "Descriptive sentence", limit: 25, unit: "words", note: "" },
			{ kind: "measured", label: "Noun cluster", value: 4, limit: 3, unit: "words", note: "over" },
		]);
		const rendered = renderLimits(parsed.value, ctx);
		expect(rendered.diagnostics).toEqual([]);
		const meters = nodesOfKind(rendered.nodes, "meter");
		expect(meters.map(node => node.p?.value)).toEqual([0.65, 1, 1]);
		expect(meters.map(node => node.p?.label)).toEqual(["13 / 20 words", "max 25 words", "4 / 3 words"]);
		expect(meters.map(node => node.p?.tone)).toEqual(["accent", "accent", "error"]);
		expect(nodesOfKind(rendered.nodes, "text").map(node => node.p?.spans)).toEqual([
			[{ t: "Procedural sentence" }],
			[{ t: "Descriptive sentence" }],
			[{ t: "Noun cluster", s: "error" }],
			[{ t: "over", s: "muted" }],
		]);
	});

	test("supports bare limits, optional unit and note, whitespace, decimal and max-prefixed numbers", () => {
		const parsed = parse([
			"  字数 | 20  ",
			"Spacing | 1.5 / max 2.5 | mm | keep room",
			"Prefixes | MAX 2 / MaX 4",
			"Without unit | 2 / 3 | | 备注",
			"Limit note | max 20 | words | cap",
		]);
		if (!parsed.ok) throw new Error("optional syntax did not parse");
		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.value.rows[0]).toEqual({ kind: "limit", label: "字数", limit: 20, unit: "", note: "" });
		expect(parsed.value.rows[1]).toEqual({ kind: "measured", label: "Spacing", value: 1.5, limit: 2.5, unit: "mm", note: "keep room" });
		expect(nodesOfKind(renderLimits(parsed.value, ctx).nodes, "meter").map(node => node.p?.label)).toEqual([
			"max 20", "1.5 / 2.5 mm", "2 / 4", "2 / 3", "max 20 words",
		]);
	});

	test("preserves source lines through blanks and whole-line comments", () => {
		const parsed = parse(["", " // ignored", "Valid | 1 / 2", "", "Invalid | nope / 2"], 42);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error("valid row was discarded");
		expect(parsed.value.rows).toHaveLength(1);
		expect(parsed.diagnostics).toHaveLength(1);
		expect(parsed.diagnostics[0]).toMatchObject({ line: 46, component: "limits", severity: "error" });
		expect(parsed.diagnostics[0]?.message).toContain("13 / 20");
	});

	test.each([
		"Missing separator", "| 20", "Label |", "Label | / 20", "Label | 13 /", "Label | 13 / 20 / 30",
	])("diagnoses missing or malformed fields: %s", line => {
		const parsed = parse(["", line], 20);
		expect(parsed.ok).toBe(false);
		expect(parsed.diagnostics).toHaveLength(1);
		expect(parsed.diagnostics[0]).toMatchObject({ line: 21, component: "limits", severity: "error" });
		expect(parsed.diagnostics[0]?.message).toContain("13 / 20");
	});

	test.each([
		"many / 20", "13 / many", "max many", "NaN", "Infinity", "0x20", "1e3", "20 words", ".5", "20.",
		"9".repeat(400),
	])("diagnoses nonnumeric or nonfinite fields: %s", value => {
		const parsed = parse([`Label | ${value}`], 75);
		expect(parsed.ok).toBe(false);
		expect(parsed.diagnostics).toHaveLength(1);
		expect(parsed.diagnostics[0]).toMatchObject({ line: 75, component: "limits", severity: "error" });
		expect(parsed.diagnostics[0]?.message).toContain("有限数字");
	});

	test("requires at least one content row", () => {
		for (const lines of [[], ["", " ", " // comment"]]) {
			const parsed = parse(lines, 31);
			expect(parsed.ok).toBe(false);
			expect(parsed.diagnostics).toHaveLength(1);
			expect(parsed.diagnostics[0]).toMatchObject({ line: 31, severity: "error", component: "limits" });
			expect(parsed.diagnostics[0]?.message).toContain("至少需要一行");
		}
	});

	test("warns about extra pipe fields while rendering the first four", () => {
		const parsed = parse(["Label | 1 / 2 | words | note | extra | more"], 50);
		if (!parsed.ok) throw new Error("extra fields must not prevent drawing");
		expect(parsed.value.rows).toEqual([{ kind: "measured", label: "Label", value: 1, limit: 2, unit: "words", note: "note" }]);
		expect(parsed.diagnostics).toHaveLength(1);
		expect(parsed.diagnostics[0]).toMatchObject({ line: 50, severity: "warning", component: "limits" });
		expect(parsed.diagnostics[0]?.message).toContain("多余字段");
	});

	test("clamps meter fills without losing numeric zero, negatives or independent over-limit tone", () => {
		const parsed = parse([
			"Zero | 0 / 20", "At limit | 20 / 20", "Over | 30 / 20", "Zero limit | 0 / 0",
			"Over zero | 1 / 0", "Negative value | -1 / 20", "Negative limit | 1 / -20",
			"Both negative | -1 / -2", "Below negative | -3 / -2", "Negative zero | -1 / 0",
			"Limit zero | 0", "Limit negative | max -20",
		]);
		if (!parsed.ok) throw new Error("finite numeric edge cases must parse");
		expect(parsed.diagnostics).toEqual([]);
		const meters = nodesOfKind(renderLimits(parsed.value, ctx).nodes, "meter");
		expect(meters.map(node => node.p?.value)).toEqual([0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1]);
		expect(meters.map(node => node.p?.tone === "error")).toEqual([false, false, true, false, true, false, true, true, false, false, false, false]);
	});

	test("keeps labels and notes inline-styled and IDs unique for duplicate labels in every view", () => {
		const parsed = parse(["**Repeated** | 1 / 2 | words | *note*", "**Repeated** | 3 / 2 | words | `note`"]);
		if (!parsed.ok) throw new Error("styled labels must parse");
		for (const view of ["changes", "before", "after"] as const) {
			const rendered = renderLimits(parsed.value, { ...ctx, view });
			const nodes = allNodes(rendered.nodes);
			expect(nodes.every(node => node.id.startsWith(`${ctx.id}.`))).toBe(true);
			expect(new Set(nodes.map(node => node.id)).size).toBe(nodes.length);
			expect(nodesOfKind(rendered.nodes, "meter")).toHaveLength(2);
			expect(nodesOfKind(rendered.nodes, "text").map(node => node.p?.spans)).toEqual([
				[{ t: "Repeated", s: "strong" }], [{ t: "note", s: "muted em" }],
				[{ t: "Repeated", s: "error strong" }], [{ t: "note", s: "muted code" }],
			]);
		}
	});
});
