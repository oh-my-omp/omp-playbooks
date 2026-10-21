import { expect, test } from "bun:test";
import { createPlaybook, type PlaybookDeps } from "../src/extension/eval-prelude";

type Call = { readonly kind: "tool"; readonly name: string; readonly args: Record<string, unknown> }
	| { readonly kind: "agent"; readonly prompt: string; readonly options: Parameters<PlaybookDeps["agent"]>[1] }
	| { readonly kind: "wait" };

/** The launch_info record as K1 returns it: `baselines[0]` is the snapshot text, later entries come from rebase. */
type Info = { readonly kind?: string; readonly baselines?: readonly string[]; readonly blocks?: readonly string[]; readonly closed?: { at: number; by: string } | null };

function harness(context: { doc?: string; run?: string; launch?: string } = { doc: "/book.yaml", run: "r1" }) {
	const calls: Call[] = [];
	const outcome = Promise.withResolvers<unknown>();
	const waiting = Promise.withResolvers<void>();
	const binding = Promise.withResolvers<void>();
	const bound = Promise.withResolvers<void>();
	let holdBind = false;
	let launchKind = "prompt";
	let contract: { agent?: string; isolated?: boolean } = {};
	let info: Info = {};
	let toolFailure: { code: string; message: string } | undefined;
	let agentFailure: Error | undefined;
	const deps: PlaybookDeps = {
		...context,
		tool: {
			playbook_launch: async args => {
				calls.push({ kind: "tool", name: "playbook_launch", args });
				if (toolFailure) return JSON.stringify({ error: toolFailure });
				if (args.op === "launch") return JSON.stringify({ launch: "l1", kind: launchKind, text: "Frozen prompt", ...contract });
				if (args.op === "info") {
					return JSON.stringify({
						id: "l1", run: "r2", kind: info.kind ?? launchKind, blocks: info.blocks ?? ["b4"],
						snapshot: { result: { kind: "Ok", text: "Existing snapshot", sources: [] } },
						baselines: info.baselines ?? ["Existing snapshot"], closed: info.closed ?? null,
					});
				}
				if (args.op === "bind") { binding.resolve(); if (holdBind) await bound.promise; }
				return "null";
			},
			playbook_timeline: async args => {
				calls.push({ kind: "tool", name: "playbook_timeline", args });
				return JSON.stringify({ seq: 7 });
			},
			playbook_read: async args => {
				calls.push({ kind: "tool", name: "playbook_read", args });
				return JSON.stringify({ title: "Book", blocks: [] });
			},
		},
		agent: async (prompt, options) => {
			calls.push({ kind: "agent", prompt, options });
			if (agentFailure) throw agentFailure;
			return { id: "worker-1", wait: async () => { calls.push({ kind: "wait" }); waiting.resolve(); return outcome.promise; } };
		},
	};
	return {
		playbook: createPlaybook(deps), calls, outcome, waiting: waiting.promise, binding: binding.promise, bound,
		set holdBind(value: boolean) { holdBind = value; },
		set launchKind(value: string) { launchKind = value; },
		set contract(value: { agent?: string; isolated?: boolean }) { contract = value; },
		set info(value: Info) { info = value; },
		set toolFailure(value: typeof toolFailure) { toolFailure = value; },
		set agentFailure(value: Error | undefined) { agentFailure = value; },
	};
}

const close = (launch = "l1", doc = "/book.yaml"): Call => ({ kind: "tool", name: "playbook_launch", args: { doc, op: "close", launch } });

test("agent() failing on a Launch it created closes that Launch and names the agent option; spawn leaves an existing Launch open", async () => {
	const h = harness(); h.agentFailure = new Error('Agent "task" is disabled in settings');
	await expect(h.playbook.agent({ blocks: ["b1"] })).rejects.toThrow(/Agent "task" is disabled in settings[\s\S]*agent: "task:mid"/);
	expect(h.calls).toEqual([
		{ kind: "tool", name: "playbook_launch", args: { doc: "/book.yaml", run: "r1", op: "launch", blocks: ["b1"] } },
		{ kind: "agent", prompt: "Frozen prompt", options: {} },
		close(),
	]);
	h.calls.length = 0;
	await expect(h.playbook.spawn("l1")).rejects.toThrow('Agent "task" is disabled in settings');
	expect(h.calls.some(call => call.kind === "tool" && call.args.op === "close")).toBe(false);
	expect(h.calls.some(call => call.kind === "tool" && call.args.op === "bind")).toBe(false);
});

test("agent launches, spawns and completes binding before exposing the handle or waiting", async () => {
	const h = harness(); h.holdBind = true;
	const options = { agent: "worker", label: "Task", schema: { type: "string" }, schemaMode: "strict", isolated: false };
	const starting = h.playbook.agent({ blocks: ["b1"], ...options });
	await h.binding;
	expect(h.calls).toEqual([
		{ kind: "tool", name: "playbook_launch", args: { doc: "/book.yaml", run: "r1", op: "launch", blocks: ["b1"] } },
		{ kind: "agent", prompt: "Frozen prompt", options },
		{ kind: "tool", name: "playbook_launch", args: { doc: "/book.yaml", op: "bind", launch: "l1", agent: "worker-1" } },
	]);
	h.bound.resolve(); const spawned = await starting;
	expect(spawned).toMatchObject({ doc: "/book.yaml", run: "r1", launch: "l1", blocks: ["b1"], ownsLaunch: true, id: "worker-1" });
	const recording = h.playbook.result(spawned, { block: "b1" });
	await h.waiting;
	expect(h.calls.at(-1)).toEqual({ kind: "wait" });
	const answer = { accepted: true, items: [1, 2] };
	h.outcome.resolve(answer);
	expect(await recording).toBe(answer);
	expect(h.calls.slice(-2)).toEqual([
		{ kind: "tool", name: "playbook_timeline", args: { doc: "/book.yaml", run: "r1", op: "post", kind: "result", text: JSON.stringify(answer, null, 2), launch: "l1", block: "b1" } },
		close(),
	]);
});

test("the blocks' preset contract fills the options the caller leaves out; explicit options win", async () => {
	const preset = harness(); preset.contract = { agent: "task:mid", isolated: true };
	await preset.playbook.agent({ blocks: ["b2"] });
	expect(preset.calls[1]).toEqual({ kind: "agent", prompt: "Frozen prompt", options: { agent: "task:mid", isolated: true } });
	const explicit = harness(); explicit.contract = { agent: "task:mid", isolated: true };
	await explicit.playbook.agent({ blocks: ["b2"], agent: "task:low", isolated: false, label: "Mine" });
	expect(explicit.calls[1]).toEqual({ kind: "agent", prompt: "Frozen prompt", options: { agent: "task:low", isolated: false, label: "Mine" } });
	const partial = harness(); partial.contract = { isolated: false };
	await partial.playbook.agent({ blocks: ["b2"], agent: "task:high" });
	expect(partial.calls[1]).toEqual({ kind: "agent", prompt: "Frozen prompt", options: { isolated: false, agent: "task:high" } });
	const none = harness();
	await none.playbook.agent({ blocks: ["b2"] });
	expect(none.calls[1]).toEqual({ kind: "agent", prompt: "Frozen prompt", options: {} });
});

test("run inherits the preset contract, records on the only block and closes its Launch", async () => {
	const h = harness(); h.contract = { agent: "task:mid" };
	const running = h.playbook.run({ blocks: ["b2"] });
	await h.waiting; h.outcome.resolve("Done");
	expect(await running).toBe("Done");
	expect(h.calls).toEqual([
		{ kind: "tool", name: "playbook_launch", args: { doc: "/book.yaml", run: "r1", op: "launch", blocks: ["b2"] } },
		{ kind: "agent", prompt: "Frozen prompt", options: { agent: "task:mid" } },
		{ kind: "tool", name: "playbook_launch", args: { doc: "/book.yaml", op: "bind", launch: "l1", agent: "worker-1" } },
		{ kind: "wait" },
		{ kind: "tool", name: "playbook_timeline", args: { doc: "/book.yaml", run: "r1", op: "post", kind: "result", text: "Done", launch: "l1", block: "b2" } },
		close(),
	]);
});

test("wait rejection posts a failure on the only block, closes the owned Launch, then rethrows the original error", async () => {
	const h = harness(); const spawned = await h.playbook.agent({ blocks: ["b1"] });
	const recording = h.playbook.result(spawned);
	const failure = new Error("subagent failed");
	await h.waiting; h.outcome.reject(failure);
	await expect(recording).rejects.toBe(failure);
	expect(h.calls.slice(-3)).toEqual([
		{ kind: "wait" },
		{ kind: "tool", name: "playbook_timeline", args: { doc: "/book.yaml", run: "r1", op: "post", kind: "failure", text: "subagent failed", launch: "l1", block: "b1" } },
		close(),
	]);
});

test("result leaves the Launch open with close: false, and a multi-block result names no block unless given", async () => {
	const h = harness(); const spawned = await h.playbook.agent({ blocks: ["b1", "b2"] });
	const recording = h.playbook.result(spawned, { close: false });
	await h.waiting; h.outcome.resolve("Both");
	await recording;
	expect(h.calls.at(-1)).toEqual({ kind: "tool", name: "playbook_timeline", args: { doc: "/book.yaml", run: "r1", op: "post", kind: "result", text: "Both", launch: "l1" } });
	expect(h.calls.filter(call => call.kind === "tool" && call.args.op === "close")).toEqual([]);
});

test("a spawned subagent shares the Launch: its result keeps the Launch open unless close: true", async () => {
	const kept = harness(); kept.info = { blocks: ["b4"] };
	const shared = await kept.playbook.spawn("l1");
	expect(shared).toMatchObject({ run: "r2", launch: "l1", blocks: ["b4"], ownsLaunch: false });
	const recording = kept.playbook.result(shared);
	await kept.waiting; kept.outcome.resolve("Part");
	await recording;
	expect(kept.calls.at(-1)).toEqual({ kind: "tool", name: "playbook_timeline", args: { doc: "/book.yaml", run: "r2", op: "post", kind: "result", text: "Part", launch: "l1", block: "b4" } });
	const closing = harness();
	const last = await closing.playbook.spawn("l1");
	const finishing = closing.playbook.result(last, { close: true });
	await closing.waiting; closing.outcome.resolve("Last");
	await finishing;
	expect(closing.calls.at(-1)).toEqual(close());
});

test("agent on an orchestration block closes the Launch it just created before rejecting; spawn rejects before any subagent", async () => {
	const agent = harness(); agent.launchKind = "orchestration";
	await expect(agent.playbook.agent({ blocks: ["b1"] })).rejects.toThrow("orchestration block (Launch l1 closed)");
	expect(agent.calls).toEqual([
		{ kind: "tool", name: "playbook_launch", args: { doc: "/book.yaml", run: "r1", op: "launch", blocks: ["b1"] } },
		close(),
	]);
	const spawn = harness(); spawn.launchKind = "orchestration";
	await expect(spawn.playbook.spawn("l1")).rejects.toThrow("orchestration");
	expect(spawn.calls).toEqual([{ kind: "tool", name: "playbook_launch", args: { doc: "/book.yaml", op: "info", launch: "l1" } }]);
});

for (const [blocks, explicit, expected] of [
	[["b1"], undefined, "b1"],
	[["b1", "b2"], undefined, undefined],
	[["b1", "b2"], "b2", "b2"],
	[["b1"], "b2", "b2"],
] as const) {
	test(`run records ${blocks.length} blocks with ${explicit ? "explicit " + explicit : "default block association"}`, async () => {
		const h = harness(); const running = h.playbook.run({ blocks, ...(explicit ? { block: explicit } : {}) });
		await h.waiting; h.outcome.resolve("Result text");
		expect(await running).toBe("Result text");
		expect(h.calls.slice(-2)).toEqual([
			{ kind: "tool", name: "playbook_timeline", args: { doc: "/book.yaml", run: "r1", op: "post", kind: "result", text: "Result text", launch: "l1", ...(expected ? { block: expected } : {}) } },
			close(),
		]);
	});
}

test("spawn uses the Launch's latest baseline and Run rather than the coordinator context", async () => {
	const h = harness(); h.info = { baselines: ["Existing snapshot", "Rebased prompt"] };
	const spawned = await h.playbook.spawn("l1", { doc: "/other.yaml", label: "More work" });
	expect(spawned).toMatchObject({ doc: "/other.yaml", run: "r2", launch: "l1" });
	expect(h.calls).toEqual([
		{ kind: "tool", name: "playbook_launch", args: { doc: "/other.yaml", op: "info", launch: "l1" } },
		{ kind: "agent", prompt: "Rebased prompt", options: { label: "More work" } },
		{ kind: "tool", name: "playbook_launch", args: { doc: "/other.yaml", op: "bind", launch: "l1", agent: "worker-1" } },
	]);
	const initial = harness();
	await initial.playbook.spawn("l1");
	expect(initial.calls[1]).toEqual({ kind: "agent", prompt: "Existing snapshot", options: {} });
});

test("spawn refuses a closed Launch before starting a subagent", async () => {
	const h = harness(); h.info = { closed: { at: 1, by: "coordinator" } };
	await expect(h.playbook.spawn("l1")).rejects.toThrow("l1 is closed");
	expect(h.calls).toEqual([{ kind: "tool", name: "playbook_launch", args: { doc: "/book.yaml", op: "info", launch: "l1" } }]);
});

test("tool error JSON propagates instead of starting an agent; missing Run fails before requesting a Launch", async () => {
	const h = harness(); h.toolFailure = { code: "RunFinished", message: "Run is finished" };
	await expect(h.playbook.agent({ blocks: ["b1"] })).rejects.toThrow("RunFinished: Run is finished");
	expect(h.calls).toHaveLength(1);
	const noRun = harness({});
	await expect(noRun.playbook.run({ blocks: ["b1"] })).rejects.toThrow("run is required");
	expect(noRun.calls).toEqual([]);
});

test("read, timeline and post decode JSON text and respect explicit scope overrides", async () => {
	const h = harness({ doc: "/book.yaml", run: "r1", launch: "l1" });
	expect(await h.playbook.read({ block: "b1" })).toEqual({ title: "Book", blocks: [] });
	expect(await h.playbook.timeline({ doc: "/other.yaml", run: "r2", after: 0 })).toEqual({ seq: 7 });
	expect(await h.playbook.post({ run: "r2", kind: "update", text: "Working", next: 30 })).toEqual({ seq: 7 });
	expect(h.calls).toEqual([
		{ kind: "tool", name: "playbook_read", args: { doc: "/book.yaml", run: "r1", block: "b1" } },
		{ kind: "tool", name: "playbook_timeline", args: { doc: "/other.yaml", run: "r2", op: "read", after: 0 } },
		{ kind: "tool", name: "playbook_timeline", args: { doc: "/book.yaml", run: "r2", op: "post", kind: "update", text: "Working", next: 30 } },
	]);
});

test("result decodes the eval agent wait JSON envelope before returning or recording text", async () => {
	const h = harness(); const spawned = await h.playbook.agent({ blocks: ["b1"] });
	const recording = h.playbook.result(spawned);
	await h.waiting; h.outcome.resolve(JSON.stringify("hello"));
	expect(await recording).toBe("hello");
	expect(h.calls.slice(-2)).toEqual([
		{ kind: "tool", name: "playbook_timeline", args: { doc: "/book.yaml", run: "r1", op: "post", kind: "result", text: "hello", launch: "l1", block: "b1" } },
		close(),
	]);
});
