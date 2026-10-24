import { describe, expect, test } from "bun:test";
import type { BlockContent, BlockId, CompileInput, CompileResult, FetchOutcome } from "../src/domain/model";
import { references } from "../src/service/references";

const fetchedAt = Date.parse("2026-10-11T08:00:00.000Z");
const issueUrl = "https://github.com/org/repo/issues/7";
const issue: FetchOutcome = { ok: true, at: fetchedAt, value: { kind: "issue", issue: {
	title: "Issue title", body: "Issue body", comments: [
		{ author: "last", createdAt: "2026-10-11T04:00:00Z", body: "Third" },
		{ author: "first", createdAt: "2026-10-11T03:00:00+02:00", body: "First" },
		{ author: "middle", createdAt: "2026-10-11T02:00:00Z", body: "Second" },
	],
} } };
function task(body: string): BlockContent {
	return { kind: "task", body };
}
function input(entries: readonly (readonly [BlockId, BlockContent])[], fetches: readonly (readonly [string, FetchOutcome])[] = []): CompileInput {
	return { blocks: new Map(entries), fetches: new Map(fetches), results: new Map(), inTemplate: false };
}
function ok(result: CompileResult): Extract<CompileResult, { kind: "Ok" }> {
	if (result.kind === "Err") throw new Error(JSON.stringify(result.error));
	return result;
}
function expansion(target: string, expression: string | null, body = "one\ntwo\nthree"): CompileResult {
	const text = `((${target}${expression === null ? "" : ` | ${expression}`}))`;
	return references.compile(["b1"], input([["b1", task(text)], ["b2", task(body)]], [[issueUrl, issue], ["file:notes.md", { ok: true, at: fetchedAt, value: { kind: "file", text: body } }]]));
}

describe("reference syntax and targets", () => {
	test("ignores fenced and inline code, preserves exact UTF-16 offsets and source text", () => {
		const body = "🙂 (( b2 | lines(1..2) ))\n`((b3))` ``a ` ((b4))``\n```js\n((b5))\n```\n~~~\n((b6))\n~~~\n((b7))";
		expect(references.parseReferences(body)).toEqual([
			{ text: "(( b2 | lines(1..2) ))", targetText: "b2", expressionText: "lines(1..2)", offset: 3 },
			{ text: "((b7))", targetText: "b7", expressionText: null, offset: body.indexOf("((b7))") },
		]);
		expect(ok(references.compile(["b1"], input([["b1", task("```py\n((missing))\n```")]]))).text).toBe("```py\n((missing))\n```");
	});
	test("fence kind and length must match, and unclosed fences hide their content", () => {
		expect(references.parseReferences("````\n```\n((b2))\n~~~~\n((b3))\n````\n((b4))").map(ref => ref.targetText)).toEqual(["b4"]);
		expect(references.parseReferences("~~~\n((b2))")).toEqual([]);
		expect(references.parseReferences("    ```\n((b2))").map(ref => ref.targetText)).toEqual(["b2"]);
	});
	test("inline code uses exact delimiter lengths, unmatched backticks are text", () => {
		expect(references.parseReferences("`` ((b2)) ` ((b3)) `` ((b4))").map(ref => ref.targetText)).toEqual(["b4"]);
		expect(references.parseReferences("`unmatched ((b2))").map(ref => ref.targetText)).toEqual(["b2"]);
		expect(references.parseReferences("`code\n((b2))` ((b3))").map(ref => ref.targetText)).toEqual(["b3"]);
	});
	test("cross-line parentheses are text, URLs outside references stay text", () => {
		const body = `((b2\n))\n((b2 | lines(1..\n2)))\n${issueUrl}`;
		expect(references.parseReferences(body)).toEqual([]);
		expect(ok(references.compile(["b1"], input([["b1", task(body)]]))).text).toBe(body);
	});
	test("classifies closed target kinds and supplies canonical keys", () => {
		for (const text of ["b1", "b1.result", issueUrl, "https://github.com/Org/Repo/pull/8/", "file:./logs/../notes.md"]) {
			const target = references.parseTarget(text);
			expect(target).not.toBeNull();
			if (!target) throw new Error(text);
			expect(references.targetKey(target)).toBe(text === "https://github.com/Org/Repo/pull/8/" ? "https://github.com/org/repo/pull/8" : text.startsWith("file:") ? "file:notes.md" : text);
		}
		for (const text of ["b0", "b01", "b-2", "b1.results", "https://example.org/x", "https://github.com/o/r/issues/0", "https://github.com/o/r/issues/1?q=x", "file:", "file:/absolute"]) expect(references.parseTarget(text)).toBeNull();
	});
});

describe("selectors", () => {
	test("inclusive one-based line ranges and ordered blank-line concatenation for block and file", () => {
		expect(ok(expansion("b2", "lines(1..1), lines(3..3)")).text).toBe("one\n\nthree");
		expect(ok(expansion("b2", "lines(1..3)")).text).toBe("one\ntwo\nthree");
		expect(ok(expansion("file:notes.md", "lines(2..2)")).text).toBe('<external source="file:notes.md" fetched="2026-10-11T08:00:00.000Z">\ntwo\n</external>');
	});
	test("section excludes heading, includes subsections, stops at same or higher heading", () => {
		const body = '# Parent\nintro\n## Target\ncontent\n### Child\nchild content\n```md\n# Fake\n```\n## Next\nexcluded\n# End';
		expect(ok(expansion("b2", 'section("Target")', body)).text).toBe('content\n### Child\nchild content\n```md\n# Fake\n```');
		expect(ok(expansion("b2", 'section("Parent")', body)).text).toBe(body.slice(body.indexOf("intro"), body.indexOf("\n# End")));
		expect(ok(expansion("b2", 'section("Setext")', "Setext\n======\ntext\nNext\n----\nchild\nEnd\n===\nno")).text).toBe("text\nNext\n----\nchild");
	});
	test("section titles preserve quoted punctuation, escaped quotes, and exact case", () => {
		expect(ok(expansion("b2", 'section("A, (B) \\"C\\"")', '# A, (B) "C"\nyes\n# Other\nno')).text).toBe("yes");
		expect(ok(expansion("b2", 'section("A )) B")', '# A )) B\nyes')).text).toBe("yes");
		expect(expansion("b2", 'section("target")', "# Target\nx").kind).toBe("Err");
	});
	test("issue defaults and selectors format comments in chronological order", () => {
		const first = "@first 2026-10-11T03:00:00+02:00:\nFirst";
		const middle = "@middle 2026-10-11T02:00:00Z:\nSecond";
		const last = "@last 2026-10-11T04:00:00Z:\nThird";
		const wrap = (text: string) => `<external source="${issueUrl}" fetched="2026-10-11T08:00:00.000Z">\n${text}\n</external>`;
		expect(ok(expansion(issueUrl, null)).text).toBe(wrap(`Issue title\n\nIssue body\n\n${first}\n\n${middle}\n\n${last}`));
		expect(ok(expansion(issueUrl, "body, title")).text).toBe(wrap("Issue body\n\nIssue title"));
		expect(ok(expansion(issueUrl, "comments(-1)")).text).toBe(wrap(last));
		expect(ok(expansion(issueUrl, "comments(-3)")).text).toBe(wrap(`${first}\n\n${middle}\n\n${last}`));
		expect(ok(expansion(issueUrl, "comments(1..2)")).text).toBe(wrap(`${first}\n\n${middle}`));
		expect(ok(expansion(issueUrl, "comments(3..3)")).text).toBe(wrap(last));
	});
	test("empty issue comments expand successfully only with all-comments selector", () => {
		const empty: FetchOutcome = { ok: true, at: fetchedAt, value: { kind: "issue", issue: { title: "", body: "", comments: [] } } };
		for (const expression of ["comments", "comments(-1)", "comments(1..1)"]) {
			const result = references.compile(["b1"], input([["b1", task(`((${issueUrl} | ${expression}))`)]], [[issueUrl, empty]]));
			expect(result.kind).toBe(expression === "comments" ? "Ok" : "Err");
		}
	});
	for (const expression of ["", "lines(0..1)", "lines(2..1)", "lines(1..4)", "lines(1..9007199254740992)", "lines(1)", "body", "comments", "lines(1..1),", 'section("missing")', "unknown", 'section("oops)', "lines(1..2"]) {
		test(`text rejects invalid expression ${JSON.stringify(expression)}`, () => {
			const result = expansion("b2", expression);
			expect(result.kind).toBe("Err");
			if (result.kind === "Err") expect(result.error.kind).toBe("BadExpression");
		});
	}
	for (const expression of ["lines(1..1)", 'section("Title")', "comments(-0)", "comments(-4)", "comments(0..1)", "comments(2..1)", "comments(1..4)"]) {
		test(`issue rejects invalid expression ${expression}`, () => {
			const result = expansion(issueUrl, expression);
			expect(result.kind).toBe("Err");
			if (result.kind === "Err") expect(result.error.kind).toBe("BadExpression");
		});
	}
});

describe("pure compile and expansion", () => {
	test("block selectors operate before compilation and excluded bad refs do not fail", () => {
		const data = input([["b1", task(`first ((file:notes.md))\n((b2))\n((unknown))\n((b8 | nope))`)], ["b2", task("((b1 | lines(1..1)))")]], [["file:notes.md", { ok: true, at: fetchedAt, value: { kind: "file", text: "external body" } }]]);
		const result = ok(references.compile(["b2"], data));
		expect(result.text).toBe('first <external source="file:notes.md" fetched="2026-10-11T08:00:00.000Z">\nexternal body\n</external>');
		expect(result.sources.map(source => source.target)).toEqual(["b1", "file:notes.md"]);
		expect([...references.closure(["b2"], data.blocks)]).toEqual(["b2", "b1", "b8"]);
	});
	test("source occurrence order includes repetitions and nested expansions", () => {
		const body = "A ((b2)) Z ((b2))";
		const data = input([["b1", task(body)], ["b2", task(`B ((${issueUrl} | title))`)], ["b3", task("end")]], [[issueUrl, issue]]);
		const result = ok(references.compile(["b1", "b3"], data));
		expect(result.sources.map(source => source.target)).toEqual(["b2", issueUrl, "b2", issueUrl]);
		expect(result.text.endsWith("\n\nend")).toBe(true);
		expect(JSON.stringify(references.compile(["b1", "b3"], data))).toBe(JSON.stringify(references.compile(["b1", "b3"], data)));
		expect(references.expandOne("b1", references.parseReferences(body)[0]!, data)).toEqual({ kind: "Ok", text: ok(references.compile(["b2"], data)).text, sources: [result.sources[0]!, result.sources[1]!] });
	});
	test("cycle error reports full root-to-repeat path and the closing reference site", () => {
		const data = input([["b1", task("((b2))")], ["b2", task("((b3))")], ["b3", task("((b2))")]]);
		expect(references.compile(["b1"], data)).toEqual({ kind: "Err", error: { kind: "Cycle", path: ["b1", "b2", "b3", "b2"], at: { block: "b3", reference: "((b2))" } } });
	});
	test("depth 8 succeeds and depth 9 fails at referring block", () => {
		const blocks = new Map<BlockId, BlockContent>();
		for (let number = 1; number <= 8; number++) blocks.set(`b${number}`, task(number === 8 ? "end" : `((b${number + 1}))`));
		const data: CompileInput = { blocks, fetches: new Map(), results: new Map(), inTemplate: false };
		expect(ok(references.compile(["b1"], data)).text).toBe("end");
		blocks.set("b8", task("((b9))")); blocks.set("b9", task("end"));
		expect(references.compile(["b1"], data)).toEqual({ kind: "Err", error: { kind: "TooDeep", at: { block: "b8", reference: "((b9))" } } });
	});
	test("result snapshots are not recursively expanded and carry provenance", () => {
		const data: CompileInput = { ...input([["b1", task("((b9.result | lines(2..2)))")]]), results: new Map([["b9", { text: "ignored\n((not-a-reference-in-results))", at: fetchedAt, seq: 42, origin: "human", launch: "l2" }]]) };
		expect(references.compile(["b1"], data)).toEqual({ kind: "Ok", text: "((not-a-reference-in-results))", sources: [{ kind: "result", target: "b9.result", expression: "lines(2..2)", seq: 42, origin: "human", launch: "l2" }] });
		expect(references.compile(["b1"], { ...data, inTemplate: true })).toEqual({ kind: "Err", error: { kind: "NoResult", block: "b9", at: { block: "b1", reference: "((b9.result | lines(2..2)))" } } });
		expect(references.compile(["b1"], { ...data, results: new Map() }).kind).toBe("Err");
	});
	test("unknown block, unknown target, missing fetch and failed fetch preserve error sites", () => {
		expect(references.compile(["b1"], input([]))).toEqual({ kind: "Err", error: { kind: "UnknownBlock", block: "b1", at: { block: "b1", reference: "" } } });
		expect(references.compile(["b1"], input([["b1", task("((b7))")]]))).toEqual({ kind: "Err", error: { kind: "UnknownBlock", block: "b7", at: { block: "b1", reference: "((b7))" } } });
		expect(references.compile(["b1"], input([["b1", task("((unknown))")]]))).toEqual({ kind: "Err", error: { kind: "UnknownTarget", at: { block: "b1", reference: "((unknown))" } } });
		for (const fetches of [[], [["file:missing", { ok: false, at: fetchedAt, error: "ENOENT: unreadable missing" }]] as const] as const) {
			const result = references.compile(["b1"], input([["b1", task("((file:missing))")]], fetches));
			expect(result.kind).toBe("Err");
			if (result.kind === "Err") { expect(result.error.kind).toBe("FetchFailed"); expect(result.error.at).toEqual({ block: "b1", reference: "((file:missing))" }); }
		}
	});
	test("external attribute values are escaped without changing fetched text", () => {
		const result = references.compile(["b1"], input([["b1", task('((file:a&b"c))')]], [['file:a&b"c', { ok: true, at: fetchedAt, value: { kind: "file", text: "<untrusted>&" } }]]));
		expect(ok(result).text).toContain('source="file:a&amp;b&quot;c"');
		expect(ok(result).text).toContain("\n<untrusted>&\n");
	});
});

describe("dependency discovery", () => {
	test("closure includes roots, missing ids and cycles, but not result ids or code refs", () => {
		const contents = new Map<BlockId, BlockContent>([["b1", task("((b2)) ((b9.result)) `((b8))`")], ["b2", task("((b1)) ((b3 | lines(1..1)))")], ["b9", task("((b7))")]]);
		expect([...references.closure(["b1", "b4"], contents)]).toEqual(["b1", "b2", "b3", "b4"]);
		expect(references.resultTargets(["b1"], contents)).toEqual(["b9"]);
	});
	test("external and result discovery scans whole closure despite compilation selectors", () => {
		const contents = new Map<BlockId, BlockContent>([["b1", task("((b2 | lines(1..1))) ((file:./notes.md)) ((b7.result))")], ["b2", task(`chosen\n((${issueUrl})) ((file:notes.md)) ((b8.result)) ((b7.result))`)], ["b7", task("((file:excluded))")]]);
		expect(references.externalTargets(["b1"], contents).map(references.targetKey)).toEqual(["file:notes.md", issueUrl]);
		expect(references.resultTargets(["b1"], contents)).toEqual(["b7", "b8"]);
	});
});

describe("design block references", () => {
	const requirement = "Build the checkout flow.";
	const design = "Introduction\n\n## A Checkout\nFirst panel.\n### Details\nKeep this subsection.\n\n## B Payment\nSecond panel.\n";
	const content: BlockContent = { kind: "design", requirement, design };
	const panelA = "## A Checkout\nFirst panel.\n### Details\nKeep this subsection.";
	function compile(expression: string | null): CompileResult {
		const reference = `((b3${expression === null ? "" : ` | ${expression}`}))`;
		return references.compile(["b1"], input([["b1", task(reference)], ["b3", content]]));
	}
	test("an unselected design reference emits tagged requirement and design with provenance", () => {
		expect(compile(null)).toEqual({
			kind: "Ok",
			text: `<requirement>\n${requirement}\n</requirement>\n\n<design>\n${design}\n</design>`,
			sources: [{ kind: "block", target: "b3", expression: null }],
		});
	});
	test("an empty requirement compiles to nothing: no empty <requirement>, no blank selection", () => {
		const blank: BlockContent = { kind: "design", requirement: "  \n", design };
		const run = (reference: string) => references.compile(["b1"], input([["b1", task(reference)], ["b3", blank]]));
		expect(run("((b3))")).toMatchObject({ kind: "Ok", text: `<design>\n${design}\n</design>` });
		expect(run("((b3 | requirement, panel(A)))")).toMatchObject({ kind: "Ok", text: panelA });
	});
	for (const [expression, expected] of [
		["requirement", requirement],
		["design", design],
		['panel("A")', panelA],
		["panel(A)", panelA],
		['panel("B"), requirement, panel(A)', `## B Payment\nSecond panel.\n\n${requirement}\n\n${panelA}`],
	] as const) {
		test(`design selector ${expression} returns the selected text in order`, () => {
			expect(compile(expression)).toEqual({
				kind: "Ok", text: expected,
				sources: [{ kind: "block", target: "b3", expression }],
			});
		});
	}
	for (const expression of ["lines(1..1)", 'section("Checkout")', 'panel("Z")']) {
		test(`design rejects ${expression} at the referring task`, () => {
			const result = compile(expression);
			expect(result.kind).toBe("Err");
			if (result.kind === "Err") {
				expect(result.error.kind).toBe("BadExpression");
				expect(result.error.at).toEqual({ block: "b1", reference: `((b3 | ${expression}))` });
			}
		});
	}
	for (const expression of ["requirement", "design", 'panel("A")', "panel(A)"]) {
		test(`task blocks reject design selector ${expression}`, () => {
			const result = expansion("b2", expression, "## A Checkout\nTask text.");
			expect(result.kind).toBe("Err");
			if (result.kind === "Err") expect(result.error.kind).toBe("BadExpression");
		});
	}
	test("an automatically assigned panel ID is not addressable", () => {
		const data = input([
			["b1", task('((b3 | panel("A")))')],
			["b3", { kind: "design", requirement: "", design: "## Checkout\nNo written letter ID." }],
		]);
		const result = references.compile(["b1"], data);
		expect(result.kind).toBe("Err");
		if (result.kind === "Err") expect(result.error.kind).toBe("BadExpression");
	});
	test("design fields are literal leaves for compilation and all dependency discovery", () => {
		const leaf: BlockContent = {
			kind: "design",
			requirement: `((b2)) ((${issueUrl})) ((b8.result))`,
			design: "## A Literal\n((b1)) ((file:missing.md)) ((b9.result)) ((unknown))",
		};
		const data = input([["b1", task("((b3))")], ["b2", task("Unexpected expansion")], ["b3", leaf]]);
		const tagged = `<requirement>\n${leaf.requirement}\n</requirement>\n\n<design>\n${leaf.design}\n</design>`;
		expect(ok(references.compile(["b1"], data)).text).toBe(tagged);
		expect([...references.closure(["b1"], data.blocks)]).toEqual(["b1", "b3"]);
		expect(references.externalTargets(["b1"], data.blocks)).toEqual([]);
		expect(references.resultTargets(["b1"], data.blocks)).toEqual([]);
		for (const [selector, expected] of [
			["requirement", leaf.requirement],
			["design", leaf.design],
			["panel(A)", leaf.design],
		] as const) {
			const selected = input([["b1", task(`((b3 | ${selector}))`)], ["b3", leaf]]);
			expect(ok(references.compile(["b1"], selected)).text).toBe(expected);
		}
	});
	test("a design root compiles both tagged fields without expanding its references", () => {
		const leaf: BlockContent = {
			kind: "design", requirement: "((b7))", design: "## A Literal\n((file:missing.md)) ((b9.result))",
		};
		const data = input([["b3", leaf], ["b4", task("Next root")]]);
		const tagged = `<requirement>\n${leaf.requirement}\n</requirement>\n\n<design>\n${leaf.design}\n</design>`;
		expect(references.compile(["b3"], data)).toEqual({ kind: "Ok", text: tagged, sources: [] });
		expect(references.compile(["b3", "b4"], data)).toEqual({ kind: "Ok", text: `${tagged}\n\nNext root`, sources: [] });
		expect([...references.closure(["b3"], data.blocks)]).toEqual(["b3"]);
		expect(references.externalTargets(["b3"], data.blocks)).toEqual([]);
		expect(references.resultTargets(["b3"], data.blocks)).toEqual([]);
	});
});

describe("design panel replacement", () => {
	const design = "---\ntitle: Checkout\n---\nIntroduction.\n\n## A Overview\nKeep overview.\n\n## B Payment\nOld payment.\n\n## C Receipt\nKeep receipt.\n";
	test("replaces one explicit panel while preserving frontmatter, lead and neighbors", () => {
		const replacement = "## B Revised payment\nNew payment.\n### Details\nNew details.";
		expect(references.replacePanel(design, "B", replacement)).toEqual({
			ok: true,
			text: `---\ntitle: Checkout\n---\nIntroduction.\n\n## A Overview\nKeep overview.\n\n${replacement}\n\n## C Receipt\nKeep receipt.\n`,
		});
	});
	test("unknown and automatically assigned panel IDs return NotFound", () => {
		for (const [source, id] of [[design, "Z"], ["## Overview\nNo written letter ID.", "A"]] as const) {
			const result = references.replacePanel(source, id, `## ${id} Replacement\nNew text.`);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.code).toBe("NotFound");
		}
	});
	for (const replacement of [
		"## A Wrong ID\nNew payment.",
		"## B Payment\nNew payment.\n\n## C Extra panel\nExtra text.",
	]) {
		test(`invalid replacement returns BadValue: ${JSON.stringify(replacement)}`, () => {
			const result = references.replacePanel(design, "B", replacement);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.code).toBe("BadValue");
		});
	}
});

describe("unified diff", () => {
	test("replacement with context and empty unchanged diff", () => {
		expect(references.unifiedDiff("a\nb\nc\n", "a\nB\nc\n")).toBe("--- before\n+++ after\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
		expect(references.unifiedDiff("same", "same")).toBe("");
	});
	test("insert/delete empty files and missing terminal newlines", () => {
		expect(references.unifiedDiff("", "new\n")).toBe("--- before\n+++ after\n@@ -0,0 +1 @@\n+new\n");
		expect(references.unifiedDiff("old\n", "")).toBe("--- before\n+++ after\n@@ -1 +0,0 @@\n-old\n");
		expect(references.unifiedDiff("old", "new")).toBe("--- before\n+++ after\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n");
		expect(references.unifiedDiff("same", "same\n")).toBe("--- before\n+++ after\n@@ -1 +1 @@\n-same\n\\ No newline at end of file\n+same\n");
	});
	test("separates distant changes and merges overlapping context", () => {
		const before = Array.from({ length: 20 }, (_, index) => `${index + 1}`).join("\n") + "\n";
		const distant = before.replace("2\n", "two\n").replace("19\n", "nineteen\n");
		expect(references.unifiedDiff(before, distant).match(/^@@/gm)?.length).toBe(2);
		const close = before.replace("5\n", "five\n").replace("9\n", "nine\n");
		expect(references.unifiedDiff(before, close).match(/^@@/gm)?.length).toBe(1);
	});
	test("duplicate line alignment remains deterministic", () => {
		const before = "a\na\nb\na\n";
		const after = "a\nb\nb\na\n";
		expect(references.unifiedDiff(before, after)).toBe(references.unifiedDiff(before, after));
		expect(references.unifiedDiff(before, after)).toContain("-a\n+b\n");
	});
});
