import { describe, expect, test } from "bun:test";
import type { BlockId, DocRef } from "../src/domain/model";
import type { Request } from "../src/domain/protocol";
import { registerCoreCleanup, coreFixture, design, task, template } from "./core-fixture";

const run: DocRef = { kind: "run", run: "r1" };

describe("coordinator ownership and mutation invariants", () => {
	for (const request of [
		{ op: "set", args: { block: "b1", field: "title", value: "Changed" } },
		{ op: "set", args: { block: "b1", field: "status", value: "done" } },
		{ op: "write", args: { block: "b1", text: "Changed" } },
		{ op: "edit", args: { block: "b1", find: "Task", replace: "Changed" } },
		{ op: "delete", args: { block: "b1" } },
		{ op: "move", args: { block: "b1", after: "b2" } },
	] satisfies Request[]) test(`${request.op} requires a held coordinator lock`, async () => {
		const f = coreFixture(); await f.connect();
		expect(await f.request(request)).toMatchObject({ ok: false, error: { code: "NotLocked" } });
		expect(f.core.view(template).blocks.map(item => item.block)).toEqual([task("b1"), task("b2", "Other")]);
	});
	test("relocking changes request identity; stale unlock cannot release newer ownership", async () => {
		const f = coreFixture(); await f.connect();
		await f.core.handle(f.connection, "first", { op: "lock", args: { block: "b1" } });
		await f.core.handle(f.connection, "second", { op: "lock", args: { block: "b1" } });
		await f.success({ op: "unlock", args: { block: "b1", request: "first" } });
		await f.success({ op: "write", args: { block: "b1", text: "Still held" } });
		await f.success({ op: "unlock", args: { block: "b1", request: "second" } });
		expect(await f.request({ op: "write", args: { block: "b1", text: "Not held" } })).toMatchObject({ ok: false, error: { code: "NotLocked" } });
	});
	test("busy connections and reveal do not steal coordinator ownership", async () => {
		const f = coreFixture(); await f.connect(); await f.success({ op: "lock", args: { block: "b1" } });
		const other = { id: 2, send() {}, close() {} }; f.core.connected(other);
		expect(await f.core.handle(other, "reveal", { op: "reveal", args: {} })).toMatchObject({ ok: true });
		expect(await f.core.handle(other, "hello", { op: "hello", args: { session: "other" } })).toMatchObject({ ok: false, error: { code: "Busy" } });
		await f.success({ op: "write", args: { block: "b1", text: "Owner remains" } });
		f.core.disconnected(f.connection); f.core.connected(other);
		expect(await f.core.handle(other, "hello-again", { op: "hello", args: { session: "other" } })).toMatchObject({ ok: true });
		expect(await f.core.handle(other, "write", { op: "write", args: { block: "b1", text: "Not inherited" } })).toMatchObject({ ok: false, error: { code: "NotLocked" } });
	});
	test("unique replacement rejects absent, repeated and overlapping matches atomically", async () => {
		const f = coreFixture([task("b1", "unique repeat repeat aaa")]); await f.connect(); await f.success({ op: "lock", args: { block: "b1" } });
		for (const find of ["missing", "repeat", "aa"]) expect(await f.request({ op: "edit", args: { block: "b1", find, replace: "Wrong" } })).toMatchObject({ ok: false, error: { code: find === "missing" ? "NotFound" : "Ambiguous" } });
		expect(f.core.view(template).blocks[0]?.block.content).toMatchObject({ body: "unique repeat repeat aaa" });
		await f.success({ op: "edit", args: { block: "b1", find: "unique", replace: "Changed" } });
		expect(f.core.view(template).blocks[0]?.block.content).toMatchObject({ body: "Changed repeat repeat aaa" });
	});
	test("design edits and panel replacement cannot alter the human requirement", async () => {
		const f = coreFixture([design("b1", "## A First\nOld\n\n## B Second\nKeep")]); await f.connect(); await f.success({ op: "lock", args: { block: "b1" } });
		await f.success({ op: "edit", args: { block: "b1", find: "Old", replace: "Changed" } });
		await f.success({ op: "panel", args: { block: "b1", panel: "A", text: "## A First\nNew panel" } });
		expect(structuredClone(f.core.view(template).blocks[0]?.block.content)).toMatchObject({ requirement: "Requirement", design: expect.stringContaining("New panel") });
		const before = f.core.view(template).blocks[0]?.block.content;
		expect(await f.request({ op: "panel", args: { block: "b1", panel: "Z", text: "## Z Unknown\nWrong" } })).toMatchObject({ ok: false, error: { code: "NotFound" } });
		expect(f.core.view(template).blocks[0]?.block.content).toEqual(before);
	});
	test("move preserves block identity, records changed order once and refuses self anchors", async () => {
		const f = coreFixture([task("b1"), task("b2"), task("b3")]); await f.connect(); await f.success({ op: "lock", args: { block: "b3" } });
		await f.success({ op: "move", args: { block: "b3", after: null } });
		expect(f.core.view(template).blocks.map(item => item.block.id)).toEqual(["b3", "b1", "b2"]);
		await f.success({ op: "move", args: { block: "b3", after: null } });
		expect(f.store.readLog(template).entries.filter(entry => entry.data.type === "blocks_reordered")).toHaveLength(1);
		expect(await f.request({ op: "move", args: { block: "b3", after: "b3" } })).toMatchObject({ ok: false, error: { code: "BadValue" } });
	});
	test("task tracking can be disabled and restored only on task content", async () => {
		const f = coreFixture([task("b1"), design("b2")]); await f.connect();
		for (const block of ["b1", "b2"] as const) await f.success({ op: "lock", args: { block } });
		await f.success({ op: "set", args: { block: "b1", field: "task", value: false } });
		expect(f.core.view(template).blocks[0]?.block.progress).toEqual({ kind: "untracked" });
		expect(await f.request({ op: "launch", args: { blocks: ["b1"] } })).toMatchObject({ ok: false, error: { code: "BadLaunch" } });
		await f.success({ op: "set", args: { block: "b1", field: "task", value: true } });
		expect(f.core.view(template).blocks[0]?.block.progress).toEqual({ kind: "tracked", status: "todo", report: null });
		expect(await f.request({ op: "set", args: { block: "b2", field: "task", value: false } })).toMatchObject({ ok: false, error: { code: "BadValue" } });
	});
});

describe("Run and Launch lifecycle through current protocol", () => {
	test("finish closes launches, forbids edits, but accepts late results and a retrospective", async () => {
		const f = coreFixture(); await f.connect(); await f.success({ op: "start_run", args: { name: "Run" } });
		await f.success({ op: "lock", args: { run: "r1", block: "b1" } });
		await f.success({ op: "launch", args: { run: "r1", blocks: ["b1"] } });
		expect(await f.request({ op: "post", args: { run: "r1", kind: "retrospective", text: "Too soon" } })).toMatchObject({ ok: false, error: { code: "BadValue" } });
		await f.success({ op: "finish_run", args: { run: "r1" } });
		expect(f.store.readLog(run).launches.get("l1")?.closed?.by).toBe("run_finished");
		expect(f.core.edit(run, "b1", "title", "b1", "Wrong")).toBeTypeOf("string");
		for (const request of [{ op: "lock", args: { run: "r1", block: "b1" } }, { op: "launch", args: { run: "r1", blocks: ["b1"] } }, { op: "insert", args: { run: "r1", title: "New", content: { kind: "task", body: "" } } }] satisfies Request[]) expect(await f.request(request)).toMatchObject({ ok: false, error: { code: "RunFinished" } });
		await f.success({ op: "post", args: { run: "r1", kind: "result", text: "Late result", block: "b1", launch: "l1" } });
		await f.success({ op: "post", args: { run: "r1", kind: "retrospective", text: "Review" } });
		expect(f.core.runs()[0]).toMatchObject({ status: "finished", retrospective: true });
	});
	test("closed launch retains info and late results but refuses bind/rebase; cross-document result is rejected", async () => {
		const f = coreFixture(); await f.connect(); await f.success({ op: "launch", args: { blocks: ["b1"] } });
		await f.success({ op: "close", args: { launch: "l1" } }); await f.success({ op: "close", args: { launch: "l1" } });
		expect(await f.success({ op: "launch_info", args: { launch: "l1" } })).toMatchObject({ closed: { by: "coordinator" } });
		for (const request of [{ op: "bind", args: { launch: "l1", agent: "worker" } }, { op: "rebase", args: { launch: "l1" } }] satisfies Request[]) expect(await f.request(request)).toMatchObject({ ok: false, error: { code: "BadLaunch" } });
		await f.success({ op: "post", args: { kind: "result", text: "Late", block: "b1", launch: "l1" } });
		await f.success({ op: "start_run", args: { name: "Other" } });
		expect(await f.request({ op: "post", args: { run: "r1", kind: "result", text: "Wrong doc", block: "b1", launch: "l1" } })).toMatchObject({ ok: false, error: { code: "BadValue" } });
	});
	test("timeline keeps quote and human origin; after is exclusive and excludes launch record lines", async () => {
		const f = coreFixture(); await f.connect(); await f.success({ op: "launch", args: { blocks: ["b1"] } });
		const posted = await f.success({ op: "post", args: { kind: "result", text: "Result", quote: "message", origin: "human", block: "b1", launch: "l1" } });
		expect(posted).toMatchObject({ seq: 2 });
		expect(structuredClone(await f.success({ op: "timeline", args: { after: 1 } }))).toMatchObject({ entries: [expect.objectContaining({ seq: 2, origin: "human", data: expect.objectContaining({ quote: "message", text: "Result" }) })] });
	});
	test("revision journals remain document-local when runs snapshot the template", async () => {
		const f = coreFixture([design("b1")]); await f.connect(); f.core.requestRevision(template, "b1", "Template request");
		await f.success({ op: "start_run", args: { name: "Snapshot" } });
		expect(await f.success({ op: "revisions", args: { run: "r1" } })).toEqual({ revisions: [] });
		f.core.requestRevision(run, "b1", "Run request");
		expect(f.store.readRevisions(template).map(revision => revision.prompt)).toEqual(["Template request"]);
		expect(f.store.readRevisions(run).map(revision => revision.prompt)).toEqual(["Run request"]);
	});
	test("default and explicit update deadlines, snooze and finished-run immutability", async () => {
		const f = coreFixture(); await f.connect(); await f.success({ op: "start_run", args: { name: "Timed", update_every: 600 } });
		const initial = f.core.view(run).run!;
		await f.success({ op: "post", args: { run: "r1", kind: "update", text: "Progress", next: 1200 } });
		const explicit = f.core.view(run).run!;
		expect(explicit.updateEvery).toBe(600); expect(explicit.updateDue! - initial.updateDue!).toBeGreaterThan(500_000);
		await f.success({ op: "snooze", args: { run: "r1", after: 1800 } });
		expect(f.core.view(run).run!.updateDue!).toBeGreaterThan(explicit.updateDue!);
		await f.success({ op: "finish_run", args: { run: "r1" } });
		expect(f.core.view(run).run!.updateDue).toBeNull();
		expect(await f.request({ op: "snooze", args: { run: "r1", after: 60 } })).toMatchObject({ ok: false, error: { code: "BadValue" } });
	});
});

registerCoreCleanup();
