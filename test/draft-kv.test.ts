import { describe, expect, test } from "bun:test";
import type { FenceInput, RenderContext } from "../src/service/draft/contract";
import { parseKv, renderKv, type KvSpec } from "../src/service/draft/kv";
import type { TspNode } from "../src/service/tsp-types";

const context: RenderContext = {
	id: "draft.kv", view: "changes",
	svg: () => { throw new Error("kv must use native nodes"); },
	image: () => { throw new Error("kv must use native nodes"); },
	readFile: () => { throw new Error("kv must not read files"); },
};
function input(lines: readonly string[], args = "", line = 10): FenceInput {
	return { lines, args, line };
}
function spec(lines: readonly string[], args = ""): KvSpec {
	const result = parseKv(input(lines, args));
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.value;
}
function flatten(nodes: readonly TspNode[]): TspNode[] {
	return nodes.flatMap(node => [node, ...flatten(node.c ?? [])]);
}

describe("kv syntax", () => {
	test("parses the authoritative title block example with default two columns", () => {
		expect(parseKv(input(["* Title: Simplified Technical English", "Specification: ASD-STE100", "Owner: ASD"]))).toEqual({
			ok: true, diagnostics: [], value: { cols: 2, items: [
				{ kind: "wide", key: "Title", value: "Simplified Technical English" },
				{ kind: "item", key: "Specification", value: "ASD-STE100" },
				{ kind: "item", key: "Owner", value: "ASD" },
			] },
		});
	});
	test("splits at whichever colon appears first and preserves further colons", () => {
		expect(spec(["网址：https://example.org:8443/path", "URL: scheme：detail:tail"]).items).toEqual([
			{ kind: "item", key: "网址", value: "https://example.org:8443/path" },
			{ kind: "item", key: "URL", value: "scheme：detail:tail" },
		]);
	});
	test("trims surrounding whitespace, accepts empty values, and recognizes unspaced wide markers", () => {
		expect(spec(["  *标题 ： **正文**  ", " Value :   "]).items).toEqual([
			{ kind: "wide", key: "标题", value: "**正文**" },
			{ kind: "item", key: "Value", value: "" },
		]);
	});
	test("ignores blanks and whole-line // comments, not # keys or inline // values", () => {
		expect(spec(["", "   ", " // note without a colon", "# Owner: ASD", "URL: //example.org"]).items).toEqual([
			{ kind: "item", key: "# Owner", value: "ASD" },
			{ kind: "item", key: "URL", value: "//example.org" },
		]);
	});
	test("reports every malformed line at its original source line while retaining drawable items", () => {
		const result = parseKv(input(["", "// note", "bad", "Key: value", "* missing separator", "：missing key"], "", 20));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.items).toEqual([{ kind: "item", key: "Key", value: "value" }]);
		expect(result.diagnostics.map(diagnostic => [diagnostic.component, diagnostic.severity, diagnostic.line])).toEqual([
			["kv", "error", 22], ["kv", "error", 24], ["kv", "error", 25],
		]);
		for (const diagnostic of result.diagnostics) expect(diagnostic.message).toContain("key: value");
	});
	test("returns no drawable spec for malformed-only content", () => {
		expect(parseKv(input(["no colon", "* no colon"], "", 4))).toMatchObject({ ok: false, diagnostics: [{ line: 4 }, { line: 5 }] });
	});
	test("empty or comment-only content requires at least one entry", () => {
		for (const lines of [[], ["", " // comment"]]) {
			expect(parseKv(input(lines, "", 30))).toMatchObject({
				ok: false, diagnostics: [{ line: 30, severity: "error", component: "kv" }],
			});
		}
	});
	test("honors integer columns with source defaulting and clamping", () => {
		for (const [args, cols] of [["cols=1", 1], ["cols=3", 3], ["cols=6", 6], ["cols=20", 6], ["cols=-1", 1], ["cols=0", 2], ["cols", 1]] as const) {
			expect(spec(["Key: value"], args).cols).toBe(cols);
		}
	});
	test("supports quoted attrs, unrelated attrs, and the last cols value", () => {
		expect(spec(["Key: value"], 'note="cols=6" cols=1 cols="3"').cols).toBe(3);
		expect(spec(["Key: value"], "cols='4'").cols).toBe(4);
		expect(spec(["Key: value"], "note=cols=6").cols).toBe(2);
	});
	test("invalid or fractional column counts diagnose the opening fence and fall back to two", () => {
		for (const args of ["cols=1.5", "cols=nope", "cols=NaN", "cols=Infinity"]) {
			const result = parseKv(input(["Key: value"], args, 15));
			expect(result).toMatchObject({ ok: true, value: { cols: 2 }, diagnostics: [{ line: 14, severity: "error", component: "kv" }] });
			expect(result.diagnostics[0]!.message).toContain("cols=2");
		}
		expect(parseKv(input(["Key: value"], "cols=nope", 1)).diagnostics[0]!.line).toBe(1);
	});
});

describe("native kv rendering", () => {
	test("renders ordinary entries as ordered cells in one N-column grid", () => {
		const result = renderKv(spec(["A: a", "B: b", "C: c", "D: d", "E: e", "F: f", "G: g"], "cols=3"), context);
		expect(result.diagnostics).toEqual([]);
		expect(result.nodes).toHaveLength(1);
		const grid = result.nodes[0]!;
		expect(grid).toMatchObject({ k: "el", p: { tag: "div", class: "am-kv am-kv-3" } });
		expect(grid.c).toHaveLength(7);
		expect(grid.c!.map(cell => cell.c?.[0]?.p?.text)).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
		for (const [index, cell] of grid.c!.entries()) {
			expect(cell).toMatchObject({ k: "el", p: { tag: "div", class: "am-kv-cell" } });
			expect(cell.c?.[0]).toMatchObject({ k: "el", p: { tag: "span", class: "am-kv-key" } });
			expect(cell.c?.[1]).toMatchObject({ k: "text", p: { spans: [{ t: String.fromCharCode(97 + index) }] } });
		}
	});
	test("wide cells span the grid without reordering ordinary entries", () => {
		const grid = renderKv(spec(["A: a", "B: b", "* Title: wide", "C: c", "* Subtitle: second", "* End: last", "D: d"]), context).nodes[0]!;
		expect(grid.c!.map(cell => cell.c?.[0]?.p?.text)).toEqual(["A", "B", "Title", "C", "Subtitle", "End", "D"]);
		expect(grid.c!.map(cell => cell.p?.class)).toEqual(["am-kv-cell", "am-kv-cell", "am-kv-cell am-kv-wide", "am-kv-cell", "am-kv-cell am-kv-wide", "am-kv-cell am-kv-wide", "am-kv-cell"]);
		expect(grid.c!.filter(cell => cell.p?.class === "am-kv-cell am-kv-wide").map(cell => cell.c?.[1]?.p?.spans)).toEqual([
			[{ t: "wide", s: "strong" }], [{ t: "second", s: "strong" }], [{ t: "last", s: "strong" }],
		]);
	});
	test("parses Markdown values into spans while keeping source keys literal", () => {
		const cell = renderKv(spec(["Raw **Key**: **bold** *em* `code` ~~old~~"]), context).nodes[0]!.c![0]!;
		expect(cell.c?.[0]?.p?.text).toBe("Raw **Key**");
		expect(cell.c?.[1]?.p?.spans).toEqual([
			{ t: "bold", s: "strong" }, { t: " " }, { t: "em", s: "em" }, { t: " " },
			{ t: "code", s: "code" }, { t: " " }, { t: "old", s: "del" },
		]);
	});
	test("keeps all wide value runs strong while preserving their inline Markdown styles", () => {
		const cell = renderKv(spec(["* Title: Text *em* `code` ~~old~~"]), context).nodes[0]!.c![0]!;
		expect(cell.c?.[1]?.p?.spans).toEqual([
			{ t: "Text ", s: "strong" }, { t: "em", s: "strong em" },
			{ t: " ", s: "strong" }, { t: "code", s: "strong code" }, { t: " ", s: "strong" }, { t: "old", s: "strong del" },
		]);
	});
	test("renders one-column and wide-only content without empty cells", () => {
		const single = renderKv(spec(["A: a", "B: b"], "cols=1"), context).nodes[0]!;
		expect(single.p?.class).toBe("am-kv am-kv-1");
		expect(single.c).toHaveLength(2);
		const wide = renderKv(spec(["* Title: t", "* Subtitle: s"]), context).nodes[0]!;
		expect(wide.c!.map(cell => cell.p?.class)).toEqual(["am-kv-cell am-kv-wide", "am-kv-cell am-kv-wide"]);
	});
	test("uses globally unique context-prefixed IDs for cells and children, even with duplicate keys", () => {
		const nodes = flatten(renderKv(spec(["A: 1", "A: 2", "* A: 3", "A: 4", "* A: 5", "A: 6"]), context).nodes);
		const ids = nodes.map(node => node.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(id.startsWith(`${context.id}.`)).toBe(true);
	});
	test("kv is independent of change views", () => {
		const parsed = spec(["A: a", "* Title: t"]);
		for (const view of ["before", "after"] as const) {
			expect(renderKv(parsed, { ...context, view })).toEqual(renderKv(parsed, context));
		}
	});
});
