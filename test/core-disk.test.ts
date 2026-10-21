import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fieldText, withField, type BlockField, type BlockId, type BlockLock, type DocRef, type FetchOutcome, type PlaybookDoc, type RunId } from "../src/domain/model";
import type { Connection } from "../src/domain/ports";
import type { EventPayload, Request } from "../src/domain/protocol";
import { checks } from "../src/service/checks";
import { Core } from "../src/service/core";
import { references } from "../src/service/references";
import { createStore } from "../src/service/store";

const template: DocRef = { kind: "template" };
const initial: PlaybookDoc = {
	title: "Disk integration",
	blocks: [
		{ id: "b1", title: "Root", content: { kind: "task", body: "root ((b2))" }, done: false },
		{ id: "b2", title: "Source", content: { kind: "task", body: "before" }, done: false },
		{ id: "b3", title: "Disposable", content: { kind: "task", body: "third" }, done: false },
	],
};
const designInitial: PlaybookDoc = {
	...initial,
	blocks: initial.blocks.map(block => block.id === "b2"
		? { ...block, content: { kind: "design", requirement: "original requirement", design: "## A Original design\n\nDesign content" } }
		: block),
};
// S2 specifies one-second polling/writeback. The extra 150 ms only allows
// scheduling and observation overhead; it is not a second polling interval.
// These integration tests exercise Core's actual platform-clock polling and
// delayed atomic IO; fake timers would not prove the requested real 1 s path.
const ONE_SECOND_WINDOW = 1_150;
const resources: { core: Core; conn: Connection; directory: string }[] = [];

async function eventually(predicate: () => boolean, timeout = ONE_SECOND_WINDOW): Promise<void> {
	const deadline = performance.now() + timeout;
	while (!predicate() && performance.now() < deadline) await Bun.sleep(10);
	expect(predicate()).toBe(true);
}

function fixture(doc: PlaybookDoc = initial) {
	const directory = mkdtempSync("/tmp/tern-core-disk-");
	const path = join(directory, "playbook.yaml");
	const store = createStore(path);
	store.write(template, store.serialize(doc, null));
	const events: EventPayload[] = [];
	const conn: Connection = { id: 1, send: event => { events.push(event); }, close() {} };
	const fetchOutcome: FetchOutcome = { ok: true, at: 100, value: { kind: "file", text: "fixed external content" } };
	let fetchCalls = 0;
	const core = new Core({
		store,
		references,
		checks,
		fetcher: { async fetch() { fetchCalls++; return fetchOutcome; } },
		panes: {
			ownPane: () => null,
			async focusPane() { return { ok: true }; },
		},
	});
	resources.push({ core, conn, directory });
	expect(core.load()).toBeNull();
	core.connected(conn);
	let requestNumber = 0;
	const request = (value: Request) => core.handle(conn, `disk-test-${++requestNumber}`, value);
	const pathFor = (ref: DocRef) => ref.kind === "template" ? path : join(directory, `playbook.runs/${ref.run}.yaml`);
	const document = (ref: DocRef): PlaybookDoc => {
		const view = core.view(ref);
		return { title: view.title, blocks: view.blocks.map(value => value.block) };
	};
	// Ensure an external write has a distinct mtime even on coarse filesystems.
	let externalMtime = Date.now();
	const externalText = (ref: DocRef, text: string) => {
		const file = pathFor(ref);
		writeFileSync(file, text);
		externalMtime = Math.max(externalMtime + 1, statSync(file).mtimeMs + 1);
		utimesSync(file, externalMtime / 1000, externalMtime / 1000);
	};
	const externalDoc = (ref: DocRef, next: PlaybookDoc) => externalText(ref, store.serialize(next, core.view(ref).run));
	const block = (ref: DocRef, id: BlockId) => {
		const found = core.view(ref).blocks.find(value => value.block.id === id);
		if (!found) throw new Error(`Missing ${id}`);
		return found;
	};
	const hello = async () => {
		expect((await request({ op: "hello", args: { session: "disk-session" } })).ok).toBe(true);
	};
	const startRun = async (): Promise<{ run: RunId; ref: DocRef }> => {
		expect((await request({ op: "start_run", args: { name: "Disk run" } })).ok).toBe(true);
		const run = core.runs()[0]!.id;
		return { run, ref: { kind: "run", run } };
	};
	return { core, store, directory, path, pathFor, document, externalText, externalDoc, block, request, hello, startRun, events, fetchCalls: () => fetchCalls };
}

afterEach(() => {
	for (const { core, conn, directory } of resources.splice(0)) {
		core.disconnected(conn);
		core.stop();
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("core disk persistence — README S2 / contracts K4", () => {
	test("human committed edits write back in one second through an atomic replacement", async () => {
		const f = fixture();
		const oldText = readFileSync(f.path, "utf8");
		const oldReader = openSync(f.path, "r");
		try {
			expect(f.core.pencil(template, "b1", "body")).toBeNull();
			expect(f.core.setDraft(template, "b1", "committed\nmultiline body\n")).toBeNull();
			expect(readFileSync(f.path, "utf8")).toBe(oldText);
			expect(f.core.commit(template, "b1")).toBeNull();
			expect(f.core.setDone(template, "b2", true)).toBeNull();
			const expected = f.store.serialize(f.document(template), null);
			await eventually(() => readFileSync(f.path, "utf8") === expected);
			expect(f.store.readTemplate()).toEqual({ ok: true, doc: f.document(template), run: null });
			expect(readFileSync(oldReader, "utf8")).toBe(oldText);
			expect(readdirSync(f.directory)).toEqual(["playbook.yaml"]);
		} finally { closeSync(oldReader); }
	});

	test("coordinator edits also write a Run back within one second", async () => {
		const f = fixture();
		await f.hello();
		const { run, ref } = await f.startRun();
		expect((await f.request({ op: "lock", args: { run, block: "b2" } })).ok).toBe(true);
		expect((await f.request({ op: "edit", args: { run, block: "b2", find: "before", replace: "coordinator change" } })).ok).toBe(true);
		const expected = f.store.serialize(f.document(ref), f.core.view(ref).run);
		await eventually(() => readFileSync(f.pathFor(ref), "utf8") === expected);
		expect(f.store.readTemplate()).toEqual({ ok: true, doc: initial, run: null });
	});

	test("external fields, insertion, deletion and order become separate disk edits in about one second", async () => {
		const f = fixture();
		await f.hello();
		const { run, ref } = await f.startRun();
		const next: PlaybookDoc = {
			title: "External document title",
			blocks: [
				{ id: "b4", title: "New first", content: { kind: "task", body: "new content" }, done: true },
				{ id: "b2", title: "Changed title", content: { kind: "task", body: "after" }, done: true },
				initial.blocks[0]!,
			],
		};
		f.externalDoc(ref, next);
		await eventually(() => Bun.deepEquals(f.document(ref), next));
		expect(await f.request({ op: "read", args: { run } })).toEqual({
			ok: true,
			result: {
				title: next.title,
				blocks: [
					{ id: "b4", kind: "task", title: "New first", body: "new content", done: true },
					{ id: "b2", kind: "task", title: "Changed title", body: "after", done: true },
					{ id: "b1", kind: "task", title: "Root", body: "root ((b2))", done: false },
				],
				run: f.core.view(ref).run,
			},
		});
		const entries = f.core.view(ref).timeline.filter(entry => entry.origin === "disk");
		expect(entries.map(entry => entry.data)).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "block_edited", block: "b2", field: "title", text: "Changed title" }),
			expect.objectContaining({ type: "block_edited", block: "b2", field: "body", text: "after" }),
			{ type: "done_changed", block: "b2", done: true },
			{ type: "block_added", block: "b4", title: "New first", content: { kind: "task", body: "new content" } },
			{ type: "block_deleted", block: "b3", title: "Disposable", content: { kind: "task", body: "third" } },
			{ type: "blocks_reordered", order: ["b4", "b2", "b1"] },
		]));
		expect(f.store.readRunLog(run).entries.filter(entry => entry.origin === "disk")).toEqual(entries);
		expect(f.fetchCalls()).toBe(0);
	});

	test("a disk body edit bypasses the coordinator lock and notifies the dependent active Launch", async () => {
		const f = fixture({ ...initial, blocks: initial.blocks.map(block => block.id === "b2" ? withField(block, "body", "before ((file:stable.md))")! : block) });
		await f.hello();
		const { run, ref } = await f.startRun();
		expect((await f.request({ op: "launch", args: { run, blocks: ["b1"] } })).ok).toBe(true);
		const launch = f.block(ref, "b1").launches[0]!.id;
		expect((await f.request({ op: "bind", args: { launch, agent: "disk-agent" } })).ok).toBe(true);
		expect((await f.request({ op: "lock", args: { run, block: "b2" } })).ok).toBe(true);
		f.externalDoc(ref, { ...f.document(ref), blocks: f.document(ref).blocks.map(block => block.id === "b2" ? withField(block, "body", "after ((file:stable.md))")! : block) });
		await eventually(() => fieldText(f.block(ref, "b2").block, "body")?.startsWith("after") === true);
		expect((await f.request({ op: "read", args: { run, block: "b2" } }))).toEqual({
			ok: true,
			result: { id: "b2", kind: "task", title: "Source", body: "after ((file:stable.md))", done: false },
		});
		expect(f.block(ref, "b2").lock.kind).toBe("coordinator");
		await eventually(() => f.events.some(event => event.event === "block_changed"), 2_200);
		const event = f.events.find(event => event.event === "block_changed");
		if (!event || event.event !== "block_changed") throw new Error("No block_changed");
		expect(event.data.launch).toEqual({ id: launch, kind: "prompt", run });
		expect(event.data.agents).toEqual(["disk-agent"]);
		expect(event.data.changed).toContain("b2");
		expect(event.data.diff).toContain("before");
		expect(event.data.diff).toContain("after");
		expect(event.data.current).toEqual(await f.core.preview(ref, ["b1"]));
		expect(f.fetchCalls()).toBe(1);
	}, 5_000);

	test("disk deletion of a dependency notifies the active Launch with a compile error", async () => {
		const f = fixture();
		await f.hello();
		const { run, ref } = await f.startRun();
		expect((await f.request({ op: "launch", args: { run, blocks: ["b1"] } })).ok).toBe(true);
		const launch = f.block(ref, "b1").launches[0]!.id;
		f.externalDoc(ref, { ...f.document(ref), blocks: f.document(ref).blocks.filter(block => block.id !== "b2") });
		await eventually(() => !f.core.view(ref).blocks.some(value => value.block.id === "b2"));
		await eventually(() => f.events.some(event => event.event === "block_changed"), 2_200);
		const event = f.events.find(event => event.event === "block_changed");
		if (!event || event.event !== "block_changed") throw new Error("No block_changed");
		expect(event.data.launch.id).toBe(launch);
		expect(event.data.changed).toContain("b2");
		expect(event.data.current).toMatchObject({ kind: "Err", error: { kind: "UnknownBlock", block: "b2" } });
	}, 5_000);

	for (const [label, invalid] of [
		["unparseable YAML", "title: ["],
		["invalid block shape", "title: bad\nblocks:\n - {id: b1, title: bad, body: changed, done: not-a-boolean}\n"],
	] as const) {
		test(`${label} is not applied or overwritten, reports an error, and permits writes after recovery`, async () => {
			const f = fixture();
			f.externalText(template, invalid);
			await eventually(() => f.core.view(template).errors.some(error => error.includes("文件不能解析")));
			expect(f.document(template)).toEqual(initial);
			expect(f.core.pencil(template, "b2", "body")).toBeNull();
			expect(f.core.setDraft(template, "b2", "human edit while file is invalid")).toBeNull();
			expect(f.core.commit(template, "b2")).toBeNull();
			await Bun.sleep(ONE_SECOND_WINDOW);
			expect(readFileSync(f.path, "utf8")).toBe(invalid);
			expect(f.core.view(template).errors.length).toBeGreaterThan(0);
			const recovered = f.document(template);
			f.externalDoc(template, recovered);
			await eventually(() => f.core.view(template).errors.length === 0);
			expect(f.document(template)).toEqual(recovered);
			expect(f.core.setDone(template, "b2", true)).toBeNull();
			await eventually(() => readFileSync(f.path, "utf8") === f.store.serialize(f.document(template), null));
		}, 6_000);
	}

	for (const field of ["title", "body", "requirement"] as const satisfies BlockField[]) {
		test(`disk change of an edited ${field} shows a notice, preserves the draft and lets commit overwrite disk`, async () => {
			const baseline = field === "requirement" ? designInitial : initial;
			const f = fixture(baseline);
			const draft = `human ${field} draft`;
			expect(f.core.pencil(template, "b2", field)).toBeNull();
			expect(f.core.setDraft(template, "b2", draft)).toBeNull();
			f.externalDoc(template, { ...baseline, blocks: baseline.blocks.map(block => block.id === "b2" ? withField(block, field, `disk ${field}`)! : block) });
			await eventually(() => fieldText(f.block(template, "b2").block, field) === `disk ${field}`);
			expect(f.block(template, "b2").notices.length).toBeGreaterThan(0);
			expect(fieldText(f.block(template, "b2").block, field)).toBe(`disk ${field}`);
			expect(f.block(template, "b2").lock).toEqual({ kind: "human", field, draft });
			expect(f.core.commit(template, "b2")).toBeNull();
			expect(fieldText(f.block(template, "b2").block, field)).toBe(draft);
			expect(f.block(template, "b2").lock).toEqual({ kind: "none" });
			await eventually(() => readFileSync(f.path, "utf8") === f.store.serialize(f.document(template), null));
		});
	}

	test("a disk change of another field does not warn or replace the human draft", async () => {
		const f = fixture();
		expect(f.core.pencil(template, "b2", "body")).toBeNull();
		expect(f.core.setDraft(template, "b2", "uncommitted body")).toBeNull();
		f.externalDoc(template, { ...initial, blocks: initial.blocks.map(block => block.id === "b2" ? { ...block, title: "external title" } : block) });
		await eventually(() => f.block(template, "b2").block.title === "external title");
		expect(f.block(template, "b2").notices).toEqual([]);
		expect(f.block(template, "b2").lock).toEqual({ kind: "human", field: "body", draft: "uncommitted body" });
		expect(fieldText(f.block(template, "b2").block, "body")).toBe("before");
	});

	test("disk deletion of a human-locked block discards the draft, unlocks and shows a deletion notice", async () => {
		const f = fixture();
		expect(f.core.pencil(template, "b2", "body")).toBeNull();
		expect(f.core.setDraft(template, "b2", "discard me")).toBeNull();
		f.externalDoc(template, { ...initial, blocks: initial.blocks.filter(block => block.id !== "b2") });
		const externalInode = statSync(f.path).ino;
		await eventually(() => !f.core.view(template).blocks.some(value => value.block.id === "b2"));
		expect(f.core.errors().some(error => error.includes("这个块已被磁盘文件删除") && error.includes("b2"))).toBe(true);
		expect(f.core.commit(template, "b2")).not.toBeNull();
		expect(f.core.pencil(template, "b3", "title")).toBeNull();
		expect(f.core.commit(template, "b3")).toBeNull();
		// Finish the scheduled atomic write before another external edit: S2
		// deliberately does not resolve simultaneous external/service writers.
		await eventually(() => statSync(f.path).ino !== externalInode);
		// Reusing an id in an external file must not resurrect its old lock/draft.
		f.externalDoc(template, initial);
		await eventually(() => f.core.view(template).blocks.some(value => value.block.id === "b2"));
		expect(f.block(template, "b2").lock).toEqual({ kind: "none" });
		expect(fieldText(f.block(template, "b2").block, "body")).toBe("before");
	});

	test("a document-title-only disk edit invalidates the subscribed view", async () => {
		const f = fixture();
		await Bun.sleep(0); // finish the initial deterministic check refresh first
		const changedTitles: string[] = [];
		f.core.onChange(ref => {
			if (ref === null || ref.kind === "template") changedTitles.push(f.core.view(template).title);
		});
		f.externalDoc(template, { ...initial, title: "title-only disk edit" });
		await eventually(() => f.core.view(template).title === "title-only disk edit");
		expect(changedTitles).toContain("title-only disk edit");
	});

	test("repairing an invalid file to identical content invalidates the error view", async () => {
		const f = fixture();
		f.externalText(template, "title: [");
		await eventually(() => f.core.view(template).errors.length > 0);
		const observedErrors: number[] = [];
		f.core.onChange(ref => {
			if (ref === null || ref.kind === "template") observedErrors.push(f.core.view(template).errors.length);
		});
		f.externalDoc(template, initial);
		await eventually(() => f.core.view(template).errors.length === 0);
		expect(observedErrors).toContain(0);
	});

	test("disk requirement and design edits merge separately in a Run without replacing a valid prompt draft", async () => {
		const f = fixture(designInitial);
		await f.hello();
		const { run, ref } = await f.startRun();
		expect(f.core.pencil(ref, "b2", "prompt")).toBeNull();
		expect(f.core.setDraft(ref, "b2", "Please revise the overview")).toBeNull();
		const content = { kind: "design", requirement: "disk requirement", design: "## A Disk design\n\nUpdated design" } as const;
		f.externalDoc(ref, {
			...designInitial,
			blocks: designInitial.blocks.map(block => block.id === "b2" ? { ...block, content } : block),
		});
		await eventually(() => fieldText(f.block(ref, "b2").block, "design") === content.design);
		expect(f.block(ref, "b2").block.content).toEqual(content);
		expect(f.block(ref, "b2").lock).toEqual({ kind: "human", field: "prompt", draft: "Please revise the overview" });
		expect(f.block(ref, "b2").notices).toEqual([]);
		const entries = f.core.view(ref).timeline.filter(entry => entry.origin === "disk");
		expect(entries.map(entry => entry.data)).toEqual([
			expect.objectContaining({ type: "block_edited", block: "b2", field: "requirement", text: content.requirement }),
			expect.objectContaining({ type: "block_edited", block: "b2", field: "design", text: content.design }),
		]);
		expect(f.store.readRunLog(run).entries.filter(entry => entry.origin === "disk")).toEqual(entries);
	});

	test("disk execution contract edits merge per key, keep the body, and never dirty an active Launch", async () => {
		const configured: PlaybookDoc = {
			...initial,
			blocks: initial.blocks.map(block => block.id === "b2" ? { ...block, content: { kind: "task", body: "before", agent: "task:old" } } : block),
		};
		const f = fixture(configured);
		await f.hello();
		const { run, ref } = await f.startRun();
		expect((await f.request({ op: "launch", args: { run, blocks: ["b1"] } })).ok).toBe(true);
		const withIsolated = { kind: "task", body: "before", agent: "task:old", isolated: true } as const;
		f.externalDoc(ref, { ...configured, blocks: configured.blocks.map(block => block.id === "b2" ? { ...block, content: withIsolated } : block) });
		await eventually(() => Bun.deepEquals(f.block(ref, "b2").block.content, withIsolated));
		expect(f.block(ref, "b2").block.content).toEqual(withIsolated);
		const withoutAgent = { kind: "task", body: "before", isolated: true } as const;
		f.externalDoc(ref, { ...configured, blocks: configured.blocks.map(block => block.id === "b2" ? { ...block, content: withoutAgent } : block) });
		await eventually(() => Bun.deepEquals(f.block(ref, "b2").block.content, withoutAgent));
		expect(f.block(ref, "b2").block.content).toEqual(withoutAgent);
		expect(f.core.launchInfo("l1")!.dirty).toEqual([]);
		expect(f.core.view(ref).timeline.filter(entry => entry.origin === "disk").map(entry => entry.data)).toEqual([
			{ type: "content_replaced", block: "b2", content: withIsolated },
			{ type: "content_replaced", block: "b2", content: withoutAgent },
		]);
	});

	test("a disk design edit preserves a human requirement draft without a conflict notice", async () => {
		const f = fixture(designInitial);
		expect(f.core.pencil(template, "b2", "requirement")).toBeNull();
		expect(f.core.setDraft(template, "b2", "uncommitted requirement")).toBeNull();
		f.externalDoc(template, {
			...designInitial,
			blocks: designInitial.blocks.map(block => block.id === "b2" ? withField(block, "design", "## A External design")! : block),
		});
		await eventually(() => fieldText(f.block(template, "b2").block, "design") === "## A External design");
		expect(f.block(template, "b2").notices).toEqual([]);
		expect(f.block(template, "b2").lock).toEqual({ kind: "human", field: "requirement", draft: "uncommitted requirement" });
		expect(fieldText(f.block(template, "b2").block, "requirement")).toBe("original requirement");
	});

	for (const pendingField of ["requirement", "design"] as const) {
		test(`disk merge preserves pending ${pendingField} while applying the other design field`, async () => {
			const f = fixture(designInitial);
			const pending = `pending ${pendingField}`;
			if (pendingField === "requirement") {
				expect(f.core.pencil(template, "b2", "requirement")).toBeNull();
				expect(f.core.setDraft(template, "b2", pending)).toBeNull();
				expect(f.core.commit(template, "b2")).toBeNull();
			} else {
				await f.hello();
				expect((await f.request({ op: "lock", args: { block: "b2" } })).ok).toBe(true);
				expect((await f.request({ op: "write", args: { block: "b2", text: pending } })).ok).toBe(true);
			}
			const diskField = pendingField === "requirement" ? "design" : "requirement";
			const diskText = `disk ${diskField}`;
			// Keep the pending field at the last-written value on disk: only the
			// other field is an external edit, not a whole-content replacement.
			f.externalDoc(template, {
				...designInitial,
				blocks: designInitial.blocks.map(block => block.id === "b2" ? withField(block, diskField, diskText)! : block),
			});
			await eventually(() => fieldText(f.block(template, "b2").block, diskField) === diskText);
			expect(f.block(template, "b2").block.content).toEqual({
				kind: "design",
				requirement: pendingField === "requirement" ? pending : diskText,
				design: pendingField === "design" ? pending : diskText,
			});
			expect(f.block(template, "b2").lock.kind).toBe(pendingField === "design" ? "coordinator" : "none");
			await eventually(() => readFileSync(f.path, "utf8") === f.store.serialize(f.document(template), null));
		});
	}

	for (const [before, after] of [[initial, designInitial], [designInitial, initial]] as const) {
		const direction = `${before.blocks[1]!.content.kind}-to-${after.blocks[1]!.content.kind}`;

		test(`a disk ${direction} switch preserves an unwritten human title commit`, async () => {
			const f = fixture(before);
			const committedTitle = "Newly committed human title";
			expect(f.core.pencil(template, "b2", "title")).toBeNull();
			expect(f.core.setDraft(template, "b2", committedTitle)).toBeNull();
			expect(f.core.commit(template, "b2")).toBeNull();
			// Switch content immediately, while disk still has the last-written title.
			expect(f.store.readTemplate()).toEqual({ ok: true, doc: before, run: null });
			f.externalDoc(template, after);
			await eventually(() => f.block(template, "b2").block.content.kind === after.blocks[1]!.content.kind);
			expect(f.block(template, "b2").block).toEqual({ ...after.blocks[1]!, title: committedTitle });
			const expected: PlaybookDoc = {
				...after,
				blocks: after.blocks.map(block => block.id === "b2" ? { ...block, title: committedTitle } : block),
			};
			await eventually(() => Bun.deepEquals(f.store.readTemplate(), { ok: true, doc: expected, run: null }));
		});

		test(`the first disk ${direction} notification already discards an invalid human draft`, async () => {
			const f = fixture(before);
			const field = before.blocks[1]!.content.kind === "task" ? "body" : "requirement";
			const draft = `Discard this ${field} draft`;
			expect(f.core.pencil(template, "b2", field)).toBeNull();
			expect(f.core.setDraft(template, "b2", draft)).toBeNull();
			expect(f.block(template, "b2").lock).toEqual({ kind: "human", field, draft });
			const diskTitle = "Kind switch with a disk title edit";
			const observed: { lock: BlockLock; notices: string[] }[] = [];
			f.core.onChange(ref => {
				if (ref !== null && ref.kind !== "template") return;
				const block = f.block(template, "b2");
				// Ignore unrelated asynchronous check notifications before the disk edit.
				// The title edit notifies before content replacement, so capture it too.
				if (block.block.title !== diskTitle) return;
				observed.push({ lock: block.lock, notices: [...block.notices] });
			});
			f.externalDoc(template, {
				...after,
				blocks: after.blocks.map(block => block.id === "b2" ? { ...block, title: diskTitle } : block),
			});
			await eventually(() => f.block(template, "b2").block.content.kind === after.blocks[1]!.content.kind);
			expect(observed.length).toBeGreaterThan(0);
			expect(observed[0]).toEqual({
				lock: { kind: "none" },
				notices: ["磁盘文件改变了块的种类，未提交的编辑已丢弃"],
			});
			expect(f.core.commit(template, "b2")).not.toBeNull();
		});
	}

	test("a disk task-to-design switch atomically replaces content, records the Run change and ends a body draft", async () => {
		const f = fixture();
		await f.hello();
		const { run, ref } = await f.startRun();
		expect(f.core.pencil(ref, "b2", "body")).toBeNull();
		expect(f.core.setDraft(ref, "b2", "discard this body draft")).toBeNull();
		const content = { kind: "design", requirement: "new requirement", design: "## A New design" } as const;
		f.externalDoc(ref, {
			...initial,
			blocks: initial.blocks.map(block => block.id === "b2" ? { ...block, content } : block),
		});
		await eventually(() => f.block(ref, "b2").block.content.kind === "design");
		expect(f.block(ref, "b2").block).toEqual({ id: "b2", title: "Source", done: false, content });
		expect(f.block(ref, "b2").lock).toEqual({ kind: "none" });
		expect(f.block(ref, "b2").notices.length).toBeGreaterThan(0);
		expect(f.core.commit(ref, "b2")).not.toBeNull();
		const entries = f.core.view(ref).timeline.filter(entry => entry.origin === "disk");
		expect(entries.map(entry => entry.data)).toEqual([{ type: "content_replaced", block: "b2", content }]);
		expect(f.store.readRunLog(run).entries.filter(entry => entry.origin === "disk")).toEqual(entries);
		expect(f.core.pencil(ref, "b2", "requirement")).toBeNull();
		expect(f.block(ref, "b2").lock).toEqual({ kind: "human", field: "requirement", draft: content.requirement });
	});

	for (const field of ["requirement", "prompt"] as const) {
		test(`a disk design-to-task switch ends a ${field} draft with a notice`, async () => {
			const f = fixture(designInitial);
			await f.hello();
			const { run, ref } = await f.startRun();
			expect(f.core.pencil(ref, "b2", field)).toBeNull();
			expect(f.core.setDraft(ref, "b2", `discard this ${field} draft`)).toBeNull();
			f.externalDoc(ref, initial);
			await eventually(() => f.block(ref, "b2").block.content.kind === "task");
			expect(f.block(ref, "b2").block).toEqual(initial.blocks[1]!);
			expect(f.block(ref, "b2").lock).toEqual({ kind: "none" });
			expect(f.block(ref, "b2").notices.length).toBeGreaterThan(0);
			expect(f.core.commit(ref, "b2")).not.toBeNull();
			const entries = f.core.view(ref).timeline.filter(entry => entry.origin === "disk");
			expect(entries.map(entry => entry.data)).toEqual([
				{ type: "content_replaced", block: "b2", content: { kind: "task", body: "before" } },
			]);
			expect(f.store.readRunLog(run).entries.filter(entry => entry.origin === "disk")).toEqual(entries);
			expect(f.core.revisions(ref, "b2")).toEqual([]);
			expect(f.core.pencil(ref, "b2", "body")).toBeNull();
			expect(f.block(ref, "b2").lock).toEqual({ kind: "human", field: "body", draft: "before" });
		});
	}

	test("disk comparison with the last write preserves an untouched field's pending human commit", async () => {
		const f = fixture();
		expect(f.core.pencil(template, "b2", "body")).toBeNull();
		expect(f.core.setDraft(template, "b2", "newly committed human body")).toBeNull();
		expect(f.core.commit(template, "b2")).toBeNull();
		// The disk program changes only title. Its body is still the last-written
		// body, so it is not a disk body edit under S2's comparison rule.
		f.externalDoc(template, { ...initial, blocks: initial.blocks.map(block => block.id === "b2" ? { ...block, title: "disk title only" } : block) });
		await eventually(() => f.block(template, "b2").block.title === "disk title only");
		expect(fieldText(f.block(template, "b2").block, "body")).toBe("newly committed human body");
		await eventually(() => readFileSync(f.path, "utf8") === f.store.serialize(f.document(template), null));
	});
});
