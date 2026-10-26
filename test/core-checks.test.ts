import type { Request } from "../src/domain/protocol";
import { describe, expect, test } from "bun:test";
import type { JudgeReport } from "../src/domain/model";
import { registerCoreCleanup, coreFixture, design, task, template } from "./core-fixture";

async function inspect(f: { success(request: Request): Promise<unknown> }, blocks: readonly "b1"[] = ["b1"]) {
	const result = await f.success({ op: "inspect", args: { blocks } });
	if (!result || typeof result !== "object" || !("version" in result) || typeof result.version !== "string") throw new Error("missing inspection token");
	return { result, version: result.version };
}
const answers: JudgeReport = { kind: "answers", answers: { missing: 0.75 } };

describe("inspection and report protocol", () => {
	test("inspect exposes structured source, compiled dependency content and render summaries", async () => {
		const f = coreFixture([task("b1", "Implement ((b2))"), design("b2", "## A Access\nScoped permissions", "Private records")]); await f.connect();
		f.core.setRenderStatus(template, "b1", { blockError: false, documentError: false, pendingOverdue: false, view: { md: ["Visible task"], images: ["Access diagram"] }, draftErrors: 0 });
		const inspected = await inspect(f);
		expect(structuredClone(inspected.result)).toMatchObject({ source: { b1: "Implement ((b2))" }, compiled: { kind: "Ok", text: expect.stringContaining("Private records") }, view: expect.anything() });
		expect(inspected.result).toHaveProperty("findings");
	});
	test("compile errors remain structured inspect results", async () => {
		const f = coreFixture([task("b1", "((b99))")]); await f.connect();
		const inspected = await inspect(f);
		expect(inspected.result).toMatchObject({ compiled: { kind: "Err", error: { kind: "UnknownBlock", block: "b99" } }, findings: { b1: { compile: true } } });
	});
	for (const result of [answers, { kind: "judge_unavailable" }] satisfies JudgeReport[]) test(`accepted report records ${result.kind}`, async () => {
		const f = coreFixture(); await f.connect(); const { version } = await inspect(f);
		expect(await f.success({ op: "report", args: { blocks: ["b1"], version, result } })).toBeNull();
		expect(f.store.readLog(template).entries.filter(entry => entry.data.type === "check_reported")).toContainEqual(expect.objectContaining({ data: { type: "check_reported", blocks: ["b1"], version, result } }));
	});
	for (const result of [{ kind: "answers", answers: {} }, { kind: "answers", answers: { missing: -1 } }, { kind: "answers", answers: { missing: 2 } }, { kind: "answers", answers: { missing: 0.5, extra: 0.5 } }] as JudgeReport[]) test(`invalid report ${JSON.stringify(result)} is rejected without recording`, async () => {
		const f = coreFixture(); await f.connect(); const { version } = await inspect(f);
		expect(await f.request({ op: "report", args: { blocks: ["b1"], version, result } })).toMatchObject({ ok: false, error: { code: "BadReport" } });
		expect(f.store.readLog(template).entries.filter(entry => entry.data.type === "check_reported")).toEqual([]);
	});
	test("uninspected and stale reports are ignored; a fresh inspection can be accepted", async () => {
		const f = coreFixture([task("b1", "((b2))"), task("b2", "Before")]); await f.connect();
		await f.success({ op: "report", args: { blocks: ["b1"], version: "uninspected", result: answers } });
		const previous = await inspect(f);
		expect(f.core.edit(template, "b2", "body", "Before", "After")).toBeNull();
		await f.success({ op: "report", args: { blocks: ["b1"], version: previous.version, result: answers } });
		expect(f.store.readLog(template).entries.filter(entry => entry.data.type === "check_reported")).toEqual([]);
		const fresh = await inspect(f);
		await f.success({ op: "report", args: { blocks: ["b1"], version: fresh.version, result: answers } });
		expect(f.store.readLog(template).entries.filter(entry => entry.data.type === "check_reported")).toHaveLength(1);
	});
	test("restoring source does not revive an inspection invalidated by a dependency edit", async () => {
		const f = coreFixture([task("b1", "((b2))"), task("b2", "Before")]); await f.connect(); const previous = await inspect(f);
		f.core.edit(template, "b2", "body", "Before", "Temporary"); f.core.edit(template, "b2", "body", "Temporary", "Before");
		await f.success({ op: "report", args: { blocks: ["b1"], version: previous.version, result: answers } });
		expect(f.store.readLog(template).entries.filter(entry => entry.data.type === "check_reported")).toHaveLength(0);
	});
});

registerCoreCleanup();
