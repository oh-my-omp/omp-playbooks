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
		{ id: "b1", title: "First", content: { kind: "task", body: "alpha unique repeated repeated aaa" }, done: false },
		{ id: "b2", title: "Second", content: { kind: "task", body: "second committed body" }, done: true },
		{ id: "b3", title: "Third", content: { kind: "task", body: "third committed body" }, done: false },
	],
};

function wire(block: Block) {
	return { id: block.id, title: block.title, ...block.content, done: block.done };
}

const originalWire = { title: original.title, blocks: original.blocks.map(wire) };
const designText = "Introduction.\n\n## A First panel\nshared unique design text\n\n## B Second panel\nuntouched panel\n\n## Unaddressed\nassigned ID only\n";
const designDoc = {
	title: original.title,
	blocks: [
		{ id: "b1", title: "First design", done: false, content: { kind: "design", requirement: "shared unique human requirement", design: designText } },
		{ id: "b2", title: "Second design", done: false, content: { kind: "design", requirement: "second requirement", design: "## A Other\nother design" } },
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

function run(h: CoreHarness): { ref: DocRef; id: RunId } {
	expect(h.api.startRun("Run with locks", null)).toBeNull();
	const id = h.api.runs().at(-1)!.id;
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

	test("another connection can reveal while a coordinator is connected without replacing it or releasing its locks", async () => {
		const focused: string[] = [];
		let ownPaneCalls = 0;
		const paneControl: PaneControl = {
			ownPane() { ownPaneCalls++; return "service-pane"; },
			async focusPane(pane) { focused.push(pane); return { ok: true }; },
		};
		const h = fixture(paneControl);
		await hello(h);
		expect(await h.request({ op: "lock", args: { block: "b1" } }, "first-lock")).toEqual({
			ok: true,
			result: { block: originalWire.blocks[0] },
		});
		const callsBeforeReveal = ownPaneCalls;
		const second = connection(2);
		h.handler.connected(second.conn);
		expect(await h.handler.handle(second.conn, "reveal-two", { op: "reveal", args: {} })).toEqual({ ok: true, result: null });
		expect(ownPaneCalls).toBe(callsBeforeReveal + 1);
		expect(focused).toEqual(["service-pane"]);
		expect(h.api.coordinator()).toEqual({ connected: true, session: "session-one", pane: "coordinator-pane" });
		expect(visible(h, template, "b1").lock).toEqual({ kind: "coordinator", request: "first-lock" });
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

	test("second connection gets Busy without replacing or unlocking the first coordinator", async () => {
		const h = fixture();
		await hello(h);
		await h.request({ op: "lock", args: { block: "b1" } }, "first-lock");
		const second = connection(2);
		h.handler.connected(second.conn);
		expectError(await h.handler.handle(second.conn, "hello-two", { op: "hello", args: { session: "session-two" } }), "Busy");
		expectError(await h.handler.handle(second.conn, "foreign-set", { op: "set", args: { block: "b1", field: "title", value: "foreign" } }), "Busy");
		h.handler.disconnected(second.conn);
		expect(h.api.coordinator().session).toBe("session-one");
		expect(visible(h, template, "b1").lock).toEqual({ kind: "coordinator", request: "first-lock" });
		expect(await h.request({ op: "set", args: { block: "b1", field: "title", value: "owned" } })).toEqual({ ok: true, result: null });
		expect(visible(h, template, "b1").block.title).toBe("owned");
	});

	for (const request of [
		{ op: "set", args: { block: "b1", field: "title", value: "unowned title" } },
		{ op: "set", args: { block: "b1", field: "done", value: true } },
		{ op: "edit", args: { block: "b1", find: "unique", replace: "unowned body" } },
		{ op: "write", args: { block: "b1", text: "unowned body" } },
		{ op: "panel", args: { block: "b1", panel: "A", text: "## A Unowned" } },
		{ op: "delete", args: { block: "b1" } },
	] satisfies Request[]) {
		test(`${request.op} without a held lock returns NotLocked and leaves committed content unchanged (${JSON.stringify(request.args)})`, async () => {
			const h = fixture();
			await hello(h);
			expectError(await h.request(request), "NotLocked");
			expect(await h.request({ op: "read", args: {} })).toEqual({ ok: true, result: originalWire });
			expect(visible(h, template, "b1").lock).toEqual({ kind: "none" });
			expect(persistedTemplate(h.store)).toEqual(original);
		});
	}

	test("lock returns latest committed content; re-lock supersedes request and only matching unlock releases that block", async () => {
		const h = fixture();
		await hello(h);
		expect(h.api.pencil(template, "b1", "title")).toBeNull();
		expect(h.api.setDraft(template, "b1", "human committed title")).toBeNull();
		expect(h.api.commit(template, "b1")).toBeNull();
		const committed = { ...original.blocks[0]!, title: "human committed title" };
		expect(await h.request({ op: "lock", args: { block: "b1" } }, "old-lock")).toEqual({ ok: true, result: { block: wire(committed) } });
		expect(await h.request({ op: "set", args: { block: "b1", field: "done", value: true } })).toEqual({ ok: true, result: null });
		expect(await h.request({ op: "lock", args: { block: "b1" } }, "new-lock")).toEqual({ ok: true, result: { block: wire({ ...committed, done: true }) } });
		await h.request({ op: "lock", args: { block: "b2" } }, "other-block-lock");
		for (const request of ["old-lock", "other-block-lock", "never-issued"]) {
			expect(await h.request({ op: "unlock", args: { block: "b1", request } })).toEqual({ ok: true, result: null });
			expect(visible(h, template, "b1").lock).toEqual({ kind: "coordinator", request: "new-lock" });
		}
		expect(await h.request({ op: "unlock", args: { block: "b1", request: "new-lock" } })).toEqual({ ok: true, result: null });
		expect(visible(h, template, "b1").lock).toEqual({ kind: "none" });
		expect(visible(h, template, "b2").lock).toEqual({ kind: "coordinator", request: "other-block-lock" });
		expectError(await h.request({ op: "set", args: { block: "b1", field: "title", value: "too late" } }), "NotLocked");
	});

	test("edit rejects missing and multiple matches atomically, including overlapping matches, and replaces one unique match", async () => {
		const h = fixture();
		await hello(h);
		await h.request({ op: "lock", args: { block: "b1" } }, "edit-lock");
		for (const [find, code] of [["absent", "NotFound"], ["repeated", "Ambiguous"], ["aa", "Ambiguous"]] as const) {
			expectError(await h.request({ op: "edit", args: { block: "b1", find, replace: "replacement" } }), code);
			expect(await h.request({ op: "read", args: { block: "b1" } })).toEqual({ ok: true, result: originalWire.blocks[0] });
			expect(visible(h, template, "b1").lock).toEqual({ kind: "coordinator", request: "edit-lock" });
			expect(persistedTemplate(h.store)).toEqual(original);
		}
		expect(await h.request({ op: "edit", args: { block: "b1", find: "unique", replace: "changed" } })).toEqual({ ok: true, result: null });
		expect(visible(h, template, "b1").block.content).toEqual({ kind: "task", body: "alpha changed repeated repeated aaa" });
		h.stop();
		expect(persistedTemplate(h.store).blocks[0]!.content).toEqual({ kind: "task", body: "alpha changed repeated repeated aaa" });
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

describe("K4 human drafts and coordinator interruption", () => {
	for (const field of ["title", "body"] satisfies BlockField[]) {
		test(`${field} pencil and draft leave committed document untouched until commit; coordinator cannot lock the draft`, async () => {
			const h = fixture();
			await hello(h);
			const r = run(h);
			const before = h.store.readRunLog(r.id).entries;
			expect(h.api.pencil(r.ref, "b1", field)).toBeNull();
			expect(visible(h, r.ref, "b1").lock).toEqual({ kind: "human", field, draft: fieldText(original.blocks[0]!, field)! });
			expect(h.api.setDraft(r.ref, "b1", `uncommitted ${field}`)).toBeNull();
			expect(visible(h, r.ref, "b1").block).toEqual(original.blocks[0]!);
			expect(await h.request({ op: "read", args: { run: r.id, block: "b1" } })).toEqual({ ok: true, result: originalWire.blocks[0] });
			expect(await h.request({ op: "read", args: { run: r.id } })).toMatchObject({ ok: true, result: { title: original.title, blocks: [originalWire.blocks[0], { ...originalWire.blocks[1]!, done: false }, originalWire.blocks[2]], run: { id: r.id } } });
			expectError(await h.request({ op: "lock", args: { run: r.id, block: "b1" } }, "draft-lock"), "Locked");
			expectError(await h.request({ op: "set", args: { run: r.id, block: "b1", field: "title", value: "overwrite" } }), "NotLocked");
			expect(visible(h, r.ref, "b1").lock).toEqual({ kind: "human", field, draft: `uncommitted ${field}` });
			expect(h.store.readRunLog(r.id).entries).toEqual(before);
			expect(h.store.readRuns().get(r.id)).toMatchObject({ ok: true, doc: { blocks: [original.blocks[0], { ...original.blocks[1]!, done: false }, original.blocks[2]] } });
			expect(h.api.commit(r.ref, "b1")).toBeNull();
			const committed = withField(original.blocks[0]!, field, `uncommitted ${field}`)!;
			expect(visible(h, r.ref, "b1").block).toEqual(committed);
			expect(visible(h, r.ref, "b1").lock).toEqual({ kind: "none" });
			expect(h.store.readRunLog(r.id).entries.slice(before.length)).toEqual([
				{ seq: before.length + 1, at: 123_000, origin: "human", data: { type: "block_edited", block: "b1", field, text: `uncommitted ${field}`, edit: 1 } },
			]);
			expect(await h.request({ op: "lock", args: { run: r.id, block: "b1" } }, "committed-lock")).toEqual({ ok: true, result: { block: wire(committed) } });
			h.stop();
			expect(h.store.readRuns().get(r.id)).toMatchObject({ ok: true, doc: { blocks: [committed, { ...original.blocks[1]!, done: false }, original.blocks[2]] } });
			expect(persistedTemplate(h.store)).toEqual(original);
		});
	}

	test("another pencil is rejected across fields, blocks, and documents while one human draft exists", async () => {
		const h = fixture();
		await hello(h);
		const r = run(h);
		expect(h.api.pencil(template, "b1", "body")).toBeNull();
		expect(h.api.setDraft(template, "b1", "private human draft")).toBeNull();
		for (const [ref, block, field] of [[template, "b1", "title"], [template, "b2", "body"], [r.ref, "b1", "body"], [r.ref, "b2", "title"]] as const) {
			expect(h.api.pencil(ref, block, field)).toBeTypeOf("string");
		}
		expect(visible(h, template, "b1").lock).toEqual({ kind: "human", field: "body", draft: "private human draft" });
		expect(visible(h, template, "b2").lock).toEqual({ kind: "none" });
		expect(visible(h, r.ref, "b1").lock).toEqual({ kind: "none" });
		expect(h.api.commit(template, "b1")).toBeNull();
		expect(h.api.pencil(r.ref, "b2", "title")).toBeNull();
	});

	for (const inRun of [false, true]) {
		test(`interrupt sends precise request identity, redraws and releases only the chosen lock (${inRun ? "Run" : "template"})`, async () => {
			const h = fixture();
			await hello(h);
			const r = inRun ? run(h) : null;
			const ref = r?.ref ?? template;
			const scope = r ? { run: r.id } : {};
			await h.request({ op: "lock", args: { ...scope, block: "b1" } }, "interrupted-lock");
			await h.request({ op: "lock", args: { ...scope, block: "b2" } }, "untouched-lock");
			expect(h.api.pencil(ref, "b1", "body")).toBeTypeOf("string");
			const changes: (DocRef | null)[] = [];
			const unsubscribe = h.api.onChange(changed => { changes.push(changed); });
			h.events.splice(0);
			expect(h.api.interrupt(ref, "b1")).toBeNull();
			expect(h.events).toEqual([{ event: "interrupted", data: { ...scope, block: "b1", request: "interrupted-lock" } }]);
			expect(changes).toContainEqual(ref);
			unsubscribe();
			expect(visible(h, ref, "b1").lock).toEqual({ kind: "none" });
			expect(visible(h, ref, "b2").lock).toEqual({ kind: "coordinator", request: "untouched-lock" });
			expectError(await h.request({ op: "set", args: { ...scope, block: "b1", field: "title", value: "after interruption" } }), "NotLocked");
			expect(visible(h, ref, "b1").block).toEqual(original.blocks[0]!);
			expect(h.api.pencil(ref, "b1", "body")).toBeNull();
			if (r) expect(h.store.readRunLog(r.id).entries).toContainEqual({ seq: 3, at: 123_000, origin: "human", data: { type: "interrupted", block: "b1", request: "interrupted-lock" } });
		});
	}

	test("disconnect releases all coordinator locks across template and Runs, preserves human draft, and reconnect does not restore locks", async () => {
		const h = fixture();
		await hello(h);
		const r = run(h);
		for (const args of [{ block: "b1" }, { block: "b2" }, { run: r.id, block: "b1" }, { run: r.id, block: "b2" }] satisfies Extract<Request, { op: "lock" }>["args"][]) {
			expect((await h.request({ op: "lock", args })).ok).toBe(true);
		}
		expect(h.api.pencil(r.ref, "b3", "body")).toBeNull();
		expect(h.api.setDraft(r.ref, "b3", "surviving human draft")).toBeNull();
		const changes: (DocRef | null)[] = [];
		const unsubscribe = h.api.onChange(ref => { changes.push(ref); });
		h.handler.disconnected(h.conn);
		expect(changes).toContain(null);
		unsubscribe();
		expect(h.api.coordinator()).toEqual({ connected: false, session: null, pane: null });
		for (const ref of [template, r.ref]) for (const block of ["b1", "b2"] satisfies BlockId[]) expect(visible(h, ref, block).lock).toEqual({ kind: "none" });
		expect(visible(h, r.ref, "b3").lock).toEqual({ kind: "human", field: "body", draft: "surviving human draft" });
		const next = connection(2);
		h.handler.connected(next.conn);
		expect((await h.handler.handle(next.conn, "rehello", { op: "hello", args: { session: "session-one" } })).ok).toBe(true);
		for (const scope of [{}, { run: r.id }]) {
			expectError(await h.handler.handle(next.conn, "not-restored", { op: "set", args: { ...scope, block: "b1", field: "title", value: "unowned after reconnect" } }), "NotLocked");
		}
		expect((await h.handler.handle(next.conn, "fresh-lock", { op: "lock", args: { block: "b1" } })).ok).toBe(true);
		expect(visible(h, template, "b1").lock).toEqual({ kind: "coordinator", request: "fresh-lock" });
	});
});

describe("K1 insert allocation and deletion lifetime", () => {
	test("insert appends by default, inserts after an anchor, starts unlocked/undone, and never reuses a deleted ID even after restart", async () => {
		const h = fixture();
		await hello(h);
		expect(await h.request({ op: "insert", args: { title: "Allocated", content: { kind: "task", body: "allocated body" } } })).toEqual({ ok: true, result: { block: "b4" } });
		expect(h.api.view(template).blocks.map(item => item.block.id)).toEqual(["b1", "b2", "b3", "b4"]);
		expect(visible(h, template, "b4")).toMatchObject({ block: { id: "b4", title: "Allocated", content: { kind: "task", body: "allocated body" }, done: false }, lock: { kind: "none" } });
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
		expect(persistedTemplate(h.store).blocks.at(-1)).toEqual({ id: "b6", title: "Restart allocated", content: { kind: "task", body: "fresh body" }, done: false });
	});
});

describe("Design ownership and coordinator edits", () => {
	for (const inRun of [false, true]) {
		test(`edit and write change only design, never the human requirement (${inRun ? "Run" : "template"})`, async () => {
			const h = fixture(panes, designDoc);
			await hello(h);
			const r = inRun ? run(h) : null;
			const ref = r?.ref ?? template;
			const scope = r ? { run: r.id } : {};
			expect(await h.request({ op: "lock", args: { ...scope, block: "b1" } }, "design-lock")).toEqual({ ok: true, result: { block: wire(designDoc.blocks[0]!) } });
			expect(await h.request({ op: "edit", args: { ...scope, block: "b1", find: "shared unique", replace: "revised" } })).toEqual({ ok: true, result: null });
			expect(visible(h, ref, "b1").block.content).toEqual({ kind: "design", requirement: "shared unique human requirement", design: designText.replace("shared unique", "revised") });
			expectError(await h.request({ op: "edit", args: { ...scope, block: "b1", find: "human requirement", replace: "not allowed" } }), "NotFound");
			expect(await h.request({ op: "write", args: { ...scope, block: "b1", text: "## A Replacement\nwhole new design" } })).toEqual({ ok: true, result: null });
			const content: BlockContent = { kind: "design", requirement: "shared unique human requirement", design: "## A Replacement\nwhole new design" };
			expect(visible(h, ref, "b1").block.content).toEqual(content);
			expect(visible(h, ref, "b1").lock).toEqual({ kind: "coordinator", request: "design-lock" });
			expect(await h.request({ op: "read", args: { ...scope, block: "b1" } })).toEqual({ ok: true, result: { id: "b1", title: "First design", done: false, ...content } });
			h.stop();
			const stored = r ? h.store.readRuns().get(r.id) : h.store.readTemplate();
			expect(stored?.ok).toBe(true);
			if (!stored?.ok) throw new Error("Edited document was not persisted");
			expect(stored.doc.blocks.find(block => block.id === "b1")?.content).toEqual(content);
			if (r) expect(persistedTemplate(h.store)).toEqual(designDoc);
		});

		test(`insert design initializes an empty human requirement (${inRun ? "Run" : "template"})`, async () => {
			const h = fixture();
			await hello(h);
			const r = inRun ? run(h) : null;
			const ref = r?.ref ?? template;
			const scope = r ? { run: r.id } : {};
			expect(await h.request({ op: "insert", args: { ...scope, after: "b1", title: "New design", content: { kind: "design", design: "## A Draft\ncoordinator design" } } })).toEqual({ ok: true, result: { block: "b4" } });
			const block: Block = { id: "b4", title: "New design", done: false, content: { kind: "design", requirement: "", design: "## A Draft\ncoordinator design" } };
			expect(visible(h, ref, "b4")).toMatchObject({ block, lock: { kind: "none" } });
			expect(h.api.view(ref).blocks.map(item => item.block.id)).toEqual(["b1", "b4", "b2", "b3"]);
			expect(await h.request({ op: "read", args: { ...scope, block: "b4" } })).toEqual({ ok: true, result: wire(block) });
			h.stop();
			const stored = r ? h.store.readRuns().get(r.id) : h.store.readTemplate();
			expect(stored?.ok).toBe(true);
			if (!stored?.ok) throw new Error("Inserted document was not persisted");
			expect(stored.doc.blocks.find(item => item.id === "b4")).toEqual(block);
		});
	}

	test("panel replaces exactly one written-ID panel and rejects unaddressable or invalid replacements atomically", async () => {
		const h = fixture(panes, designDoc);
		await hello(h);
		await h.request({ op: "lock", args: { block: "b1" } }, "panel-lock");
		for (const [panel, text, code] of [
			["Z", "## Z Missing", "NotFound"],
			["C", "## C Automatically assigned", "NotFound"],
			["Unaddressed", "## Unaddressed", "NotFound"],
			["A", "body without heading", "BadValue"],
			["A", "## B Wrong ID\nreplacement", "BadValue"],
			["A", "## A First\none\n\n## B Second\ntwo", "BadValue"],
		] as const) {
			expectError(await h.request({ op: "panel", args: { block: "b1", panel, text } }), code);
			expect(visible(h, template, "b1").block).toEqual(designDoc.blocks[0]);
			expect(visible(h, template, "b1").lock).toEqual({ kind: "coordinator", request: "panel-lock" });
			expect(persistedTemplate(h.store)).toEqual(designDoc);
		}
		const replacement = "## A Revised first panel\nnew panel content";
		expect(await h.request({ op: "panel", args: { block: "b1", panel: "A", text: replacement } })).toEqual({ ok: true, result: null });
		const expected = designText.replace("## A First panel\nshared unique design text", replacement);
		expect(visible(h, template, "b1").block.content).toEqual({ kind: "design", requirement: "shared unique human requirement", design: expected });
		await h.request({ op: "lock", args: { block: "b3" } }, "task-panel-lock");
		expectError(await h.request({ op: "panel", args: { block: "b3", panel: "A", text: replacement } }), "BadValue");
		expect(visible(h, template, "b3").block).toEqual(designDoc.blocks[2]);
		h.stop();
		expect(persistedTemplate(h.store).blocks[0]!.content).toEqual({ kind: "design", requirement: "shared unique human requirement", design: expected });
	});

	test("human pencil rejects design-equivalent paths and task-only mismatches, but can commit requirements", () => {
		const h = fixture(panes, designDoc);
		for (const [block, field] of [["b1", "body"], ["b3", "requirement"], ["b3", "prompt"]] as const) {
			expect(h.api.pencil(template, block, field)).toBeTypeOf("string");
			expect(visible(h, template, block).lock).toEqual({ kind: "none" });
		}
		expect(h.api.pencil(template, "b1", "requirement")).toBeNull();
		expect(visible(h, template, "b1").lock).toEqual({ kind: "human", field: "requirement", draft: "shared unique human requirement" });
		expect(h.api.setDraft(template, "b1", "revised human requirement")).toBeNull();
		expect(visible(h, template, "b1").block).toEqual(designDoc.blocks[0]);
		expect(h.api.commit(template, "b1")).toBeNull();
		expect(visible(h, template, "b1").block.content).toEqual({ kind: "design", requirement: "revised human requirement", design: designText });
		expect(visible(h, template, "b1").lock).toEqual({ kind: "none" });
		h.stop();
		expect(persistedTemplate(h.store).blocks[0]!.content).toEqual({ kind: "design", requirement: "revised human requirement", design: designText });
	});
});

describe("Design change request drafts and revision journals", () => {
	for (const inRun of [false, true]) {
		test(`prompt starts empty; a merely connected socket cannot submit and keeps the draft (${inRun ? "Run" : "template"})`, async () => {
			const h = fixture(panes, designDoc);
			const r = inRun ? run(h) : null;
			const ref = r?.ref ?? template;
			expect(h.api.pencil(ref, "b1", "prompt")).toBeNull();
			expect(visible(h, ref, "b1").lock).toEqual({ kind: "human", field: "prompt", draft: "" });
			expect(h.api.setDraft(ref, "b1", "Keep this requested change")).toBeNull();
			expect(h.api.commit(ref, "b1")).toBeTypeOf("string");
			expect(visible(h, ref, "b1").lock).toEqual({ kind: "human", field: "prompt", draft: "Keep this requested change" });
			expect(visible(h, ref, "b1").block).toEqual(designDoc.blocks[0]);
			expect(h.store.readRevisions(ref)).toEqual([]);
			expect(h.api.revisions(ref, "b1")).toEqual([]);
			expect(h.events).toEqual([]);
			await h.request({ op: "hello", args: { session: "revision-coordinator" } });
			expect(h.api.commit(ref, "b1")).toBeNull();
			expect(h.store.readRevisions(ref)).toEqual([{ seq: 1, at: 123_000, block: "b1", prompt: "Keep this requested change" }]);
			expect(h.events).toEqual([{ event: "revision_requested", data: { ...(r ? { run: r.id } : {}), block: "b1", revision: 1 } }]);
			expect(visible(h, ref, "b1").lock).toEqual({ kind: "none" });
		});
	}

	test("empty or whitespace-only prompt cannot create a revision, notify, or release its draft lock", async () => {
		const h = fixture(panes, designDoc);
		await hello(h);
		expect(h.api.pencil(template, "b1", "prompt")).toBeNull();
		for (const prompt of ["", " \n\t "]) {
			expect(h.api.setDraft(template, "b1", prompt)).toBeNull();
			expect(h.api.commit(template, "b1")).toBeTypeOf("string");
			expect(visible(h, template, "b1").lock).toEqual({ kind: "human", field: "prompt", draft: prompt });
			expect(visible(h, template, "b1").block).toEqual(designDoc.blocks[0]);
			expect(h.store.readRevisions(template)).toEqual([]);
			expect(h.api.revisions(template, "b1")).toEqual([]);
			expect(h.events).toEqual([]);
		}
	});

	test("submission appends before notifying, releases the lock, sequences per document, and filters revision queries", async () => {
		const h = fixture(panes, designDoc);
		await hello(h);
		const appended: { ref: DocRef; revision: Revision }[] = [];
		const appendRevision = h.store.appendRevision;
		h.store.appendRevision = (ref, revision) => {
			appendRevision(ref, revision);
			appended.push({ ref, revision });
		};
		const send = h.conn.send;
		h.conn.send = event => {
			if (event.event === "revision_requested") {
				const ref: DocRef = event.data.run ? { kind: "run", run: event.data.run } : template;
				expect(appended.at(-1)).toEqual({ ref, revision: { seq: event.data.revision, at: 123_000, block: event.data.block, prompt: h.store.readRevisions(ref).at(-1)!.prompt } });
				expect(h.api.revisions(ref, event.data.block).at(-1)?.seq).toBe(event.data.revision);
				expect(visible(h, ref, event.data.block).lock).toEqual({ kind: "none" });
			}
			send(event);
		};
		const submit = (ref: DocRef, block: BlockId, prompt: string) => {
			expect(h.api.pencil(ref, block, "prompt")).toBeNull();
			expect(visible(h, ref, block).lock).toEqual({ kind: "human", field: "prompt", draft: "" });
			expect(h.api.setDraft(ref, block, prompt)).toBeNull();
			expect(h.api.commit(ref, block)).toBeNull();
		};
		submit(template, "b1", "template first");
		const r = run(h);
		expect(h.api.revisions(r.ref, "b1")).toEqual([]);
		expect(h.store.readRevisions(r.ref)).toEqual([]);
		submit(r.ref, "b1", "run first");
		submit(template, "b2", "template second");
		submit(r.ref, "b2", "run second");
		submit(template, "b1", "template third");
		const templateRevisions: [Revision, Revision, Revision] = [
			{ seq: 1, at: 123_000, block: "b1", prompt: "template first" },
			{ seq: 2, at: 123_000, block: "b2", prompt: "template second" },
			{ seq: 3, at: 123_000, block: "b1", prompt: "template third" },
		];
		const runRevisions: [Revision, Revision] = [
			{ seq: 1, at: 123_000, block: "b1", prompt: "run first" },
			{ seq: 2, at: 123_000, block: "b2", prompt: "run second" },
		];
		expect(appended).toEqual([
			{ ref: template, revision: templateRevisions[0] },
			{ ref: r.ref, revision: runRevisions[0] },
			{ ref: template, revision: templateRevisions[1] },
			{ ref: r.ref, revision: runRevisions[1] },
			{ ref: template, revision: templateRevisions[2] },
		]);
		expect(h.events.filter(event => event.event === "revision_requested")).toEqual(appended.map(({ ref, revision }) => ({ event: "revision_requested", data: { ...(ref.kind === "run" ? { run: ref.run } : {}), block: revision.block, revision: revision.seq } })));
		expect(h.store.readRevisions(template)).toEqual(templateRevisions);
		expect(h.store.readRevisions(r.ref)).toEqual(runRevisions);
		expect(h.api.revisions(template, "b1")).toEqual([templateRevisions[0], templateRevisions[2]]);
		expect(h.api.revisions(template, "b2")).toEqual([templateRevisions[1]]);
		expect(h.api.revisions(r.ref, "b1")).toEqual([runRevisions[0]]);
		expect(h.api.revisions(r.ref, "b3")).toEqual([]);
		for (const [args, expected] of [
			[{}, templateRevisions],
			[{ block: "b1" }, [templateRevisions[0], templateRevisions[2]]],
			[{ after: 1 }, templateRevisions.slice(1)],
			[{ block: "b1", after: 1 }, [templateRevisions[2]]],
			[{ after: 3 }, []],
			[{ run: r.id }, runRevisions],
			[{ run: r.id, block: "b2", after: 1 }, [runRevisions[1]]],
			[{ run: r.id, block: "b1", after: 1 }, []],
		] satisfies [Extract<Request, { op: "revisions" }>["args"], readonly Revision[]][]) {
			expect(await h.request({ op: "revisions", args })).toEqual({ ok: true, result: { revisions: expected } });
		}
		expect(await h.request({ op: "read", args: { block: "b1" } })).toEqual({ ok: true, result: wire(designDoc.blocks[0]!) });
		expect(visible(h, template, "b1").block).toEqual(designDoc.blocks[0]);
		h.stop();
		expect(persistedTemplate(h.store)).toEqual(designDoc);
		const restarted = startCore(h.store);
		await restarted.request({ op: "hello", args: { session: "after-restart" } });
		expect(restarted.api.revisions(template, "b1")).toEqual([templateRevisions[0], templateRevisions[2]]);
		expect(restarted.api.revisions(r.ref, "b2")).toEqual([runRevisions[1]]);
		expect(restarted.api.pencil(template, "b1", "prompt")).toBeNull();
		expect(restarted.api.setDraft(template, "b1", "after restart")).toBeNull();
		expect(restarted.api.commit(template, "b1")).toBeNull();
		expect(h.store.readRevisions(template).at(-1)).toEqual({ seq: 4, at: 123_000, block: "b1", prompt: "after restart" });
	});

	test("discard drops both content and prompt drafts without committing content or creating revisions", async () => {
		const h = fixture(panes, designDoc);
		await hello(h);
		for (const [block, field] of [["b1", "prompt"], ["b1", "requirement"], ["b3", "body"]] as const) {
			expect(h.api.pencil(template, block, field)).toBeNull();
			expect(h.api.setDraft(template, block, "discard this private draft")).toBeNull();
			expect(h.api.discard(template, block)).toBeNull();
			expect(visible(h, template, block).lock).toEqual({ kind: "none" });
			expect(h.api.setDraft(template, block, "no draft")).toBeTypeOf("string");
			expect(h.api.commit(template, block)).toBeTypeOf("string");
			expect(h.api.discard(template, block)).toBeTypeOf("string");
			expect(h.api.view(template).blocks.map(item => item.block)).toEqual([...designDoc.blocks]);
			expect(h.store.readRevisions(template)).toEqual([]);
			expect(h.events).toEqual([]);
		}
		h.stop();
		expect(persistedTemplate(h.store)).toEqual(designDoc);
	});
});

describe("Task execution contract and block moves", () => {
	test("insert and set write, change and clear agent and isolated; title, body and done edits keep them; design blocks refuse them", async () => {
		const h = fixture(panes, designDoc);
		await hello(h);
		const ok = { ok: true, result: null } as const;
		expect(await h.request({ op: "insert", args: { title: "Configured", content: { kind: "task", body: "configured body", agent: "task:mid", isolated: true } } })).toEqual({ ok: true, result: { block: "b4" } });
		expect(await h.request({ op: "read", args: { block: "b4" } })).toEqual({ ok: true, result: { id: "b4", kind: "task", title: "Configured", body: "configured body", agent: "task:mid", isolated: true, done: false } });
		await h.request({ op: "lock", args: { block: "b4" } }, "config-lock");
		expect(await h.request({ op: "set", args: { block: "b4", field: "title", value: "Renamed" } })).toEqual(ok);
		expect(await h.request({ op: "write", args: { block: "b4", text: "rewritten body" } })).toEqual(ok);
		expect(await h.request({ op: "edit", args: { block: "b4", find: "rewritten", replace: "edited" } })).toEqual(ok);
		expect(await h.request({ op: "set", args: { block: "b4", field: "done", value: true } })).toEqual(ok);
		expect(visible(h, template, "b4").block).toEqual({ id: "b4", title: "Renamed", done: true, content: { kind: "task", body: "edited body", agent: "task:mid", isolated: true } });
		expect(await h.request({ op: "set", args: { block: "b4", field: "agent", value: "task:low" } })).toEqual(ok);
		expect(await h.request({ op: "set", args: { block: "b4", field: "isolated", value: null } })).toEqual(ok);
		expect(visible(h, template, "b4").block.content).toEqual({ kind: "task", body: "edited body", agent: "task:low" });
		expect(await h.request({ op: "set", args: { block: "b4", field: "agent", value: null } })).toEqual(ok);
		expect(await h.request({ op: "set", args: { block: "b4", field: "isolated", value: false } })).toEqual(ok);
		expect(visible(h, template, "b4").block.content).toEqual({ kind: "task", body: "edited body", isolated: false });
		expect(await h.request({ op: "unlock", args: { block: "b4", request: "config-lock" } })).toEqual(ok);
		expect(h.api.pencil(template, "b4", "body")).toBeNull();
		expect(h.api.setDraft(template, "b4", "human body")).toBeNull();
		expect(h.api.commit(template, "b4")).toBeNull();
		expect(visible(h, template, "b4").block.content).toEqual({ kind: "task", body: "human body", isolated: false });
		await h.request({ op: "lock", args: { block: "b1" } }, "design-lock");
		expectError(await h.request({ op: "set", args: { block: "b1", field: "agent", value: "task:mid" } }), "BadValue");
		expectError(await h.request({ op: "set", args: { block: "b1", field: "isolated", value: true } }), "BadValue");
		expect(visible(h, template, "b1").block).toEqual(designDoc.blocks[0]);
		h.stop();
		expect(persistedTemplate(h.store).blocks.at(-1)).toEqual({ id: "b4", title: "Renamed", done: true, content: { kind: "task", body: "human body", isolated: false } });
	});

	test("a contract change in a Run is recorded as content_replaced with the whole content", async () => {
		const h = fixture();
		await hello(h);
		const { id } = run(h);
		await h.request({ op: "lock", args: { run: id, block: "b1" } }, "run-config-lock");
		expect(await h.request({ op: "set", args: { run: id, block: "b1", field: "agent", value: "task:mid" } })).toEqual({ ok: true, result: null });
		expect(h.store.readRunLog(id).entries.at(-1)?.data).toEqual({ type: "content_replaced", block: "b1", content: { kind: "task", body: "alpha unique repeated repeated aaa", agent: "task:mid" } });
	});

	test("move puts a held block first or after another, records the Run order, and leaves an unchanged order unrecorded", async () => {
		const h = fixture();
		await hello(h);
		const { id, ref } = run(h);
		const order = () => h.api.view(ref).blocks.map(item => item.block.id);
		const reorders = () => h.store.readRunLog(id).entries.filter(entry => entry.data.type === "blocks_reordered").map(entry => entry.data);
		await h.request({ op: "lock", args: { run: id, block: "b3" } }, "move-lock");
		expect(await h.request({ op: "move", args: { run: id, block: "b3", after: null } })).toEqual({ ok: true, result: null });
		expect(order()).toEqual(["b3", "b1", "b2"]);
		expect(await h.request({ op: "move", args: { run: id, block: "b3", after: "b1" } })).toEqual({ ok: true, result: null });
		expect(order()).toEqual(["b1", "b3", "b2"]);
		const entries = h.store.readRunLog(id).entries.length;
		expect(await h.request({ op: "move", args: { run: id, block: "b3", after: "b1" } })).toEqual({ ok: true, result: null });
		expect(h.store.readRunLog(id).entries).toHaveLength(entries);
		expect(reorders()).toEqual([{ type: "blocks_reordered", order: ["b3", "b1", "b2"] }, { type: "blocks_reordered", order: ["b1", "b3", "b2"] }]);
		expectError(await h.request({ op: "move", args: { run: id, block: "b3", after: "b3" } }), "BadValue");
		expectError(await h.request({ op: "move", args: { run: id, block: "b3", after: "b9" } }), "UnknownBlock");
		expectError(await h.request({ op: "move", args: { run: id, block: "b2", after: null } }), "NotLocked");
		expect(h.api.pencil(ref, "b2", "title")).toBeNull();
		expectError(await h.request({ op: "move", args: { run: id, block: "b2", after: null } }), "Locked");
		expect(order()).toEqual(["b1", "b3", "b2"]);
		expect(reorders()).toHaveLength(2);
		h.stop();
		const persisted = h.store.readRuns().get(id);
		expect(persisted?.ok && persisted.doc.blocks.map(block => block.id)).toEqual(["b1", "b3", "b2"]);
	});
});
