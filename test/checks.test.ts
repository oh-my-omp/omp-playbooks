import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { BlockId, BlockResult, CompileError, CompileResult, Source } from "../src/domain/model";
import type { ChecksModule } from "../src/domain/ports";
import { checks } from "../src/service/checks";

const numericTable = "| Stage | ms |\n|---|---|\n| Compile | 12 |\n| Fetch | 340 |\n| Launch | 85 |\n| Write | 9 |";
const textTable = "| Stage | State |\n|---|---|\n| Compile | ready |\n| Fetch | complete |";
const ok: CompileResult = { kind: "Ok", text: "Complete prompt", sources: [] };
const site = { block: "b1", reference: "((b2))" } as const;
const compileErrors: readonly CompileError[] = [
	{ kind: "UnknownBlock", block: "b2", at: site },
	{ kind: "UnknownTarget", at: site },
	{ kind: "BadExpression", reason: "invalid selector", at: site },
	{ kind: "Cycle", path: ["b1", "b2", "b1"], at: site },
	{ kind: "TooDeep", at: site },
	{ kind: "NoResult", block: "b2", at: site },
	{ kind: "FetchFailed", target: "missing.txt", error: "ENOENT", at: site },
	{ kind: "UnknownSlot", block: "b2", slot: "mode", at: site },
];
const outlined = "## A Where · Scope\nThe service.\n\n## B What · Goal\nIt answers.\n\n## C How · Steps\nRun it.";
const input: Parameters<ChecksModule["findings"]>[0] = {
	compiled: ok,
	expansions: [],
	content: { kind: "task", body: outlined },
	render: { blockError: false, documentError: false, pendingOverdue: false, draftErrors: 0, view: { md: [], images: [] } },
};

describe("deterministic findings", () => {
	test("a complete rendered prompt passes every check", () => {
		expect(checks.findings(input)).toEqual({
			compile: false,
			empty_expansion: false,
			render_error: false,
			render_pending: false,
			draft: false,
			outline: false,
		});
	});

	for (const error of compileErrors) {
		test(`compile fails for ${error.kind}`, () => {
			expect(checks.findings({ ...input, compiled: { kind: "Err", error } }).compile).toBe(true);
		});
	}

	test("an empty compiled prompt is not an empty reference expansion", () => {
		expect(checks.findings({ ...input, compiled: { ...ok, text: "" } }).empty_expansion).toBe(false);
	});

	for (const text of ["", " ", "\t\r\n", "\u00a0\u2003"]) {
		test(`empty expansion fails for ${JSON.stringify(text)}`, () => {
			expect(checks.findings({ ...input, expansions: [ok, { ...ok, text }, ok] }).empty_expansion).toBe(true);
		});
	}

	test("nonempty text and failed expansions do not count as empty expansions", () => {
		const failed: CompileResult = { kind: "Err", error: { kind: "UnknownTarget", at: site } };
		expect(checks.findings({ ...input, expansions: [failed, { ...ok, text: " \n x \t " }] }).empty_expansion).toBe(false);
	});

	for (const blockError of [false, true]) {
		for (const documentError of [false, true]) {
			test(`render error combines block=${blockError}, document=${documentError}`, () => {
				expect(checks.findings({ ...input, render: { ...input.render, blockError, documentError } }).render_error).toBe(
					blockError || documentError,
				);
			});
		}
	}

	for (const pendingOverdue of [false, true]) {
		test(`render pending reflects overdue=${pendingOverdue}`, () => {
			expect(checks.findings({ ...input, render: { ...input.render, pendingOverdue } }).render_pending).toBe(pendingOverdue);
		});
	}

	test("all failures can coexist independently", () => {
		expect(
			checks.findings({
				compiled: { kind: "Err", error: { kind: "UnknownTarget", at: site } },
				expansions: [{ ...ok, text: "\n" }],
				content: { kind: "task", body: numericTable },
				render: { blockError: true, documentError: false, pendingOverdue: true, draftErrors: 2, view: { md: [], images: [] } },
			}),
		).toEqual({ compile: true, empty_expansion: true, render_error: true, render_pending: true, draft: true, outline: true });
	});
});

describe("design draft findings", () => {
	const cleanDesign = "Design overview.\n\n## A Where · Scope\nThe service.\n\n## B What · Architecture\nA complete design.\n\n## C How · Execution\nImplement the plan.";
	const designContent = { kind: "design", requirement: "A user requirement.", design: cleanDesign } as const;

	test("design content skips empty expansion and chart checks", () => {
		const findings = checks.findings({
			...input,
			content: { ...designContent, requirement: numericTable, design: `## A Metrics\n${numericTable}` },
			expansions: [{ ...ok, text: " \n\t " }],
			render: { ...input.render, },
		});
		expect(findings.empty_expansion).toBe(false);
		expect(findings.draft).toBe(false);
	});

	for (const [name, design] of [
		["unclosed fence", "## A Implementation\n```typescript\nconst value = 1;"],
		["duplicate panel ID", "## A First\nFirst panel.\n\n## A Second\nSecond panel."],
	] as const) {
		test(`draft fails for ${name} without render-reported errors`, () => {
			expect(checks.findings({ ...input, content: { ...designContent, design } }).draft).toBe(true);
		});
	}

	test("a clean design passes every check", () => {
		expect(checks.findings({ ...input, content: designContent })).toEqual({
			compile: false,
			empty_expansion: false,
			render_error: false,
			render_pending: false,
			draft: false,
			outline: false,
		});
	});

	test("outline is checked on the design and the body, never on the person's requirement or an orchestration body", () => {
		expect(checks.findings({ ...input, content: { ...designContent, design: "## A Architecture\nA design." } }).outline).toBe(true);
		expect(checks.findings({ ...input, content: { ...designContent, requirement: "free text" } }).outline).toBe(false);
		expect(checks.findings({ ...input, content: { kind: "task", body: "Do it." } }).outline).toBe(true);
		expect(checks.findings({ ...input, content: { kind: "task", body: "```js\nawait playbook.run({ blocks: [\"b2\"] });\n```" } }).outline).toBe(false);
	});

	for (const draftErrors of [0, 1, 2]) {
		test(`a clean design reflects ${draftErrors} render-reported draft errors`, () => {
			expect(checks.findings({
				...input,
				content: designContent,
				render: { ...input.render, draftErrors },
			}).draft).toBe(draftErrors > 0);
		});
	}

	test("task draft diagnostics include malformed content and render-reported errors", () => {
		expect(checks.findings({
			...input,
			content: { kind: "task", body: "## A First\nFirst panel.\n\n## A Second\n```typescript\nconst value = 1;" },
			render: { ...input.render, draftErrors: 2 },
		}).draft).toBe(true);
	});
});

describe("closed judge report validation", () => {
	for (const missing of [0, Number.MIN_VALUE, 0.499999999, 0.5, 0.500000001, 1 - Number.EPSILON, 1]) {
		test(`accepts complete probability ${missing}`, () => {
			expect(checks.validateReport({ kind: "answers", answers: { missing } })).toBe(true);
		});
	}

	for (const missing of [-Number.MIN_VALUE, -1, 1 + Number.EPSILON, 2, NaN, Infinity, -Infinity]) {
		test(`rejects out-of-domain probability ${missing}`, () => {
			expect(checks.validateReport({ kind: "answers", answers: { missing } })).toBe(false);
		});
	}

	test("rejects missing, additional, and unknown question ids", () => {
		const answerSets: readonly Readonly<Record<string, number>>[] = [{}, { missing: 0, chart: 0 }, { chart: 0 }, { Missing: 0 }];
		for (const answers of answerSets) {
			expect(checks.validateReport({ kind: "answers", answers })).toBe(false);
		}
	});

	test("accepts an unavailable judge as an explicit result", () => {
		expect(checks.validateReport({ kind: "judge_unavailable" })).toBe(true);
	});

	test("the missing-material verdict switches at its inclusive threshold", () => {
		const question = checks.questions.find(question => question.id === "missing");
		if (!question) throw new Error("Missing-material question absent");
		expect(0.5 - Number.EPSILON >= question.threshold).toBe(false);
		expect(0.5 >= question.threshold).toBe(true);
		expect(0.5 + Number.EPSILON >= question.threshold).toBe(true);
	});
});
