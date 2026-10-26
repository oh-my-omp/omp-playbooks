import { fieldText } from "../src/domain/model";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Block, BlockContent, DocRef, FetchOutcome, PlaybookDoc, Revision, RunId, RunMeta, TimelineEntry } from "../src/domain/model";
import type { Connection } from "../src/domain/ports";
import type { ErrorCode, EventPayload, Outcome, Request, RunSummary } from "../src/domain/protocol";
import { checks } from "../src/service/checks";
import { Core, type PaneControl } from "../src/service/core";
import { references } from "../src/service/references";
import { createStore } from "../src/service/store";

const BASE_TIME = Date.parse("2026-10-11T00:00:00.000Z");
const template: PlaybookDoc = {
	title: "Night operations",
	blocks: [
		{ id: "b1", title: "Prepare", content: { kind: "task", body: "First line\nSecond line\n" }, progress: { kind: "tracked", status: "done", report: null } },
		{ id: "b2", title: "Execute", content: { kind: "task", body: "Review ((b1))" }, progress: { kind: "tracked", status: "todo", report: null } },
	],
};
const designTemplate: PlaybookDoc = {
	...template,
	blocks: [
		...template.blocks,
		{
			id: "b3", title: "Deployment design", progress: { kind: "tracked", status: "done", report: null },
			content: { kind: "design", requirement: "Keep the service available.\n", design: "## A Rollout\n\nDeploy one instance at a time.\n" },
		},
	],
};
const templateRef: DocRef = { kind: "template" };
const runRef: DocRef = { kind: "run", run: "r1" };
const fixtures: { readonly directory: string; readonly cores: Core[] }[] = [];

function expectOk(outcome: Outcome<unknown>): unknown {
	expect(outcome.ok).toBe(true);
	if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
	return outcome.result;
}
function expectError(outcome: Outcome<unknown>, code: ErrorCode): void {
	expect(outcome.ok).toBe(false);
	if (outcome.ok) throw new Error(`Expected ${code}, got success`);
	expect(outcome.error.code).toBe(code);
}
function fixture(doc: PlaybookDoc = template) {
	const directory = mkdtempSync("/tmp/tern-core-runs-");
	const store = createStore(join(directory, "operations.yaml"));
	store.write(templateRef, store.serialize(doc, null));
	const cores: Core[] = [];
	fixtures.push({ directory, cores });
	let clock = BASE_TIME;
	let fetchCalls = 0;
	const fetched: FetchOutcome = { ok: true, at: BASE_TIME, value: { kind: "file", text: "External instruction" } };
	const panes: PaneControl = {
		ownPane: () => null,
		focusPane: async () => ({ ok: true }),
	};
	function newCore(): Core {
		const core = new Core({
			store, references, checks, panes,
			now: () => clock,
			fetcher: { fetch: async () => { fetchCalls++; return fetched; } },
		});
		cores.push(core);
		expect(core.load()).toBeNull();
		return core;
	}
	const core = newCore();
	const events: EventPayload[] = [];
	const eventWaiters = new Set<(event: EventPayload) => void>();
	const connection: Connection = {
		id: 1,
		send: event => {
			events.push(event);
			for (const notify of eventWaiters) notify(event);
		},
		close: () => {},
	};
	function nextEvent(): Promise<EventPayload> {
		const { promise, resolve } = Promise.withResolvers<EventPayload>();
		const notify = (event: EventPayload) => {
			eventWaiters.delete(notify);
			resolve(event);
		};
		eventWaiters.add(notify);
		return promise;
	}
	let requestNumber = 0;
	const request = (value: Request, target = core) => target.handle(connection, `q${++requestNumber}`, value);
	async function connect(target = core, session = "session-one"): Promise<void> {
		target.connected(connection);
		expectOk(await request({ op: "hello", args: { session } }, target));
	}
	function persisted(run: RunId = "r1") {
		const parsed = store.readRuns().get(run);
		if (!parsed || !parsed.ok || !parsed.run) throw new Error(`Missing persisted Run ${run}`);
		return { doc: parsed.doc, run: parsed.run };
	}
	return { core, store, events, connection, request, connect, persisted, newCore, nextEvent,
		setTime: (value: number) => { clock = value; }, fetchCount: () => fetchCalls };
}

afterEach(() => {
	for (const { cores, directory } of fixtures.splice(0)) {
		for (const core of cores) core.stop();
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Run creation and independent copies (runs.md §§1–2)", () => {
	test("start_run copies every template field, resets done and persists its start before returning", async () => {
		const f = fixture();
		await f.connect();
		expect(expectOk(await f.request({ op: "start_run", args: { name: "First run", update_every: 60 } }))).toEqual({ run: "r1" });
		const copied = template.blocks.map((block): Block => ({ ...block, progress: { kind: "tracked", status: "todo", report: null } }));
		expect(f.core.view(runRef).blocks.map(view => view.block)).toEqual(copied);
		expect(f.persisted()).toEqual({
			doc: { ...template, blocks: copied },
			run: { id: "r1", name: "First run", status: "running", startedAt: BASE_TIME, finishedAt: null, updateEvery: 60, updateDue: BASE_TIME + 60_000 },
		});
		expect(f.store.readLog({ kind: "run", run: "r1" }).entries).toEqual([{ seq: 1, at: BASE_TIME, origin: "coordinator", data: { type: "run_started", name: "First run" } }]);
		expect(f.events).toEqual([]);
		expect(f.core.edit(templateRef, "b1", "body", fieldText(f.core.view(templateRef).blocks.find(item => item.block.id === "b1")!.block, "body")!, "Changed template")).toBeNull();
		expect(f.core.view(runRef).blocks[0]!.block.content).toEqual(template.blocks[0]!.content);
		expect(f.core.edit(runRef, "b2", "title", fieldText(f.core.view(runRef).blocks.find(item => item.block.id === "b2")!.block, "title")!, "Changed run")).toBeNull();
		expect(f.core.view(templateRef).blocks[1]!.block.title).toBe("Execute");
		expect(expectOk(await f.request({ op: "start_run", args: { name: "Second run" } }))).toEqual({ run: "r2" });
		expect(f.core.view({ kind: "run", run: "r2" }).blocks[0]!.block.content).toEqual({ kind: "task", body: "Changed template" });
		expect(f.core.view({ kind: "run", run: "r2" }).blocks[1]!.block.title).toBe("Execute");
	});

	test("start_run copies design requirement and design, resets done and keeps later edits independent", async () => {
		const f = fixture(designTemplate);
		await f.connect();
		expectOk(await f.request({ op: "start_run", args: { name: "Design snapshot" } }));
		const copied = designTemplate.blocks.map((block): Block => ({ ...block, progress: { kind: "tracked", status: "todo", report: null } }));
		expect(f.core.view(runRef).blocks.map(view => view.block)).toEqual(copied);
		expect(f.persisted().doc).toEqual({ ...designTemplate, blocks: copied });
		expect(f.persisted().doc.blocks[2]!.progress).toMatchObject({ status: "todo" });

		expect(f.core.edit(templateRef, "b3", "requirement", fieldText(f.core.view(templateRef).blocks.find(item => item.block.id === "b3")!.block, "requirement")!, "Keep the service and database available.\n")).toBeNull();
		expect(f.core.view(runRef).blocks[2]!.block.content).toEqual(designTemplate.blocks[2]!.content);
		expectOk(await f.request({ op: "lock", args: { run: "r1", block: "b3" } }));
		expectOk(await f.request({ op: "write", args: { run: "r1", block: "b3", text: "## A Rollout\n\nDeploy the canary first.\n" } }));
		const templateContent: BlockContent = {
			kind: "design", requirement: "Keep the service and database available.\n", design: "## A Rollout\n\nDeploy one instance at a time.\n",
		};
		const runContent: BlockContent = {
			kind: "design", requirement: "Keep the service available.\n", design: "## A Rollout\n\nDeploy the canary first.\n",
		};
		expect(f.core.view(templateRef).blocks[2]!.block.content).toEqual(templateContent);
		expect(f.core.view(runRef).blocks[2]!.block.content).toEqual(runContent);
		f.core.stop();
		expect(f.persisted().doc.blocks[2]!.content).toEqual(runContent);
		const parsedTemplate = f.store.readTemplate();
		expect(parsedTemplate.ok).toBe(true);
		if (!parsedTemplate.ok) throw new Error(parsedTemplate.error);
		expect(parsedTemplate.doc.blocks[2]!.content).toEqual(templateContent);
		expect(parsedTemplate.doc.blocks[2]!.progress).toMatchObject({ status: "done" });
		const restarted = f.newCore();
		expect(restarted.view(templateRef).blocks[2]!.block.content).toEqual(templateContent);
		expect(restarted.view(runRef).blocks[2]!.block.content).toEqual(runContent);
		expect(restarted.view(runRef).blocks[2]!.block.progress).toMatchObject({ status: "todo" });
	});

	test("read returns flattened task and design wire blocks with kind, without revision history", async () => {
		const f = fixture(designTemplate);
		await f.connect();
		expect(f.core.requestRevision(templateRef, "b3", "Describe deployment risks.")).toBeNull();
		const task = { id: "b1", kind: "task", title: "Prepare", body: "First line\nSecond line\n", status: "done" };
		const design = {
			id: "b3", kind: "design", title: "Deployment design", status: "done",
			requirement: "Keep the service available.\n", design: "## A Rollout\n\nDeploy one instance at a time.\n",
		};
		const wireBlocks = [task, { id: "b2", kind: "task", title: "Execute", body: "Review ((b1))", status: "todo" }, design];
		expect(expectOk(await f.request({ op: "read", args: {} }))).toEqual({ title: designTemplate.title, blocks: wireBlocks });
		expect(expectOk(await f.request({ op: "read", args: { block: "b1" } }))).toEqual(task);
		expect(expectOk(await f.request({ op: "read", args: { block: "b3" } }))).toEqual(design);
		expectOk(await f.request({ op: "start_run", args: { name: "Wire snapshot" } }));
		expect(expectOk(await f.request({ op: "read", args: { run: "r1" } }))).toEqual({
			title: designTemplate.title, blocks: wireBlocks.map(block => ({ ...block, status: "todo" })), run: f.persisted().run,
		});
		expect(expectOk(await f.request({ op: "read", args: { run: "r1", block: "b1" } }))).toEqual({ ...task, status: "todo" });
		expect(expectOk(await f.request({ op: "read", args: { run: "r1", block: "b3" } }))).toEqual({ ...design, status: "todo" });
	});

	test("human done changes send events but coordinator set only appends its change", async () => {
		const f = fixture();
		await f.connect();
		expectOk(await f.request({ op: "start_run", args: { name: "Checklist" } }));
		expect(f.core.setStatus(runRef, "b1", "done")).toBeNull();
		expect(f.core.setStatus(runRef, "b1", "todo")).toBeNull();
		expect(f.events).toEqual([
			{ event: "status_changed", data: { run: "r1", block: "b1", status: "done" } },
			{ event: "status_changed", data: { run: "r1", block: "b1", status: "todo" } },
		]);
		expectOk(await f.request({ op: "lock", args: { run: "r1", block: "b1" } }));
		expectOk(await f.request({ op: "set", args: { run: "r1", block: "b1", field: "status", value: "done" } }));
		expect(f.events).toHaveLength(2);
		expect(f.store.readLog(runRef).entries.filter(entry => entry.data.type === "progress_changed").map(entry => ({ origin: entry.origin, data: entry.data }))).toEqual([
			{ origin: "human", data: { type: "progress_changed", block: "b1", progress: { kind: "tracked", status: "done", report: null } } },
			{ origin: "human", data: { type: "progress_changed", block: "b1", progress: { kind: "tracked", status: "todo", report: null } } },
			{ origin: "coordinator", data: { type: "progress_changed", block: "b1", progress: { kind: "tracked", status: "done", report: null } } },
		]);
		f.core.stop();
		expect(f.persisted().doc.blocks[0]!.progress).toMatchObject({ status: "done" });
	});
});

describe("Status updates and snooze (runs.md §6)", () => {

	// These integration cases exercise Core's platform timer; `now` controls metadata only.
	// Await the connection's actual event rather than guessing how long scheduling takes.
	test("a due sends its exact event once, stays overdue and can be rescheduled", async () => {
		const f = fixture();
		await f.connect();
		expectOk(await f.request({ op: "start_run", args: { name: "Timed", update_every: 1 } }));
		expectOk(await f.request({ op: "post", args: { run: "r1", kind: "update", text: "Current progress" } }));
		f.setTime(BASE_TIME + 1_000);
		await f.nextEvent();
		expect(f.events).toEqual([{ event: "update_due", data: { run: "r1", due: BASE_TIME + 1_000, last_update: BASE_TIME } }]);
		expect(f.store.readLog(runRef).entries.filter(entry => entry.data.type === "update_due")).toEqual([
			{ seq: 3, at: BASE_TIME + 1_000, origin: "service", data: { type: "update_due", due: BASE_TIME + 1_000 } },
		]);
		expect(f.persisted().run.updateDue).toBe(BASE_TIME + 1_000);
		expect(f.core.runs()[0]!.update_overdue).toBe(true);
		expect(f.events).toHaveLength(1);
		expect(f.store.readLog({ kind: "run", run: "r1" }).entries.filter(entry => entry.data.type === "update_due")).toHaveLength(1);
		expectOk(await f.request({ op: "snooze", args: { run: "r1", after: 1 } }));
		f.setTime(BASE_TIME + 2_000);
		await f.nextEvent();
		expect(f.events).toEqual([
			{ event: "update_due", data: { run: "r1", due: BASE_TIME + 1_000, last_update: BASE_TIME } },
			{ event: "update_due", data: { run: "r1", due: BASE_TIME + 2_000, last_update: BASE_TIME } },
		]);
		expect(f.store.readLog({ kind: "run", run: "r1" }).entries.filter(entry => entry.data.type === "update_due")).toHaveLength(2);
	});

	test("finishing before the deadline prevents a later due event and log", async () => {
		const f = fixture();
		await f.connect();
		expectOk(await f.request({ op: "start_run", args: { name: "No reminder after finish", update_every: 1 } }));
		expectOk(await f.request({ op: "start_run", args: { name: "Live timer control", update_every: 1 } }));
		expectOk(await f.request({ op: "finish_run", args: { run: "r1" } }));
		f.setTime(BASE_TIME + 2_000);
		await f.nextEvent();
		expect(f.events).toEqual([{ event: "update_due", data: { run: "r2", due: BASE_TIME + 1_000, last_update: null } }]);
		expect(f.store.readLog({ kind: "run", run: "r1" }).entries.filter(entry => entry.data.type === "update_due")).toEqual([]);
	});
});

describe("Run persistence, timeline and summaries (runs.md §§3,5–7)", () => {
	test("Run mapping is already on disk before each start/update/snooze/due/finish timeline append", async () => {
		const f = fixture();
		await f.connect();
		const observed: { readonly entry: TimelineEntry; readonly meta: RunMeta; readonly alreadyLogged: boolean }[] = [];
		const append = f.store.appendEntry.bind(f.store);
		f.store.appendEntry = (ref, entry) => {
			if (ref.kind !== "run") throw new Error("Expected Run log");
			observed.push({ entry, meta: f.persisted(ref.run).run, alreadyLogged: f.store.readLog(ref).entries.some(prior => prior.seq === entry.seq) });
			append(ref, entry);
		};
		expectOk(await f.request({ op: "start_run", args: { name: "Ordered writes", update_every: 60 } }));
		f.setTime(BASE_TIME + 1_000);
		expectOk(await f.request({ op: "post", args: { run: "r1", kind: "update", text: "Reschedule", next: 20 } }));
		f.setTime(BASE_TIME + 2_000);
		expectOk(await f.request({ op: "snooze", args: { run: "r1", after: 1 } }));
		f.setTime(BASE_TIME + 3_000);
		await f.nextEvent();
		expectOk(await f.request({ op: "finish_run", args: { run: "r1" } }));
		expect(observed.every(observation => !observation.alreadyLogged)).toBe(true);
		expect(observed.filter(observation => observation.entry.data.type !== "event_sent").map(({ entry, meta }) => ({ type: entry.data.type, status: meta.status, due: meta.updateDue, finished: meta.finishedAt }))).toEqual([
			{ type: "run_started", status: "running", due: BASE_TIME + 60_000, finished: null },
			{ type: "post", status: "running", due: BASE_TIME + 21_000, finished: null },
			{ type: "update_snoozed", status: "running", due: BASE_TIME + 3_000, finished: null },
			{ type: "update_due", status: "running", due: BASE_TIME + 3_000, finished: null },
			{ type: "run_finished", status: "finished", due: null, finished: BASE_TIME + 3_000 },
		]);
		expect(f.store.readLog({ kind: "run", run: "r1" }).entries).toEqual([...f.store.readLog(runRef).entries]);
	});

	test("runs exposes complete running/finished summaries, done counts, overdue and retrospective state", async () => {
		const f = fixture();
		await f.connect();
		expectOk(await f.request({ op: "start_run", args: { name: "Running", update_every: 60 } }));
		expect(f.core.setStatus(runRef, "b2", "done")).toBeNull();
		expectOk(await f.request({ op: "start_run", args: { name: "Finished" } }));
		f.setTime(BASE_TIME + 61_000);
		expectOk(await f.request({ op: "finish_run", args: { run: "r2" } }));
		const summaries: RunSummary[] = [
			{ id: "r1", name: "Running", status: "running", started_at: BASE_TIME, finished_at: null, done: 1, total: 2, update_due: BASE_TIME + 60_000, update_overdue: true, retrospective: false },
			{ id: "r2", name: "Finished", status: "finished", started_at: BASE_TIME, finished_at: BASE_TIME + 61_000, done: 0, total: 2, update_due: null, update_overdue: false, retrospective: false },
		];
		expect(f.core.runs()).toEqual(summaries);
		expect(expectOk(await f.request({ op: "runs", args: {} }))).toEqual({ runs: summaries });
		expectOk(await f.request({ op: "post", args: { run: "r2", kind: "retrospective", text: "Complete review" } }));
		expect(f.core.runs()[1]).toEqual({ ...summaries[1]!, retrospective: true });
	});
});
