import { fence, passiveEdit, renderDefaults } from "./draft-helpers";
import { describe, expect, test } from "bun:test";
import type { RenderContext } from "../src/service/draft/contract";
import { parseTable, renderTable, type TableSpec } from "../src/service/draft/table";

const ctx: RenderContext = { ...renderDefaults,
	id: "draft.table.7",
	view: "changes",
	svg() { throw new Error("Tables must not render SVG"); },
	image() { throw new Error("Tables must not render images"); },
	readFile() { throw new Error("Tables must not read files"); },
};

function parse(lines: readonly string[], line = 20): TableSpec {
	const parsed = parseTable(fence({ args: "", lines, line }));
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
	return parsed.value;
}

function rendered(lines: readonly string[]) {
	return renderTable(parse(lines), ctx);
}

describe("draft table", () => {
	test("parses and renders aligned GFM cells, escaped pipes, inline Markdown and status", () => {
		const result = parseTable(fence({
			args: "",
			line: 5,
			lines: ["| **Check** | Result | Count |", "| :--- | :---: | ---: |", "| API\\|CLI | ok **approved** | `3` |"],
		}));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.diagnostics).toEqual([]);
		expect(result.value).toEqual({
			columns: [{ header: "**Check**", align: "start" }, { header: "Result", align: "center" }, { header: "Count", align: "end" }],
			rows: [["API|CLI", "ok **approved**", "`3`"]],
		});
		expect(renderTable(result.value, ctx)).toEqual({
			nodes: [{
				id: `${ctx.id}.table`,
				k: "table",
				p: {
					cols: [
						{ id: `${ctx.id}.column.0`, head: [{ t: "Check", s: "strong" }], align: "start", grow: 1 },
						{ id: `${ctx.id}.column.1`, head: [{ t: "Result" }], align: "center", grow: 1 },
						{ id: `${ctx.id}.column.2`, head: [{ t: "Count" }], align: "end", grow: 1 },
					],
					rows: [{ id: `${ctx.id}.row.0`, cells: {
						[`${ctx.id}.column.0`]: [{ t: "API|CLI" }],
						[`${ctx.id}.column.1`]: [{ t: "✓ ", s: "success" }, { t: "approved", s: "success strong" }],
						[`${ctx.id}.column.2`]: [{ t: "3", s: "code" }],
					} }],
				},
			}],
			diagnostics: [],
		});
	});

	test("accepts optional outer pipes and one-hyphen delimiter cells", () => {
		expect(parse(["Left | Middle | Right", ":- | :-: | -:", "one | two | three"])).toEqual({
			columns: [{ header: "Left", align: "start" }, { header: "Middle", align: "center" }, { header: "Right", align: "end" }],
			rows: [["one", "two", "three"]],
		});
		expect(parse(["| A | B", "--- | --- |", "| a | b |"]).rows).toEqual([["a", "b"]]);
	});

	test("preserves intentional empty cells", () => {
		expect(parse(["| A | B | C |", "| --- | --- | --- |", "| | text | |", "||||"]).rows).toEqual([
			["", "text", ""], ["", "", ""],
		]);
	});

	test("uses odd backslash parity for escaped pipes, including in inline code", () => {
		expect(parse(["A | B", "--- | ---", String.raw`x\\|y`, String.raw`x\\\|y | z`, "`a\\|b` | c"]).rows).toEqual([
			[String.raw`x\\`, "y"], [String.raw`x\\|y`, "z"], ["`a|b`", "c"],
		]);
		expect(parse([String.raw`| A\|B | C |`, "| --- | --- |", String.raw`| end\| | tail\| |`]).rows).toEqual([["end|", "tail|"]]);
	});

	test("pads short rows and drops excess cells with original-line warnings", () => {
		const result = parseTable(fence({ args: "", line: 40, lines: ["| A | B |", "| --- | --- |", "| short |", "| one | two | extra |", "| good | row |"] }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.rows).toEqual([["short", ""], ["one", "two"], ["good", "row"]]);
		expect(result.diagnostics).toHaveLength(2);
		expect(result.diagnostics[0]).toMatchObject({ component: "table", severity: "warning", line: 42 });
		expect(result.diagnostics[1]).toMatchObject({ component: "table", severity: "warning", line: 43 });
		expect(result.diagnostics.every(finding => finding.message.includes("2 格"))).toBe(true);
	});

	test.each([
		["empty input", []],
		["absent delimiter", ["| A | B |"]],
		["body in delimiter position", ["| A | B |", "| one | two |"]],
		["invalid colon placement", ["| A | B |", "| -:- | --- |"]],
		["delimiter column-count mismatch", ["| A | B |", "| --- |"]],
		["empty delimiter cell", ["| A | B |", "| --- | |"]],
	] as const)("reports %s as an error at the delimiter line", (_label, lines) => {
		const result = parseTable(fence({ args: "", lines, line: 12 }));
		expect(result.ok).toBe(false);
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]).toMatchObject({ component: "table", severity: "error", line: 13 });
		expect(result.diagnostics[0]?.message).toContain("| --- | ---: |");
		expect(result).not.toHaveProperty("value");
	});

	test("renders a header and delimiter with zero body rows", () => {
		const output = rendered(["| **Name** |", "| --- |"]);
		expect(output.nodes[0]?.p?.cols).toEqual([{ id: `${ctx.id}.column.0`, head: [{ t: "Name", s: "strong" }], align: "start", grow: 1 }]);
		expect(output.nodes[0]?.p?.rows).toEqual([]);
	});

	test.each([
		["ok", [{ t: "✓", s: "success" }]],
		["no", [{ t: "✗", s: "error" }]],
		["warn", [{ t: "!", s: "warning" }]],
		["ok approved", [{ t: "✓ approved", s: "success" }]],
		["no *denied*", [{ t: "✗ ", s: "error" }, { t: "denied", s: "error em" }]],
		["warn\t`check` ~~old~~", [{ t: "! ", s: "warning" }, { t: "check", s: "warning code" }, { t: " ", s: "warning" }, { t: "old", s: "warning del" }]],
	] as const)("decorates a leading %s status while preserving inline styles", (cell, spans) => {
		const output = rendered(["Status", "---", cell]);
		expect(output.nodes[0]?.p?.rows).toEqual([{ id: `${ctx.id}.row.0`, cells: { [`${ctx.id}.column.0`]: spans } }]);
	});

	test.each(["okay", "none", "warning", "OK approved", "Warn caution", "not ok", "ok: approved", "✓ approved"])("leaves non-status cell %s unchanged", cell => {
		const output = rendered(["Status", "---", cell]);
		expect(output.nodes[0]?.p?.rows).toEqual([{ id: `${ctx.id}.row.0`, cells: { [`${ctx.id}.column.0`]: [{ t: cell }] } }]);
	});

	test("keeps status-looking headers as inline Markdown, matching am table headers", () => {
		const output = rendered(["| ok **approved** |", "| --- |", "| ordinary |"]);
		expect(output.nodes[0]?.p?.cols).toEqual([{ id: `${ctx.id}.column.0`, head: [{ t: "ok " }, { t: "approved", s: "strong" }], align: "start", grow: 1 }]);
	});

	test("namespaces every node, column and row ID and avoids duplicates", () => {
		const output = rendered(["| Repeated | Repeated |", "| --- | --- |", "| same | same |", "| same | same |"]);
		expect(output.nodes.map(node => node.id)).toEqual([`${ctx.id}.table`]);
		expect(output.nodes[0]?.p?.cols).toEqual([
			{ id: `${ctx.id}.column.0`, head: [{ t: "Repeated" }], align: "start", grow: 1 },
			{ id: `${ctx.id}.column.1`, head: [{ t: "Repeated" }], align: "start", grow: 1 },
		]);
		expect(output.nodes[0]?.p?.rows).toEqual([
			{ id: `${ctx.id}.row.0`, cells: { [`${ctx.id}.column.0`]: [{ t: "same" }], [`${ctx.id}.column.1`]: [{ t: "same" }] } },
			{ id: `${ctx.id}.row.1`, cells: { [`${ctx.id}.column.0`]: [{ t: "same" }], [`${ctx.id}.column.1`]: [{ t: "same" }] } },
		]);
		const ids = [`${ctx.id}.table`, `${ctx.id}.column.0`, `${ctx.id}.column.1`, `${ctx.id}.row.0`, `${ctx.id}.row.1`];
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.every(id => id.startsWith(`${ctx.id}.`))).toBe(true);
	});
});
