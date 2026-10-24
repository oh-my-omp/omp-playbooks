import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startUi } from "../src/service/ui";
import { checks } from "../src/service/checks";
import { Core } from "../src/service/core";
import { references } from "../src/service/references";
import { createStore } from "../src/service/store";
import type { EventPayload } from "../src/domain/protocol";
import { fieldText, withField, type BlockContent, type BlockId, type CompileResult, type DocRef, type HumanField, type Launch, type LaunchId, type RecordKind, type Revision, type RunId } from "../src/domain/model";
import type { BlockView, CoreApi, DocView, RenderStatus } from "../src/domain/ports";
import type { RunSummary } from "../src/domain/protocol";
import type { FrameOp, FrameStatus, TspEvent, TspInput, TspNode, TspSession } from "../src/service/tsp-types";

const template: DocRef = { kind: "template" };
const runRef: DocRef = { kind: "run", run: "r1" };
const body = "## Work\n\n| Phase | ms |\n|---|---|\n| Compile | 12 |\n| Fetch | 340 |\n| Launch | 85 |\n| Write | 9 |\n\n((file:context.md))";
function item(id: BlockId = "b1", value = body): BlockView {
	return { block: { id, title: "Task", content: { kind: "task", body: value }, done: false }, lock: { kind: "none" }, references: [{ key: "reference", reference: { text: "((file:context.md))", targetText: "file:context.md", expressionText: null, offset: value.indexOf("((") }, external: true, status: "ready", fetchedAt: 1000, fetchFailed: false, expansion: { kind: "Ok", text: '<external source="file:context.md" fetched="1970-01-01T00:00:01.000Z">\nContext\n</external>', sources: [] } }], launches: [{ id: "l1", active: false, session: "session-a", agents: ["agent-a"] }], latestRecord: null, findings: { compile: false, empty_expansion: false, render_error: false, render_pending: false, chart: false, draft: false }, report: { version: "v1", result: { kind: "answers", answers: { missing: 0.75 } } }, notices: ["卡片通知"] };
}
const design = "## A Storage\n\n```kv\nOwner: Platform\n```\n\n```callout info Review\nKeep writes atomic.\n```\n\n| Layer | Status |\n| --- | --- |\n| Journal | ok Durable |\n";
const requirement = "Keep submitted changes durable.";
function designItem(id: BlockId = "b1", draft = design): BlockView {
	return { ...item(id), block: { id, title: "Storage design", done: false, content: { kind: "design", requirement, design: draft } }, references: [], launches: [], report: null, notices: [] };
}
function descendants(node: TspNode): TspNode[] {
	return [node, ...(node.c ?? []).flatMap(descendants)];
}
class FakeCore implements CoreApi {
	calls: { method: string; args: readonly unknown[] }[] = [];
	listener: (ref: DocRef | null) => void = () => {};
	connected = false;
	statuses: { ref: DocRef; block: BlockId; status: RenderStatus }[] = [];
	history: readonly Revision[] = [];
	revisionReads: { ref: DocRef; block: BlockId }[] = [];
	template: DocView = { ref: template, title: "Playbook", run: null, blocks: [item(), item("b2", "Other")], timeline: [], lastUpdateAt: null, retrospective: false, errors: [] };
	run: DocView = { ref: runRef, title: "Playbook", run: { id: "r1", name: "Incident", status: "running", startedAt: 1000, finishedAt: null, updateEvery: 60, updateDue: 2000 }, blocks: [item(), item("b2", "Other")], timeline: [{ seq: 1, at: 1000, origin: "coordinator", data: { type: "launch_created", launch: "l1", kind: "prompt", blocks: ["b1"] } }, { seq: 2, at: 2000, origin: "human", data: { type: "post", kind: "result", text: "Finished work", block: "b1", launch: "l1", quote: "message-a", session: "session-a" } }], lastUpdateAt: 1500, retrospective: false, errors: [] };
	call(method: string, ...args: readonly unknown[]): null { this.calls.push({ method, args }); return null; }
	view(ref: DocRef): DocView { return ref.kind === "template" ? this.template : this.run; }
	runs(): RunSummary[] { return [{ id: "r1", name: "Incident", status: this.run.run!.status, started_at: 1000, finished_at: this.run.run!.finishedAt, done: 0, total: 2, update_due: this.run.run!.updateDue, update_overdue: this.run.run!.updateDue !== null, retrospective: this.run.retrospective }]; }
	coordinator() { return { connected: this.connected, session: this.connected ? "session-a" : null, pane: this.connected ? "pane-a" : null }; }
	async focusCoordinator() { return this.call("focusCoordinator"); }
	errors(): readonly string[] { return []; }
	onChange(listener: (ref: DocRef | null) => void) { this.listener = listener; return () => {}; }
	setRenderStatus(ref: DocRef, block: BlockId, status: RenderStatus): void { this.statuses.push({ ref, block, status }); }
	revisions(ref: DocRef, block: BlockId): readonly Revision[] { this.revisionReads.push({ ref, block }); return this.history.filter(revision => revision.block === block); }
	change(ref: DocRef, block: BlockId, transform: (value: BlockView) => BlockView): void {
		const next = { ...this.view(ref), blocks: this.view(ref).blocks.map(value => value.block.id === block ? transform(value) : value) };
		if (ref.kind === "template") this.template = next; else this.run = next;
	}
	pencil(ref: DocRef, block: BlockId, field: HumanField) { this.call("pencil", ref, block, field); this.change(ref, block, value => ({ ...value, lock: { kind: "human", field, draft: field === "prompt" ? "" : fieldText(value.block, field) ?? "" } })); this.listener(ref); return null; }
	setDraft(ref: DocRef, block: BlockId, text: string) { this.call("setDraft", ref, block, text); this.change(ref, block, value => value.lock.kind === "human" ? { ...value, lock: { ...value.lock, draft: text } } : value); return null; }
	commit(ref: DocRef, block: BlockId) {
		this.call("commit", ref, block);
		this.change(ref, block, value => {
			if (value.lock.kind !== "human") return value;
			const updated = value.lock.field === "prompt" ? value.block : withField(value.block, value.lock.field, value.lock.draft);
			if (!updated) throw new Error("Draft field does not belong to block");
			return { ...value, block: updated, lock: { kind: "none" } };
		});
		this.listener(ref); return null;
	}
	discard(ref: DocRef, block: BlockId) { this.call("discard", ref, block); this.change(ref, block, value => ({ ...value, lock: { kind: "none" } })); this.listener(ref); return null; }
	interrupt(ref: DocRef, block: BlockId) { return this.call("interrupt", ref, block); }
	setDone(ref: DocRef, block: BlockId, done: boolean) { return this.call("setDone", ref, block, done); }
	insertBlock(ref: DocRef, after: BlockId | null, kind: BlockContent["kind"]) { return this.call("insertBlock", ref, after, kind); }
	deleteBlock(ref: DocRef, block: BlockId) { return this.call("deleteBlock", ref, block); }
	requestLaunch(run: RunId, blocks: readonly BlockId[]) { return this.call("requestLaunch", run, blocks); }
	requestCheck(ref: DocRef, blocks: readonly BlockId[]) { return this.call("requestCheck", ref, blocks); }
	async preview(ref: DocRef, blocks: readonly BlockId[]): Promise<CompileResult> { this.call("preview", ref, blocks); return { kind: "Ok", text: "Compiled text", sources: [] }; }
	async refetch(ref: DocRef, target: string) { return this.call("refetch", ref, target); }
	startRun(name: string, every: number | null) { return this.call("startRun", name, every); }
	finishRun(run: RunId) { return this.call("finishRun", run); }
	post(run: RunId, kind: RecordKind, text: string, block: BlockId | null, next: number | null) { return this.call("post", run, kind, text, block, next); }
	snooze(run: RunId, after: number) { return this.call("snooze", run, after); }
	closeLaunch(launch: LaunchId) { return this.call("closeLaunch", launch); }
	launchInfo(launch: LaunchId): Launch {
		this.call("launchInfo", launch);
		return { id: launch, run: "r1", session: "session-a", blocks: ["b1"], kind: "prompt", snapshot: { result: { kind: "Ok", text: "Complete snapshot", sources: [] }, fetches: [], results: [] }, agents: ["agent-a"], baselines: ["Baseline"], notified: null, dirty: [["b1", 1]], fetches: [], closed: null };
	}
}
class FakeTsp implements TspSession {
	input: (input: TspInput) => void = () => {};
	statusListener: (blocks: readonly string[]) => void = () => {};
	frames: { ops: readonly FrameOp[]; blocks: readonly string[] }[] = [];
	order: string[] = [];
	root: TspNode | null = null;
	facts: FrameStatus = { blockError: false, documentError: false, pendingOverdue: false };
	blockFacts = new Map<string, FrameStatus>();
	frameWaiters: (() => void)[] = [];
	nextFrame(): Promise<void> { const { promise, resolve } = Promise.withResolvers<void>(); this.frameWaiters.push(resolve); return promise; }
	start(_app: string, onInput: (input: TspInput) => void) { this.input = onInput; }
	open() { this.order.push("open"); }
	blob(id: string, mime: string, bytes: Uint8Array) { expect(mime).toBe("image/svg+xml"); expect(bytes.length).toBeGreaterThan(0); this.order.push(`blob:${id}`); }
	frame(ops: readonly FrameOp[], blocks: readonly string[]) { this.frames.push({ ops, blocks }); this.order.push("frame"); for (const op of ops) if (op[0] === "add") this.root = op[4]; for (const resolve of this.frameWaiters.splice(0)) resolve(); return this.frames.length; }
	status(block: string): FrameStatus { return this.blockFacts.get(block) ?? this.facts; }
	fullRedraw() {}
	onStatusChange(listener: (blocks: readonly string[]) => void) { this.statusListener = listener; }
	event(event: TspEvent) { this.input({ kind: "event", event }); }
	click(id: string) { this.event({ ev: "action", id, act: "invoke" }); }
	keys(bytes: string) { this.input({ kind: "keys", bytes }); }
	selectTab(item: "template" | RunId) { this.event({ ev: "other", body: { ev: "select", id: "tabs", item } }); }
	node(id: string): TspNode {
		function find(node: TspNode): TspNode | undefined { if (node.id === id) return node; for (const child of node.c ?? []) { const match = find(child); if (match) return match; } }
		const node = this.root && find(this.root); if (!node) throw new Error(`Missing ${id}`); return node;
	}
}
async function fixture(core = new FakeCore(), tsp = new FakeTsp()): Promise<{ core: FakeCore; tsp: FakeTsp }> {
	startUi(core, tsp, process.cwd());
	const ready = tsp.nextFrame(); tsp.input({ kind: "hello", dark: true }); await ready;
	expect(tsp.root).not.toBeNull(); return { core, tsp };
}
const tick = () => Promise.resolve();

describe("K4 form UI", () => {
	test("pencil → native input → Esc owns draft through Core and leaves blank clicks alone", async () => {
		const { core, tsp } = await fixture(); tsp.click("b1.title.pencil"); await tick();
		expect(tsp.node("b1.title").k).toBe("input"); expect(tsp.frames.at(-1)?.ops.at(-1)).toEqual(["focus", "b1.title"]);
		tsp.event({ ev: "edit", id: "b1.title", from: 4, to: 4, text: "!", cursor: 5, len: 4 }); tsp.click("main");
		expect(core.calls.map(call => call.method)).toEqual(["pencil", "setDraft"]);
		tsp.keys("\x1b"); await tick();
		expect(core.calls).toEqual([{ method: "pencil", args: [template, "b1", "title"] }, { method: "setDraft", args: [template, "b1", "Task!"] }, { method: "commit", args: [template, "b1"] }]);
		expect(core.template.blocks[0]?.block.title).toBe("Task!"); expect(tsp.node("b1.title.heading").p?.text).toBe("Task!");
	});
	test("stale edits drop without writing and expose the exact notice", async () => {
		const { core, tsp } = await fixture(); tsp.click("b1.title.pencil"); await tick(); tsp.keys("new");
		tsp.event({ ev: "edit", id: "b1.title", from: 0, to: 4, text: "stale", cursor: 5, len: 4 });
		expect(core.calls.filter(call => call.method === "setDraft")).toHaveLength(1); expect(tsp.node("b1.title.notice").p?.text).toBe("一次输入因文本已变化未应用"); expect(tsp.node("b1.title").p?.text).toBe("Tasknew");
	});
	test("an edit arriving after Esc committed the field is not silently lost", async () => {
		const { core, tsp } = await fixture(); tsp.click("b1.title.pencil"); await tick();
		tsp.keys("\x1b"); await tick();
		tsp.event({ ev: "edit", id: "b1.title", from: 0, to: 4, text: "replacement", cursor: 11, len: 4 }); await tick();
		expect(core.calls.filter(call => call.method === "setDraft")).toHaveLength(0);
		expect(tsp.node("b1.title.notice").p?.text).toBe("一次输入因文本已变化未应用");
	});
	test("keys, paste, Unicode deletion, caret-only edit and undo", async () => {
		const { core, tsp } = await fixture(); tsp.click("b1.title.pencil"); await tick();
		tsp.keys("😀"); tsp.keys("\x7f"); tsp.keys("\x1b[200~ pasted\x1b[201~");
		tsp.event({ ev: "edit", id: "b1.title", from: 0, to: 0, text: "", cursor: 0, len: 11 });
		expect(core.calls.filter(call => call.method === "setDraft")).toHaveLength(3);
		tsp.event({ ev: "undo", id: "b1.title" }); expect(core.calls.at(-1)?.args.at(-1)).toBe("Task");
		tsp.click("b1.title.commit"); expect(core.calls.at(-1)?.method).toBe("commit");
	});
	test("text keys arriving after Esc committed the field are not silently lost", async () => {
		const { core, tsp } = await fixture(); tsp.click("b1.body.pencil"); await tick();
		tsp.keys("\x1b"); await tick();
		tsp.keys("late text"); await tick();
		expect(core.calls.filter(call => call.method === "setDraft")).toHaveLength(0);
		expect(tsp.node("b1.body.notice").p?.text).toBe("一次输入因文本已变化未应用");
	});
	test("navigation keys after a commit change no text and show nothing", async () => {
		const { tsp } = await fixture(); tsp.click("b1.body.pencil"); await tick();
		tsp.keys("\x1b"); await tick(); tsp.keys("\x1b[D"); await tick();
		expect(() => tsp.node("b1.body.notice")).toThrow("Missing b1.body.notice");
	});
	test("coalesced pty reads and split paste preserve text before Esc, including kitty keys", async () => {
		const { core, tsp } = await fixture(); tsp.click("b1.title.pencil"); await tick();
		tsp.keys("\x1b[200~pa"); tsp.keys("ste\x1b[201~");
		tsp.keys("\x1b[33u"); tsp.keys(" end\x1b"); await tick();
		expect(core.template.blocks[0]?.block.title).toBe("Taskpaste! end");
		expect(core.calls.at(-1)?.method).toBe("commit");
	});
	test("editor ancestors have no click and other pencils/locked controls are unavailable", async () => {
		const { core, tsp } = await fixture(); tsp.click("b1.body.pencil"); await tick();
		function inspect(node: TspNode, parents: readonly TspNode[]): void { if (node.id === "b1.body") { expect(node.k).toBe("editor"); for (const ancestor of parents) expect(ancestor.p?.actions).toBeUndefined(); } node.c?.forEach(child => inspect(child, [...parents, node])); }
		inspect(tsp.root!, []); expect(tsp.node("b1.done").p?.disabled).toBe(true);
		tsp.click("nav.b2"); expect(tsp.node("b2.title.pencil").p?.actions).toBeUndefined(); tsp.click("nav.b1");
		expect(core.statuses.filter(entry => entry.block === "b1").at(-1)?.status.chartNodes).toBe(1);
		expect(core.statuses.filter(entry => entry.block === "b1").at(-1)?.status.view.images).toHaveLength(1);
		core.template = { ...core.template, blocks: [item("b1"), { ...item("b2"), lock: { kind: "coordinator", request: "request" } }] }; core.listener(template); await tick();
		tsp.click("nav.b2"); tsp.click("b2.interrupt"); expect(core.calls.at(-1)).toEqual({ method: "interrupt", args: [template, "b2"] }); expect(tsp.node("b2.delete").p?.actions).toBeUndefined();
	});
	test("block actions ignore selection and selection actions use document order", async () => {
		const { core, tsp } = await fixture();
		tsp.event({ ev: "change", id: "b1.done", checked: true }); tsp.click("block.insert.task"); tsp.click("block.insert.design"); tsp.click("b1.delete"); tsp.click("b1.delete.yes"); tsp.click("b1.reference.0.refetch"); tsp.click("b1.preview"); await tick();
		expect(core.calls.filter(call => call.method !== "revisions")).toEqual([{ method: "setDone", args: [template, "b1", true] }, { method: "insertBlock", args: [template, "b1", "task"] }, { method: "insertBlock", args: [template, "b1", "design"] }, { method: "deleteBlock", args: [template, "b1"] }, { method: "refetch", args: [template, "file:context.md"] }, { method: "preview", args: [template, ["b1"]] }]);
		expect(tsp.node("b1.compiled.text").p?.text).toBe("Compiled text"); expect(tsp.node("b1.compiled.length").p?.text).toBe("13 字符");
		core.run = { ...core.run, blocks: [...core.run.blocks, item("b3", "Third")] };
		tsp.selectTab("r1");
		tsp.event({ ev: "change", id: "b2.selected", checked: true }); tsp.event({ ev: "change", id: "b1.selected", checked: true });
		tsp.click("nav.b3"); tsp.click("b3.launch"); tsp.click("b3.check"); tsp.click("b3.preview"); await tick();
		expect(core.calls.filter(call => ["requestLaunch", "requestCheck", "preview"].includes(call.method)).slice(-3)).toEqual([
			{ method: "requestLaunch", args: ["r1", ["b3"]] },
			{ method: "requestCheck", args: [runRef, ["b3"]] },
			{ method: "preview", args: [runRef, ["b3"]] },
		]);
		tsp.click("selection.launch"); tsp.click("selection.check"); tsp.click("selection.preview"); await tick();
		expect(core.calls.filter(call => ["requestLaunch", "requestCheck", "preview"].includes(call.method)).slice(-3)).toEqual([
			{ method: "requestLaunch", args: ["r1", ["b1", "b2"]] },
			{ method: "requestCheck", args: [runRef, ["b1", "b2"]] },
			{ method: "preview", args: [runRef, ["b1", "b2"]] },
		]);
		expect(tsp.node("selection.preview.text").p?.text).toBe("Compiled text");
		expect(descendants(tsp.root!).filter(node => /^b\d+\.card$/.test(node.id))).toEqual([]);
		expect(tsp.frames.at(-1)?.blocks).toEqual([]);
		tsp.click("nav.b1"); tsp.click("b1.launch.l1.close");
		expect(core.calls.at(-1)).toEqual({ method: "closeLaunch", args: ["l1"] });
	});
	test("Run forms, update reminder, timeline quotes, filter and full Launch record", async () => {
		const { core, tsp } = await fixture(); tsp.event({ ev: "focus", id: "run.name" }); tsp.keys("Incident"); tsp.event({ ev: "focus", id: "run.every" }); tsp.keys("60"); tsp.click("run.start"); expect(core.calls.at(-1)).toEqual({ method: "startRun", args: ["Incident", 60] });
		tsp.selectTab("r1"); tsp.click("nav.activity"); expect(tsp.node("run.due.time").p?.text).toContain("状态更新已到期"); expect(tsp.node("timeline.2.record.quote").p?.text).toBe("取自会话 session-a 的消息 message-a");
		tsp.event({ ev: "change", id: "run.snooze.duration.300", checked: true }); tsp.click("run.snooze"); expect(core.calls.at(-1)).toEqual({ method: "snooze", args: ["r1", 300] });
		tsp.event({ ev: "change", id: "post.block.b1", checked: true }); tsp.event({ ev: "focus", id: "post.text" }); tsp.keys("Status"); tsp.event({ ev: "focus", id: "post.next" }); tsp.keys("120"); tsp.click("post.submit"); expect(core.calls.at(-1)).toEqual({ method: "post", args: ["r1", "update", "Status", "b1", 120] });
		tsp.click("timeline.1.launch"); expect(core.calls.at(-1)?.method).toBe("launchInfo"); expect(tsp.node("launch-info.l1.text").p?.text).toContain("Complete snapshot");
		tsp.event({ ev: "change", id: "timeline.filter.post", checked: true }); expect(() => tsp.node("timeline.1")).toThrow(); expect(tsp.node("timeline.2")).toBeDefined(); tsp.click("run.finish"); expect(core.calls.at(-1)?.method).toBe("finishRun");
	});
	test("finished Run defaults to retrospective, disables mutation but keeps records enabled", async () => {
		const { core, tsp } = await fixture(); core.run = { ...core.run, run: { ...core.run.run!, status: "finished", finishedAt: 3000, updateDue: null } }; tsp.selectTab("r1");
		expect(tsp.node("b1.title.pencil").p?.actions).toBeUndefined(); expect(tsp.node("b1.done").p?.disabled).toBe(true); expect(tsp.node("block.insert.task").p?.actions).toBeUndefined(); expect(tsp.node("b1.launch").p?.actions).toBeUndefined();
		tsp.click("nav.activity"); expect(tsp.node("post.kind.retrospective").p?.checked).toBe(true);
		tsp.click("post.submit"); expect(core.calls.at(-1)).toEqual({ method: "post", args: ["r1", "retrospective", "", null, null] });
	});
	test("mixed orchestration selection cannot launch", async () => {
		const { core, tsp } = await fixture(); core.run = { ...core.run, blocks: [item(), item("b2", "```js\nawait agent('work')\n```")] }; tsp.selectTab("r1"); tsp.event({ ev: "change", id: "b1.selected", checked: true }); tsp.event({ ev: "change", id: "b2.selected", checked: true });
		expect(tsp.node("selection.launch").p?.actions).toBeUndefined(); tsp.click("selection.launch");
		expect(core.calls.filter(call => call.method === "requestLaunch")).toEqual([]);
		tsp.event({ ev: "change", id: "b1.selected", checked: false }); tsp.click("selection.launch");
		expect(core.calls.filter(call => call.method === "requestLaunch")).toEqual([{ method: "requestLaunch", args: ["r1", ["b2"]] }]);
	});
	test("coordinator focus, graph blobs before frames, stable expansion keys and render status", async () => {
		const { core, tsp } = await fixture(); expect(tsp.order.indexOf("frame")).toBeGreaterThan(tsp.order.findIndex(value => value.startsWith("blob:"))); expect(tsp.node("b1.reference.0.body").p).toMatchObject({ collapsed: true, collapsible: true, key: "0:((file:context.md))" });
		expect(tsp.order.some(value => value.startsWith("blob:"))).toBe(true);
		expect(core.statuses.find(entry => entry.block === "b1")?.status.chartNodes).toBe(1); expect(core.statuses.find(entry => entry.block === "b1")?.status.view.images).toHaveLength(1);
		tsp.facts = { blockError: true, documentError: false, pendingOverdue: true }; tsp.statusListener(["b1"]); expect(core.statuses.filter(entry => entry.block === "b1").at(-1)?.status).toMatchObject({ blockError: true, pendingOverdue: true, chartNodes: 1 });
		core.connected = true; core.listener(null); await tick(); tsp.click("coordinator.focus"); await tick(); expect(core.calls.filter(call => call.method !== "revisions").map(call => call.method)).toEqual(["focusCoordinator"]);
		const beforeTheme = tsp.order.filter(value => value.startsWith("blob:")).at(-1);
		const themed = tsp.nextFrame(); tsp.event({ ev: "theme", dark: false }); await themed;
		expect(tsp.order.filter(value => value.startsWith("blob:")).at(-1)).not.toBe(beforeTheme);
		tsp.event({ ev: "error", msg: "Rejected SVG" }); expect(tsp.node("error.0").p?.text).toBe("Rejected SVG");
	});
	test("design cards render real components and a Markdown table, with only the requirement human-editable", async () => {
		const core = new FakeCore();
		core.template = { ...core.template, blocks: [designItem()] };
		const { tsp } = await fixture(core);
		expect(tsp.node("b1.requirement.view")).toMatchObject({ k: "md", p: { text: requirement } });
		expect(tsp.node("b1.requirement.pencil").p?.actions).toEqual({ click: "invoke" });
		expect(() => tsp.node("b1.design.pencil")).toThrow();
		expect(() => tsp.node("b1.body.pencil")).toThrow();
		const nodes = descendants(tsp.node("b1.design"));
		expect(nodes.find(node => node.p?.class === "am-kv am-kv-2")).toMatchObject({ k: "el", p: { tag: "div" } });
		expect(nodes.find(node => node.p?.class === "am-kv-key")?.p?.text).toBe("Owner");
		expect(nodes.find(node => node.p?.class === "am-callout-title")?.p?.text).toBe("Review");
		expect(nodes.find(node => node.k === "md" && node.p?.text === "Keep writes atomic.")).toBeDefined();
		const table = nodes.find(node => node.k === "table");
		expect(table).toBeDefined();
		expect(JSON.stringify(table?.p)).toContain("Journal");
		expect(JSON.stringify(table?.p)).toContain("Durable");
		expect(core.statuses.at(-1)?.status).toMatchObject({ draftErrors: 0, chartNodes: 0 });

		tsp.click("b1.requirement.pencil"); await tick();
		expect(core.calls).toContainEqual({ method: "pencil", args: [template, "b1", "requirement"] });
		expect(tsp.node("b1.requirement")).toMatchObject({ k: "editor", p: { text: requirement } });
		tsp.keys(" Also retain history.");
		tsp.click("b1.requirement.commit"); await tick();
		expect(core.calls.filter(call => call.method !== "revisions")).toEqual([
			{ method: "pencil", args: [template, "b1", "requirement"] },
			{ method: "setDraft", args: [template, "b1", `${requirement} Also retain history.`] },
			{ method: "commit", args: [template, "b1"] },
		]);
		expect(core.template.blocks[0]?.block.content).toEqual({ kind: "design", requirement: `${requirement} Also retain history.`, design });
		expect(tsp.node("b1.requirement.view").p?.text).toBe(`${requirement} Also retain history.`);
	});
	test("design checks keep the changes view while a marked flow is drawn in the before view", async () => {
		const core = new FakeCore();
		const draft = "## A Flow\n\nFlow context.\n\n```flow\nHub\n- Removed\n+ Added\n```\n";
		core.template = { ...core.template, blocks: [designItem("b1", draft)] };
		const { tsp } = await fixture(core);
		const imageId = "b1.design.view.p0.1.diagram";
		const changesImage = tsp.node(imageId);
		expect(changesImage.p?.alt).toBe("Hub、Removed、Added");
		const changesStatus = core.statuses.at(-1)!;
		expect(changesStatus).toMatchObject({ ref: template, block: "b1", status: { draftErrors: 0 } });
		const checked = { md: [...changesStatus.status.view.md], images: [...changesStatus.status.view.images] };
		expect(checked.md).toContain("\nFlow context.\n");
		expect(checked.images).toEqual(["Hub、Removed、Added"]);
		const statusCount = core.statuses.length;
		expect(tsp.node("b1.design.view.p0.1.view.before.text").p?.text).toBe("之前");

		tsp.event({ ev: "change", id: "b1.design.view.p0.1.view.before", checked: true }); await tick();

		expect(tsp.node("b1.design.view.p0.1.view.before").p?.checked).toBe(true);
		const beforeImage = tsp.node(imageId);
		expect(beforeImage.p?.alt).toBe("Hub、Removed");
		expect(beforeImage.p?.blob).not.toBe(changesImage.p?.blob);
		expect(core.statuses.length).toBeGreaterThan(statusCount);
		expect(core.statuses.at(-1)).toMatchObject({ ref: template, block: "b1", status: { view: checked } });
	});
	test("an unclosed design fence shows line diagnostics and reports draftErrors through render status", async () => {
		const core = new FakeCore();
		core.template = { ...core.template, blocks: [designItem("b1", "## A Broken\n\n```callout info Review\nKeep writes atomic.")] };
		const { tsp } = await fixture(core);
		expect(tsp.node("b1.diagnostics")).toMatchObject({ k: "el", p: { tag: "div", class: "pb-panel" } });
		expect(tsp.node("b1.diagnostic.0").p?.tone).toBe("error");
		expect(tsp.node("b1.diagnostic.0").p?.text).toContain("第 3 行");
		expect(tsp.node("b1.diagnostic.0").p?.text).toContain("draft");
		expect(core.statuses.at(-1)).toMatchObject({ ref: template, block: "b1", status: { draftErrors: 1, chartNodes: 0 } });
		tsp.facts = { blockError: false, documentError: false, pendingOverdue: true };
		tsp.statusListener(["b1"]);
		expect(core.statuses.at(-1)?.status).toMatchObject({ draftErrors: 1, pendingOverdue: true });
		core.change(template, "b1", () => designItem());
		core.listener(template); await tick();
		expect(() => tsp.node("b1.diagnostics")).toThrow();
		expect(core.statuses.at(-1)?.status.draftErrors).toBe(0);
	});
	test.each(["submit", "discard"] as const)("prompt %s is an explicit Core action, never a direct design edit", async action => {
		const core = new FakeCore();
		core.connected = true;
		core.template = { ...core.template, blocks: [designItem()] };
		const { tsp } = await fixture(core);
		expect(tsp.node("b1.prompt.pencil").p?.actions).toEqual({ click: "invoke" });
		tsp.click("b1.prompt.pencil"); await tick();
		expect(tsp.node("b1.prompt")).toMatchObject({ k: "editor", p: { text: "" } });
		expect(tsp.node("b1.prompt.submit").p?.actions).toEqual({ click: "invoke" });
		expect(tsp.node("b1.prompt.discard").p?.actions).toEqual({ click: "invoke" });
		tsp.keys("Explain failure recovery.");
		expect(core.template.blocks[0]?.lock).toEqual({ kind: "human", field: "prompt", draft: "Explain failure recovery." });
		tsp.click(`b1.prompt.${action}`); await tick();
		expect(core.calls.filter(call => call.method !== "revisions")).toEqual([
			{ method: "pencil", args: [template, "b1", "prompt"] },
			{ method: "setDraft", args: [template, "b1", "Explain failure recovery."] },
			{ method: action === "submit" ? "commit" : "discard", args: [template, "b1"] },
		]);
		expect(core.template.blocks[0]?.block.content).toEqual({ kind: "design", requirement, design });
		expect(core.template.blocks[0]?.lock).toEqual({ kind: "none" });
		expect(() => tsp.node("b1.prompt")).toThrow();
		expect(tsp.node("b1.prompt.pencil").p?.actions).toEqual({ click: "invoke" });
	});
	test("an edit arriving after a prompt was submitted shows the late-input notice without writing", async () => {
		const core = new FakeCore();
		core.connected = true;
		core.template = { ...core.template, blocks: [designItem()] };
		const { tsp } = await fixture(core);
		const prompt = "Explain failure recovery.";
		tsp.click("b1.prompt.pencil"); await tick();
		tsp.keys(prompt);
		tsp.click("b1.prompt.submit"); await tick();
		expect(core.template.blocks[0]?.lock).toEqual({ kind: "none" });
		expect(core.template.blocks[0]?.block.content).toEqual({ kind: "design", requirement, design });
		expect(() => tsp.node("b1.prompt")).toThrow("Missing b1.prompt");
		const writes = core.calls.filter(call => call.method === "setDraft");
		const commits = core.calls.filter(call => call.method === "commit");
		expect(writes).toEqual([{ method: "setDraft", args: [template, "b1", prompt] }]);
		expect(commits).toEqual([{ method: "commit", args: [template, "b1"] }]);

		tsp.event({ ev: "edit", id: "b1.prompt", from: prompt.length, to: prompt.length, text: " late", cursor: prompt.length + 5, len: prompt.length }); await tick();

		expect(tsp.node("b1.prompt.notice").p?.text).toBe("一次输入因文本已变化未应用");
		expect(core.calls.filter(call => call.method === "setDraft")).toEqual(writes);
		expect(core.calls.filter(call => call.method === "commit")).toEqual(commits);
		expect(core.template.blocks[0]?.lock).toEqual({ kind: "none" });
		expect(() => tsp.node("b1.prompt")).toThrow("Missing b1.prompt");
	});
	test("Esc retains a prompt draft and does not submit or discard it", async () => {
		const core = new FakeCore();
		core.template = { ...core.template, blocks: [designItem()] };
		const { tsp } = await fixture(core);
		tsp.click("b1.prompt.pencil"); await tick();
		tsp.keys("Keep this request");
		tsp.keys("\x1b"); tsp.keys("\x1b[27u"); await tick();
		expect(core.calls.filter(call => call.method !== "revisions")).toEqual([
			{ method: "pencil", args: [template, "b1", "prompt"] },
			{ method: "setDraft", args: [template, "b1", "Keep this request"] },
		]);
		expect(core.template.blocks[0]?.lock).toEqual({ kind: "human", field: "prompt", draft: "Keep this request" });
		expect(tsp.node("b1.prompt").k).toBe("editor");
		tsp.keys(" for review.");
		expect(core.template.blocks[0]?.lock).toEqual({ kind: "human", field: "prompt", draft: "Keep this request for review." });
	});
	test("revision history comes from Core, stays block-scoped and preserves newlines", async () => {
		const core = new FakeCore();
		core.run = { ...core.run, blocks: [designItem()] };
		core.history = [
			{ seq: 2, at: 1000, block: "b1", prompt: "Include recovery steps.\nKeep blank lines.\n\nDo not flatten." },
			{ seq: 4, at: 2000, block: "b1", prompt: "Explain retention." },
			{ seq: 5, at: 3000, block: "b2", prompt: "Different block." },
		];
		const { tsp } = await fixture(core);
		tsp.selectTab("r1");
		expect(core.revisionReads).toContainEqual({ ref: runRef, block: "b1" });
		expect(tsp.node("b1.revision.2.text")).toMatchObject({ k: "el", p: { tag: "div", text: core.history[0]!.prompt } });
		expect(tsp.node("b1.revision.4.text").p?.text).toBe("Explain retention.");
		expect(tsp.node("b1.revision.2.meta").p?.text).toContain("#2");
		expect(tsp.node("b1.revision.4.meta").p?.text).toContain("1970-01-01 00:00:02");
		expect(() => tsp.node("b1.revision.5.text")).toThrow();
	});
	test("design selections cannot launch but do not disable a task's own launch", async () => {
		const core = new FakeCore();
		core.run = { ...core.run, blocks: [item(), designItem("b2")] };
		const { tsp } = await fixture(core);
		tsp.selectTab("r1");
		tsp.event({ ev: "change", id: "b1.selected", checked: true });
		tsp.event({ ev: "change", id: "b2.selected", checked: true });
		expect(tsp.node("selection.launch").p?.actions).toBeUndefined();
		tsp.click("selection.launch");
		expect(core.calls.filter(call => call.method === "requestLaunch")).toHaveLength(0);
		expect(tsp.node("b1.launch").p?.actions).toEqual({ click: "invoke" });
		tsp.click("b1.launch");
		expect(core.calls.filter(call => call.method === "requestLaunch")).toEqual([{ method: "requestLaunch", args: ["r1", ["b1"]] }]);
		tsp.click("nav.b2"); expect(() => tsp.node("b2.launch")).toThrow();
	});
});

const askDesign = "## A Cache\n\n```ask\nWhich cache?\n* Redis | keeps data\n- Memcached | no disk\n```\n";
function choice(tsp: FakeTsp, index: number): TspNode {
	return tsp.node(`b1.design.view.p0.0.choice.${index}`);
}
async function realCore(design: string, coordinator: boolean) {
	const directory = mkdtempSync("/tmp/tern-ui-ask-");
	const store = createStore(join(directory, "playbook.yaml"));
	store.write(template, store.serialize({ title: "Ask", blocks: [{ id: "b1", title: "Cache design", done: false, content: { kind: "design", requirement: "Pick a cache.", design } }] }, null));
	const core = new Core({ store, references, checks, fetcher: { async fetch() { throw new Error("no external targets"); } }, panes: { ownPane: () => null, async focusPane() { return { ok: true }; } } });
	expect(core.load()).toBeNull();
	const events: EventPayload[] = [];
	if (coordinator) {
		const conn = { id: 1, send: (event: EventPayload) => { events.push(event); }, close() {} };
		core.connected(conn);
		expect((await core.handle(conn, "hello", { op: "hello", args: { session: "ask-session" } })).ok).toBe(true);
	}
	const tsp = new FakeTsp();
	startUi(core, tsp, directory);
	const ready = tsp.nextFrame(); tsp.input({ kind: "hello", dark: true }); await ready;
	return { core, store, tsp, events, stop: () => { core.stop(); rmSync(directory, { recursive: true, force: true }); } };
}

describe("ask drafts, navigator and execution contract", () => {
	test("navigator mounts one block, preserves its draft across navigation and reports exact per-block summaries", async () => {
		const core = new FakeCore();
		core.template = { ...core.template, blocks: [
			{ ...item("b1", "First body."), references: [] },
			designItem("b2", "Second body."),
		] };
		const tsp = new FakeTsp();
		const lastFrameFacts = { blockError: true, documentError: false, pendingOverdue: true };
		tsp.blockFacts.set("b2", lastFrameFacts);
		await fixture(core, tsp);
		const cards = () => descendants(tsp.root!).filter(node => /^b\d+\.card$/.test(node.id)).map(node => node.id);
		const summary = (block: BlockId) => core.statuses.filter(entry => entry.block === block).at(-1)?.status;
		expect(cards()).toEqual(["b1.card"]);
		expect(tsp.frames.at(-1)?.blocks).toEqual(["b1"]);
		expect(summary("b1")).toEqual({ ...tsp.facts, chartNodes: 0, draftErrors: 0, view: { md: ["Task", "First body."], images: [] } });
		expect(summary("b2")).toEqual({ ...lastFrameFacts, chartNodes: 0, draftErrors: 0, view: { md: ["Storage design", requirement, "Second body."], images: [] } });
		const before = summary("b2");
		tsp.click("b1.body.pencil"); await tick(); tsp.keys(" More.");
		const draft = core.template.blocks[0]!.lock;
		tsp.click("nav.b2");
		expect(cards()).toEqual(["b2.card"]);
		expect(tsp.frames.at(-1)?.blocks).toEqual(["b2"]);
		expect(tsp.frames.at(-1)?.ops.at(-1)).toEqual(["focus", null]);
		expect(core.template.blocks[0]!.lock).toEqual(draft);
		expect(() => tsp.node("b1.body")).toThrow();
		tsp.click("nav.b1");
		expect(tsp.node("b1.body")).toMatchObject({ k: "editor", p: { text: "First body. More." } });
		const at = core.statuses.length;
		const frameAt = tsp.frames.length;
		core.listener(template); await tick();
		expect(tsp.frames.slice(frameAt).every(frame => frame.blocks.length === 1 && frame.blocks[0] === "b1")).toBe(true);
		expect(core.statuses.slice(at).map(entry => entry.block)).toEqual(["b1", "b2"]);
		expect(summary("b2")).toEqual(before);
		core.change(template, "b2", value => ({ ...value, block: { ...value.block, title: "Updated while unmounted" } }));
		core.listener(template); await tick();
		expect(summary("b2")).toEqual({ ...lastFrameFacts, chartNodes: 0, draftErrors: 0, view: { md: ["Updated while unmounted", requirement, "Second body."], images: [] } });
		expect(cards()).toEqual(["b1.card"]);
		expect(tsp.frames.at(-1)?.blocks).toEqual(["b1"]);
	});

	test("pins are read-only, survive navigation, and local references and cited rows navigate correctly", async () => {
		const core = new FakeCore();
		const citingTask = (id: BlockId): BlockView => {
			const value = item(id, "Use ((b1)).");
			return { ...value, references: [{
				...value.references[0]!, external: false,
				reference: { text: "((b1))", targetText: "b1", expressionText: null, offset: 4 },
				expansion: { kind: "Ok", text: requirement, sources: [] },
			}] };
		};
		core.template = { ...core.template, blocks: [designItem("b1", askDesign), citingTask("b2"), citingTask("b3")] };
		const { tsp } = await fixture(core);
		expect(tsp.node("b1.cited.0").p?.actions).toEqual({ click: "invoke" });
		expect(tsp.node("b1.cited.1").p?.actions).toEqual({ click: "invoke" });
		tsp.click("b1.pin"); tsp.click("nav.b2");
		const reference = tsp.node("pin.b1");
		expect(descendants(reference).some(node => node.k === "editor" || node.k === "input" || node.p?.tag === "input")).toBe(false);
		expect(descendants(reference).filter(node => node.p?.actions).map(node => node.id)).toEqual(["pin.b1.open", "pin.b1.unpin"]);
		expect(tsp.node("b2.card").c!.findIndex(node => node.id === "pin.b1")).toBeLessThan(tsp.node("b2.card").c!.findIndex(node => node.id === "b2.body.panel"));
		tsp.click("nav.b3"); expect(tsp.node("pin.b1")).toBeDefined();
		tsp.click("pin.b1.unpin"); expect(() => tsp.node("pin.b1")).toThrow();
		tsp.click("nav.b2"); tsp.click("b2.reference.0.pin"); expect(tsp.node("pin.b1")).toBeDefined();
		tsp.click("b2.body.pencil"); await tick(); tsp.keys(" More context."); tsp.click("b2.body.commit"); await tick();
		expect(core.template.blocks[1]!.block.content).toEqual({ kind: "task", body: "Use ((b1)). More context." });
		expect(core.template.blocks[0]!.block.content).toEqual(designItem("b1", askDesign).block.content);
		tsp.click("pin.b1.open"); expect(tsp.node("b1.card")).toBeDefined();
		tsp.click("b1.cited.1"); expect(tsp.node("b3.card")).toBeDefined(); expect(tsp.node("pin.b1")).toBeDefined();
		tsp.click("nav.b1"); tsp.click("b1.pin"); tsp.click("nav.b2"); expect(() => tsp.node("pin.b1")).toThrow();
	});

	test("ask starts unchecked, replaces its draft answer and submits two answers and free text once", async () => {
		const second = "\n```ask\nWhich policy?\n* LRU\n- FIFO\n```\n";
		const f = await realCore(askDesign + second, true);
		try {
			expect([0, 1].map(index => choice(f.tsp, index).p?.checked)).toEqual([false, false]);
			expect(f.tsp.node("b1.design.view.p0.1.choice.0").p?.checked).toBe(false);
			expect(f.tsp.node("b1.design.view.p0.1.choice.1").p?.checked).toBe(false);
			expect(choice(f.tsp, 0).p).toMatchObject({ tag: "input", type: "radio", value: "Redis" });
			f.tsp.event({ ev: "change", id: "b1.design.view.p0.0.choice.0", checked: true }); await tick();
			expect(f.core.view(template).blocks[0]!.lock).toEqual({ kind: "human", field: "prompt", draft: "针对问题「Which cache?」，选择：Redis" });
			f.tsp.keys("\nKeep writes durable.");
			f.tsp.event({ ev: "change", id: "b1.design.view.p0.0.choice.1", checked: true }); await tick();
			expect(choice(f.tsp, 0).p?.checked).toBe(false);
			expect(choice(f.tsp, 1).p?.checked).toBe(true);
			expect(choice(f.tsp, 1).p?.disabled).toBe(false);
			f.tsp.event({ ev: "change", id: "b1.design.view.p0.1.choice.1", checked: true }); await tick();
			const prompt = "针对问题「Which cache?」，选择：Memcached\nKeep writes durable.\n针对问题「Which policy?」，选择：FIFO";
			expect(f.core.view(template).blocks[0]!.lock).toEqual({ kind: "human", field: "prompt", draft: prompt });
			expect(f.store.readRevisions(template)).toEqual([]);
			expect(f.events).toEqual([]);
			f.tsp.click("b1.prompt.submit"); await tick();
			expect(f.store.readRevisions(template).map(revision => revision.prompt)).toEqual([prompt]);
			expect(f.events).toEqual([{ event: "revision_requested", data: { block: "b1", revision: 1 } }]);
			expect(f.core.view(template).blocks[0]!.lock).toEqual({ kind: "none" });
			expect(f.tsp.node("b1.revision.1.text")).toMatchObject({ k: "el", p: { tag: "div", text: prompt } });
		} finally { f.stop(); }
	});

	test("without a coordinator the refused choice stays in the block's prompt draft and the error is shown", async () => {
		const f = await realCore(askDesign, false);
		try {
			f.tsp.event({ ev: "change", id: "b1.design.view.p0.0.choice.0", checked: true }); await tick();
			f.tsp.click("b1.prompt.submit"); await tick();
			expect(f.store.readRevisions(template)).toEqual([]);
			expect(f.core.view(template).blocks[0]!.lock).toEqual({ kind: "human", field: "prompt", draft: "针对问题「Which cache?」，选择：Redis" });
			expect(f.tsp.node("b1.prompt").p?.text).toBe("针对问题「Which cache?」，选择：Redis");
			expect(f.tsp.node("error.0").p?.text).toContain("没有协调者连接");
			expect(choice(f.tsp, 0).p?.disabled).toBe(false);
		} finally { f.stop(); }
	});

	test("multi answers use option order and removing the last answer keeps free text without committing", async () => {
		const multi = "## A Cache\n\n```ask multi\nWhich stores?\n* Redis\n* Postgres\n- Memcached\n```\n";
		const f = await realCore(multi, true);
		try {
			expect([0, 1, 2].map(index => choice(f.tsp, index).p?.checked)).toEqual([false, false, false]);
			expect(choice(f.tsp, 0).p?.type).toBe("checkbox");
			f.tsp.click("b1.prompt.pencil"); await tick(); f.tsp.keys("Keep this explanation.\n\nAnd this paragraph.");
			f.tsp.event({ ev: "change", id: "b1.design.view.p0.0.choice.2", checked: true });
			f.tsp.event({ ev: "change", id: "b1.design.view.p0.0.choice.0", checked: true }); await tick();
			expect(f.core.view(template).blocks[0]!.lock).toEqual({ kind: "human", field: "prompt", draft: "Keep this explanation.\n\nAnd this paragraph.\n针对问题「Which stores?」，选择：Redis、Memcached" });
			f.tsp.event({ ev: "change", id: "b1.design.view.p0.0.choice.2", checked: false });
			f.tsp.event({ ev: "change", id: "b1.design.view.p0.0.choice.0", checked: false }); await tick();
			expect(f.core.view(template).blocks[0]!.lock).toEqual({ kind: "human", field: "prompt", draft: "Keep this explanation.\n\nAnd this paragraph." });
			expect([0, 1, 2].map(index => choice(f.tsp, index).p?.checked)).toEqual([false, false, false]);
			expect(f.store.readRevisions(template)).toEqual([]);
			expect(f.events).toEqual([]);
		} finally { f.stop(); }
	});

	test("ask controls are unavailable while the block is locked, another draft exists, or the Run has finished", async () => {
		const core = new FakeCore();
		core.template = { ...core.template, blocks: [{ ...designItem("b1", askDesign), lock: { kind: "coordinator", request: "q1" } }] };
		core.run = { ...core.run, run: { ...core.run.run!, status: "finished", finishedAt: 3000, updateDue: null }, blocks: [designItem("b1", askDesign)] };
		const { tsp } = await fixture(core);
		expect(choice(tsp, 0).p?.disabled).toBe(true);
		tsp.event({ ev: "change", id: "b1.design.view.p0.0.choice.0", checked: true });
		expect(core.calls.filter(call => call.method === "pencil")).toEqual([]);
		core.template = { ...core.template, blocks: [designItem("b1", askDesign), { ...item("b2"), lock: { kind: "human", field: "body", draft: "Other draft" } }] };
		core.listener(template); await tick();
		expect(choice(tsp, 0).p?.disabled).toBe(true);
		tsp.event({ ev: "change", id: "b1.design.view.p0.0.choice.0", checked: true });
		expect(core.calls.filter(call => call.method === "pencil")).toEqual([]);
		tsp.selectTab("r1");
		expect(choice(tsp, 0).p?.disabled).toBe(true);
		tsp.event({ ev: "change", id: "b1.design.view.p0.0.choice.0", checked: true });
		expect(core.calls.filter(call => call.method === "pencil")).toEqual([]);
	});

	test("a task card's state row shows its execution contract", async () => {
		const core = new FakeCore();
		const configured = item("b1");
		core.template = { ...core.template, blocks: [{ ...configured, block: { ...configured.block, content: { kind: "task", body, agent: "task:mid", isolated: false } } }, item("b2", "Other")] };
		const { tsp } = await fixture(core);
		expect(tsp.node("b1.agent")).toMatchObject({ k: "badge", p: { text: "agent: task:mid" } });
		expect(tsp.node("b1.isolated")).toMatchObject({ k: "badge", p: { text: "isolated: false" } });
		tsp.click("nav.b2");
		expect(() => tsp.node("b2.agent")).toThrow();
		expect(() => tsp.node("b2.isolated")).toThrow();
	});

	test("title, body and requirement editors expose discard buttons that drop drafts without mutating blocks", async () => {
		const core = new FakeCore();
		core.template = { ...core.template, blocks: [item("b1"), designItem("b2")] };
		const { tsp } = await fixture(core);

		tsp.click("b1.title.pencil"); await tick();
		tsp.keys(" discarded");
		tsp.click("b1.title.discard"); await tick();
		expect(core.template.blocks[0]!.block.title).toBe("Task");
		expect(core.template.blocks[0]!.lock).toEqual({ kind: "none" });
		expect(() => tsp.node("b1.title")).toThrow();

		tsp.click("b1.body.pencil"); await tick();
		tsp.keys(" discarded");
		tsp.click("b1.body.discard"); await tick();
		expect(core.template.blocks[0]!.block.content).toEqual({ kind: "task", body });

		tsp.click("nav.b2"); tsp.click("b2.requirement.pencil"); await tick();
		tsp.keys(" discarded");
		tsp.click("b2.requirement.discard"); await tick();
		expect(core.template.blocks[1]!.block.content).toEqual({ kind: "design", requirement, design });
	});

	test("inserting a block and starting a Run with real Core auto-focuses the new block title and switches to the new Run", async () => {
		const f = await realCore(askDesign, true);
		try {
			f.tsp.click("block.insert.task"); await tick();
			expect(f.core.view(template).blocks.map(entry => entry.block.id)).toEqual(["b1", "b2"]);
			expect(f.core.view(template).blocks[1]!.lock).toEqual({ kind: "human", field: "title", draft: "" });
			expect(f.tsp.frames.at(-1)?.ops.at(-1)).toEqual(["focus", "b2.title"]);
			f.tsp.click("b2.title.discard"); await tick();

			f.tsp.event({ ev: "focus", id: "run.name" });
			f.tsp.keys("LiveRun");
			f.tsp.click("run.start"); await tick();
			expect(f.tsp.node("tabs").p?.active).toBe("r1");
			expect(f.tsp.node("heading").p?.text).toBe("LiveRun");
		} finally { f.stop(); }
	});

	test("finishing a Run after picking failure resets the post form to retrospective, and opened Launch details refresh live", async () => {
		const core = new FakeCore();
		let closed = false;
		core.launchInfo = (launch: LaunchId): Launch => ({
			id: launch, run: "r1", session: "session-a", blocks: ["b1"], kind: "prompt",
			snapshot: { result: { kind: "Ok", text: "Complete snapshot", sources: [] }, fetches: [], results: [] },
			agents: ["agent-a"], baselines: ["Baseline"], notified: null, dirty: [], fetches: [],
			closed: closed ? { at: 4000, by: "human" } : null,
		});
		const { tsp } = await fixture(core);
		tsp.selectTab("r1"); tsp.click("nav.activity");
		tsp.click("timeline.1.launch");
		expect(tsp.node("launch-info.l1.text").p?.text).toContain('"closed": null');
		closed = true;
		tsp.click("nav.b1"); tsp.click("b1.launch.l1.close"); tsp.click("nav.activity");
		core.listener(runRef); await tick();
		expect(tsp.node("launch-info.l1.text").p?.text).toContain('"by": "human"');

		tsp.event({ ev: "change", id: "post.kind.failure", checked: true });
		tsp.event({ ev: "change", id: "post.block.b1", checked: true });
		core.run = { ...core.run, run: { ...core.run.run!, status: "finished", finishedAt: 5000, updateDue: null } };
		core.listener(runRef); await tick();
		expect(tsp.node("post.kind.retrospective").p?.checked).toBe(true);
		expect(tsp.node("post.block.none").p?.checked).toBe(true);
		expect(tsp.node("post.submit").p?.text).toBe("写复盘");
		expect(tsp.node("timeline.2.record.content").p?.text).toContain("关联块 b1");
	});

	test("coordinator connection clears disconnected action error while preserving Tern render error", async () => {
		const f = await realCore(askDesign, false);
		try {
			f.tsp.event({ ev: "change", id: "b1.design.view.p0.0.choice.0", checked: true }); await tick();
			f.tsp.click("b1.prompt.submit"); await tick();
			expect(f.tsp.node("error.0").p?.text).toContain("没有协调者连接");
			f.tsp.event({ ev: "error", msg: "Rejected SVG" });
			expect(f.tsp.node("error.0").p?.text).toBe("Rejected SVG");
			expect(f.tsp.node("error.1").p?.text).toContain("没有协调者连接");

			const conn = { id: 2, send() {}, close() {} };
			f.core.connected(conn);
			await f.core.handle(conn, "hello", { op: "hello", args: { session: "reconnected" } });
			await tick();
			expect(f.tsp.node("error.0").p?.text).toBe("Rejected SVG");
			expect(() => f.tsp.node("error.1")).toThrow();

			f.tsp.click("error.dismiss");
			expect(() => f.tsp.node("error.0")).toThrow();
		} finally { f.stop(); }
	});
});
