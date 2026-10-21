import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Block, BlockId, CompileResult, DocRef, FetchOutcome, LaunchId } from "../src/domain/model";
import type { Connection, Fetcher } from "../src/domain/ports";
import type { ErrorCode, EventPayload, Outcome, Request } from "../src/domain/protocol";
import { checks } from "../src/service/checks";
import { Core } from "../src/service/core";
import { references } from "../src/service/references";
import { createStore } from "../src/service/store";

type ChangedEvent = Extract<EventPayload, { event: "block_changed" }>;
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function block(id: BlockId, body: string): Block {
	return { id, title: id, content: { kind: "task", body }, done: false };
}

function designBlock(id: BlockId, design: string, requirement = "Human requirement"): Block {
	return { id, title: id, content: { kind: "design", requirement, design }, done: false };
}

async function fixture(blocks: readonly Block[] = [block("b1", "Task:\n((b2))"), block("b2", "before")], fetcher?: Fetcher) {
	const directory = mkdtempSync("/tmp/tern-core-launch-");
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	const store = createStore(join(directory, "playbook.yaml"));
	store.write({ kind: "template" }, store.serialize({ title: "Launch integration", blocks }, null));
	const fetchCalls: string[] = [];
	let fetchOutcome: FetchOutcome = { ok: true, at: Date.parse("2026-01-01T00:00:00Z"), value: { kind: "file", text: "external before" } };
	const core = new Core({
		store, references, checks,
		fetcher: { async fetch(target, baseDir) {
			expect(baseDir).toBe(directory);
			fetchCalls.push(references.targetKey(target));
			return fetcher ? fetcher.fetch(target, baseDir) : fetchOutcome;
		} },
		panes: {
			ownPane: () => null,
			async focusPane() { return { ok: false, error: "not used by launch tests" }; },
		},
	});
	cleanups.push(() => core.stop());
	expect(core.load()).toBeNull();
	const events: EventPayload[] = [];
	let connectionId = 0;
	let requestId = 0;
	let conn: Connection;
	async function connect(session = "launch-owner") {
		conn = { id: ++connectionId, send: event => events.push(event), close() {} };
		core.connected(conn);
		expect((await core.handle(conn, `q${++requestId}`, { op: "hello", args: { session } })).ok).toBe(true);
	}
	await connect();
	const send = (request: Request) => core.handle(conn, `q${++requestId}`, request);
	async function success(request: Request): Promise<unknown> {
		const outcome = await send(request);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
		return outcome.result;
	}
	expect(core.startRun("Test run", null)).toBeNull();
	const run = core.runs()[0]!.id;
	const ref: DocRef = { kind: "run", run };
	const changed = () => events.filter((event): event is ChangedEvent => event.event === "block_changed");
	function edit(id: BlockId, body: string, field: "body" | "title" = "body") {
		expect(core.pencil(ref, id, field)).toBeNull();
		expect(core.setDraft(ref, id, body)).toBeNull();
		expect(core.commit(ref, id)).toBeNull();
	}
	async function launch(ids: readonly BlockId[] = ["b1"]) {
		const result = await success({ op: "launch", args: { run, blocks: ids } });
		const record = [...store.readRunLog(run).launches.values()].at(-1);
		if (!record) throw new Error("launch did not persist a record");
		expect(result).toEqual({ launch: record.id, kind: record.kind, text: record.snapshot.result.text });
		return record.id;
	}
	return {
		core, store, run, ref, send, success, changed, edit, launch, connect, events, fetchCalls,
		disconnect: () => core.disconnected(conn),
		setFetchOutcome: (outcome: FetchOutcome) => { fetchOutcome = outcome; },
	};
}

// Integration exception: Core owns real timers and exposes no fake-timer seam.
// These tests intentionally exercise the platform's 2 s debounce and full no-event window.
// Positive assertions wait for the observable event with a bounded deadline.
const debounce = () => Bun.sleep(2_150);
async function awaitChanges(changed: () => readonly ChangedEvent[], count: number, timeout = 3_000) {
	const deadline = Date.now() + timeout;
	while (changed().length < count && Date.now() < deadline) await Bun.sleep(10);
	expect(changed()).toHaveLength(count);
	return changed()[count - 1]!;
}
function error(outcome: Outcome<unknown>, code: ErrorCode) {
	expect(outcome.ok).toBe(false);
	if (outcome.ok) throw new Error(`Expected ${code}, got success`);
	expect(outcome.error.code).toBe(code);
	return outcome.error;
}

// launch-events.md §1–§4; references.md §4–§5.
describe("Core Launch integration", () => {
	test("human dependency edits emit after 2 s with compiled current, diff, agents and changed ids", async () => {
		const f = await fixture();
		const preview = await f.core.preview(f.ref, ["b1"]);
		expect(await f.success({ op: "compile", args: { run: f.run, blocks: ["b1"] } })).toEqual(preview);
		const launch = await f.launch();
		expect<unknown>(f.core.launchInfo(launch)!.snapshot.result).toEqual(preview);
		await f.success({ op: "bind", args: { launch, agent: "agent-alpha" } });
		await f.success({ op: "bind", args: { launch, agent: "agent-beta" } });
		const editedAt = Date.now();
		f.edit("b2", "after");
		await Bun.sleep(150);
		expect(f.changed()).toEqual([]);
		const event = await awaitChanges(f.changed, 1);
		expect(Date.now() - editedAt).toBeGreaterThanOrEqual(1_950);
		const current = references.compile(["b1"], {
			blocks: new Map([["b1", block("b1", "Task:\n((b2))").content], ["b2", block("b2", "after").content]]), fetches: new Map(), results: new Map(), inTemplate: false,
		});
		expect(event.data).toEqual({
			id: expect.any(String), launch: { id: launch, kind: "prompt", run: f.run },
			agents: ["agent-alpha", "agent-beta"], changed: ["b2"],
			diff: references.unifiedDiff("Task:\nbefore", "Task:\nafter"), current,
		});
		expect(event.data.diff).toContain("-before");
		expect(event.data.diff).toContain("+after");
		expect<unknown>(f.core.launchInfo(launch)!.snapshot.result).toEqual(preview);
		expect(f.store.readRunLog(f.run).entries.some(entry => entry.data.type === "event_sent" && entry.data.event === "block_changed")).toBe(true);
	}, 8_000);

	test("BadLaunch, UnknownBlock, template launch and CompileError never create a Launch", async () => {
		const f = await fixture([block("b1", "plain"), block("b2", "```js\nconsole.log(1);\n```"), block("b3", "((b99))")]);
		error(await f.send({ op: "launch", args: { run: f.run, blocks: [] } }), "BadLaunch");
		error(await f.send({ op: "launch", args: { run: f.run, blocks: ["b2", "b1"] } }), "BadLaunch");
		error(await f.send({ op: "launch", args: { run: f.run, blocks: ["b99"] } }), "UnknownBlock");
		// Malformed K1 boundary: omitting run targets the template in other operations,
		// but launch requires a Run and must not create a template Launch.
		// @ts-expect-error Deliberately exercise missing run at the runtime boundary.
		const templateLaunch: Request = { op: "launch", args: { blocks: ["b1"] } };
		error(await f.send(templateLaunch), "UnknownRun");
		const failure = error(await f.send({ op: "launch", args: { run: f.run, blocks: ["b3"] } }), "CompileError");
		expect(failure.detail).toMatchObject({ kind: "UnknownBlock", block: "b99" });
		expect(f.store.readRunLog(f.run).launches.size).toBe(0);
		const prompt = await f.launch(["b1"]);
		const orchestration = await f.launch(["b2"]);
		expect(prompt).toBe("l1");
		expect(f.core.launchInfo(orchestration)!.kind).toBe("orchestration");
	});

	test("design blocks cannot launch alone or with a task through either entry point", async () => {
		const f = await fixture([block("b1", "plain task"), designBlock("b2", "## A Overview\nDesign")]);
		const selections: readonly (readonly BlockId[])[] = [["b2"], ["b1", "b2"], ["b2", "b1"]];
		for (const blocks of selections) {
			error(await f.send({ op: "launch", args: { run: f.run, blocks } }), "BadLaunch");
			expect(f.core.requestLaunch(f.run, blocks)).not.toBeNull();
			expect(f.events.filter(event => event.event === "launch_requested")).toEqual([]);
			expect(f.store.readRunLog(f.run).launches.size).toBe(0);
		}
		expect(f.core.requestLaunch(f.run, ["b1"])).toBeNull();
		expect(f.events.filter(event => event.event === "launch_requested")).toEqual([
			{ event: "launch_requested", data: { run: f.run, blocks: ["b1"] } },
		]);
		expect(await f.launch(["b1"])).toBe("l1");
	});

	test("launch rechecks task kind after a disk edit while an external fetch is pending", async () => {
		const fetched = Promise.withResolvers<FetchOutcome>();
		const started = Promise.withResolvers<void>();
		const f = await fixture([block("b1", "Task:\n((file:context.txt))")], {
			fetch() {
				started.resolve();
				return fetched.promise;
			},
		});
		let settled = false;
		const pending = f.send({ op: "launch", args: { run: f.run, blocks: ["b1"] } }).then(outcome => {
			settled = true;
			return outcome;
		});
		await started.promise;
		expect(settled).toBe(false);
		expect(f.fetchCalls).toEqual(["file:context.txt"]);

		const replacement = designBlock("b1", "## A Overview\nDesign after disk edit", "Requirement after disk edit");
		const before = f.core.view(f.ref);
		expect(before.blocks[0]!.block.content.kind).toBe("task");
		f.store.write(f.ref, f.store.serialize({ title: before.title, blocks: [replacement] }, before.run));
		// Core owns real disk polling with no fake-clock seam; wait for the observed kind change, not a fixed delay.
		const deadline = Date.now() + 3_000;
		while (f.core.view(f.ref).blocks[0]!.block.content.kind !== "design" && Date.now() < deadline) await Bun.sleep(10);
		expect(f.core.view(f.ref).blocks[0]!.block).toEqual(replacement);
		expect(settled).toBe(false);

		fetched.resolve({ ok: true, at: Date.parse("2026-01-01T00:00:00Z"), value: { kind: "file", text: "external before" } });
		error(await pending, "BadLaunch");
		expect(f.fetchCalls).toEqual(["file:context.txt"]);
		expect(f.store.readRunLog(f.run).launches.size).toBe(0);
		expect(f.store.readServiceRecords().filter(record => record.kind === "launch")).toEqual([]);
		const after = f.core.view(f.ref);
		expect(after.blocks[0]!.launches).toEqual([]);
		expect(after.timeline.filter(entry => entry.data.type === "launch_created")).toEqual([]);
	}, 8_000);

	for (const operation of ["write", "panel"] as const) {
		test(`coordinator ${operation} of a referenced design notifies the running Launch after the judge delay`, async () => {
			const before = "## A Overview\nbefore\n\n## B Unchanged\nKeep this panel";
			const after = "## A Overview\nafter\n\n## B Unchanged\nKeep this panel";
			const f = await fixture([block("b1", 'Task:\n((b2 | panel("A")))'), designBlock("b2", before)]);
			const launch = await f.launch();
			const snapshot = f.core.launchInfo(launch)!.snapshot;
			expect(snapshot.result).toMatchObject({ kind: "Ok", text: "Task:\n## A Overview\nbefore" });
			await f.success({ op: "bind", args: { launch, agent: "design-worker" } });
			await f.success({ op: "lock", args: { run: f.run, block: "b2" } });
			const editedAt = Date.now();
			if (operation === "write") {
				await f.success({ op: "write", args: { run: f.run, block: "b2", text: after } });
			} else {
				await f.success({ op: "panel", args: { run: f.run, block: "b2", panel: "A", text: "## A Overview\nafter" } });
			}
			await Bun.sleep(150);
			expect(f.changed()).toEqual([]);
			const event = await awaitChanges(f.changed, 1);
			expect(Date.now() - editedAt).toBeGreaterThanOrEqual(1_950);
			expect(event.data.launch).toEqual({ id: launch, kind: "prompt", run: f.run });
			expect(event.data.agents).toEqual(["design-worker"]);
			expect(event.data.changed).toEqual(["b2"]);
			expect(event.data.current).toMatchObject({ kind: "Ok", text: "Task:\n## A Overview\nafter" });
			expect(event.data.diff).toBe(references.unifiedDiff("Task:\n## A Overview\nbefore", "Task:\n## A Overview\nafter"));
			const persisted = f.store.readRuns().get(f.run);
			if (!persisted?.ok) throw new Error("expected persisted Run");
			expect(persisted.doc.blocks.find(block => block.id === "b2")!.content).toEqual({
				kind: "design", requirement: "Human requirement", design: after,
			});
			expect(f.core.launchInfo(launch)!.snapshot).toEqual(snapshot);
			expect(f.store.readRunLog(f.run).entries.some(entry => entry.data.type === "event_sent" && entry.data.event === "block_changed")).toBe(true);
		}, 8_000);
	}

	test("ordered multi-block snapshot equals compile and is frozen across edits and rebase", async () => {
		const f = await fixture([block("b1", "first"), block("b2", "second")]);
		const ids: readonly BlockId[] = ["b2", "b1"];
		const compiled = await f.success({ op: "compile", args: { run: f.run, blocks: ids } });
		const launch = await f.launch(ids);
		const snapshot = f.core.launchInfo(launch)!.snapshot;
		expect<unknown>(snapshot.result).toEqual(compiled);
		expect(snapshot.result.text).toBe("second\n\nfirst");
		f.edit("b1", "new first");
		await f.success({ op: "rebase", args: { launch } });
		expect(f.core.launchInfo(launch)!.snapshot).toEqual(snapshot);
		expect(f.store.readRunLog(f.run).launches.get(launch)!.snapshot).toEqual(snapshot);
	});

	test("pending ack suppresses a second event; ack immediately judges later edits after the deadline", async () => {
		const f = await fixture();
		const launch = await f.launch();
		f.edit("b2", "first change");
		const first = await awaitChanges(f.changed, 1);
		f.edit("b2", "second change");
		await debounce();
		expect(f.changed()).toHaveLength(1);
		expect(f.core.launchInfo(launch)!.notified).toBeNull();
		expect(f.core.launchInfo(launch)!.dirty.map(([id]) => id)).toEqual(["b2"]);
		await f.success({ op: "ack", args: { event: first.data.id } });
		const second = await awaitChanges(f.changed, 2, 500);
		expect(second.data.id).not.toBe(first.data.id);
		expect(second.data.current).toMatchObject({ kind: "Ok", text: "Task:\nsecond change" });
		expect(f.core.launchInfo(launch)!.notified).toEqual(first.data.current);
		await f.success({ op: "ack", args: { event: second.data.id } });
		expect(f.core.launchInfo(launch)!.dirty).toEqual([]);
		expect(f.core.launchInfo(launch)!.notified).toEqual(second.data.current);
	}, 10_000);

	test("after ack a dirty edit with the same compiled result is not resent", async () => {
		const f = await fixture([block("b1", "((b2 | lines(1..1)))"), block("b2", "before\nignored")]);
		const launch = await f.launch();
		f.edit("b2", "after\nignored");
		const first = await awaitChanges(f.changed, 1);
		await f.success({ op: "ack", args: { event: first.data.id } });
		f.edit("b2", "after\ndifferent ignored line");
		await debounce();
		expect(f.changed()).toHaveLength(1);
		expect(f.core.launchInfo(launch)!.dirty).toEqual([]);
		expect(f.core.launchInfo(launch)!.notified).toEqual(first.data.current);
	}, 10_000);

	test("returning to baseline emits nothing, resets notified and allows a later repeat change", async () => {
		const f = await fixture();
		const launch = await f.launch();
		f.edit("b2", "after");
		const first = await awaitChanges(f.changed, 1);
		await f.success({ op: "ack", args: { event: first.data.id } });
		f.edit("b2", "before");
		await debounce();
		expect(f.changed()).toHaveLength(1);
		expect(f.core.launchInfo(launch)!.notified).toBeNull();
		expect(f.core.launchInfo(launch)!.dirty).toEqual([]);
		f.edit("b2", "after");
		const second = await awaitChanges(f.changed, 2);
		expect(second.data.current).toEqual(first.data.current);
	}, 12_000);

	for (const operation of ["edit", "write"] as const) {
		test(`coordinator task ${operation} and human title/done edits do not trigger changes, including reconnect`, async () => {
			const f = await fixture();
			const launch = await f.launch();
			await f.success({ op: "lock", args: { run: f.run, block: "b2" } });
			if (operation === "edit") {
				await f.success({ op: "edit", args: { run: f.run, block: "b2", find: "before", replace: "coordinator edit" } });
			} else {
				await f.success({ op: "write", args: { run: f.run, block: "b2", text: "coordinator edit" } });
			}
			f.disconnect(); // Releases the coordinator lock without a human body edit.
			await f.connect();
			f.edit("b2", "human title", "title");
			expect(f.core.setDone(f.ref, "b2", true)).toBeNull();
			await debounce();
			expect(f.changed()).toEqual([]);
			expect(f.core.launchInfo(launch)!.dirty).toEqual([]);
			expect(await f.core.preview(f.ref, ["b1"])).toMatchObject({ kind: "Ok", text: "Task:\ncoordinator edit" });
		}, 8_000);
	}

	test("deleting a referenced block emits Err with an empty diff; failed rebase preserves state", async () => {
		const f = await fixture();
		const launch = await f.launch();
		expect(f.core.deleteBlock(f.ref, "b2")).toBeNull();
		const event = await awaitChanges(f.changed, 1);
		expect(event.data.changed).toEqual(["b2"]);
		expect(event.data.diff).toBe("");
		expect(event.data.current).toMatchObject({ kind: "Err", error: { kind: "UnknownBlock", block: "b2", at: { block: "b1", reference: "((b2))" } } });
		const before = f.core.launchInfo(launch)!;
		error(await f.send({ op: "rebase", args: { launch } }), "CompileError");
		expect(f.core.launchInfo(launch)).toEqual(before);
		await f.success({ op: "ack", args: { event: event.data.id } });
		expect(f.core.launchInfo(launch)!.notified).toEqual(event.data.current);
	}, 8_000);

	test("rebase discards pending event and moves the diff reference to the newest baseline", async () => {
		const f = await fixture();
		const launch = await f.launch();
		const snapshot = f.core.launchInfo(launch)!.snapshot;
		f.edit("b2", "rebased");
		const first = await awaitChanges(f.changed, 1);
		expect(await f.success({ op: "rebase", args: { launch } })).toEqual({ baseline: "Task:\nrebased" });
		expect(f.core.launchInfo(launch)!.baselines).toEqual(["Task:\nbefore", "Task:\nrebased"]);
		expect(f.core.launchInfo(launch)!.dirty).toEqual([]);
		expect(f.core.launchInfo(launch)!.notified).toBeNull();
		error(await f.send({ op: "ack", args: { event: first.data.id } }), "UnknownEvent");
		f.edit("b2", "changed again");
		const second = await awaitChanges(f.changed, 2);
		expect(second.data.diff).toBe(references.unifiedDiff("Task:\nrebased", "Task:\nchanged again"));
		expect(second.data.diff).toContain("-rebased");
		expect(f.core.launchInfo(launch)!.snapshot).toEqual(snapshot);
	}, 10_000);

	test("bind, close and rebase reject unknown Launches and non-owner sessions", async () => {
		const f = await fixture();
		const launch = await f.launch();
		const initial = f.core.launchInfo(launch)!;
		f.disconnect();
		await f.connect("other-session");
		function operations(id: LaunchId): Request[] {
			return [{ op: "bind", args: { launch: id, agent: "intruder" } }, { op: "close", args: { launch: id } }, { op: "rebase", args: { launch: id } }];
		}
		for (const request of operations("l999")) error(await f.send(request), "UnknownLaunch");
		for (const request of operations(launch)) error(await f.send(request), "NotOwner");
		expect(f.core.launchInfo(launch)).toEqual(initial);
		f.disconnect();
		await f.connect();
		await f.success({ op: "bind", args: { launch, agent: "owner-agent" } });
		await f.success({ op: "close", args: { launch } });
		expect(f.core.launchInfo(launch)!.closed?.by).toBe("coordinator");
	});

	test("disconnect drops pending delivery; same session reconnect immediately judges dirty edits", async () => {
		const f = await fixture();
		const launch = await f.launch();
		f.edit("b2", "first unacknowledged");
		const first = await awaitChanges(f.changed, 1);
		f.disconnect();
		f.edit("b2", "offline change");
		await debounce();
		expect(f.changed()).toHaveLength(1);
		expect(f.core.launchInfo(launch)!.notified).toBeNull();
		// A newly edited value has not yet reached its 2 s deadline; hello overrides it.
		f.edit("b2", "just before reconnect");
		await f.connect();
		const second = await awaitChanges(f.changed, 2, 500);
		expect(second.data.id).not.toBe(first.data.id);
		expect(second.data.current).toMatchObject({ kind: "Ok", text: "Task:\njust before reconnect" });
		error(await f.send({ op: "ack", args: { event: first.data.id } }), "UnknownEvent");
		await f.success({ op: "ack", args: { event: second.data.id } });
		expect(f.core.launchInfo(launch)!.dirty).toEqual([]);
	}, 10_000);

	test("human close discards pending and queued judgments and prevents later events", async () => {
		const f = await fixture();
		const launch = await f.launch();
		f.edit("b2", "pending change");
		const first = await awaitChanges(f.changed, 1);
		const queued = await f.launch();
		const beforeCount = f.changed().length;
		f.edit("b2", "future change");
		expect(f.core.closeLaunch(launch)).toBeNull();
		expect(f.core.closeLaunch(queued)).toBeNull();
		expect(f.core.launchInfo(queued)!.closed?.by).toBe("human");
		expect(f.core.launchInfo(launch)!.closed?.by).toBe("human");
		const closed = f.core.launchInfo(first.data.launch.id)!;
		error(await f.send({ op: "ack", args: { event: first.data.id } }), "UnknownEvent");
		expect(f.core.launchInfo(first.data.launch.id)).toEqual(closed);
		await debounce();
		f.disconnect();
		await f.connect();
		await Bun.sleep(50);
		expect(f.changed()).toHaveLength(beforeCount);
	}, 10_000);

	test("external references fetch once until explicit refetch; existing Launch judgments and rebase retain their fetch table", async () => {
		const f = await fixture([block("b1", "Task:\n((file:context.txt))")]);
		const compile = await f.success({ op: "compile", args: { run: f.run, blocks: ["b1"] } });
		const launch = await f.launch();
		const snapshot = f.core.launchInfo(launch)!.snapshot;
		expect<unknown>(snapshot.result).toEqual(compile);
		expect(snapshot.fetches).toHaveLength(1);
		await f.core.preview(f.ref, ["b1"]);
		await f.success({ op: "inspect", args: { run: f.run, blocks: ["b1"] } });
		f.core.view(f.ref);
		expect(f.fetchCalls).toEqual(["file:context.txt"]);
		f.setFetchOutcome({ ok: true, at: Date.parse("2026-01-02T00:00:00Z"), value: { kind: "file", text: "external refetched" } });
		await f.success({ op: "refetch", args: { run: f.run, targets: ["file:context.txt"] } });
		expect(f.fetchCalls).toEqual(["file:context.txt", "file:context.txt"]);
		const documentPreview = await f.core.preview(f.ref, ["b1"]);
		if (documentPreview.kind !== "Ok") throw new Error("expected successful refetched preview");
		expect(documentPreview.text).toContain("external refetched");
		expect(f.core.launchInfo(launch)!.fetches).toEqual(snapshot.fetches);
		f.edit("b1", "Modified task:\n((file:context.txt))");
		const event = await awaitChanges(f.changed, 1);
		const frozen: CompileResult = references.compile(["b1"], {
			blocks: new Map([["b1", block("b1", "Modified task:\n((file:context.txt))").content]]),
			fetches: new Map(snapshot.fetches), results: new Map(snapshot.results), inTemplate: false,
		});
		expect(event.data.current).toEqual(frozen);
		if (frozen.kind !== "Ok") throw new Error("expected successful frozen compile");
		expect(frozen.text).toContain("external before");
		expect(frozen.text).not.toContain("external refetched");
		await f.success({ op: "ack", args: { event: event.data.id } });
		expect(await f.success({ op: "rebase", args: { launch } })).toEqual({ baseline: frozen.text });
		expect(f.core.launchInfo(launch)!.snapshot).toEqual(snapshot);
		expect(f.core.launchInfo(launch)!.fetches).toEqual(snapshot.fetches);
		expect(f.fetchCalls).toHaveLength(2);
		// A newly introduced target is fetched once and appended without replacing the old one.
		f.edit("b1", "Modified task:\n((file:context.txt))\n((file:new.txt))");
		const second = await awaitChanges(f.changed, 2);
		const extended = f.core.launchInfo(launch)!;
		expect(second.data.current).toEqual(references.compile(["b1"], {
			blocks: new Map([["b1", block("b1", "Modified task:\n((file:context.txt))\n((file:new.txt))").content]]),
			fetches: new Map(extended.fetches), results: new Map(snapshot.results), inTemplate: false,
		}));
		if (second.data.current.kind !== "Ok") throw new Error("expected successful extended compile");
		expect(second.data.current.text).toContain("external before");
		expect(second.data.current.text).toContain("external refetched");
		expect(f.fetchCalls).toEqual(["file:context.txt", "file:context.txt", "file:new.txt"]);
		expect(f.core.launchInfo(launch)!.fetches.map(([key]) => key)).toEqual(["file:context.txt", "file:new.txt"]);
		expect(f.core.launchInfo(launch)!.snapshot).toEqual(snapshot);
		expect(f.store.readRunLog(f.run).launches.get(launch)!.fetches).toEqual(f.core.launchInfo(launch)!.fetches);
		await f.success({ op: "ack", args: { event: second.data.id } });
		const beforeHumanRefetch = f.core.launchInfo(launch)!.fetches;
		f.setFetchOutcome({ ok: true, at: Date.parse("2026-01-03T00:00:00Z"), value: { kind: "file", text: "human refetched" } });
		expect(await f.core.refetch(f.ref, "file:context.txt")).toBeNull();
		expect(f.fetchCalls).toEqual(["file:context.txt", "file:context.txt", "file:new.txt", "file:context.txt"]);
		expect(f.core.launchInfo(launch)!.fetches).toEqual(beforeHumanRefetch);
		expect(f.core.launchInfo(launch)!.snapshot).toEqual(snapshot);
		expect(f.core.launchInfo(launch)!.dirty).toEqual([]);
	}, 12_000);
});

// C2 / C3-Core of #9: launch defaults, closed-Launch guards, and race-free rebase.
describe("Launch execution contract and lifecycle guards", () => {
	const configured = (id: BlockId, body: string, agent?: string, isolated?: boolean): Block => ({
		id, title: id, done: false,
		content: { kind: "task", body, ...(agent === undefined ? {} : { agent }), ...(isolated === undefined ? {} : { isolated }) },
	});

	test("launch returns the contract every root shares; a contract change neither dirties the Launch nor notifies", async () => {
		const f = await fixture([configured("b1", "one ((b4))", "task:mid", true), configured("b2", "two", "task:mid", false), configured("b3", "three"), configured("b4", "source", "task:low")]);
		expect(await f.success({ op: "launch", args: { run: f.run, blocks: ["b1"] } })).toEqual({ launch: "l1", kind: "prompt", text: "one source", agent: "task:mid", isolated: true });
		expect(await f.success({ op: "launch", args: { run: f.run, blocks: ["b1", "b2"] } })).toEqual({ launch: "l2", kind: "prompt", text: "one source\n\ntwo", agent: "task:mid" });
		expect(await f.success({ op: "launch", args: { run: f.run, blocks: ["b1", "b3"] } })).toEqual({ launch: "l3", kind: "prompt", text: "one source\n\nthree" });
		await f.success({ op: "lock", args: { run: f.run, block: "b4" } });
		await f.success({ op: "set", args: { run: f.run, block: "b4", field: "agent", value: null } });
		await f.success({ op: "set", args: { run: f.run, block: "b4", field: "isolated", value: true } });
		expect(f.core.launchInfo("l1")!.dirty).toEqual([]);
		await debounce();
		expect(f.changed()).toEqual([]);
		expect(f.store.readRunLog(f.run).entries.filter(entry => entry.data.type === "content_replaced").map(entry => entry.data)).toEqual([
			{ type: "content_replaced", block: "b4", content: { kind: "task", body: "source" } },
			{ type: "content_replaced", block: "b4", content: { kind: "task", body: "source", isolated: true } },
		]);
	}, 6_000);

	test("a closed Launch refuses bind and rebase but still answers info, close and late results; post refuses another Run's Launch", async () => {
		const f = await fixture();
		const launch = await f.launch();
		await f.success({ op: "close", args: { launch } });
		const closed = f.core.launchInfo(launch)!;
		expect(error(await f.send({ op: "bind", args: { launch, agent: "late" } }), "BadLaunch").message).toBe("Launch 已关闭");
		expect(error(await f.send({ op: "rebase", args: { launch } }), "BadLaunch").message).toBe("Launch 已关闭");
		expect(await f.success({ op: "close", args: { launch } })).toBeNull();
		expect(await f.success({ op: "launch_info", args: { launch } })).toEqual(closed);
		expect(f.core.launchInfo(launch)).toEqual(closed);
		expect(await f.success({ op: "post", args: { run: f.run, kind: "result", text: "late", block: "b1", launch } })).toEqual({ seq: expect.any(Number) });
		expect(f.core.startRun("Other run", null)).toBeNull();
		const other = f.core.runs().at(-1)!.id;
		const before = f.store.readRunLog(other).entries;
		expect(error(await f.send({ op: "post", args: { run: other, kind: "result", text: "wrong run", block: "b1", launch } }), "BadValue").message).toBe("Launch 不属于这个 Run");
		expect(f.store.readRunLog(other).entries).toEqual(before);
	});

	test("rebase refuses roots that no longer form a Launch of the same kind", async () => {
		const f = await fixture([block("b1", "Task:\n((b2))"), block("b2", "before"), block("b3", "third")]);
		const switched = await f.launch(["b1"]);
		f.edit("b1", "```js\nconsole.log(1);\n```");
		expect(error(await f.send({ op: "rebase", args: { launch: switched } }), "BadLaunch").message).toContain("执行块");
		const multi = await f.launch(["b2", "b3"]);
		f.edit("b3", "```js\nconsole.log(3);\n```");
		expect(error(await f.send({ op: "rebase", args: { launch: multi } }), "BadLaunch").message).toBe("编排块只能单独启动");
		const deleted = await f.launch(["b2"]);
		await f.success({ op: "lock", args: { run: f.run, block: "b2" } });
		await f.success({ op: "delete", args: { run: f.run, block: "b2" } });
		expect(error(await f.send({ op: "rebase", args: { launch: deleted } }), "BadLaunch").message).toContain("b2");
		for (const id of [switched, multi, deleted]) expect(f.core.launchInfo(id)!.baselines).toHaveLength(1);
	});

	test("an edit made while rebase fetches stays dirty and is judged against the new baseline", async () => {
		let release: () => void = () => { throw new Error("fetch not started"); };
		const gated: Fetcher = {
			async fetch(target) {
				const key = references.targetKey(target);
				if (key === "file:new.txt") await new Promise<void>(resolve => { release = resolve; });
				return { ok: true, at: Date.parse("2026-01-01T00:00:00Z"), value: { kind: "file", text: `text of ${key}` } };
			},
		};
		const f = await fixture(undefined, gated);
		const launch = await f.launch();
		f.edit("b2", "uses ((file:new.txt))");
		// The rebase request runs until it awaits the gated fetch, so this edit lands mid-rebase.
		const rebased = f.send({ op: "rebase", args: { launch } });
		f.edit("b2", "later ((file:new.txt))");
		const lateSeq = f.core.launchInfo(launch)!.dirty.find(([id]) => id === "b2")![1];
		release();
		const outcome = await rebased;
		const baselines = f.core.launchInfo(launch)!.baselines;
		expect(baselines).toHaveLength(2);
		expect(outcome).toEqual({ ok: true, result: { baseline: baselines[1] } });
		expect(baselines[1]).toContain("later");
		expect(baselines[1]).toContain("text of file:new.txt");
		expect(f.core.launchInfo(launch)!.dirty).toEqual([["b2", lateSeq]]);
		await debounce();
		expect(f.changed()).toEqual([]);
		expect(f.core.launchInfo(launch)!.dirty).toEqual([]);
	}, 8_000);

	test("a judgment compiles the contents current after its fetch, so its current is what rebase accepts", async () => {
		let release: () => void = () => { throw new Error("fetch not started"); };
		const gated: Fetcher = {
			async fetch(target) {
				const key = references.targetKey(target);
				if (key === "file:new.txt") await new Promise<void>(resolve => { release = resolve; });
				return { ok: true, at: Date.parse("2026-01-01T00:00:00Z"), value: { kind: "file", text: `text of ${key}` } };
			},
		};
		const f = await fixture(undefined, gated);
		const launch = await f.launch();
		// The document's own check pass starts this fetch; the judgment waits for the same in-flight fetch.
		f.edit("b2", "first ((file:new.txt))");
		await debounce();
		expect(f.changed()).toEqual([]);
		f.edit("b2", "latest ((file:other.txt))");
		release();
		const event = await awaitChanges(f.changed, 1);
		const judged = 'Task:\nlatest <external source="file:other.txt" fetched="2026-01-01T00:00:00.000Z">\ntext of file:other.txt\n</external>';
		expect(event.data.current).toMatchObject({ kind: "Ok", text: judged });
		expect(await f.success({ op: "rebase", args: { launch } })).toEqual({ baseline: judged });
	}, 10_000);

	test("edit numbers continue above persisted dirty entries after a restart, so rebase clears what it accepted", async () => {
		const f = await fixture();
		const launch = await f.launch();
		f.disconnect();
		for (const text of ["one", "two", "three"]) f.edit("b2", text);
		const persisted = f.core.launchInfo(launch)!.dirty;
		expect(persisted.map(([id]) => id)).toEqual(["b2"]);
		f.core.stop();
		const restarted = new Core({ store: f.store, references, checks, fetcher: { async fetch() { throw new Error("no external targets"); } }, panes: { ownPane: () => null, async focusPane() { return { ok: false, error: "unused" }; } } });
		cleanups.push(() => restarted.stop());
		expect(restarted.load()).toBeNull();
		const conn: Connection = { id: 99, send() {}, close() {} };
		restarted.connected(conn);
		expect((await restarted.handle(conn, "hello", { op: "hello", args: { session: "launch-owner" } })).ok).toBe(true);
		expect(await restarted.handle(conn, "rebase", { op: "rebase", args: { launch } })).toEqual({ ok: true, result: { baseline: "Task:\nthree" } });
		expect(restarted.launchInfo(launch)!.dirty).toEqual([]);
		expect(restarted.pencil(f.ref, "b2", "body")).toBeNull();
		expect(restarted.setDraft(f.ref, "b2", "four")).toBeNull();
		expect(restarted.commit(f.ref, "b2")).toBeNull();
		const [[, next]] = restarted.launchInfo(launch)!.dirty as [[BlockId, number]];
		expect(next).toBeGreaterThan(persisted[0]![1]);
	});

	test("rebase and later judgments compile with the Run's current block results", async () => {
		const f = await fixture([block("b1", "Task:\n((b2.result))"), block("b2", "producer")]);
		await f.success({ op: "post", args: { run: f.run, kind: "result", text: "first result", block: "b2" } });
		const launch = await f.launch();
		await f.success({ op: "post", args: { run: f.run, kind: "result", text: "second result", block: "b2" } });
		expect(await f.success({ op: "rebase", args: { launch } })).toEqual({ baseline: "Task:\nsecond result" });
		expect(f.core.launchInfo(launch)!.snapshot.result).toMatchObject({ text: "Task:\nfirst result" });
		f.edit("b1", "Changed task:\n((b2.result))");
		const event = await awaitChanges(f.changed, 1);
		expect(event.data.current).toMatchObject({ kind: "Ok", text: "Changed task:\nsecond result" });
		expect(event.data.diff).toBe(references.unifiedDiff("Task:\nsecond result", "Changed task:\nsecond result"));
	}, 8_000);
});
