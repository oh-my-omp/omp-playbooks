import { describe, expect, test } from "bun:test";
import { startUi } from "../src/service/ui";
import type { FrameOp, FrameStatus, TspEvent, TspInput, TspNode, TspSession } from "../src/service/tsp-types";
import { registerCoreCleanup, coreFixture, design, task, template } from "./core-fixture";

class TestTsp implements TspSession {
	input: (input: TspInput) => void = () => {};
	statusListener: (blocks: readonly string[]) => void = () => {};
	roots = new Map<string, TspNode>();
	frames: { ops: readonly FrameOp[]; blocks: readonly string[] }[] = [];
	ready = Promise.withResolvers<void>();
	start(_app: string, input: (input: TspInput) => void) { this.input = input; }
	open() {}
	blob() {}
	frame(ops: readonly FrameOp[], blocks: readonly string[]) {
		this.frames.push({ ops, blocks });
		for (const op of ops) { if (op[0] === "add") this.roots.set(op[1], op[4]); else if (op[0] === "del") this.roots.delete(op[1]); }
		this.ready.resolve();
		return this.frames.length;
	}
	status(): FrameStatus { return { blockError: false, documentError: false, pendingOverdue: false }; }
	fullRedraw() {}
	onStatusChange(listener: (blocks: readonly string[]) => void) { this.statusListener = listener; }
	action(id: string, act = "invoke", mods: readonly string[] = []) { this.input({ kind: "event", event: { ev: "action", id, act, mods } }); }
	event(event: TspEvent) { this.input({ kind: "event", event }); }
	keys(bytes: string) { this.input({ kind: "keys", bytes }); }
	nodes(): TspNode[] {
		const walk = (node: TspNode): TspNode[] => [node, ...(node.c ?? []).flatMap(walk)];
		return [...this.roots.values()].flatMap(walk);
	}
	node(id: string): TspNode { const found = this.nodes().find(node => node.id === id); if (!found) throw new Error(`Missing node ${id}`); return found; }
}
async function fixture(blocks = [task("b1"), task("b2")]) {
	const f = coreFixture(blocks);
	const tsp = new TestTsp();
	startUi(f.core, tsp, f.directory);
	tsp.input({ kind: "hello", dark: true });
	await tsp.ready.promise;
	return { ...f, tsp };
}

describe("current Playbook user interactions", () => {
	test("opens first card and folding another mounts exactly that body", async () => {
		const f = await fixture();
		expect(f.tsp.nodes().some(node => node.id === "b1.body")).toBe(true);
		expect(f.tsp.nodes().some(node => node.id === "b2.body")).toBe(false);
		f.tsp.action("b2.fold");
		expect(f.tsp.nodes().some(node => node.id === "b1.body")).toBe(false);
		expect(f.tsp.nodes().some(node => node.id === "b2.body")).toBe(true);
	});
	for (const end of ["\r", "\x1b"]) test(`inline title editing commits through ${JSON.stringify(end)}`, async () => {
		const f = await fixture();
		f.tsp.action("b1.title", "edit");
		f.tsp.event({ ev: "edit", id: "b1.title.edit", from: 0, to: 2, text: "Renamed", cursor: 7, len: 2 });
		f.tsp.keys(end);
		expect(f.core.view(template).blocks[0]?.block.title).toBe("Renamed");
	});
	test("stale inline edits cannot overwrite a concurrent title change", async () => {
		const f = await fixture();
		f.tsp.action("b1.title", "edit");
		f.tsp.keys(" local");
		expect(f.core.edit(template, "b1", "title", "b1", "Concurrent")).toBeNull();
		f.tsp.keys("\r");
		expect(f.core.view(template).blocks[0]?.block.title).toBe("Concurrent");
		expect(f.tsp.nodes().some(node => node.k === "toast" && node.p?.tone === "error")).toBe(true);
	});
	test("document title editing persists through core", async () => {
		const f = await fixture();
		f.tsp.action("doc.title", "edit");
		f.tsp.keys(" changed\r");
		expect(f.core.view(template).title).toBe("Playbook changed");
	});
	test("native edit length guard rejects an edit against obsolete text", async () => {
		const f = await fixture();
		f.tsp.action("b1.title", "edit");
		f.tsp.event({ ev: "edit", id: "b1.title.edit", from: 0, to: 2, text: "Wrong", cursor: 5, len: 100 });
		f.tsp.keys("\r");
		expect(f.core.view(template).blocks[0]?.block.title).toBe("b1");
	});
	test("status toggles update the task and dock completion count", async () => {
		const f = await fixture();
		f.tsp.action("b1.status");
		expect(f.core.view(template).blocks[0]?.block.progress).toEqual({ kind: "tracked", status: "done", report: null });
		expect(f.tsp.node("status.done").p?.text).toBe("1 / 2 已完成");
		f.tsp.action("b1.status");
		expect(f.core.view(template).blocks[0]?.block.progress).toMatchObject({ status: "todo" });
	});
	test("meta-click selects tracked tasks and grouped launch requests retain document order", async () => {
		const f = await fixture(); await f.connect();
		f.tsp.action("b2.title", "invoke", ["meta"]); f.tsp.action("b1.title", "invoke", ["meta"]);
		f.tsp.action("bar.launch");
		expect(f.events).toContainEqual({ event: "launch_requested", data: { blocks: ["b1", "b2"] } });
		expect(f.tsp.nodes().some(node => node.id === "bar.launch")).toBe(false);
	});
	test("untracked and design cards cannot be selected for grouped launch", async () => {
		const untracked = { ...task("b1"), progress: { kind: "untracked" as const } };
		const f = await fixture([untracked, design("b2")]);
		f.tsp.action("b1.title", "invoke", ["meta"]); f.tsp.action("b2.title", "invoke", ["meta"]);
		expect(f.tsp.nodes().some(node => node.id === "bar.launch")).toBe(false);
		expect(f.tsp.nodes().some(node => node.id === "b1.status")).toBe(false);
	});
	test("launch is disabled while pending and running task uses stop instead", async () => {
		const f = await fixture(); await f.connect();
		f.tsp.action("b1.foot.launch"); f.tsp.action("b1.foot.launch");
		expect(f.events.filter(event => event.event === "launch_requested")).toHaveLength(1);
		await f.success({ op: "launch", args: { blocks: ["b1"] } });
		f.core.setStatus(template, "b1", "running"); await Promise.resolve();
		f.tsp.action("b1.foot.launch");
		expect(f.events).toContainEqual(expect.objectContaining({ event: "stop_requested", data: { block: "b1", launches: [{ id: "l1", agents: [] }] } }));
	});
	test("task slots rewrite source while design slots submit a revision without editing design", async () => {
		const source = "```slot mode\n= Fast\n* Fast\n- Safe\n```\nUse {{mode}}.";
		const f = await fixture([task("b1", source), design("b2", source)]); await f.connect();
		const slot = f.tsp.nodes().find(node => node.p?.text === "Fast" && node.p?.actions)!;
		f.tsp.action(slot.id); f.tsp.action("picker.o1");
		expect(f.core.view(template).blocks[0]?.block.content).toMatchObject({ body: source.replace("= Fast", "= Safe") });
		f.tsp.action("b2.fold");
		const designSlot = f.tsp.nodes().find(node => node.p?.text === "Fast" && node.p?.actions)!;
		f.tsp.action(designSlot.id); f.tsp.action("picker.o1");
		expect(f.core.view(template).blocks[1]?.block.content).toMatchObject({ design: source });
		expect(f.store.readRevisions(template)).toContainEqual(expect.objectContaining({ block: "b2" }));
	});
	test("ordered list pick-and-place rewrites and renumbers the actual body", async () => {
		const f = await fixture([task("b1", "3. One\n4. Two\n5. Three")]);
		const grip = f.tsp.nodes().find(node => node.k === "icon" && node.p?.name === "grip")!;
		f.tsp.action(grip.id);
		const target = f.tsp.nodes().filter(node => node.p?.tag === "li" && node.p?.actions).at(-1)!;
		f.tsp.action(target.id);
		expect(f.core.view(template).blocks[0]?.block.content).toMatchObject({ body: "3. Two\n4. Three\n5. One" });
	});
	test("completion reports start folded and reveal the subagent's text on request", async () => {
		const block = { ...task("b1"), progress: { kind: "tracked" as const, status: "done" as const, report: "Work completed" } };
		const f = await fixture([block]);
		expect(f.tsp.nodes().some(node => node.p?.text === "Work completed")).toBe(false);
		f.tsp.action("b1.foot.report.toggle");
		expect(f.tsp.nodes().some(node => node.p?.text === "Work completed")).toBe(true);
	});
	test("more menu deletes the open block through core", async () => {
		const f = await fixture(); f.tsp.action("b1.more"); f.tsp.action("menu.delete");
		expect(f.core.view(template).blocks.map(item => item.block.id)).toEqual(["b2"]);
	});
	test("Unicode deletion removes a code point and undo restores the last edit", async () => {
		const f = await fixture();
		f.tsp.action("b1.title", "edit");
		f.tsp.event({ ev: "edit", id: "b1.title.edit", from: 0, to: 2, text: "A😀B", cursor: 4, len: 2 });
		f.tsp.keys("\x7f\x7f");
		f.tsp.event({ ev: "undo", id: "b1.title.edit" });
		f.tsp.keys("\r");
		expect(f.core.view(template).blocks[0]?.block.title).toBe("A😀");
	});
	test("fragmented paste and coalesced text plus Escape commit one single-line edit", async () => {
		const f = await fixture();
		f.tsp.action("b1.title", "edit");
		f.tsp.keys("\x1b[200~");
		f.tsp.keys(" pasted\ntext");
		f.tsp.keys("\x1b[201~!\x1b");
		expect(f.core.view(template).blocks[0]?.block.title).toBe("b1 pasted text!");
	});
	test("Shift+Enter inserts a requirement newline and Ctrl+Enter commits without editing design", async () => {
		const f = await fixture([design("b1")]);
		f.tsp.action("b1.requirement", "edit");
		f.tsp.keys("\x1b[13;2u");
		f.tsp.keys("Extra requirement");
		f.tsp.keys("\x1b[13;5u");
		expect(f.core.view(template).blocks[0]?.block.content).toEqual({ kind: "design", requirement: "Requirement\nExtra requirement", design: "## A Plan\nDesign" });
	});
});

registerCoreCleanup();
