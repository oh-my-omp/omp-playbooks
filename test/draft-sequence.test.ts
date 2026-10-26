import { fence, passiveEdit, renderDefaults } from "./draft-helpers";
import { describe, expect, test } from "bun:test";
import type { RenderContext } from "../src/service/draft/contract";
import { parseSequence, renderSequence, type SequenceSpec } from "../src/service/draft/sequence";

function parsed(lines: readonly string[], args = ""): SequenceSpec {
	const result = parseSequence(fence({ lines, args, line: 10 }));
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	expect(result.diagnostics).toEqual([]);
	return result.value;
}

function rendered(spec: SequenceSpec, id = "draft") {
	let source = "";
	let size = { w: 0, h: 0 };
	const ctx: RenderContext = { ...renderDefaults,
		id,
		view: "changes",
		svg(nodeId, svg, dimensions, alt) {
			source = svg;
			size = dimensions;
			return { id: nodeId, k: "image", p: { alt } };
		},
		image() { throw new Error("sequence must use SVG"); },
		readFile() { throw new Error("sequence must not read files"); },
	};
	return { result: renderSequence(spec, ctx), get svg() { return source; }, get size() { return size; } };
}

describe("sequence parser", () => {
	test("parses the am handshake example in first-seen participant order", () => {
		const spec = parsed(["Client -> Server: SYN", "Server --> Client: SYN-ACK", "Client -> Server: ACK", "note Client, Server: ESTABLISHED"]);
		expect(spec.participants).toEqual(["Client", "Server"]);
		expect(spec.numbered).toBe(false);
		expect(spec.steps).toEqual([
			{ kind: "message", from: "Client", to: "Server", dashed: false, label: "SYN", line: 10 },
			{ kind: "message", from: "Server", to: "Client", dashed: true, label: "SYN-ACK", line: 11 },
			{ kind: "message", from: "Client", to: "Server", dashed: false, label: "ACK", line: 12 },
			{ kind: "note", over: ["Client", "Server"], text: "ESTABLISHED", line: 13 },
		]);
	});

	test("honors declared ordering, self calls, single/spanning notes and phase dividers", () => {
		const spec = parsed(["participants: C, A, B", "A -> B: request: with detail", "B -> B: self call", "note A: on one", "note A, C: across", "== Phase divider =="], "num");
		expect(spec.participants).toEqual(["C", "A", "B"]);
		expect(spec.numbered).toBe(true);
		expect(spec.steps.map(step => step.kind)).toEqual(["message", "message", "note", "note", "divider"]);
		expect(spec.steps[0]).toMatchObject({ label: "request: with detail" });
		expect(spec.steps[1]).toMatchObject({ from: "B", to: "B" });
		expect(spec.steps[2]).toMatchObject({ over: ["A"] });
		expect(spec.steps[3]).toMatchObject({ over: ["A", "C"] });
	});

	test("keeps reference first-seen order with late declarations and new note participants", () => {
		const spec = parsed(["A -> B", "participants: C, B, A", "note D: discovered by note"]);
		expect(spec.participants).toEqual(["A", "B", "C", "D"]);
		expect(spec.steps[0]).toMatchObject({ label: "" });
	});

	test("trims names, supports reference CJK separators and ignores blank/comment lines", () => {
		const spec = parsed(["", "  // explanation", "  participants：客户端，服务端  ", "  客户端 --> 服务端： 返回  ", "note 客户端，服务端：连接已建立"]);
		expect(spec.participants).toEqual(["客户端", "服务端"]);
		expect(spec.steps[0]).toMatchObject({ from: "客户端", to: "服务端", dashed: true, label: "返回", line: 13 });
	});

	test.each(["A => B: invalid", "A ---> B: invalid", "A -> : missing", "-> B: missing", "note A:", "note : text", "== ==", "unrecognized", "participants:", "participants: A,,B", "note A,: text"])("reports malformed line %s at its original source location", text => {
		const result = parseSequence(fence({ args: "", lines: ["A -> B: good", "", text], line: 20 }));
		expect(result.ok).toBe(false);
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]).toMatchObject({ line: 22, severity: "error", component: "sequence" });
		expect(result.diagnostics[0]!.message).toMatch(/请写/);
	});

	test("rejects unknown arguments on the fence line and an empty diagram", () => {
		const option = parseSequence(fence({ args: "numbers", lines: ["A -> B"], line: 8 }));
		expect(option.ok).toBe(false);
		expect(option.diagnostics[0]).toMatchObject({ line: 7, severity: "error" });
		const empty = parseSequence(fence({ args: "", lines: ["", "// no actors"], line: 8 }));
		expect(empty.ok).toBe(false);
		expect(empty.diagnostics[0]).toMatchObject({ line: 8, severity: "error" });
	});

	test("permits a declared-participant-only or note-only diagram, as the reference does", () => {
		expect(parsed(["participants: A, B"]).steps).toEqual([]);
		expect(parsed(["note A: note"]).participants).toEqual(["A"]);
	});
});

describe("sequence SVG renderer", () => {
	test("draws SVG with solid/dashed messages, return arrowheads and self loop", () => {
		const output = rendered(parsed(["A -> B: request", "B --> A: reply", "B -> B: self", "note A, B: complete", "== Phase =="]));
		expect(output.result.diagnostics).toEqual([]);
		expect(output.result.nodes).toHaveLength(1);
		expect(output.result.nodes[0]).toMatchObject({ id: "draft.sequence", k: "image" });
		expect(output.svg.match(/<polygon /g)).toHaveLength(3);
		expect(output.svg).toContain('stroke-dasharray="6 4"');
		expect(output.svg).toMatch(/<path d="M [^"]+ H [^"]+ V [^"]+ H /);
		expect(output.svg).toContain('stroke-dasharray="4 5"');
		expect(output.svg).toContain("complete");
		expect(output.svg).toContain("Phase");
		expect(output.size.w).toBeLessThanOrEqual(1000);
	});

	test("numbers messages only, including self and unlabeled calls", () => {
		const output = rendered(parsed(["A -> B: one", "note A: note", "== Phase ==", "B -> B: two", "B --> A"], "num"));
		expect(output.svg).toContain("1. one");
		expect(output.svg).toContain("2. two");
		expect(output.svg).toContain(">3.</text>");
		expect(output.svg).not.toContain(">4.</text>");
	});

	test("wraps CJK/long identifiers and XML-escapes labels without script or external refs", () => {
		const output = rendered(parsed([
			"participants: 客户端, 服务端, 数据库",
			"客户端 -> 服务端: **这是需要换行的中文请求消息，附带完整身份认证信息以及业务参数**",
			`服务端 -> 数据库: ${"verylongidentifier".repeat(20)}`,
			"数据库 --> 服务端: <script>alert(1)</script> & done",
			"note 客户端, 数据库: 安全地显示 <xml> & 内容",
		]));
		expect(output.svg).not.toContain("<script>");
		expect(output.svg).not.toContain("**");
		expect(output.svg).toContain("&lt;script&gt;");
		expect(output.svg).toContain("&amp;");
		expect(output.svg).not.toContain("foreignObject");
		expect(output.svg).not.toContain("href=");
		expect(output.svg.match(/<text /g)!.length).toBeGreaterThan(15);
		expect(output.size.w).toBeLessThanOrEqual(1000);
		expect(output.svg).not.toMatch(/NaN|undefined/);
	});

	test("keeps wide diagrams zoomable while capping displayed size proportionally", () => {
		const participants = Array.from({ length: 30 }, (_, index) => `Actor${index}`);
		const output = rendered(parsed([`participants: ${participants.join(", ")}`, "Actor0 -> Actor29: all participants", "Actor29 -> Actor29: self call"]));
		const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(output.svg)!;
		const naturalWidth = Number(viewBox[1]);
		const naturalHeight = Number(viewBox[2]);
		expect(output.size.w).toBe(1000);
		expect(naturalWidth).toBeGreaterThan(1000);
		expect(output.size.h / output.size.w).toBeCloseTo(naturalHeight / naturalWidth);
		expect(output.svg).not.toMatch(/width="-|NaN|undefined/);
		expect(output.svg.match(/stroke-dasharray="4 5"/g)).toHaveLength(30);
	});

	test("has unique namespaced node IDs across renders", () => {
		const spec = parsed(["A -> A: self"]);
		const ids = [rendered(spec, "one"), rendered(spec, "two")].flatMap(output => output.result.nodes.map(node => node.id));
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toEqual(["one.sequence", "two.sequence"]);
	});
});
