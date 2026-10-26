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
		{ id: "b1", title: "Root", content: { kind: "task", body: "root ((b2))" }, progress: { kind: "tracked", status: "todo", report: null } },
		{ id: "b2", title: "Source", content: { kind: "task", body: "before" }, progress: { kind: "tracked", status: "todo", report: null } },
		{ id: "b3", title: "Disposable", content: { kind: "task", body: "third" }, progress: { kind: "tracked", status: "todo", report: null } },
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

	for (const [label, invalid] of [
		["unparseable YAML", "title: ["],
		["invalid block shape", "title: bad\nblocks:\n - {id: b1, title: bad, body: changed, done: not-a-boolean}\n"],
	] as const) {
		test(`${label} is not applied or overwritten, reports an error, and permits writes after recovery`, async () => {
			const f = fixture();
			f.externalText(template, invalid);
			await eventually(() => f.core.view(template).errors.some(error => error.includes("文件不能解析")));
			expect(f.document(template)).toEqual(initial);
			expect(f.core.edit(template, "b2", "body", fieldText(f.core.view(template).blocks.find(item => item.block.id === "b2")!.block, "body")!, "human edit while file is invalid")).toBeNull();
			await Bun.sleep(ONE_SECOND_WINDOW);
			expect(readFileSync(f.path, "utf8")).toBe(invalid);
			expect(f.core.view(template).errors.length).toBeGreaterThan(0);
			const recovered = f.document(template);
			f.externalDoc(template, recovered);
			await eventually(() => f.core.view(template).errors.length === 0);
			expect(f.document(template)).toEqual(recovered);
			expect(f.core.setStatus(template, "b2", "done")).toBeNull();
			await eventually(() => readFileSync(f.path, "utf8") === f.store.serialize(f.document(template), null));
		}, 6_000);
	}

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

	for (const [before, after] of [[initial, designInitial], [designInitial, initial]] as const) {
		const direction = `${before.blocks[1]!.content.kind}-to-${after.blocks[1]!.content.kind}`;

		test(`a disk ${direction} switch preserves an unwritten human title commit`, async () => {
			const f = fixture(before);
			const committedTitle = "Newly committed human title";
			expect(f.core.edit(template, "b2", "title", fieldText(f.core.view(template).blocks.find(item => item.block.id === "b2")!.block, "title")!, committedTitle)).toBeNull();
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

		
	}

	test("disk comparison with the last write preserves an untouched field's pending human commit", async () => {
		const f = fixture();
		expect(f.core.edit(template, "b2", "body", fieldText(f.core.view(template).blocks.find(item => item.block.id === "b2")!.block, "body")!, "newly committed human body")).toBeNull();
		// The disk program changes only title. Its body is still the last-written
		// body, so it is not a disk body edit under S2's comparison rule.
		f.externalDoc(template, { ...initial, blocks: initial.blocks.map(block => block.id === "b2" ? { ...block, title: "disk title only" } : block) });
		await eventually(() => f.block(template, "b2").block.title === "disk title only");
		expect(fieldText(f.block(template, "b2").block, "body")).toBe("newly committed human body");
		await eventually(() => readFileSync(f.path, "utf8") === f.store.serialize(f.document(template), null));
	});
	test("human edits write a complete atomic replacement while an existing reader retains the old file", async () => {
		const f = fixture();
		const before = readFileSync(f.path, "utf8");
		const reader = openSync(f.path, "r");
		try {
			expect(f.core.edit(template, "b2", "body", "before", "Human body")).toBeNull();
			await eventually(() => readFileSync(f.path, "utf8").includes("Human body"));
			expect(readFileSync(reader, "utf8")).toBe(before);
			expect(structuredClone(f.store.readTemplate())).toMatchObject({ ok: true, doc: { blocks: expect.arrayContaining([expect.objectContaining({ id: "b2", content: { kind: "task", body: "Human body" } })]) } });
		} finally { closeSync(reader); }
	});
	test("coordinator Run edits are persisted without modifying the template", async () => {
		const f = fixture(); await f.hello(); const { run, ref } = await f.startRun();
		await f.request({ op: "lock", args: { run, block: "b2" } });
		expect(await f.request({ op: "write", args: { run, block: "b2", text: "Run body" } })).toMatchObject({ ok: true });
		await eventually(() => readFileSync(f.pathFor(ref), "utf8").includes("Run body"));
		expect(readFileSync(f.path, "utf8")).not.toContain("Run body");
	});
	test("external insertion deletion field changes and order are recorded independently", async () => {
		const f = fixture();
		const next: PlaybookDoc = { title: "Disk title", blocks: [
			{ ...initial.blocks[1]!, title: "Disk block", content: { kind: "task", body: "Disk body" }, progress: { kind: "tracked", status: "done", report: "Report" } },
			{ id: "b4", title: "Inserted", content: { kind: "task", body: "New" }, progress: { kind: "tracked", status: "todo", report: null } },
			initial.blocks[0]!,
		] };
		f.externalDoc(template, next);
		await eventually(() => Bun.deepEquals(f.document(template), next));
		const entries = f.store.readLog(template).entries;
		for (const type of ["block_added", "block_deleted", "block_edited", "progress_changed", "blocks_reordered"]) expect(entries.some(entry => entry.data.type === type)).toBe(true);
	});
	test("disk execution contract changes preserve pending body edits without dirtying a Launch", async () => {
		const f = fixture(); await f.hello();
		await f.request({ op: "launch", args: { blocks: ["b1"] } });
		expect(f.core.setAgent(template, "b2", "human-agent")).toBeNull();
		f.externalDoc(template, { ...initial, blocks: initial.blocks.map(block => block.id === "b2" ? { ...block, content: { kind: "task", body: "before", isolated: true } } : block) });
		await eventually(() => { const content = f.block(template, "b2").block.content; return content.kind === "task" && content.isolated === true; });
		expect(f.block(template, "b2").block.content).toEqual({ kind: "task", body: "before", agent: "human-agent", isolated: true });
		expect(f.store.readLog(template).launches.get("l1")!.dirty).toEqual([]);
	});
	test("disk dependency deletion is observed by an open Launch as a compile failure", async () => {
		const f = fixture(); await f.hello();
		await f.request({ op: "launch", args: { blocks: ["b1"] } });
		f.externalDoc(template, { ...initial, blocks: initial.blocks.filter(block => block.id !== "b2") });
		await eventually(() => f.events.some(event => event.event === "block_changed"), 4_000);
		expect(f.events).toContainEqual(expect.objectContaining({ event: "block_changed", data: expect.objectContaining({ changed: ["b2"], current: expect.objectContaining({ kind: "Err", error: expect.objectContaining({ kind: "UnknownBlock", block: "b2" }) }) }) }));
	}, 5_000);
});
