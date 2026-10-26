import { fence, passiveEdit, renderDefaults } from "./draft-helpers";
import { describe, expect, test } from "bun:test";
import { parseCallout, renderCallout, type CalloutSpec } from "../src/service/draft/callout.ts";
import type { FenceInput, RenderContext } from "../src/service/draft/contract.ts";
import type { TspNode } from "../src/service/tsp-types.ts";

function input(args = "", lines: readonly string[] = ["正文"], line = 20): FenceInput {
	return fence({ args, lines, line });
}

function parsed(source: FenceInput): CalloutSpec {
	const result = parseCallout(source);
	expect(result.diagnostics).toEqual([]);
	if (!result.ok) throw new Error("Expected a valid callout");
	return result.value;
}

function context(id = "draft.callout"): RenderContext {
	return { ...renderDefaults,
		id,
		view: "changes",
		svg() { throw new Error("Callout must use native elements/Markdown nodes"); },
		image() { throw new Error("Callout must use native elements/Markdown nodes"); },
		readFile() { throw new Error("Callout must not read files"); },
	};
}

const variants = [
	{ type: "info", head: "信息", tone: "info" },
	{ type: "ok", head: "成功", tone: "success" },
	{ type: "warn", head: "警告", tone: "warning" },
	{ type: "err", head: "错误", tone: "error" },
] as const;

describe("callout argument syntax", () => {
	for (const { type } of variants) {
		test(`parses ${type} with a title`, () => {
			expect(parsed(input(`${type} 注意事项`))).toEqual({ span: expect.anything(), type, title: "注意事项", body: "正文" });
		});
	}

	test("parses the authoritative caution example", () => {
		expect(parsed(input("warn Caution", ["Close the valve before you remove the pump."]))).toEqual({ span: expect.anything(),
			type: "warn", title: "Caution", body: "Close the valve before you remove the pump.",
		});
	});

	test("uses the entire unknown argument string as an info title", () => {
		for (const title of ["注意  保留间距", "warning Caution", "error Failure", "note Note", "WARN Caution", "warning info"]) {
			expect(parsed(input(title))).toEqual({ span: expect.anything(), type: "info", title, body: "正文" });
		}
	});

	test("normalizes known-type title whitespace like the reference parser", () => {
		expect(parsed(input("  warn\t先关闭   阀门  "))).toEqual({ span: expect.anything(), type: "warn", title: "先关闭 阀门", body: "正文" });
		expect(parsed(input("  未知\t保留   空格  "))).toEqual({ span: expect.anything(), type: "info", title: "未知\t保留   空格", body: "正文" });
	});

	test("allows omitted type and title when the body is present", () => {
		expect(parsed(input())).toEqual({ span: expect.anything(), type: "info", title: "", body: "正文" });
	});

	test("allows a title without a body", () => {
		expect(parsed(input("ok 完成", []))).toEqual({ span: expect.anything(), type: "ok", title: "完成", body: "" });
		expect(parsed(input("仅标题", ["", "  "]))).toEqual({ span: expect.anything(), type: "info", title: "仅标题", body: "\n  " });
	});
});

describe("callout diagnostics", () => {
	test("rejects a callout with neither title nor body at the first content line", () => {
		for (const args of ["", "  ", "info", "ok", "warn", "err"]) {
			const result = parseCallout(input(args, ["", " \t"], 42));
			expect(result.ok).toBe(false);
			expect(result.diagnostics).toEqual([{ line: 42, severity: "error", component: "callout", message: "callout 需要标题或正文，例如：```callout info 提示" }]);
		}
	});

	for (const [word, suggested] of [
		["info", "info"], ["ok", "ok"], ["warn", "warn"], ["err", "err"],
		["warning", "warn"], ["error", "err"], ["note", "info"], ["other-kind", "<info|ok|warn|err>"],
	] as const) {
		test(`rejects body type ${word} and names the corrected fence syntax`, () => {
			const result = parseCallout(input("标题", ["", "  // comment", `type: ${word} # comment`, "正文"], 60));
			expect(result.ok).toBe(false);
			expect(result.diagnostics).toEqual([{
				line: 62, severity: "error", component: "callout",
				message: `类型应写在围栏行而非正文，例如：\`\`\`callout ${suggested} [标题]`,
			}]);
		});
	}

	test("recognizes case-insensitive body type declarations and Chinese colons", () => {
		const result = parseCallout(input("", [" \t", " TyPe ： WARNING "], 10));
		expect(result.ok).toBe(false);
		expect(result.diagnostics[0]?.line).toBe(11);
		expect(result.diagnostics[0]?.message).toContain("```callout warn [标题]");
	});

	test("does not treat later declarations or Markdown headings as misplaced types", () => {
		for (const lines of [["正文", "type: warn"], ["# Heading", "type: warn"], ["type: warning is prose"]]) {
			expect(parsed(input("", lines)).body).toBe(lines.join("\n"));
		}
	});
});

describe("editable callout rendering", () => {
	test("preserves authored title, Markdown and math without supplying a default heading", () => {
		const body = "**Conclusion** $E=mc^2$\n\n- item";
		const parsedSpec = parsed(input("warn Review", body.split("\n")));
		const edits: string[] = [];
		const rendered = renderCallout(parsedSpec, { ...context(), edit: { ...passiveEdit, text(_id, span, multiline, view) { expect(multiline).toBe(true); edits.push(body.slice(span.start, span.end)); return view; } } });
		const walk = (node: TspNode): TspNode[] => [node, ...(node.c ?? []).flatMap(walk)];
		const nodes = rendered.nodes.flatMap(walk);
		expect(nodes.some(node => node.p?.text === "Review")).toBe(true);
		expect(nodes.some(node => node.k === "md" && node.p?.text === body)).toBe(true);
		expect(edits).toEqual([body]);
		expect(rendered.diagnostics).toEqual([]);
		const titleless = renderCallout(parsed(input("info", ["Body"])), context()).nodes.flatMap(walk);
		expect(titleless.filter(node => node.p?.tag === "strong")).toEqual([]);
	});
	test("unique node ids allow multiple callouts in the same document", () => {
		const walk = (node: TspNode): TspNode[] => [node, ...(node.c ?? []).flatMap(walk)];
		const nodes = [...renderCallout(parsed(input("info")), context("one")).nodes, ...renderCallout(parsed(input("err")), context("two")).nodes].flatMap(walk);
		expect(new Set(nodes.map(node => node.id)).size).toBe(nodes.length);
	});
});
