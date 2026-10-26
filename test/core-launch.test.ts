import { launchFooter } from "../src/service/footer";
import type { Store } from "../src/domain/ports";
import { fieldText } from "../src/domain/model";
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
	return { id, title: id, content: { kind: "task", body }, progress: { kind: "tracked", status: "todo", report: null } };
}

function designBlock(id: BlockId, design: string, requirement = "Human requirement"): Block {
	return { id, title: id, content: { kind: "design", requirement, design }, progress: { kind: "tracked", status: "todo", report: null } };
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
	await success({ op: "start_run", args: { name: "Test run" } });
	const run = core.runs()[0]!.id;
	const ref: DocRef = { kind: "run", run };
	const changed = () => events.filter((event): event is ChangedEvent => event.event === "block_changed");
	function edit(id: BlockId, body: string, field: "body" | "title" = "body") {
		expect(core.edit(ref, id, field, fieldText(core.view(ref).blocks.find(item => item.block.id === id)!.block, field)!, body)).toBeNull();
	}
	async function launch(ids: readonly BlockId[] = ["b1"]) {
		const result = await success({ op: "launch", args: { run, blocks: ids } });
		const record = [...store.readLog({ kind: "run", run: run }).launches.values()].at(-1);
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
function prompt(f: { store: Store; ref: DocRef }, text: string, blocks: readonly BlockId[] = ["b1"]): string {
 return text + "\n\n" + launchFooter(f.store.path(f.ref), blocks.map(id => ({ id, title: id })));
}
function error(outcome: Outcome<unknown>, code: ErrorCode) {
	expect(outcome.ok).toBe(false);
	if (outcome.ok) throw new Error(`Expected ${code}, got success`);
	expect(outcome.error.code).toBe(code);
	return outcome.error;
}

// launch-events.md §1–§4; references.md §4–§5.
describe("Core Launch integration", () => {
	

	test("invalid roots and compile errors never create a Launch", async () => {
		const f = await fixture([block("b1", "plain"), block("b2", "```js\nconsole.log(1);\n```"), block("b3", "((b99))")]);
		error(await f.send({ op: "launch", args: { run: f.run, blocks: [] } }), "BadLaunch");
		error(await f.send({ op: "launch", args: { run: f.run, blocks: ["b2", "b1"] } }), "BadLaunch");
		error(await f.send({ op: "launch", args: { run: f.run, blocks: ["b99"] } }), "UnknownBlock");
		const failure = error(await f.send({ op: "launch", args: { run: f.run, blocks: ["b3"] } }), "CompileError");
		expect(failure.detail).toMatchObject({ kind: "UnknownBlock", block: "b99" });
		expect(f.store.readLog({ kind: "run", run: f.run }).launches.size).toBe(0);
		const prompt = await f.launch(["b1"]);
		const orchestration = await f.launch(["b2"]);
		expect(prompt).toBe("l1");
		expect((f.store.readLog(f.ref).launches.get(orchestration) ?? null)!.kind).toBe("orchestration");
	});

	test("design blocks cannot launch alone or with a task through either entry point", async () => {
		const f = await fixture([block("b1", "plain task"), designBlock("b2", "## A Overview\nDesign")]);
		const selections: readonly (readonly BlockId[])[] = [["b2"], ["b1", "b2"], ["b2", "b1"]];
		for (const blocks of selections) {
			error(await f.send({ op: "launch", args: { run: f.run, blocks } }), "BadLaunch");
			expect(f.core.requestLaunch(f.ref, blocks)).not.toBeNull();
			expect(f.events.filter(event => event.event === "launch_requested")).toEqual([]);
			expect(f.store.readLog({ kind: "run", run: f.run }).launches.size).toBe(0);
		}
		expect(f.core.requestLaunch(f.ref, ["b1"])).toBeNull();
		expect(f.events.filter(event => event.event === "launch_requested")).toEqual([
			{ event: "launch_requested", data: { run: f.run, blocks: ["b1"] } },
		]);
		expect(await f.launch(["b1"])).toBe("l1");
	});

	for (const operation of ["write", "panel"] as const) {
		test(`coordinator ${operation} of a referenced design notifies the running Launch after the judge delay`, async () => {
			const before = "## A Overview\nbefore\n\n## B Unchanged\nKeep this panel";
			const after = "## A Overview\nafter\n\n## B Unchanged\nKeep this panel";
			const f = await fixture([block("b1", 'Task:\n((b2 | panel("A")))'), designBlock("b2", before)]);
			const launch = await f.launch();
			const snapshot = (f.store.readLog(f.ref).launches.get(launch) ?? null)!.snapshot;
			expect(structuredClone(snapshot.result)).toMatchObject({ kind: "Ok", text: expect.stringContaining("Task:\n## A Overview\nbefore") });
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
			expect(structuredClone(event.data.current)).toMatchObject({ kind: "Ok", text: expect.stringContaining("Task:\n## A Overview\nafter") });
			expect(event.data.diff).toBe(references.unifiedDiff(prompt(f, "Task:\n## A Overview\nbefore"), prompt(f, "Task:\n## A Overview\nafter")));
			const persisted = f.store.readRuns().get(f.run);
			if (!persisted?.ok) throw new Error("expected persisted Run");
			expect(persisted.doc.blocks.find(block => block.id === "b2")!.content).toEqual({
				kind: "design", requirement: "Human requirement", design: after,
			});
			expect((f.store.readLog(f.ref).launches.get(launch) ?? null)!.snapshot).toEqual(snapshot);
			expect(f.store.readLog({ kind: "run", run: f.run }).entries.some(entry => entry.data.type === "event_sent" && entry.data.event === "block_changed")).toBe(true);
		}, 8_000);
	}

	test("ordered multi-block snapshot equals compile and is frozen across edits and rebase", async () => {
		const f = await fixture([block("b1", "first"), block("b2", "second")]);
		const ids: readonly BlockId[] = ["b2", "b1"];
		const compiled = await f.success({ op: "compile", args: { run: f.run, blocks: ids } });
		const launch = await f.launch(ids);
		const snapshot = (f.store.readLog(f.ref).launches.get(launch) ?? null)!.snapshot;
		if (!compiled || typeof compiled !== "object" || !("text" in compiled) || typeof compiled.text !== "string") throw new Error("compile missing text");
		expect(snapshot.result.text).toBe(prompt(f, compiled.text, ids));
		expect(snapshot.result.text).toBe(prompt(f, "second\n\nfirst", ids));
		f.edit("b1", "new first");
		await f.success({ op: "rebase", args: { launch } });
		expect((f.store.readLog(f.ref).launches.get(launch) ?? null)!.snapshot).toEqual(snapshot);
		expect(f.store.readLog({ kind: "run", run: f.run }).launches.get(launch)!.snapshot).toEqual(snapshot);
	});

	test("pending ack suppresses a second event; ack immediately judges later edits after the deadline", async () => {
		const f = await fixture();
		const launch = await f.launch();
		f.edit("b2", "first change");
		const first = await awaitChanges(f.changed, 1);
		f.edit("b2", "second change");
		await debounce();
		expect(f.changed()).toHaveLength(1);
		expect((f.store.readLog(f.ref).launches.get(launch) ?? null)!.notified).toBeNull();
		expect((f.store.readLog(f.ref).launches.get(launch) ?? null)!.dirty.map(([id]) => id)).toEqual(["b2"]);
		await f.success({ op: "ack", args: { event: first.data.id } });
		const second = await awaitChanges(f.changed, 2, 500);
		expect(second.data.id).not.toBe(first.data.id);
		expect(structuredClone(second.data.current)).toMatchObject({ kind: "Ok", text: expect.stringContaining("Task:\nsecond change") });
		expect((f.store.readLog(f.ref).launches.get(launch) ?? null)!.notified).toEqual(first.data.current);
		await f.success({ op: "ack", args: { event: second.data.id } });
		expect((f.store.readLog(f.ref).launches.get(launch) ?? null)!.dirty).toEqual([]);
		expect((f.store.readLog(f.ref).launches.get(launch) ?? null)!.notified).toEqual(second.data.current);
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
		expect((f.store.readLog(f.ref).launches.get(launch) ?? null)!.dirty).toEqual([]);
		expect((f.store.readLog(f.ref).launches.get(launch) ?? null)!.notified).toEqual(first.data.current);
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
		expect((f.store.readLog(f.ref).launches.get(launch) ?? null)!.notified).toBeNull();
		expect((f.store.readLog(f.ref).launches.get(launch) ?? null)!.dirty).toEqual([]);
		f.edit("b2", "after");
		const second = await awaitChanges(f.changed, 2);
		expect(second.data.current).toEqual(first.data.current);
	}, 12_000);

	test("deleting a referenced block emits Err with an empty diff; failed rebase preserves state", async () => {
		const f = await fixture();
		const launch = await f.launch();
		expect(f.core.deleteBlock(f.ref, "b2")).toBeNull();
		const event = await awaitChanges(f.changed, 1);
		expect(event.data.changed).toEqual(["b2"]);
		expect(event.data.diff).toBe("");
		expect(event.data.current).toMatchObject({ kind: "Err", error: { kind: "UnknownBlock", block: "b2", at: { block: "b1", reference: "((b2))" } } });
		const before = (f.store.readLog(f.ref).launches.get(launch) ?? null)!;
		error(await f.send({ op: "rebase", args: { launch } }), "CompileError");
		expect((f.store.readLog(f.ref).launches.get(launch) ?? null)).toEqual(before);
		await f.success({ op: "ack", args: { event: event.data.id } });
		expect((f.store.readLog(f.ref).launches.get(launch) ?? null)!.notified).toEqual(event.data.current);
	}, 8_000);

	test("rebase discards pending event and moves the diff reference to the newest baseline", async () => {
		const f = await fixture();
		const launch = await f.launch();
		const snapshot = (f.store.readLog(f.ref).launches.get(launch) ?? null)!.snapshot;
		f.edit("b2", "rebased");
		const first = await awaitChanges(f.changed, 1);
		expect(await f.success({ op: "rebase", args: { launch } })).toEqual({ baseline: expect.stringContaining("Task:\nrebased") });
		expect((f.store.readLog(f.ref).launches.get(launch) ?? null)!.baselines).toEqual([prompt(f, "Task:\nbefore"), prompt(f, "Task:\nrebased")]);
		expect((f.store.readLog(f.ref).launches.get(launch) ?? null)!.dirty).toEqual([]);
		expect((f.store.readLog(f.ref).launches.get(launch) ?? null)!.notified).toBeNull();
		error(await f.send({ op: "ack", args: { event: first.data.id } }), "UnknownEvent");
		f.edit("b2", "changed again");
		const second = await awaitChanges(f.changed, 2);
		expect(second.data.diff).toBe(references.unifiedDiff(prompt(f, "Task:\nrebased"), prompt(f, "Task:\nchanged again")));
		expect(second.data.diff).toContain("-rebased");
		expect((f.store.readLog(f.ref).launches.get(launch) ?? null)!.snapshot).toEqual(snapshot);
	}, 10_000);

	test("bind, close and rebase reject unknown Launches and non-owner sessions", async () => {
		const f = await fixture();
		const launch = await f.launch();
		const initial = (f.store.readLog(f.ref).launches.get(launch) ?? null)!;
		f.disconnect();
		await f.connect("other-session");
		function operations(id: LaunchId): Request[] {
			return [{ op: "bind", args: { launch: id, agent: "intruder" } }, { op: "close", args: { launch: id } }, { op: "rebase", args: { launch: id } }];
		}
		for (const request of operations("l999")) error(await f.send(request), "UnknownLaunch");
		for (const request of operations(launch)) error(await f.send(request), "NotOwner");
		expect((f.store.readLog(f.ref).launches.get(launch) ?? null)).toEqual(initial);
		f.disconnect();
		await f.connect();
		await f.success({ op: "bind", args: { launch, agent: "owner-agent" } });
		await f.success({ op: "close", args: { launch } });
		expect((f.store.readLog(f.ref).launches.get(launch) ?? null)!.closed?.by).toBe("coordinator");
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
		expect((f.store.readLog(f.ref).launches.get(launch) ?? null)!.notified).toBeNull();
		// A newly edited value has not yet reached its 2 s deadline; hello overrides it.
		f.edit("b2", "just before reconnect");
		await f.connect();
		const second = await awaitChanges(f.changed, 2, 500);
		expect(second.data.id).not.toBe(first.data.id);
		expect(structuredClone(second.data.current)).toMatchObject({ kind: "Ok", text: expect.stringContaining("Task:\njust before reconnect") });
		error(await f.send({ op: "ack", args: { event: first.data.id } }), "UnknownEvent");
		await f.success({ op: "ack", args: { event: second.data.id } });
		expect((f.store.readLog(f.ref).launches.get(launch) ?? null)!.dirty).toEqual([]);
	}, 10_000);

});

// C2 / C3-Core of #9: launch defaults, closed-Launch guards, and race-free rebase.
describe("Launch execution contract and lifecycle guards", () => {
	const configured = (id: BlockId, body: string, agent?: string, isolated?: boolean): Block => ({
		id, title: id, progress: { kind: "tracked", status: "todo", report: null },
		content: { kind: "task", body, ...(agent === undefined ? {} : { agent }), ...(isolated === undefined ? {} : { isolated }) },
	});

	test("launch returns the contract every root shares; a contract change neither dirties the Launch nor notifies", async () => {
		const f = await fixture([configured("b1", "one ((b4))", "task:mid", true), configured("b2", "two", "task:mid", false), configured("b3", "three"), configured("b4", "source", "task:low")]);
		expect(await f.success({ op: "launch", args: { run: f.run, blocks: ["b1"] } })).toEqual({ launch: "l1", kind: "prompt", text: expect.stringContaining("one source"), agent: "task:mid", isolated: true });
		expect(await f.success({ op: "launch", args: { run: f.run, blocks: ["b1", "b2"] } })).toEqual({ launch: "l2", kind: "prompt", text: expect.stringContaining("one source\n\ntwo"), agent: "task:mid" });
		expect(await f.success({ op: "launch", args: { run: f.run, blocks: ["b1", "b3"] } })).toEqual({ launch: "l3", kind: "prompt", text: expect.stringContaining("one source\n\nthree") });
		await f.success({ op: "lock", args: { run: f.run, block: "b4" } });
		await f.success({ op: "set", args: { run: f.run, block: "b4", field: "agent", value: null } });
		await f.success({ op: "set", args: { run: f.run, block: "b4", field: "isolated", value: true } });
		expect((f.store.readLog(f.ref).launches.get("l1") ?? null)!.dirty).toEqual([]);
		await debounce();
		expect(f.changed()).toEqual([]);
		expect(f.store.readLog({ kind: "run", run: f.run }).entries.filter(entry => entry.data.type === "content_replaced").map(entry => entry.data)).toEqual([
			{ type: "content_replaced", block: "b4", content: { kind: "task", body: "source" } },
			{ type: "content_replaced", block: "b4", content: { kind: "task", body: "source", isolated: true } },
		]);
	}, 6_000);

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
		for (const id of [switched, multi, deleted]) expect((f.store.readLog(f.ref).launches.get(id) ?? null)!.baselines).toHaveLength(1);
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
		const lateSeq = (f.store.readLog(f.ref).launches.get(launch) ?? null)!.dirty.find(([id]) => id === "b2")![1];
		release();
		const outcome = await rebased;
		const baselines = (f.store.readLog(f.ref).launches.get(launch) ?? null)!.baselines;
		expect(baselines).toHaveLength(2);
		expect(outcome).toEqual({ ok: true, result: { baseline: baselines[1] } });
		expect(baselines[1]).toContain("later");
		expect(baselines[1]).toContain("text of file:new.txt");
		expect((f.store.readLog(f.ref).launches.get(launch) ?? null)!.dirty).toEqual([["b2", lateSeq]]);
		await debounce();
		expect(f.changed()).toEqual([]);
		expect((f.store.readLog(f.ref).launches.get(launch) ?? null)!.dirty).toEqual([]);
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
		expect(structuredClone(event.data.current)).toMatchObject({ kind: "Ok", text: expect.stringContaining(judged) });
		expect(await f.success({ op: "rebase", args: { launch } })).toEqual({ baseline: expect.stringContaining(judged) });
	}, 10_000);

	test("rebase and later judgments compile with the Run's current block results", async () => {
		const f = await fixture([block("b1", "Task:\n((b2.result))"), block("b2", "producer")]);
		await f.success({ op: "post", args: { run: f.run, kind: "result", text: "first result", block: "b2" } });
		const launch = await f.launch();
		await f.success({ op: "post", args: { run: f.run, kind: "result", text: "second result", block: "b2" } });
		expect(await f.success({ op: "rebase", args: { launch } })).toEqual({ baseline: expect.stringContaining("Task:\nsecond result") });
		expect(structuredClone((f.store.readLog(f.ref).launches.get(launch) ?? null)!.snapshot.result)).toMatchObject({ text: expect.stringContaining("Task:\nfirst result") });
		f.edit("b1", "Changed task:\n((b2.result))");
		const event = await awaitChanges(f.changed, 1);
		expect(structuredClone(event.data.current)).toMatchObject({ kind: "Ok", text: expect.stringContaining("Changed task:\nsecond result") });
		expect(event.data.diff).toBe(references.unifiedDiff(prompt(f, "Task:\nsecond result"), prompt(f, "Changed task:\nsecond result")));
	}, 8_000);
});
