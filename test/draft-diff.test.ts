import { fence, passiveEdit, renderDefaults } from "./draft-helpers";
import { describe, expect, test } from "bun:test";
import { parseDiff, renderDiff, type DiffSpec } from "../src/service/draft/diff";
import type { Parsed, RenderContext } from "../src/service/draft/contract";

function parse(lines: readonly string[], args = "", line = 12): Parsed<DiffSpec> {
	return parseDiff(fence({ lines, args, line }));
}
function value(result: Parsed<DiffSpec>): DiffSpec {
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.value;
}
const ctx: RenderContext = { ...renderDefaults,
	id: "draft.diff", view: "changes",
	svg: () => { throw new Error("Diff must use native nodes"); },
	image: () => { throw new Error("Diff must use native nodes"); },
	readFile: () => { throw new Error("Diff must not read files"); },
};
function errorAt(result: Parsed<DiffSpec>, line: number, message: string): void {
	expect(result.ok).toBe(false);
	expect(result.diagnostics).toContainEqual(expect.objectContaining({ component: "diff", severity: "error", line, message: expect.stringContaining(message) }));
}

describe("parseDiff", () => {
	test("parses the documented example and its stats", () => {
		const result = parse([
			"@@ -60,3 +60,3 @@", " export function parseCodeArgs(args) {",
			"-  const attrs = parseAttrs(args);", "+  const attrs = parseAttrs(args, { diff: true });", "   const opts = {};",
		], "file=src/code.js hl=61");
		expect(result.diagnostics).toEqual([]);
		expect(value(result)).toMatchObject({ file: "src/code.js", title: "src/code.js", language: "js", added: 1, removed: 1, numbering: { kind: "hunks" }, highlights: [61] });
	});

	test("accepts quoted file and title, with title overriding explicit and inferred file", () => {
		const spec = value(parse(["--- a/inferred.ts", "+++ b/inferred.ts", "@@ -1 +1 @@", "-old", "+new"], 'file="src/my code.TS" title="修复 · sketch"'));
		expect(spec).toMatchObject({ file: "src/my code.TS", title: "修复 · sketch", language: "ts" });
		expect(value(parse(["+new"], "title='a title'"))).toMatchObject({ title: "a title", language: "diff" });
	});

	test("ignores git metadata and uses +++ path without timestamps", () => {
		const spec = value(parse([
			"diff --git a/src/a.ts b/src/a.ts", "index 123..456 100644", "--- a/src/a.ts", "+++ b/src/a.ts\t2026-01-01",
			"@@ -1 +1 @@", "-old", "\\ No newline at end of file", "+new", "\\ No newline at end of file",
		]));
		expect(spec).toMatchObject({ file: "src/a.ts", title: "src/a.ts", added: 1, removed: 1 });
		expect(spec.text).toBe("@@ -1 +1 @@\n-old\n+new");
		expect(spec.lineCount).toBe(3);
	});

	test("recognizes standalone git file headers before content", () => {
		expect(value(parse(["+++ b/src/a.ts", "+new"]))).toMatchObject({ file: "src/a.ts", added: 1 });
		expect(value(parse(["--- a/src/a.ts", "+++ /dev/null", "-old"]))).toMatchObject({ file: "src/a.ts", removed: 1 });
		expect(value(parse(["--- /dev/null", "+++ b/new.ts", "+new"]))).toMatchObject({ file: "new.ts", added: 1 });
	});

	test("retains header-looking additions and removals inside an unfinished hunk", () => {
		const result = parse(["@@ -5,2 +7,2 @@", "--- old", "+++ new", ""], "hl=7-8");
		expect(result.diagnostics).toEqual([]);
		expect(value(result)).toMatchObject({ text: "@@ -5,2 +7,2 @@\n--- old\n+++ new\n", added: 1, removed: 1, highlights: [7, 8] });
	});

	test("omitted counts mean one, and a blank line is context on both sides", () => {
		const result = parse(["@@ -6 +8 @@", ""], "hl=8");
		expect(result.diagnostics).toEqual([]);
		expect(value(result)).toMatchObject({ added: 0, removed: 0, highlights: [8], lineCount: 2 });
	});

	test("leading and trailing blanks are not trimmed out of context", () => {
		const result = parse(["", "-old", "+new", ""], "start=20 hl=20-22");
		expect(result.diagnostics).toEqual([]);
		expect(value(result)).toMatchObject({ text: "\n-old\n+new\n", highlights: [20, 21, 22], numbering: { kind: "start", start: 20 } });
	});

	test("zero-count insertion and deletion hunks are valid", () => {
		const result = parse(["@@ -0,0 +1,2 @@", "+first", "+second", "@@ -10,1 +12,0 @@", "-removed"], "hl=1-2");
		expect(result.diagnostics).toEqual([]);
		expect(value(result)).toMatchObject({ added: 2, removed: 1, highlights: [1, 2] });
	});

	test("multiple hunk starts determine new-side highlight numbering", () => {
		const result = parse(["@@ -5 +8 @@ label", " context", "@@ -20 +30 @@", "-old", "+new"], "start=99 hl=30,8,30");
		expect(result.diagnostics).toEqual([]);
		expect(value(result)).toMatchObject({ numbering: { kind: "hunks" }, highlights: [8, 30] });
	});

	test("multiple file preambles do not contribute to stats", () => {
		const result = parse([
			"diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-old", "+new",
			"diff --git a/b.ts b/b.ts", "--- a/b.ts", "+++ b/b.ts", "@@ -2 +2 @@", " same",
		]);
		expect(result.diagnostics).toEqual([]);
		expect(value(result)).toMatchObject({ file: "a.ts", added: 1, removed: 1 });
	});

	test("mismatched counts warn at each hunk's absolute source line", () => {
		const result = parse(["@@ -1,3 +1,2 @@", " same", "@@ -5 +5 @@", "+extra"], "", 30);
		expect(result.ok).toBe(true);
		expect(result.diagnostics).toEqual([
			expect.objectContaining({ severity: "warning", line: 30, component: "diff" }),
			expect.objectContaining({ severity: "warning", line: 32, component: "diff" }),
		]);
	});

	test.each(["...", "…", " ...", " …  "])("rejects cut line %j at its source line", cut => {
		errorAt(parse(["@@ -1,2 +1,2 @@", " same", cut], "", 40), 42, "不能用");
	});

	test.each(["code without prefix", "@invalid", "\\ unexpected", "\tindented"])("rejects invalid diff prefix %j", line => {
		errorAt(parse([" same", line]), 13, "diff 行须");
	});
	test("rejects malformed hunk header at its source line", () => {
		errorAt(parse(["@@ -1,2 +2 @ broken header", " same"]), 12, "区块头");
	});

	test("requires numbers for hl", () => { errorAt(parse(["+new"], "hl=1"), 11, "需要新侧行号"); });
	test("rejects old-only and absent new-side highlights", () => {
		errorAt(parse(["@@ -10 +20,0 @@", "-old"], "hl=10"), 11, "不在 diff 新侧");
		errorAt(parse(["@@ -1 +1 @@", " same", "@@ -3 +3 @@", " same"], "hl=1-3"), 11, "hl=2");
	});

	test.each(["0", "4-2", "abc", "1,,2", "", "9007199254740992"])("rejects malformed highlight range %j", range => {
		errorAt(parse(["+new"], `start=1 hl="${range}"`), 11, "高亮范围");
	});

	test("huge hl ranges stop at first nonexistent line", () => {
		errorAt(parse(["+new"], "start=1 hl=1-9007199254740991"), 11, "hl=2");
	});

	test.each(["0", "-1", "1.5", "x", "1-3", "9007199254740992"])("rejects invalid start %j", start => {
		errorAt(parse(["+new"], `start=${start}`), 11, "起始行号");
	});

	test.each(["src=a.ts", "lines=1-2", "unknown=yes", 'title="unclosed', "file", "title=x garbage"])("rejects invalid arguments %j on the fence line", args => {
		expect(parse(["+new"], args).diagnostics).toContainEqual(expect.objectContaining({ severity: "error", line: 11 }));
		expect(parse(["+new"], args).ok).toBe(false);
	});

	test("warns only above 40 and fails only above 200 lines", () => {
		expect(parse(Array(40).fill(" same")).diagnostics).toEqual([]);
		for (const count of [41, 200]) {
			const result = parse(Array(count).fill(" same"), "", 80);
			expect(result.ok).toBe(true);
			expect(result.diagnostics).toEqual([expect.objectContaining({ severity: "warning", line: 80, message: expect.stringContaining("40 行") })]);
		}
		errorAt(parse(Array(201).fill(" same"), "", 80), 80, "200 行");
	});

	test.each([
		"+-----BEGIN PRIVATE KEY-----", `+const token = 'ghp_${"x".repeat(30)}';`, '+api_key = "not-a-real-secret-value"',
	])("refuses secret-looking text %j at its source line", text => {
		errorAt(parse([" context", text], "", 22), 23, "密钥或令牌");
	});

	test.each([
		"sk-proj-" + "A".repeat(48),
		"sk-" + "Ab_9-".repeat(4),
		"sk-" + "A".repeat(20),
	])("refuses separator-bearing and minimum-length sk keys %j without a content value", token => {
		for (const marker of ["+", "-", " "]) {
			const result = parse([" context", `${marker}${token}`], "", 22);
			errorAt(result, 23, "密钥或令牌");
			expect(result).not.toHaveProperty("value");
			expect(JSON.stringify(result)).not.toContain(token);
		}
	});

	test.each(["password", "passwd", "secret", "token", "API_KEY", "api-key", "apikey", "ACCESS_KEY", "access-key", "accesskey"])("refuses unquoted %s assignments for both separators at the eight-character boundary", key => {
		for (const separator of [": ", "="]) {
			for (const marker of ["+", "-", " "]) {
				const result = parse([" context", `${marker}${key}${separator}aB_9-xY7`], "", 22);
				errorAt(result, 23, "密钥或令牌");
				expect(result).not.toHaveProperty("value");
				expect(JSON.stringify(result)).not.toContain("aB_9-xY7");
			}
		}
	});

	test("short values, unrelated identifiers and quoted placeholders remain allowed", () => {
		for (const text of ["sk-" + "A".repeat(19), "password: abcdefg", "API_KEY=abcdefg", "mytoken=abcdefgh", 'password = "$PASSWORD_FROM_ENV"', 'api_key = "<injected-secret>"', 'token = "${ACCESS_TOKEN}"']) {
			const result = parse([`+${text}`]);
			expect(result.diagnostics).toEqual([]);
			expect(renderDiff(value(result), ctx).nodes.some(node => node.k === "diff")).toBe(true);
		}
	});

	test("does not read or refuse a file label, and accepts placeholder keys", () => {
		expect(value(parse(['+api_key = "${API_KEY}"'], "file=.env.example"))).toMatchObject({ file: ".env.example" });
	});

	test("rejects unsafe hunk numbers", () => {
		errorAt(parse(["@@ -1 +9007199254740992 @@", "+new"]), 12, "行号或行数过大");
	});
});

describe("renderDiff", () => {
	test("draws its own title and semantic stats followed by a native diff", () => {
		const spec = value(parse(["@@ -2 +2 @@", "-old", "+new"], 'file=src/a.ts title="修改" hl=2'));
		const rendered = renderDiff(spec, ctx);
		expect(rendered.diagnostics).toEqual([]);
		expect(rendered.nodes.map(node => node.k)).toEqual(["text", "diff", "text"]);
		expect(rendered.nodes[0]?.p?.spans).toEqual([{ t: "修改", s: "strong" }, { t: "  +1", s: "success" }, { t: " −1", s: "error" }]);
		expect(rendered.nodes[1]?.p).toEqual({ text: spec.text, path: "src/a.ts", lang: "ts" });
		expect(rendered.nodes[2]?.p?.spans).toEqual([{ t: "高亮：2", s: "muted" }]);
	});

	test("synthesizes a valid hunk for start= with correct old/new counts", () => {
		const rendered = renderDiff(value(parse([" context", "-old", "+new", "+extra"], "start=38")), ctx);
		expect(rendered.nodes[1]?.p?.text).toBe("@@ -38,2 +38,3 @@\n context\n-old\n+new\n+extra");
	});

	test("distinguishes a blank context from an empty block when synthesizing counts", () => {
		expect(renderDiff(value(parse([""], "start=5")), ctx).nodes[1]?.p?.text).toBe("@@ -5,1 +5,1 @@\n");
		expect(renderDiff(value(parse([], "start=5")), ctx).nodes[1]?.p?.text).toBe("@@ -5,0 +5,0 @@\n");
	});

	test("unnumbered mode uses the unchanged native diff body with no added UI", () => {
		const rendered = renderDiff(value(parse(["-old", "+new"])), ctx);
		expect(rendered.nodes).toHaveLength(2);
		expect(rendered.nodes[1]?.p?.text).toBe("-old\n+new");
	});

	test("IDs are unique and scoped, and view mode does not hide diff rows", () => {
		const spec = value(parse(["@@ -1 +1 @@", "-old", "+new"], "hl=1"));
		const rendered = renderDiff(spec, ctx);
		const ids = rendered.nodes.map(node => node.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.every(id => id.startsWith(`${ctx.id}.`))).toBe(true);
		for (const view of ["before", "after"] as const) expect(renderDiff(spec, { ...ctx, view })).toEqual(rendered);
	});
});
