import { fence, passiveEdit, renderDefaults } from "./draft-helpers";
import { describe, expect, test } from "bun:test";
import type { FenceInput, RenderContext } from "../src/service/draft/contract";
import { parseKv, renderKv, type KvSpec } from "../src/service/draft/kv";
import type { TspNode } from "../src/service/tsp-types";

const context: RenderContext = { ...renderDefaults,
	id: "draft.kv", view: "changes",
	svg: () => { throw new Error("kv must use native nodes"); },
	image: () => { throw new Error("kv must use native nodes"); },
	readFile: () => { throw new Error("kv must not read files"); },
};
function input(lines: readonly string[], args = "", line = 10): FenceInput {
	return fence({ lines, args, line });
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
				{ keySpan: expect.anything(), valueSpan: expect.anything(), kind: "wide", key: "Title", value: "Simplified Technical English" },
				{ keySpan: expect.anything(), valueSpan: expect.anything(), kind: "item", key: "Specification", value: "ASD-STE100" },
				{ keySpan: expect.anything(), valueSpan: expect.anything(), kind: "item", key: "Owner", value: "ASD" },
			] },
		});
	});
	test("splits at whichever colon appears first and preserves further colons", () => {
		expect(spec(["网址：https://example.org:8443/path", "URL: scheme：detail:tail"]).items).toEqual([
			{ keySpan: expect.anything(), valueSpan: expect.anything(), kind: "item", key: "网址", value: "https://example.org:8443/path" },
			{ keySpan: expect.anything(), valueSpan: expect.anything(), kind: "item", key: "URL", value: "scheme：detail:tail" },
		]);
	});
	test("trims surrounding whitespace, accepts empty values, and recognizes unspaced wide markers", () => {
		expect(spec(["  *标题 ： **正文**  ", " Value :   "]).items).toEqual([
			{ keySpan: expect.anything(), valueSpan: expect.anything(), kind: "wide", key: "标题", value: "**正文**" },
			{ keySpan: expect.anything(), valueSpan: expect.anything(), kind: "item", key: "Value", value: "" },
		]);
	});
	test("ignores blanks and whole-line // comments, not # keys or inline // values", () => {
		expect(spec(["", "   ", " // note without a colon", "# Owner: ASD", "URL: //example.org"]).items).toEqual([
			{ keySpan: expect.anything(), valueSpan: expect.anything(), kind: "item", key: "# Owner", value: "ASD" },
			{ keySpan: expect.anything(), valueSpan: expect.anything(), kind: "item", key: "URL", value: "//example.org" },
		]);
	});
	test("reports every malformed line at its original source line while retaining drawable items", () => {
		const result = parseKv(input(["", "// note", "bad", "Key: value", "* missing separator", "：missing key"], "", 20));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.items).toEqual([{ keySpan: expect.anything(), valueSpan: expect.anything(), kind: "item", key: "Key", value: "value" }]);
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

describe("editable kv rendering", () => {
	test("keys and values retain source order and exact editable spans", () => {
		const source = "  Owner : Platform\n* Title: Wide value\nEmpty:";
		const parsed = spec(source.split("\n"));
		const edits: { text: string; multiline: boolean }[] = [];
		const result = renderKv(parsed, { ...context, edit: { ...passiveEdit, text(_id, span, multiline, node) { edits.push({ text: source.slice(span.start, span.end), multiline }); return node; } } });
		expect(result.diagnostics).toEqual([]);
		expect(edits).toEqual([
			{ text: "Owner", multiline: false }, { text: "Platform", multiline: false },
			{ text: "Title", multiline: false }, { text: "Wide value", multiline: false },
			{ text: "Empty", multiline: false }, { text: "", multiline: false },
		]);
	});
	test("duplicate keys still emit unique namespaced node ids", () => {
		const ids = flatten(renderKv(spec(["A: 1", "A: 2", "* A: 3"]), context).nodes).map(node => node.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.every(id => id.startsWith(`${context.id}.`))).toBe(true);
	});
	test("inline Markdown in values is drawn, not shown as literal backticks", () => {
		const nodes = flatten(renderKv(spec(["Target: only `mail-to-root` (**sendmail**)"]), context).nodes);
		expect(nodes.filter(node => node.p?.tag === "code").map(node => node.p?.text)).toEqual(["mail-to-root"]);
		expect(nodes.filter(node => node.p?.tag === "strong").map(node => node.p?.text)).toEqual(["sendmail"]);
		expect(nodes.some(node => typeof node.p?.text === "string" && node.p.text.includes("`"))).toBe(false);
	});
	test("declared slots in values use the slot host without changing keys", () => {
		const uses: string[] = [];
		const slot = { name: "owner", value: "Platform", options: [], line: 1 };
		renderKv(spec(["Owner: {{owner}}"]), { ...context, slots: new Map([["owner", slot]]), edit: { ...passiveEdit, slot(id, name) { uses.push(name); return { id, k: "text", p: { text: slot.value } }; } } });
		expect(uses).toEqual(["owner"]);
	});
});
