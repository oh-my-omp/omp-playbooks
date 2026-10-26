import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { registerCoreCleanup, coreFixture, design, task, template } from "./core-fixture";
import { launchFooter } from "../src/service/footer";

describe("direct human commands", () => {
	test("compare-and-swap rejects stale expected text and persists only a matching edit", () => {
		const f = coreFixture([task("b1", "Original")]);
		expect(f.core.edit(template, "b1", "body", "Stale", "Wrong")).toBeTypeOf("string");
		expect(f.core.view(template).blocks[0]?.block.content).toEqual({ kind: "task", body: "Original" });
		expect(f.store.readLog(template).entries).toEqual([]);
		expect(f.core.edit(template, "b1", "body", "Original", "Updated")).toBeNull();
		expect(f.core.edit(template, "b1", "body", "Original", "Lost update")).toBeTypeOf("string");
		f.core.stop();
		expect(f.store.readTemplate()).toMatchObject({ ok: true, doc: { blocks: [{ content: { body: "Updated" } }] } });
		expect(f.store.readLog(template).entries.filter(entry => entry.data.type === "block_edited")).toHaveLength(1);
	});
	test("matching edits take back coordinator ownership; stale or unchanged edits do not", async () => {
		const f = coreFixture(); await f.connect();
		await f.success({ op: "lock", args: { block: "b1" } });
		expect(f.core.edit(template, "b1", "body", "Wrong", "Changed")).toBeTypeOf("string");
		expect(f.core.edit(template, "b1", "body", "Task body", "Task body")).toBeNull();
		expect(f.events.filter(event => event.event === "interrupted")).toHaveLength(0);
		expect(f.core.edit(template, "b1", "body", "Task body", "Human edit")).toBeNull();
		expect(f.events.filter(event => event.event === "interrupted")).toHaveLength(1);
		expect(await f.request({ op: "write", args: { block: "b1", text: "Coordinator overwrite" } })).toMatchObject({ ok: false, error: { code: "NotLocked" } });
	});
	test("title CAS, requirement ownership and invalid target errors leave unrelated fields intact", () => {
		const f = coreFixture([design("b1"), task("b2")]);
		expect(f.core.setTitle(template, "Stale", "Wrong")).toBeTypeOf("string");
		expect(f.core.setTitle(template, "Playbook", "Renamed")).toBeNull();
		expect(f.core.edit(template, "b1", "requirement", "Requirement", "New requirement")).toBeNull();
		expect(f.core.edit(template, "b1", "body", "", "Wrong")).toBeTypeOf("string");
		expect(f.core.edit(template, "b2", "requirement", "", "Wrong")).toBeTypeOf("string");
		expect(f.core.edit(template, "b99", "title", "", "Wrong")).toBeTypeOf("string");
		expect(f.core.view(template).blocks[0]?.block.content).toEqual({ kind: "design", requirement: "New requirement", design: "## A Plan\nDesign" });
	});
	test("design revisions require a coordinator and persist before notification without changing design", async () => {
		const f = coreFixture([design("b1")]);
		expect(f.core.requestRevision(template, "b1", "Change storage")).toBeTypeOf("string");
		expect(f.store.readRevisions(template)).toEqual([]);
		await f.connect();
		expect(f.core.requestRevision(template, "b1", "   ")).toBeTypeOf("string");
		expect(f.core.requestRevision(template, "b1", "Change storage")).toBeNull();
		expect(f.store.readRevisions(template)).toContainEqual(expect.objectContaining({ seq: 1, block: "b1", prompt: "Change storage" }));
		expect(f.events).toContainEqual({ event: "revision_requested", data: { block: "b1", revision: 1 } });
		expect(f.core.view(template).blocks[0]?.block.content).toMatchObject({ design: "## A Plan\nDesign" });
	});
	test("status constraints, untracked task constraints and status events", async () => {
		const f = coreFixture([design("b1"), { ...task("b2"), progress: { kind: "untracked" } }, task("b3")]); await f.connect();
		expect(f.core.setStatus(template, "b1", "running")).toBeTypeOf("string");
		expect(f.core.setStatus(template, "b2", "done")).toBeTypeOf("string");
		expect(f.core.setStatus(template, "b3", "running")).toBeNull();
		expect(f.events).toContainEqual({ event: "status_changed", data: { block: "b3", status: "running" } });
		expect(f.store.readLog(template).entries).toContainEqual(expect.objectContaining({ data: { type: "progress_changed", block: "b3", progress: { kind: "tracked", status: "running", report: null } } }));
	});
	test("requestStop resets a task with no open launch and sends owned launch details otherwise", async () => {
		const f = coreFixture(); await f.connect();
		expect(f.core.setStatus(template, "b1", "running")).toBeNull();
		expect(f.core.requestStop(template, "b1")).toBeNull();
		expect(f.core.view(template).blocks[0]?.block.progress).toMatchObject({ status: "todo" });
		await f.success({ op: "launch", args: { blocks: ["b1"] } });
		await f.success({ op: "bind", args: { launch: "l1", agent: "worker" } });
		expect(f.core.requestStop(template, "b1")).toBeNull();
		expect(f.events).toContainEqual({ event: "stop_requested", data: { block: "b1", launches: [{ id: "l1", agents: ["worker"] }] } });
	});
	test("configuration changes stay task-only and can clear default agent", () => {
		const f = coreFixture([task("b1"), design("b2")]);
		expect(f.core.setAgent(template, "b1", " worker ")).toBeNull();
		expect(f.core.setIsolated(template, "b1", true)).toBeNull();
		expect(f.core.view(template).blocks[0]?.block.content).toMatchObject({ agent: "worker", isolated: true });
		expect(f.core.setAgent(template, "b1", null)).toBeNull();
		expect(f.core.view(template).blocks[0]?.block.content).not.toHaveProperty("agent");
		expect(f.core.setAgent(template, "b2", "worker")).toBeTypeOf("string");
		expect(f.core.setIsolated(template, "b2", true)).toBeTypeOf("string");
	});
});

describe("template execution log and launch footer", () => {
	test("template launch prompt appends the exact document-specific footer and persists its null run", async () => {
		const f = coreFixture([task("b1", "Perform task")]); await f.connect();
		const compiled = await f.success({ op: "compile", args: { blocks: ["b1"] } });
		expect(compiled).toMatchObject({ kind: "Ok", text: "Perform task" });
		const result = await f.success({ op: "launch", args: { blocks: ["b1"] } });
		const footer = launchFooter(f.store.templatePath, [{ id: "b1", title: "b1" }]);
		expect(result).toEqual({ launch: "l1", kind: "prompt", text: `Perform task\n\n${footer}` });
		const log = f.store.readLog(template);
		expect(log.launches.get("l1")).toMatchObject({ run: null, snapshot: { result: { text: `Perform task\n\n${footer}` } } });
		expect(readFileSync(f.store.templatePath + ".log.jsonl", "utf8")).toContain("launch_created");
		expect(structuredClone(await f.success({ op: "timeline", args: {} }))).toMatchObject({ entries: [expect.objectContaining({ data: { type: "launch_created", launch: "l1", kind: "prompt", blocks: ["b1"] } })] });
	});
	test("orchestration launch leaves executable source unchanged", async () => {
		const code = "```js\nreturn 1;\n```";
		const f = coreFixture([task("b1", code)]); await f.connect();
		expect(await f.success({ op: "launch", args: { blocks: ["b1"] } })).toEqual({ launch: "l1", kind: "orchestration", text: code });
	});
});

registerCoreCleanup();
