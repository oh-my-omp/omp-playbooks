import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fieldText, withField, type Block, type BlockContent, type BlockField, type BlockId, type DocRef, type FetchOutcome, type PlaybookDoc, type Revision, type RunId } from "../src/domain/model";
import type { Connection, CoreApi, Fetcher, K1Handler, Store } from "../src/domain/ports";
import type { ErrorCode, EventPayload, Outcome, Request } from "../src/domain/protocol";
import { checks } from "../src/service/checks";
import { Core, type PaneControl } from "../src/service/core";
import { references } from "../src/service/references";
import { createStore } from "../src/service/store";

const template: DocRef = { kind: "template" };
const original: PlaybookDoc = {
	title: "Lock integration",
	blocks: [
		{ id: "b1", title: "First", content: { kind: "task", body: "alpha unique repeated repeated aaa" }, progress: { kind: "tracked", status: "todo", report: null } },
		{ id: "b2", title: "Second", content: { kind: "task", body: "second committed body" }, progress: { kind: "tracked", status: "done", report: null } },
		{ id: "b3", title: "Third", content: { kind: "task", body: "third committed body" }, progress: { kind: "tracked", status: "todo", report: null } },
	],
};

function wire(block: Block) {
	return { id: block.id, title: block.title, ...block.content, status: ((block.progress.kind === "tracked" && block.progress.status === "done") ? "done" : "todo") };
}

const originalWire = { title: original.title, blocks: original.blocks.map(wire) };
const designText = "Introduction.\n\n## A First panel\nshared unique design text\n\n## B Second panel\nuntouched panel\n\n## Unaddressed\nassigned ID only\n";
const designDoc = {
	title: original.title,
	blocks: [
		{ id: "b1", title: "First design", progress: { kind: "tracked", status: "todo", report: null }, content: { kind: "design", requirement: "shared unique human requirement", design: designText } },
		{ id: "b2", title: "Second design", progress: { kind: "tracked", status: "todo", report: null }, content: { kind: "design", requirement: "second requirement", design: "## A Other\nother design" } },
		original.blocks[2]!,
	] satisfies [Block, Block, Block],
} satisfies PlaybookDoc;
const directories: string[] = [];
const activeCores = new Set<Core>();

const panes: PaneControl = {
	ownPane: () => "service-pane",
	async focusPane() { return { ok: true }; },
};

function connection(id: number) {
	const events: EventPayload[] = [];
	const conn: Connection = {
		id,
		send: frame => { events.push(frame); },
		close() {},
	};
	return { conn, events };
}

interface CoreHarness {
	readonly core: Core;
	readonly api: CoreApi;
	readonly handler: K1Handler;
	readonly conn: Connection;
	readonly events: EventPayload[];
	readonly store: Store;
	fetchCount(): number;
	request(request: Request, id?: string): Promise<Outcome<unknown>>;
	stop(): void;
}

function startCore(store: Store, paneControl: PaneControl = panes): CoreHarness {
	let fetchCount = 0;
	const fetched: FetchOutcome = { ok: true, at: 123, value: { kind: "file", text: "fixed external content" } };
	const fetcher: Fetcher = { async fetch() { fetchCount++; return fetched; } };
	const core = new Core({ store, references, checks, fetcher, panes: paneControl, now: () => 123_000 });
	activeCores.add(core);
	expect(core.load()).toBeNull();
	const api: CoreApi = core;
	const handler: K1Handler = core;
	const { conn, events } = connection(1);
	handler.connected(conn);
	let sequence = 0;
	return {
		core, api, handler, conn, events, store,
		fetchCount: () => fetchCount,
		request: (request: Request, id = `request-${++sequence}`) => handler.handle(conn, id, request),
		stop() { core.stop(); activeCores.delete(core); },
	};
}

function fixture(paneControl: PaneControl = panes, doc: PlaybookDoc = original) {
	const directory = mkdtempSync("/tmp/tern-core-locks-");
	directories.push(directory);
	const store = createStore(join(directory, "playbook.yaml"));
	store.write(template, store.serialize(doc, null));
	return startCore(store, paneControl);
}

function expectError(outcome: Outcome<unknown>, code: ErrorCode) {
	expect(outcome).toMatchObject({ ok: false, error: { code } });
}

function persistedTemplate(store: Store): PlaybookDoc {
	const parsed = store.readTemplate();
	expect(parsed.ok).toBe(true);
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.doc;
}

async function hello(h: CoreHarness) {
	expect(await h.request({ op: "hello", args: { session: "session-one", pane: "coordinator-pane" } }, "hello-one")).toEqual({
		ok: true,
		result: { blocks: ["b1", "b2", "b3"], runs: [], pane: "service-pane" },
	});
}

async function run(h: CoreHarness): Promise<{ ref: DocRef; id: RunId }> {
	expect((await h.request({ op: "start_run", args: { name: "Run with locks" } })).ok).toBe(true);
	const id = h.core.runs().at(-1)!.id;
	return { ref: { kind: "run", run: id }, id };
}

function visible(h: CoreHarness, ref: DocRef, id: BlockId) {
	const block = h.api.view(ref).blocks.find(item => item.block.id === id);
	if (!block) throw new Error(`Missing visible block ${id}`);
	return block;
}

afterEach(() => {
	for (const core of activeCores) core.stop();
	activeCores.clear();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("K1 hello and lock ownership", () => {
	test("reveal before hello focuses its own pane without taking the coordinator slot", async () => {
		const focused: string[] = [];
		let ownPaneCalls = 0;
		const paneControl: PaneControl = {
			ownPane() { ownPaneCalls++; return "reveal-pane"; },
			async focusPane(pane) { focused.push(pane); return { ok: true }; },
		};
		const h = fixture(paneControl);
		expect(await h.request({ op: "reveal", args: {} })).toEqual({ ok: true, result: null });
		expect(ownPaneCalls).toBe(1);
		expect(focused).toEqual(["reveal-pane"]);
		expect(h.api.coordinator()).toEqual({ connected: false, session: null, pane: null });
		const second = connection(2);
		h.handler.connected(second.conn);
		expect(await h.handler.handle(second.conn, "hello-two", { op: "hello", args: { session: "session-two", pane: "pane-two" } })).toEqual({
			ok: true,
			result: { blocks: ["b1", "b2", "b3"], runs: [], pane: "reveal-pane" },
		});
		expect(h.api.coordinator()).toEqual({ connected: true, session: "session-two", pane: "pane-two" });
	});

	test("reveal without an own pane returns RevealFailed without attempting focus", async () => {
		const focused: string[] = [];
		let ownPaneCalls = 0;
		const paneControl: PaneControl = {
			ownPane() { ownPaneCalls++; return null; },
			async focusPane(pane) { focused.push(pane); return { ok: true }; },
		};
		const h = fixture(paneControl);
		expect(await h.request({ op: "reveal", args: {} })).toEqual({
			ok: false,
			error: { code: "RevealFailed", message: "文档服务不在 session daemon 托管的 pane 中" },
		});
		expect(ownPaneCalls).toBe(1);
		expect(focused).toEqual([]);
		expect(h.api.coordinator()).toEqual({ connected: false, session: null, pane: null });
	});

	test("reveal propagates focusPane failure as RevealFailed", async () => {
		const focused: string[] = [];
		let ownPaneCalls = 0;
		const paneControl: PaneControl = {
			ownPane() { ownPaneCalls++; return "unfocusable-pane"; },
			async focusPane(pane) { focused.push(pane); return { ok: false, error: "pane focus was rejected" }; },
		};
		const h = fixture(paneControl);
		expect(await h.request({ op: "reveal", args: {} })).toEqual({
			ok: false,
			error: { code: "RevealFailed", message: "pane focus was rejected" },
		});
		expect(ownPaneCalls).toBe(1);
		expect(focused).toEqual(["unfocusable-pane"]);
		expect(h.api.coordinator()).toEqual({ connected: false, session: null, pane: null });
	});

	test("read before hello is NotHello; hello establishes status and allows unlocked reads", async () => {
		const h = fixture();
		expectError(await h.request({ op: "read", args: {} }), "NotHello");
		expect(h.api.coordinator()).toEqual({ connected: false, session: null, pane: null });
		await hello(h);
		expect(h.api.coordinator()).toEqual({ connected: true, session: "session-one", pane: "coordinator-pane" });
		expect(await h.request({ op: "read", args: {} })).toEqual({ ok: true, result: originalWire });
		expect(await h.request({ op: "read", args: { block: "b2" } })).toEqual({ ok: true, result: originalWire.blocks[1] });
		expect(h.fetchCount()).toBe(0);
	});

	test("an idle connection does not block hello, gets Busy after another coordinator joins, and allows replacement after disconnect", async () => {
		const h = fixture();
		expect(h.api.coordinator()).toEqual({ connected: false, session: null, pane: null });
		const second = connection(2);
		h.handler.connected(second.conn);
		expect(await h.handler.handle(second.conn, "hello-two", { op: "hello", args: { session: "session-two", pane: "pane-two" } })).toEqual({
			ok: true,
			result: { blocks: ["b1", "b2", "b3"], runs: [], pane: "service-pane" },
		});
		expect(h.api.coordinator()).toEqual({ connected: true, session: "session-two", pane: "pane-two" });
		expectError(await h.request({ op: "read", args: {} }), "Busy");
		expect(h.api.coordinator()).toEqual({ connected: true, session: "session-two", pane: "pane-two" });
		h.handler.disconnected(second.conn);
		expect(h.api.coordinator()).toEqual({ connected: false, session: null, pane: null });
		const third = connection(3);
		h.handler.connected(third.conn);
		expect(await h.handler.handle(third.conn, "hello-three", { op: "hello", args: { session: "session-three", pane: "pane-three" } })).toEqual({
			ok: true,
			result: { blocks: ["b1", "b2", "b3"], runs: [], pane: "service-pane" },
		});
		expect(h.api.coordinator()).toEqual({ connected: true, session: "session-three", pane: "pane-three" });
	});

	test("unknown blocks and runs return their domain errors without altering the template", async () => {
		const h = fixture();
		await hello(h);
		for (const request of [
			{ op: "read", args: { block: "b999" } },
			{ op: "lock", args: { block: "b999" } },
			{ op: "set", args: { block: "b999", field: "title", value: "missing" } },
			{ op: "edit", args: { block: "b999", find: "x", replace: "y" } },
			{ op: "write", args: { block: "b999", text: "missing" } },
			{ op: "panel", args: { block: "b999", panel: "A", text: "## A Missing" } },
			{ op: "delete", args: { block: "b999" } },
		] satisfies Request[]) expectError(await h.request(request), "UnknownBlock");
		expectError(await h.request({ op: "read", args: { run: "r999" } }), "UnknownRun");
		expectError(await h.request({ op: "lock", args: { run: "r999", block: "b1" } }), "UnknownRun");
		expect(await h.request({ op: "read", args: {} })).toEqual({ ok: true, result: originalWire });
	});
});

describe("K1 insert allocation and deletion lifetime", () => {
	test("insert appends by default, inserts after an anchor, starts unlocked/undone, and never reuses a deleted ID even after restart", async () => {
		const h = fixture();
		await hello(h);
		expect(await h.request({ op: "insert", args: { title: "Allocated", content: { kind: "task", body: "allocated body" } } })).toEqual({ ok: true, result: { block: "b4" } });
		expect(h.api.view(template).blocks.map(item => item.block.id)).toEqual(["b1", "b2", "b3", "b4"]);
		expect(visible(h, template, "b4")).toMatchObject({ block: { id: "b4", title: "Allocated", content: { kind: "task", body: "allocated body" }, progress: { kind: "tracked", status: "todo", report: null } }, launchPending: false });
		await h.request({ op: "lock", args: { block: "b4" } }, "delete-lock");
		expect(await h.request({ op: "delete", args: { block: "b4" } })).toEqual({ ok: true, result: null });
		expect(h.api.view(template).blocks.some(item => item.block.id === "b4")).toBe(false);
		expectError(await h.request({ op: "lock", args: { block: "b4" } }), "UnknownBlock");
		expect(await h.request({ op: "insert", args: { after: "b1", title: "Next", content: { kind: "task", body: "next body" } } })).toEqual({ ok: true, result: { block: "b5" } });
		expect(h.api.view(template).blocks.map(item => item.block.id)).toEqual(["b1", "b5", "b2", "b3"]);
		await h.request({ op: "lock", args: { block: "b5" } }, "delete-next-lock");
		expect(await h.request({ op: "delete", args: { block: "b5" } })).toEqual({ ok: true, result: null });
		h.stop();
		expect(persistedTemplate(h.store)).toEqual(original);
		expect(h.store.readServiceRecords()).toEqual([{ kind: "block", id: "b4" }, { kind: "block", id: "b5" }]);
		const restarted = startCore(h.store);
		await hello(restarted);
		expect(await restarted.request({ op: "insert", args: { title: "Restart allocated", content: { kind: "task", body: "fresh body" } } })).toEqual({ ok: true, result: { block: "b6" } });
		restarted.stop();
		expect(persistedTemplate(h.store).blocks.at(-1)).toEqual({ id: "b6", title: "Restart allocated", content: { kind: "task", body: "fresh body" }, progress: { kind: "tracked", status: "todo", report: null } });
	});
});

describe("Design ownership and coordinator edits", () => {
	for (const inRun of [false, true]) {
		

		test(`insert design initializes an empty human requirement (${inRun ? "Run" : "template"})`, async () => {
			const h = fixture();
			await hello(h);
			const r = inRun ? await run(h) : null;
			const ref = r?.ref ?? template;
			const scope = r ? { run: r.id } : {};
			expect(await h.request({ op: "insert", args: { ...scope, after: "b1", title: "New design", content: { kind: "design", design: "## A Draft\ncoordinator design" } } })).toEqual({ ok: true, result: { block: "b4" } });
			const block: Block = { id: "b4", title: "New design", progress: { kind: "tracked", status: "todo", report: null }, content: { kind: "design", requirement: "", design: "## A Draft\ncoordinator design" } };
			expect(visible(h, ref, "b4")).toMatchObject({ block, launchPending: false });
			expect(h.api.view(ref).blocks.map(item => item.block.id)).toEqual(["b1", "b4", "b2", "b3"]);
			expect(await h.request({ op: "read", args: { ...scope, block: "b4" } })).toEqual({ ok: true, result: wire(block) });
			h.stop();
			const stored = r ? h.store.readRuns().get(r.id) : h.store.readTemplate();
			expect(stored?.ok).toBe(true);
			if (!stored?.ok) throw new Error("Inserted document was not persisted");
			expect(stored.doc.blocks.find(item => item.id === "b4")).toEqual(block);
		});
	}

});

describe("Task execution contract and block moves", () => {
	test("insert and set write, change and clear agent and isolated; title, body and done edits keep them; design blocks refuse them", async () => {
		const h = fixture(panes, designDoc);
		await hello(h);
		const ok = { ok: true, result: null } as const;
		expect(await h.request({ op: "insert", args: { title: "Configured", content: { kind: "task", body: "configured body", agent: "task:mid", isolated: true } } })).toEqual({ ok: true, result: { block: "b4" } });
		expect(await h.request({ op: "read", args: { block: "b4" } })).toEqual({ ok: true, result: { id: "b4", kind: "task", title: "Configured", body: "configured body", agent: "task:mid", isolated: true, status: "todo" } });
		await h.request({ op: "lock", args: { block: "b4" } }, "config-lock");
		expect(await h.request({ op: "set", args: { block: "b4", field: "title", value: "Renamed" } })).toEqual(ok);
		expect(await h.request({ op: "write", args: { block: "b4", text: "rewritten body" } })).toEqual(ok);
		expect(await h.request({ op: "edit", args: { block: "b4", find: "rewritten", replace: "edited" } })).toEqual(ok);
		expect(await h.request({ op: "set", args: { block: "b4", field: "status", value: "done" } })).toEqual(ok);
		expect(visible(h, template, "b4").block).toEqual({ id: "b4", title: "Renamed", progress: { kind: "tracked", status: "done", report: null }, content: { kind: "task", body: "edited body", agent: "task:mid", isolated: true } });
		expect(await h.request({ op: "set", args: { block: "b4", field: "agent", value: "task:low" } })).toEqual(ok);
		expect(await h.request({ op: "set", args: { block: "b4", field: "isolated", value: null } })).toEqual(ok);
		expect(visible(h, template, "b4").block.content).toEqual({ kind: "task", body: "edited body", agent: "task:low" });
		expect(await h.request({ op: "set", args: { block: "b4", field: "agent", value: null } })).toEqual(ok);
		expect(await h.request({ op: "set", args: { block: "b4", field: "isolated", value: false } })).toEqual(ok);
		expect(visible(h, template, "b4").block.content).toEqual({ kind: "task", body: "edited body", isolated: false });
		expect(await h.request({ op: "unlock", args: { block: "b4", request: "config-lock" } })).toEqual(ok);
		expect(h.api.edit(template, "b4", "body", fieldText(h.api.view(template).blocks.find(item => item.block.id === "b4")!.block, "body")!, "human body")).toBeNull();
		expect(visible(h, template, "b4").block.content).toEqual({ kind: "task", body: "human body", isolated: false });
		await h.request({ op: "lock", args: { block: "b1" } }, "design-lock");
		expectError(await h.request({ op: "set", args: { block: "b1", field: "agent", value: "task:mid" } }), "BadValue");
		expectError(await h.request({ op: "set", args: { block: "b1", field: "isolated", value: true } }), "BadValue");
		expect(visible(h, template, "b1").block).toEqual(designDoc.blocks[0]);
		h.stop();
		expect(persistedTemplate(h.store).blocks.at(-1)).toEqual({ id: "b4", title: "Renamed", progress: { kind: "tracked", status: "done", report: null }, content: { kind: "task", body: "human body", isolated: false } });
	});

	test("a contract change in a Run is recorded as content_replaced with the whole content", async () => {
		const h = fixture();
		await hello(h);
		const { id } = await run(h);
		await h.request({ op: "lock", args: { run: id, block: "b1" } }, "run-config-lock");
		expect(await h.request({ op: "set", args: { run: id, block: "b1", field: "agent", value: "task:mid" } })).toEqual({ ok: true, result: null });
		expect(h.store.readLog({ kind: "run", run: id }).entries.at(-1)?.data).toEqual({ type: "content_replaced", block: "b1", content: { kind: "task", body: "alpha unique repeated repeated aaa", agent: "task:mid" } });
	});

	
});
