import { describe, expect, test } from "bun:test";
import { parseAsk, renderAsk, type AskSpec } from "../src/service/draft/ask";
import type { FenceInput, Parsed, RenderContext } from "../src/service/draft/contract";
import type { TspNode } from "../src/service/tsp-types";

function input(lines: readonly string[], args = "", line = 20): FenceInput {
	return { args, lines, line };
}

function value(result: Parsed<AskSpec>): AskSpec {
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	expect(result.diagnostics).toEqual([]);
	return result.value;
}

function error(result: Parsed<AskSpec>, line: number, message: string): void {
	expect(result.ok).toBe(false);
	expect(result.diagnostics).toHaveLength(1);
	expect(result.diagnostics[0]).toEqual({ component: "ask", severity: "error", line, message: expect.stringContaining(message) });
}

const context: RenderContext = {
	id: "panel.cache",
	view: "changes",
	svg() { throw new Error("ask must not need SVG"); },
	image() { throw new Error("ask must not need images"); },
	readFile() { throw new Error("ask must not read files"); },
};

function descendants(nodes: readonly TspNode[]): TspNode[] {
	return nodes.flatMap(node => [node, ...descendants(node.c ?? [])]);
}

function node(nodes: readonly TspNode[], suffix: string): TspNode {
	const found = nodes.find(candidate => candidate.id === `${context.id}.${suffix}`);
	if (!found) throw new Error(`Missing ask node ${suffix}`);
	return found;
}

const example = ["Which cache do we use?", "* Redis | keeps data after a restart", "- Memcached | simpler, no disk"];

describe("ask syntax", () => {
	test("accepts the authoritative single-choice example with notes", () => {
		expect(value(parseAsk(input(example)))).toEqual({
			question: "Which cache do we use?",
			mode: "single",
			options: [
				{ label: "Redis", note: "keeps data after a restart", suggested: true },
				{ label: "Memcached", note: "simpler, no disk", suggested: false },
			],
		});
	});

	test("trims content, skips blank lines and whole-line comments, and preserves inline slashes", () => {
		expect(value(parseAsk(input([" ", " // explanation", "  选择缓存？  ", "", "\t* Redis\t| 数据保留  ", "// ignored", " - Memcached // simpler "])))).toEqual({
			question: "选择缓存？",
			mode: "single",
			options: [
				{ label: "Redis", note: "数据保留", suggested: true },
				{ label: "Memcached // simpler", note: "", suggested: false },
			],
		});
	});

	for (const suggested of [0, 1, 2, 6]) {
		test(`multi accepts ${suggested} suggested options`, () => {
			const spec = value(parseAsk(input(["启用哪些功能？", ...Array.from({ length: 6 }, (_, index) => `${index < suggested ? "*" : "-"} 功能 ${index + 1}`)], "multi")));
			expect(spec.mode).toBe("multi");
			expect(spec.options).toHaveLength(6);
			expect(spec.options.filter(option => option.suggested)).toHaveLength(suggested);
		});
	}

	test("multi is a whitespace-delimited fence token, not a substring", () => {
		expect(value(parseAsk(input(example, "  multi\t"))).mode).toBe("multi");
		expect(value(parseAsk(input(example, "multiplayer"))).mode).toBe("single");
	});

	test("preserves upstream handling of extra arguments and extra pipe fields", () => {
		const spec = value(parseAsk(input(["Question?", "* First | note | ignored", "- Second |"], "other")));
		expect(spec.mode).toBe("single");
		expect(spec.options).toEqual([
			{ label: "First", note: "note", suggested: true },
			{ label: "Second", note: "", suggested: false },
		]);
	});

	for (const lines of [[], ["", "  ", "// comment"]]) {
		test(`requires a question for empty content ${JSON.stringify(lines)}`, () => {
			error(parseAsk(input(lines)), 20, "第一行");
		});
	}

	test("an option cannot replace the first question, even after ignored lines", () => {
		error(parseAsk(input(["", "// comment", "* Redis", "- Memcached"])), 22, "第一行");
	});

	for (const invalid of ["Redis", "+ Redis", "*Redis", "-Redis", "*", "- "]) {
		test(`rejects malformed option ${JSON.stringify(invalid)} at its source line`, () => {
			error(parseAsk(input(["", "Question?", "// comment", "* First", "", invalid])), 25, "以 * 或 -");
		});
	}

	test("an option requires a label before the note delimiter", () => {
		error(parseAsk(input(["Question?", "* First", "- | note"])), 22, "| 前写名称");
	});

	for (const count of [0, 1, 7]) {
		test(`rejects ${count} options at the question's original source line`, () => {
			error(parseAsk(input(["// comment", "", "Question?", ...Array.from({ length: count }, (_, index) => `${index === 0 ? "*" : "-"} Option ${index + 1}`)])), 22, "2–6");
		});
	}

	test("accepts both two and six options in single-choice mode", () => {
		for (const count of [2, 6]) {
			expect(value(parseAsk(input(["Question?", ...Array.from({ length: count }, (_, index) => `${index === 0 ? "*" : "-"} Option ${index + 1}`)]))).options).toHaveLength(count);
		}
	});

	for (const options of [["- First", "- Second"], ["* First", "* Second"]]) {
		test(`single choice requires exactly one suggestion: ${options.join(", ")}`, () => {
			error(parseAsk(input(["// comment", "Question?", ...options])), 21, "恰好一个 *");
		});
	}

	for (const args of ["", "multi"]) {
		test(`rejects duplicate trimmed labels in ${args || "single"} mode at the duplicate line`, () => {
			error(parseAsk(input(["Question?", "* Redis | first note", "// comment", "", "- Redis   | different note"], args)), 24, "重复");
		});
	}
});

describe("ask rendering without controls (the checks' hidden pass)", () => {
	test("shows the question, accent suggestion badge, ordinary options, muted notes and single-choice explanation", () => {
		const rendered = renderAsk(value(parseAsk(input(example))), context);
		expect(rendered.diagnostics).toEqual([]);
		expect(rendered.nodes[0]).toMatchObject({ k: "el", p: { tag: "div", class: "am-ask" } });
		const nodes = descendants(rendered.nodes);
		expect(node(nodes, "question").p).toEqual({ spans: [{ t: "Which cache do we use?", s: "strong" }] });
		expect(node(nodes, "option.0.label").p).toEqual({ spans: [{ t: "Redis", s: "accent" }] });
		expect(node(nodes, "option.0.suggested")).toMatchObject({ k: "badge", p: { text: "建议", tone: "accent" } });
		expect(node(nodes, "option.1.label").p).toEqual({ spans: [{ t: "Memcached" }] });
		expect(nodes.some(candidate => candidate.id === `${context.id}.option.1.suggested`)).toBe(false);
		expect(node(nodes, "option.0.note").p).toEqual({ spans: [{ t: "keeps data after a restart", s: "muted" }] });
		expect(node(nodes, "option.1.note").p).toEqual({ spans: [{ t: "simpler, no disk", s: "muted" }] });
		expect(node(nodes, "mode").p).toEqual({ spans: [{ t: "单选", s: "muted" }] });
	});

	test("multi marks every suggestion and retains inline text semantics", () => {
		const spec = value(parseAsk(input(["选择 **缓存**？", "* **Redis** | 使用 `磁盘`", "* *Memcached*", "- ~~Other~~"], "multi")));
		const nodes = descendants(renderAsk(spec, context).nodes);
		expect(nodes.filter(candidate => candidate.k === "badge")).toHaveLength(2);
		expect(node(nodes, "question").p).toEqual({ spans: [{ t: "选择 ", s: "strong" }, { t: "缓存", s: "strong strong" }, { t: "？", s: "strong" }] });
		expect(node(nodes, "option.0.label").p).toEqual({ spans: [{ t: "Redis", s: "accent strong" }] });
		expect(node(nodes, "option.1.label").p).toEqual({ spans: [{ t: "Memcached", s: "accent em" }] });
		expect(node(nodes, "option.2.label").p).toEqual({ spans: [{ t: "Other", s: "del" }] });
		expect(node(nodes, "option.0.note").p).toEqual({ spans: [{ t: "使用 ", s: "muted" }, { t: "磁盘", s: "muted code" }] });
		expect(node(nodes, "mode").p).toEqual({ spans: [{ t: "多选", s: "muted" }] });
	});

	test("a multi-choice display with no suggestions omits badges and empty note nodes", () => {
		const nodes = descendants(renderAsk(value(parseAsk(input(["Question?", "- First", "- Second |"], "multi"))), context).nodes);
		expect(nodes.some(candidate => candidate.k === "badge" || candidate.id.endsWith(".note"))).toBe(false);
	});

	test("all node IDs are unique, namespaced, and output contains no selectable controls or actions", () => {
		const spec = value(parseAsk(input(["Question?", ...Array.from({ length: 6 }, (_, index) => `* Option ${index + 1} | note`)], "multi")));
		const nodes = descendants(renderAsk(spec, context).nodes);
		expect(new Set(nodes.map(candidate => candidate.id)).size).toBe(nodes.length);
		for (const candidate of nodes) {
			expect(candidate.id.startsWith(`${context.id}.`)).toBe(true);
			expect(["el", "col", "row", "text", "badge"]).toContain(candidate.k);
			for (const property of ["act", "actions", "checked", "value", "onChange", "onClick"]) {
				expect(candidate.p).not.toHaveProperty(property);
			}
		}
	});

	test("change views do not hide normal hyphen-prefixed ask options", () => {
		const spec = value(parseAsk(input(example)));
		const displayed = renderAsk(spec, context);
		for (const view of ["before", "after"] as const) {
			expect(renderAsk(spec, { ...context, view })).toEqual(displayed);
		}
	});

	test("with an askControl hook, the UI's controls replace the static option list and receive the parsed ask", () => {
		const spec = value(parseAsk(input(example)));
		const calls: { id: string; spec: AskSpec }[] = [];
		const control: TspNode = { id: "panel.cache.choice.0", k: "el", p: { tag: "input", type: "radio" } };
		const nodes = descendants(renderAsk(spec, { ...context, askControl: (id, given) => { calls.push({ id, spec: given }); return [control]; } }).nodes);
		expect(calls).toEqual([{ id: "panel.cache.choice", spec }]);
		expect(nodes.map(candidate => candidate.id)).toEqual(["panel.cache.ask", "panel.cache.question", "panel.cache.choice.0", "panel.cache.mode"]);
	});
});
