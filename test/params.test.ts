import { expect, test } from "bun:test";
import * as zod from "@oh-my-pi/omptype/zod";
import { toolParameters } from "../src/extension/params";

const schemas = toolParameters(zod);
type ToolName = keyof Omit<typeof schemas, "wire">;

const call = (name: ToolName, params: Record<string, unknown>): unknown => {
	const entry = schemas[name];
	return entry.toInternal(entry.parameters.parse(params) as never);
};
const rejects = (name: ToolName, params: Record<string, unknown>): void => {
	const entry = schemas[name];
	let threw = false;
	try {
		entry.toInternal(entry.parameters.parse(params) as never);
	} catch {
		threw = true;
	}
	expect(threw).toBe(true);
};

test("playbook_read and monolithic playbook_edit are removed", () => {
	expect("playbook_read" in schemas).toBe(false);
	expect("playbook_edit" in schemas).toBe(false);
	expect(Object.keys(schemas).filter((key) => key !== "wire")).toEqual([
		"playbook_open",
		"playbook_edit_content",
		"playbook_edit_structure",
		"playbook_compile",
		"playbook_check",
		"playbook_run",
		"playbook_timeline",
		"playbook_launch",
	]);
});

for (const [name, params, internal] of [
	["playbook_open", { doc: "/book.yaml" }, { doc: "/book.yaml" }],
	[
		"playbook_edit_content",
		{ doc: "/b.yaml", run: "r1", block: "b1", title: "Renamed" },
		{ doc: "/b.yaml", run: "r1", block: "b1", title: "Renamed" },
	],
	[
		"playbook_edit_content",
		{ doc: "/b.yaml", block: "b1", body: "Task body" },
		{ doc: "/b.yaml", block: "b1", change: { kind: "write", text: "Task body" } },
	],
	[
		"playbook_edit_content",
		{ doc: "/b.yaml", block: "b1", design: "Design draft" },
		{ doc: "/b.yaml", block: "b1", change: { kind: "write", text: "Design draft" } },
	],
	[
		"playbook_edit_content",
		{ doc: "/b.yaml", block: "b1", text: "Whole text" },
		{ doc: "/b.yaml", block: "b1", change: { kind: "write", text: "Whole text" } },
	],
	[
		"playbook_edit_content",
		{ doc: "/b.yaml", block: "b1", find: "Old", replace: "New" },
		{ doc: "/b.yaml", block: "b1", change: { kind: "replace", find: "Old", replace: "New" } },
	],
	[
		"playbook_edit_content",
		{ doc: "/b.yaml", block: "b1", panel: "A", text: "## A P" },
		{ doc: "/b.yaml", block: "b1", change: { kind: "panel", panel: "A", text: "## A P" } },
	],
	[
		"playbook_edit_content",
		{ doc: "/b.yaml", block: "b1", panel: "where", text: "## A Where · Context" },
		{ doc: "/b.yaml", block: "b1", change: { kind: "panel", panel: "where", text: "## A Where · Context" } },
	],
	[
		"playbook_edit_content",
		{ doc: "/b.yaml", block: "b1", title: "Both", body: "Updated" },
		{ doc: "/b.yaml", block: "b1", title: "Both", change: { kind: "write", text: "Updated" } },
	],
	[
		"playbook_edit_structure",
		{ doc: "/b.yaml", run: "r1", add: { title: "T", body: "B", after: "b1", agent: " task:mid ", isolation: "worktree" } },
		{ kind: "insert_task", doc: "/b.yaml", run: "r1", title: "T", body: "B", after: "b1", agent: "task:mid", isolated: true },
	],
	[
		"playbook_edit_structure",
		{ doc: "/b.yaml", add: { title: "T", body: "B", at_top: true, isolation: "none" } },
		{ kind: "insert_task", doc: "/b.yaml", title: "T", body: "B", at_top: true, isolated: false },
	],
	[
		"playbook_edit_structure",
		{ doc: "/b.yaml", add: { title: "D", design: "## A" } },
		{ kind: "insert_design", doc: "/b.yaml", title: "D", design: "## A" },
	],
	["playbook_edit_structure", { doc: "/b.yaml", remove_block: "b1" }, { kind: "delete", doc: "/b.yaml", block: "b1" }],
	[
		"playbook_edit_structure",
		{ doc: "/b.yaml", move: { block: "b1", at_top: true } },
		{ kind: "move", doc: "/b.yaml", block: "b1", after: null },
	],
	[
		"playbook_edit_structure",
		{ doc: "/b.yaml", move: { block: "b1", after: "b2" } },
		{ kind: "move", doc: "/b.yaml", block: "b1", after: "b2" },
	],
	[
		"playbook_edit_structure",
		{ doc: "/b.yaml", meta: { block: "b1", agent: " task:mid ", isolation: "worktree", status: "done", tracked: true } },
		{ kind: "meta", doc: "/b.yaml", block: "b1", agent: "task:mid", isolated: true, status: "done", tracked: true },
	],
	[
		"playbook_edit_structure",
		{ doc: "/b.yaml", meta: { block: "b1", clear_agent: true, isolation: "clear" } },
		{ kind: "meta", doc: "/b.yaml", block: "b1", agent: null, isolated: null },
	],
	[
		"playbook_edit_structure",
		{ doc: "/b.yaml", meta: { block: "b1", isolation: "none", tracked: false } },
		{ kind: "meta", doc: "/b.yaml", block: "b1", isolated: false, tracked: false },
	],
	[
		"playbook_compile",
		{ doc: "/b.yaml", run: "r1", blocks: ["b1", "b3"] },
		{ kind: "compile", doc: "/b.yaml", run: "r1", blocks: ["b1", "b3"] },
	],
	[
		"playbook_compile",
		{ doc: "/b.yaml", refetch: true, targets: ["file:x.md"] },
		{ kind: "refetch", doc: "/b.yaml", targets: ["file:x.md"] },
	],
	[
		"playbook_compile",
		{ doc: "/b.yaml", refetch: true, targets: ["file:x.md"], blocks: ["b1"] },
		{ kind: "refetch_and_compile", doc: "/b.yaml", targets: ["file:x.md"], blocks: ["b1"] },
	],
	[
		"playbook_check",
		{ doc: "/b.yaml", blocks: ["b1"], version: "v1", result: "answers", answers: { missing: 0.8 } },
		{ doc: "/b.yaml", blocks: ["b1"], version: "v1", result: { kind: "answers", answers: { missing: 0.8 } } },
	],
	[
		"playbook_check",
		{ doc: "/b.yaml", no_blocks: true, version: "v1", result: "pass" },
		{ doc: "/b.yaml", blocks: [], version: "v1", result: { kind: "answers", answers: { missing: 0 } } },
	],
	[
		"playbook_check",
		{ doc: "/b.yaml", blocks: ["b1"], version: "v1", result: "pass" },
		{ doc: "/b.yaml", blocks: ["b1"], version: "v1", result: { kind: "answers", answers: { missing: 0 } } },
	],
	[
		"playbook_check",
		{ doc: "/b.yaml", blocks: ["b1"], version: "v1", result: "fail" },
		{ doc: "/b.yaml", blocks: ["b1"], version: "v1", result: { kind: "answers", answers: { missing: 1 } } },
	],
	[
		"playbook_check",
		{ doc: "/b.yaml", blocks: ["b1"], version: "v1", result: "judge_unavailable" },
		{ doc: "/b.yaml", blocks: ["b1"], version: "v1", result: { kind: "judge_unavailable" } },
	],
	[
		"playbook_run",
		{ doc: "/b.yaml", start_name: "Run", update_every: 30 },
		{ kind: "start", doc: "/b.yaml", name: "Run", update_every: 30 },
	],
	["playbook_run", { doc: "/b.yaml", finish_run: "r1" }, { kind: "finish", doc: "/b.yaml", run: "r1" }],
	[
		"playbook_timeline",
		{ doc: "/b.yaml", run: "r1", kind: "result", text: "Done", block: "b1", launch: "l1", next: 60, quote: "m-1" },
		{ kind: "post", doc: "/b.yaml", run: "r1", recordKind: "result", text: "Done", block: "b1", launch: "l1", next: 60, quote: "m-1" },
	],
	["playbook_timeline", { doc: "/b.yaml", run: "r1", snooze_seconds: 30 }, { kind: "snooze", doc: "/b.yaml", run: "r1", after: 30 }],
	["playbook_launch", { doc: "/b.yaml", run: "r1", blocks: ["b1"] }, { kind: "launch", doc: "/b.yaml", run: "r1", blocks: ["b1"] }],
	[
		"playbook_launch",
		{ doc: "/b.yaml", bind_launch: "l1", agent: "worker-1" },
		{ kind: "bind", doc: "/b.yaml", launch: "l1", agent: "worker-1" },
	],
	["playbook_launch", { doc: "/b.yaml", rebase_launch: "l1" }, { kind: "rebase", doc: "/b.yaml", launch: "l1" }],
	["playbook_launch", { doc: "/b.yaml", close_launch: "l1" }, { kind: "close", doc: "/b.yaml", launch: "l1" }],
] as const) {
	test(`${name} parses ${JSON.stringify(params)}`, () => {
		expect(call(name, params)).toEqual(internal);
	});
}

for (const [name, params] of [
	["playbook_open", { doc: "/b.yaml", op: "start" }],
	["playbook_edit_content", { doc: "/b.yaml", block: "b1" }],
	["playbook_edit_content", { doc: "/b.yaml", block: "b1", find: "x" }],
	["playbook_edit_content", { doc: "/b.yaml", block: "b1", replace: "y" }],
	["playbook_edit_content", { doc: "/b.yaml", block: "b1", panel: "A" }],
	["playbook_edit_content", { doc: "/b.yaml", block: "b1", body: "a", design: "b" }],
	["playbook_edit_content", { doc: "/b.yaml", block: "b1", body: "a", find: "x", replace: "y" }],
	["playbook_edit_content", { doc: "/b.yaml", block: "b1", panel: "a", text: "t" }],
	["playbook_edit_structure", { doc: "/b.yaml" }],
	["playbook_edit_structure", { doc: "/b.yaml", remove_block: "b1", move: { block: "b1", at_top: true } }],
	["playbook_edit_structure", { doc: "/b.yaml", add: { title: "T" } }],
	["playbook_edit_structure", { doc: "/b.yaml", add: { title: "T", body: "B", design: "D" } }],
	["playbook_edit_structure", { doc: "/b.yaml", add: { title: "T", body: "B", at_top: true, after: "b1" } }],
	["playbook_edit_structure", { doc: "/b.yaml", add: { title: "T", design: "D", agent: "task:mid" } }],
	["playbook_edit_structure", { doc: "/b.yaml", add: { title: "T", body: "B", agent: "   " } }],
	["playbook_edit_structure", { doc: "/b.yaml", move: { block: "b1" } }],
	["playbook_edit_structure", { doc: "/b.yaml", move: { block: "b1", at_top: true, after: "b2" } }],
	["playbook_edit_structure", { doc: "/b.yaml", meta: { block: "b1" } }],
	["playbook_edit_structure", { doc: "/b.yaml", meta: { block: "b1", agent: "   " } }],
	["playbook_edit_structure", { doc: "/b.yaml", meta: { block: "b1", isolation: "yes" } }],
	["playbook_edit_structure", { doc: "/b.yaml", meta: { block: "b1", agent: "task:mid", clear_agent: true } }],
	["playbook_edit_structure", { doc: "/b.yaml", meta: { block: "b1", clear_agent: false } }],
	["playbook_edit_structure", { doc: "/b.yaml", meta: { block: "b1", agent: null } }],
	["playbook_edit_structure", { doc: "/b.yaml", meta: { block: "b1", isolation: null } }],
	["playbook_edit_structure", { doc: "/b.yaml", remove_block: "b0" }],
	["playbook_compile", { doc: "/b.yaml" }],
	["playbook_compile", { doc: "/b.yaml", refetch: true }],
	["playbook_compile", { doc: "/b.yaml", blocks: ["b1"], targets: ["file:x"] }],
	["playbook_check", { doc: "/b.yaml", blocks: ["b1"], version: "v1", result: "answers" }],
	["playbook_check", { doc: "/b.yaml", blocks: ["b1"], no_blocks: true, version: "v1", result: "pass" }],
	["playbook_check", { doc: "/b.yaml", no_blocks: false, version: "v1", result: "pass" }],
	["playbook_check", { doc: "/b.yaml", blocks: ["b1"], version: "v1", result: "judge_unavailable", answers: { missing: 0.8 } }],
	["playbook_run", { doc: "/b.yaml" }],
	["playbook_run", { doc: "/b.yaml", start_name: "R", finish_run: "r1" }],
	["playbook_run", { doc: "/b.yaml", finish_run: "r1", update_every: 30 }],
	["playbook_timeline", { doc: "/b.yaml" }],
	["playbook_timeline", { doc: "/b.yaml", snooze_seconds: 30 }],
	["playbook_timeline", { doc: "/b.yaml", run: "r1", snooze_seconds: 30, kind: "update", text: "hi" }],
	["playbook_timeline", { doc: "/b.yaml", kind: "update", text: "t", launch: "l0" }],
	["playbook_launch", { doc: "/b.yaml" }],
	["playbook_launch", { doc: "/b.yaml", blocks: ["b1"], agent: "w" }],
	["playbook_launch", { doc: "/b.yaml", bind_launch: "l1" }],
	["playbook_launch", { doc: "/b.yaml", rebase_launch: "l1", blocks: ["b1"] }],
	["playbook_launch", { doc: "/b.yaml", close_launch: "l1", run: "r1" }],
	["playbook_launch", { doc: "/b.yaml", close_launch: "1" }],
] as const) {
	test(`${name} rejects invalid call ${JSON.stringify(params)}`, () => {
		rejects(name, params);
	});
}
