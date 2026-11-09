import { expect, test } from "bun:test";
import * as zod from "@oh-my-pi/omptype/zod";
import { toolParameters } from "../src/extension/params";

// Issue #36: the public flat shape parses at the execute entry into the same internal values the
// previous op-union produced. Every internal branch keeps a call; every op rejects a field that is
// not its own.
const schemas = toolParameters(zod);
const call = (name: keyof Omit<typeof schemas, "wire">, params: Record<string, unknown>): unknown => {
	const entry = schemas[name];
	return entry.toInternal(entry.parameters.parse(params) as never);
};
const rejects = (name: keyof Omit<typeof schemas, "wire">, params: Record<string, unknown>): void => {
	const entry = schemas[name];
	let threw = false;
	try { entry.toInternal(entry.parameters.parse(params) as never); } catch { threw = true; }
	expect(threw).toBe(true);
};

for (const [name, params, internal] of [
	// open (1)
	["playbook_open", { doc: "/book.yaml" }, { doc: "/book.yaml" }],
	// read (2): the public `op` is optional; omitted and "read" both map to the plain-read branch.
	["playbook_read", { doc: "/b.yaml", run: "r1", block: "b1" }, { doc: "/b.yaml", run: "r1", block: "b1" }],
	["playbook_read", { op: "revisions", doc: "/b.yaml", run: "r1", block: "b3", after: 4 }, { doc: "/b.yaml", run: "r1", op: "revisions", block: "b3", after: 4 }],
	// edit (12)
	["playbook_edit", { op: "title", doc: "/b.yaml", run: "r1", block: "b1", title: "Renamed" }, { doc: "/b.yaml", run: "r1", op: "title", block: "b1", value: "Renamed" }],
	["playbook_edit", { op: "status", doc: "/b.yaml", block: "b1", status: "done" }, { doc: "/b.yaml", op: "status", block: "b1", value: "done" }],
	["playbook_edit", { op: "task", doc: "/b.yaml", block: "b1", tracked: false }, { doc: "/b.yaml", op: "task", block: "b1", value: false }],
	["playbook_edit", { op: "replace", doc: "/b.yaml", block: "b1", find: "Old", replace: "New" }, { doc: "/b.yaml", op: "replace", block: "b1", find: "Old", replace: "New" }],
	["playbook_edit", { op: "write", doc: "/b.yaml", block: "b1", text: "Text" }, { doc: "/b.yaml", op: "write", block: "b1", text: "Text" }],
	["playbook_edit", { op: "panel", doc: "/b.yaml", block: "b1", panel: "A", text: "## A P" }, { doc: "/b.yaml", op: "panel", block: "b1", panel: "A", text: "## A P" }],
	["playbook_edit", { op: "insert", doc: "/b.yaml", run: "r1", after: "b1", title: "T", body: "B", agent: " task:mid ", isolated: true }, { doc: "/b.yaml", run: "r1", op: "insert", after: "b1", title: "T", body: "B", agent: "task:mid", isolated: true }],
	["playbook_edit", { op: "insert_design", doc: "/b.yaml", title: "D", design: "## A" }, { doc: "/b.yaml", op: "insert_design", title: "D", design: "## A" }],
	["playbook_edit", { op: "delete", doc: "/b.yaml", block: "b1" }, { doc: "/b.yaml", op: "delete", block: "b1" }],
	// The calls the old shape wrote as `after: null`, `value: null` keep that internal value.
	["playbook_edit", { op: "move", doc: "/b.yaml", block: "b1", position: "top" }, { doc: "/b.yaml", op: "move", block: "b1", after: null }],
	["playbook_edit", { op: "move", doc: "/b.yaml", block: "b1", position: "after", after: "b2" }, { doc: "/b.yaml", op: "move", block: "b1", after: "b2" }],
	["playbook_edit", { op: "agent", doc: "/b.yaml", block: "b1", agent: " task:mid " }, { doc: "/b.yaml", op: "agent", block: "b1", value: "task:mid" }],
	["playbook_edit", { op: "agent", doc: "/b.yaml", block: "b1", clear: true }, { doc: "/b.yaml", op: "agent", block: "b1", value: null }],
	["playbook_edit", { op: "isolated", doc: "/b.yaml", block: "b1", isolation: "isolated" }, { doc: "/b.yaml", op: "isolated", block: "b1", value: true }],
	["playbook_edit", { op: "isolated", doc: "/b.yaml", block: "b1", isolation: "default" }, { doc: "/b.yaml", op: "isolated", block: "b1", value: null }],
	// compile (2)
	["playbook_compile", { op: "compile", doc: "/b.yaml", run: "r1", blocks: ["b1", "b3"] }, { doc: "/b.yaml", run: "r1", op: "compile", blocks: ["b1", "b3"] }],
	["playbook_compile", { op: "refetch", doc: "/b.yaml", targets: ["file:x.md"] }, { doc: "/b.yaml", op: "refetch", targets: ["file:x.md"] }],
	// check (2)
	["playbook_check", { op: "inspect", doc: "/b.yaml", run: "r1", blocks: ["b1"] }, { doc: "/b.yaml", run: "r1", op: "inspect", blocks: ["b1"] }],
	["playbook_check", { op: "report", doc: "/b.yaml", blocks: ["b1"], version: "v1", result: "answers", answers: [{ question: "q1", probability: 0.8 }] }, { doc: "/b.yaml", op: "report", blocks: ["b1"], version: "v1", result: { kind: "answers", answers: { q1: 0.8 } } }],
	["playbook_check", { op: "report", doc: "/b.yaml", blocks: ["b1"], version: "v1", result: "judge_unavailable" }, { doc: "/b.yaml", op: "report", blocks: ["b1"], version: "v1", result: { kind: "judge_unavailable" } }],
	// run (3)
	["playbook_run", { op: "start", doc: "/b.yaml", name: "Run", update_every: 30 }, { doc: "/b.yaml", op: "start", name: "Run", update_every: 30 }],
	["playbook_run", { op: "finish", doc: "/b.yaml", run: "r1" }, { doc: "/b.yaml", op: "finish", run: "r1" }],
	["playbook_run", { op: "list", doc: "/b.yaml" }, { doc: "/b.yaml", op: "list" }],
	// timeline (3)
	["playbook_timeline", { op: "read", doc: "/b.yaml", run: "r1", after: 6, limit: 200 }, { doc: "/b.yaml", op: "read", run: "r1", after: 6, limit: 200 }],
	["playbook_timeline", { op: "post", doc: "/b.yaml", run: "r1", kind: "result", text: "Done", block: "b1", launch: "l1", next: 60, quote: "m-1" }, { doc: "/b.yaml", op: "post", run: "r1", kind: "result", text: "Done", block: "b1", launch: "l1", next: 60, quote: "m-1" }],
	["playbook_timeline", { op: "snooze", doc: "/b.yaml", run: "r1", after: 30 }, { doc: "/b.yaml", op: "snooze", run: "r1", after: 30 }],
	// launch (5)
	["playbook_launch", { op: "launch", doc: "/b.yaml", run: "r1", blocks: ["b1"] }, { doc: "/b.yaml", op: "launch", run: "r1", blocks: ["b1"] }],
	["playbook_launch", { op: "bind", doc: "/b.yaml", launch: "l1", agent: "worker-1" }, { doc: "/b.yaml", op: "bind", launch: "l1", agent: "worker-1" }],
	["playbook_launch", { op: "info", doc: "/b.yaml", launch: "l1" }, { doc: "/b.yaml", op: "info", launch: "l1" }],
	["playbook_launch", { op: "rebase", doc: "/b.yaml", launch: "l1" }, { doc: "/b.yaml", op: "rebase", launch: "l1" }],
	["playbook_launch", { op: "close", doc: "/b.yaml", launch: "l1" }, { doc: "/b.yaml", op: "close", launch: "l1" }],
] as const) {
	test(`${name} ${"op" in params ? params.op : "open"} parses into the same internal value as before`, () => {
		expect(call(name, params)).toEqual(internal);
	});
}

test("playbook_read accepts an explicit op read and still produces the plain-read branch", () => {
	expect(call("playbook_read", { op: "read", doc: "/b.yaml", block: "b1" })).toEqual({ doc: "/b.yaml", block: "b1" });
});

for (const [name, params] of [
	// One call per op carrying a field that only a sibling op of the same device knows.
	["playbook_open", { doc: "/b.yaml", op: "start" }],
	["playbook_read", { op: "revisions", doc: "/b.yaml", title: "T" }],
	["playbook_read", { doc: "/b.yaml", limit: 10 }],
	["playbook_edit", { op: "title", doc: "/b.yaml", block: "b1" }],
	["playbook_edit", { op: "status", doc: "/b.yaml", block: "b1", status: "done", title: "T" }],
	["playbook_edit", { op: "task", doc: "/b.yaml", block: "b1" }],
	["playbook_edit", { op: "replace", doc: "/b.yaml", block: "b1", find: "x", text: "y" }],
	["playbook_edit", { op: "write", doc: "/b.yaml", block: "b1", text: "t", find: "x" }],
	["playbook_edit", { op: "panel", doc: "/b.yaml", block: "b1", panel: "A", title: "T" }],
	["playbook_edit", { op: "insert", doc: "/b.yaml", title: "T", body: "B", block: "b1" }],
	["playbook_edit", { op: "insert_design", doc: "/b.yaml", title: "T", design: "D", body: "B" }],
	["playbook_edit", { op: "delete", doc: "/b.yaml", block: "b1", status: "done" }],
	["playbook_edit", { op: "move", doc: "/b.yaml", block: "b1", position: "top", after: "b2" }],
	["playbook_edit", { op: "move", doc: "/b.yaml", block: "b1", position: "after" }],
	["playbook_edit", { op: "agent", doc: "/b.yaml", block: "b1", agent: "task:mid", clear: true }],
	["playbook_edit", { op: "agent", doc: "/b.yaml", block: "b1" }],
	["playbook_edit", { op: "isolated", doc: "/b.yaml", block: "b1" }],
	["playbook_compile", { op: "compile", doc: "/b.yaml", blocks: ["b1"], targets: ["file:x"] }],
	["playbook_compile", { op: "refetch", doc: "/b.yaml", blocks: ["b1"] }],
	["playbook_check", { op: "inspect", doc: "/b.yaml", blocks: ["b1"], version: "v1" }],
	["playbook_check", { op: "report", doc: "/b.yaml", blocks: ["b1"], version: "v1", result: "answers", answers: [{ question: "q1", probability: 0.1 }, { question: "q1", probability: 0.9 }] }],
	["playbook_check", { op: "report", doc: "/b.yaml", blocks: ["b1"], version: "v1" }],
	["playbook_run", { op: "start", doc: "/b.yaml", name: "R", run: "r1" }],
	["playbook_run", { op: "finish", doc: "/b.yaml" }],
	["playbook_run", { op: "list", doc: "/b.yaml", name: "R" }],
	["playbook_timeline", { op: "read", doc: "/b.yaml", kind: "update" }],
	["playbook_timeline", { op: "post", doc: "/b.yaml", kind: "update", text: "t", limit: 5 }],
	["playbook_timeline", { op: "snooze", doc: "/b.yaml", after: 30 }],
	["playbook_timeline", { op: "snooze", doc: "/b.yaml", run: "r1" }],
	["playbook_launch", { op: "launch", doc: "/b.yaml", blocks: ["b1"], agent: "w" }],
	["playbook_launch", { op: "bind", doc: "/b.yaml", launch: "l1" }],
	["playbook_launch", { op: "info", doc: "/b.yaml", blocks: ["b1"] }],
	["playbook_launch", { op: "rebase", doc: "/b.yaml", launch: "l1", blocks: ["b1"] }],
	["playbook_launch", { op: "close", doc: "/b.yaml", launch: "l1", agent: "w" }],
] as const) {
	test(`${name} ${"op" in params ? params.op : "open"} rejects a call with fields outside its branch`, () => {
		rejects(name, params);
	});
}

for (const [name, params] of [
	["playbook_read", { doc: "/b.yaml", block: "1" }],
	["playbook_read", { doc: "/b.yaml", run: "x" }],
	["playbook_edit", { op: "delete", doc: "/b.yaml", block: "b0" }],
	["playbook_timeline", { op: "post", doc: "/b.yaml", kind: "update", text: "t", launch: "l0" }],
	["playbook_launch", { op: "info", doc: "/b.yaml", launch: "1" }],
	["playbook_edit", { op: "panel", doc: "/b.yaml", block: "b1", panel: "a", text: "t" }],
] as const) {
	test(`${name} still rejects the malformed id in ${JSON.stringify(params)}`, () => {
		rejects(name, params);
	});
}
