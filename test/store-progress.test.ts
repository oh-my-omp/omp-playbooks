import { describe, expect, test } from "bun:test";
import type { PlaybookDoc, Progress } from "../src/domain/model";
import { registerCoreCleanup, coreFixture, design, task, template } from "./core-fixture";

describe("persisted block progress", () => {
	for (const status of ["todo", "running", "done"] as const) for (const report of [null, "Done\nVerified\n"]) test(`task ${status} report ${JSON.stringify(report)} round-trips`, () => {
		const f = coreFixture();
		const progress: Progress = { kind: "tracked", status, report };
		const document: PlaybookDoc = { title: "Progress", blocks: [{ ...task("b1"), progress }] };
		const text = f.store.serialize(document, null);
		expect(text).toContain(`status: ${status}`);
		if (report !== null) expect(text).toContain("report: |");
		expect(f.store.parse(text, false)).toEqual({ ok: true, doc: document, run: null });
	});
	for (const status of ["todo", "done"] as const) test(`design ${status} round-trips`, () => {
		const f = coreFixture();
		const document: PlaybookDoc = { title: "Design", blocks: [{ ...design("b1"), progress: { kind: "tracked", status, report: null } }] };
		expect(f.store.parse(f.store.serialize(document, null), false)).toEqual({ ok: true, doc: document, run: null });
	});
	test("task false round-trips as untracked without status or report", () => {
		const f = coreFixture();
		const document: PlaybookDoc = { title: "Reference", blocks: [{ ...task("b1"), progress: { kind: "untracked" } }] };
		const text = f.store.serialize(document, null);
		expect(text).toContain("task: false");
		expect(text).not.toContain("status:");
		expect(text).not.toContain("report:");
		expect(f.store.parse(text, false)).toEqual({ ok: true, doc: document, run: null });
	});
	for (const [content, extra] of [
		[{ requirement: "", design: "" }, { status: "running" }],
		[{ requirement: "", design: "" }, { status: "done", report: "Forbidden" }],
		[{ requirement: "", design: "" }, { task: false }],
		[{ body: "" }, { task: true }], [{ body: "" }, { task: "false" }],
		[{ body: "" }, { task: false, status: "todo" }], [{ body: "" }, { task: false, report: "Forbidden" }],
		[{ body: "" }, { status: "unknown" }], [{ body: "" }, { status: false }], [{ body: "" }, { status: "done", report: 1 }],
	] as const) test(`rejects invalid progress ${JSON.stringify({ ...content, ...extra })}`, () => {
		const f = coreFixture();
		const parsed = f.store.parse(JSON.stringify({ title: "Invalid", blocks: [{ id: "b1", title: "Block", ...content, ...extra }] }), false);
		expect(parsed.ok).toBe(false);
	});
	test("missing status is rejected and template logs reopen independently from run logs", () => {
		const f = coreFixture();
		expect(f.store.parse("title: Default\nblocks:\n  - id: b1\n    title: Task\n    body: Body\n", false)).toMatchObject({ ok: false });
		f.store.appendEntry(template, { seq: 1, at: 100, origin: "human", data: { type: "progress_changed", block: "b1", progress: { kind: "tracked", status: "done", report: "Report" } } });
		expect(f.store.readLog(template).entries).toHaveLength(1);
		expect(f.store.readLog({ kind: "run", run: "r1" }).entries).toEqual([]);
	});
});

registerCoreCleanup();
