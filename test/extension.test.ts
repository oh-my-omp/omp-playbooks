import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, watch } from "node:fs";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { z as zod } from "@oh-my-pi/omptype/zod";
import { parseRunId } from "../src/domain/model";
import { socketPath, type EventPayload, type Request, type ServerFrame } from "../src/domain/protocol";
import extension from "../src/extension/index";
import { K1Client } from "../src/extension/client";
import { ensureTernPlugin } from "../src/extension/tern-setup";

const summary = { id: "r1", name: "Run", status: "running", started_at: 1, finished_at: null, done: 0, total: 1, update_due: null, update_overdue: false, retrospective: false };
const block = { id: "b1", kind: "task", title: "Block", body: "Body", status: "todo" };
const designBlock = { id: "b3", kind: "design", title: "Design", requirement: "Human requirement", design: "```js\nreturn 42;\n```", status: "todo" };
type Frame = Request & { readonly id: string };
type Cleanup = () => void | Promise<void>;
const cleanup: Cleanup[] = [];
// The extension factory links the Tern plugin through the real `tern` (once per process);
// point it at a throwaway Tern config so the user's Tern is never touched.
let ternConfig: string;
beforeAll(async () => {
	ternConfig = await mkdtemp("/tmp/pb-ext-tern-");
	process.env.TERN_CONFIG_DIR = ternConfig;
	process.env.TERN_DAEMON_SOCKET = ternConfig + "/daemon.sock";
	await ensureTernPlugin();
});
afterAll(() => rm(ternConfig, { recursive: true, force: true }));
beforeEach(() => {
	const original = { PATH: process.env.PATH, TERN_PANE: process.env.TERN_PANE };
	delete process.env.TERN_PANE;
	cleanup.push(() => {
		for (const key of ["PATH", "TERN_PANE"] as const) {
			const value = original[key];
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	});
});
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function temporaryDirectory(): Promise<string> {
	const dir = await mkdtemp("/tmp/pb-ext-");
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}
function respond(socket: Socket, frame: Frame, result?: unknown): void {
	socket.write(JSON.stringify({ id: frame.id, ok: true, result }) + "\n");
}
async function service(pane: string | undefined = "document-pane", existingDoc?: string) {
	const doc = existingDoc ?? (await temporaryDirectory()) + "/book.yaml";
	if (!existingDoc) await Bun.write(doc, "title: Book\nblocks: []\n");
	await mkdir(tmpdir() + "/omp-playbooks", { recursive: true });
	const path = socketPath(tmpdir(), await realpath(doc));
	const frames: Frame[] = [];
	const sockets: Socket[] = [];
	const received = new Map<Request["op"], ((frame: Frame) => void)[]>();
	let handler = (frame: Frame, socket: Socket): void => {
		const result = frame.op === "hello" ? { blocks: ["b1"], runs: [summary], ...(pane ? { pane } : {}) }
			: frame.op === "lock" ? { block } : frame.op === "runs" ? { runs: [summary] }
			: frame.op === "read" ? { title: "Book", blocks: [block] } : frame.op === "post" ? { seq: 7 } : undefined;
		respond(socket, frame, result);
	};
	const server = createServer(socket => {
		sockets.push(socket);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			buffer += chunk;
			for (;;) {
				const end = buffer.indexOf("\n"); if (end < 0) break;
				const frame = JSON.parse(buffer.slice(0, end)) as Frame;
				buffer = buffer.slice(end + 1);
				frames.push(frame); handler(frame, socket);
				for (const resolve of received.get(frame.op) ?? []) resolve(frame);
				received.delete(frame.op);
			}
		});
	});
	const listeningReady = Promise.withResolvers<void>();
	server.once("error", listeningReady.reject);
	server.listen(path, listeningReady.resolve);
	await listeningReady.promise;
	let listening = true;
	async function stop(): Promise<void> {
		for (const socket of sockets) socket.destroy();
		if (!listening) return;
		listening = false;
		const closed = Promise.withResolvers<void>();
		server.close(error => error ? closed.reject(error) : closed.resolve());
		await closed.promise;
	}
	async function disconnect(): Promise<void> {
		const socket = sockets.at(-1)!;
		const closed = once(socket, "close");
		socket.end();
		await closed;
	}
	function nextFrame(op: Request["op"]): Promise<Frame> {
		const next = Promise.withResolvers<Frame>();
		received.set(op, [...received.get(op) ?? [], next.resolve]);
		return next.promise;
	}
	cleanup.push(stop);
	return { doc, path, frames, sockets, stop, disconnect, nextFrame, set handler(value: typeof handler) { handler = value; }, push(frame: EventPayload) { sockets.at(-1)!.write(JSON.stringify(frame) + "\n"); } };
}

type TextPart = { type: "text"; text: string } | { type: "thinking"; thinking: string };
type Entry = { type: "message"; id: string; message: { role: "user" | "assistant" | "toolResult"; content: string | TextPart[] } } | { type: "custom"; id: string };
type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
type Tool = { name: string; parameters: { parse(value: unknown): unknown }; execute(id: string, params: unknown, signal: undefined, update: undefined, ctx: ExtensionContext): Promise<ToolResult> };
type ToolCallResult = { input: { language: "js" | "py"; code: string; title?: string; timeout?: number; reset?: boolean } } | { block: true; reason: string } | undefined;
type Handler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
async function harness(kind: "main" | "sub" = "main") {
	const tools = new Map<string, Tool>();
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
	const messages: { message: { customType: string; content: string; display: boolean }; options: unknown }[] = [];
	const notices: { message: string; type: string }[] = [];
	const menus: { title: string; options: string[] }[] = [];
	const choices: (string | null | undefined)[] = [];
	const sent = Promise.withResolvers<void>();
	let aborted = 0;
	let selectHook: ((title: string) => Promise<void>) | undefined;
	let branch: Entry[] = [
		{ type: "message", id: "user-1", message: { role: "user", content: "USER" } },
		{ type: "message", id: "assistant-1", message: { role: "assistant", content: [{ type: "text", text: "FULL FIRST" }, { type: "thinking", thinking: "NO" }, { type: "text", text: "FULL SECOND" }] } },
	];
	const ctx = {
		agent: { kind },
		sessionManager: { getSessionId: () => "session-test", getBranch: () => branch },
		abort: () => { aborted++; },
		ui: {
			select: async (title: string, options: string[]) => {
				menus.push({ title, options }); await selectHook?.(title);
				const choice = choices.shift(); return choice === null ? undefined : typeof choice === "string" ? choice : options[0];
			},
			notify: (message: string, type: string) => { notices.push({ message, type }); },
		},
	} as unknown as ExtensionCommandContext;
	// Only the host surfaces this extension consumes are supplied; production types remain unchanged.
	const api = {
		zod, registerTool: (value: Tool) => { tools.set(value.name, value); },
		on: (event: string, handler: Handler) => { handlers.set(event, handler); },
		registerCommand: (name: string, value: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) => { commands.set(name, value); },
		sendMessage: (message: { customType: string; content: string; display: boolean }, options: unknown) => { messages.push({ message, options }); sent.resolve(); },
	} as unknown as ExtensionAPI;
	await extension(api);
	let started = false;
	async function event(name: string, payload: unknown = {}): Promise<unknown> {
		if (name === "session_start") started = true;
		return handlers.get(name)?.(payload, ctx);
	}
	// omp fires session_start before the session can run tools or commands.
	async function start(): Promise<void> {
		if (!started) await event("session_start");
	}
	cleanup.push(async () => { await event("session_shutdown"); });
	return {
		ctx, messages, notices, menus, choices, event, tools, messageSent: sent.promise,
		get aborted() { return aborted; }, get registered() { return { tools: [...tools.keys()], commands: [...commands.keys()] }; },
		set branch(value: Entry[]) { branch = value; }, set selectHook(value: typeof selectHook) { selectHook = value; },
		execute: async (name: string, params: unknown) => { await start(); return tools.get(name)!.execute("tool", params, undefined, undefined, ctx); },
		call: async (input: unknown, toolName = "eval"): Promise<ToolCallResult> => { await start(); return await event("tool_call", { toolName, input }) as ToolCallResult; },
		command: async (name: string, doc = "") => { await start(); return commands.get(name)!.handler(doc, ctx); },
	};
}
async function fakeTern(exit = 0, stdout = "") {
	const dir = await temporaryDirectory();
	const capture = dir + "/args";
	await Bun.write(dir + "/tern", `#!/bin/sh\nprintf '%s\\n' "$@" >> '${capture}'\nprintf '%s' '${stdout}'\nprintf 'focus failed' >&2\nexit ${exit}\n`);
	await chmod(dir + "/tern", 0o755);
	process.env.PATH = dir + ":" + process.env.PATH;
	return { capture, args: async () => (await Bun.file(capture).text()).trim().split("\n") };
}
/** Resolves when the fake tern child has written its arguments: the split happened. */
function fileAppears(path: string): Promise<void> {
	const appeared = Promise.withResolvers<void>();
	const watcher = watch(dirname(path), () => { if (existsSync(path)) { watcher.close(); appeared.resolve(); } });
	cleanup.push(() => watcher.close());
	if (existsSync(path)) { watcher.close(); appeared.resolve(); }
	return appeared.promise;
}
function parseFrame(value: unknown): ServerFrame { return value as ServerFrame; }
function client(path: string): K1Client {
	const value = new K1Client(path, { session: "client-test" }, parseFrame, () => {});
	cleanup.push(() => value.close()); return value;
}
const runId = parseRunId("r1")!;

for (const [op, fields, mutation, args] of [
	["title", { value: "Renamed" }, "set", { field: "title", value: "Renamed" }],
	["status", { value: "done" }, "set", { field: "status", value: "done" }],
	["replace", { find: "Body", replace: "New" }, "edit", { find: "Body", replace: "New" }],
	["write", { text: "New design" }, "write", { text: "New design" }],
	["panel", { panel: "A", text: "## A Revised\nNew design" }, "panel", { panel: "A", text: "## A Revised\nNew design" }],
	["delete", {}, "delete", {}],
	["move", { after: null }, "move", { after: null }],
	["move", { after: "b2" }, "move", { after: "b2" }],
	["agent", { value: " task:mid " }, "set", { field: "agent", value: "task:mid" }],
	["agent", { value: null }, "set", { field: "agent", value: null }],
	["isolated", { value: false }, "set", { field: "isolated", value: false }],
	["isolated", { value: null }, "set", { field: "isolated", value: null }],
] as const) {
	test(`edit ${op} ${JSON.stringify(fields)} locks, changes and releases only its own lock`, async () => {
		const s = await service(); const h = await harness();
		const result = await h.execute("playbook_edit", { doc: s.doc, run: "r1", block: "b1", op, ...fields });
		expect(result.isError).toBe(false);
		expect(s.frames.map(frame => frame.op)).toEqual(op === "delete" ? ["hello", "lock", mutation] : ["hello", "lock", mutation, "unlock"]);
		expect(s.frames[0]).toMatchObject({ args: { session: "session-test" } });
		expect(s.frames[1]!.args).toEqual({ run: "r1", block: "b1" });
		expect(s.frames[2]!.args).toEqual({ run: "r1", block: "b1", ...args });
		if (op !== "delete") expect(s.frames[3]!.args).toEqual({ run: "r1", block: "b1", request: s.frames[1]!.id });
		await h.event("session_shutdown");
		expect(s.frames).toHaveLength(op === "delete" ? 3 : 4);
	});
}

test("playbook_edit rejects a blank agent, a design-block contract field and a move without a target before any request", async () => {
	const s = await service(); const h = await harness();
	for (const params of [
		{ op: "agent", block: "b1", value: "   " },
		{ op: "isolated", block: "b1", value: "yes" },
		{ op: "move", block: "b1" },
		{ op: "insert", title: "T", body: "B", agent: "" },
		{ op: "insert_design", title: "T", design: "D", agent: "task:mid" },
	]) {
		const result = await h.execute("playbook_edit", { doc: s.doc, ...params });
		expect(result.isError).toBe(true);
	}
	expect(s.frames).toEqual([]);
});

test("playbook_read accepts task blocks carrying agent and isolated", async () => {
	const s = await service(); const h = await harness();
	const configured = { ...block, agent: "task:mid", isolated: true };
	s.handler = (frame, socket) => respond(socket, frame, frame.op === "hello" ? { blocks: ["b1"], runs: [] } : { title: "Book", blocks: [configured] });
	const result = await h.execute("playbook_read", { doc: s.doc });
	expect(result.isError).toBe(false);
	expect(JSON.parse(result.content[0]!.text!)).toEqual({ title: "Book", blocks: [configured] });
});

test("interruption revokes an in-flight edit without aborting the coordinator; Locked never sends a mutation", async () => {
	const s = await service(); const h = await harness();
	await h.execute("playbook_open", { doc: s.doc });
	s.handler = (frame, socket) => {
		if (frame.op === "lock") {
			respond(socket, frame, { block });
			socket.write(JSON.stringify({ event: "interrupted", data: { run: "r1", block: "b1", request: frame.id } }) + "\n");
		} else if (frame.op === "set") {
			socket.write(JSON.stringify({ id: frame.id, ok: false, error: { code: "NotLocked", message: "lock revoked" } }) + "\n");
		} else respond(socket, frame);
	};
	const changed = await h.execute("playbook_edit", { op: "title", run: "r1", block: "b1", value: "New" });
	expect(changed.isError).toBe(true);
	expect(structuredClone(JSON.parse(changed.content[0]!.text!).error)).toMatchObject({ code: "NotLocked", message: expect.stringContaining("person took this block back") });
	expect(s.frames.map(frame => frame.op)).toEqual(["hello", "lock", "set", "unlock"]);
	expect(h.aborted).toBe(0); expect(h.messages).toEqual([]);
	s.handler = (frame, socket) => socket.write(JSON.stringify({ id: frame.id, ok: false, error: { code: "Locked", message: "human editing", detail: { block: "b1" } } }) + "\n");
	const locked = await h.execute("playbook_edit", { op: "delete", block: "b1" });
	expect(JSON.parse(locked.content[0]!.text!)).toEqual({ error: { code: "Locked", message: "human editing", detail: { block: "b1" } } });
	expect(s.frames.map(frame => frame.op)).toEqual(["hello", "lock", "set", "unlock", "lock"]);
});

test("event aside precedes block_changed ack; unrelated interruption is ignored", async () => {
	const s = await service(); const h = await harness(); await h.execute("playbook_run", { doc: s.doc, op: "list" });
	let deliveredBeforeAck = false;
	s.handler = (frame, socket) => {
		if (frame.op === "ack") deliveredBeforeAck = h.messages.length === 1;
		respond(socket, frame, frame.op === "runs" ? { runs: [summary] } : undefined);
	};
	const ack = s.nextFrame("ack");
	s.push({ event: "block_changed", data: { id: "e1", launch: { id: "l1", kind: "prompt", run: "r1" }, agents: [], changed: ["b1"], diff: "diff", current: { kind: "Ok", text: "new", sources: [] } } } as EventPayload);
	await ack;
	expect(deliveredBeforeAck).toBe(true);
	expect(h.messages[0]!.message.customType).toBe("playbook-event");
	expect(h.messages[0]!.message.content.split("\n")[0]).toBe("这是 Playbook 文档服务的通知，不是用户消息");
	const lines = h.messages[0]!.message.content.split("\n");
	expect(lines).toHaveLength(3);
	expect(lines[1]).toContain('op: "rebase", launch: "l1"');
	expect(JSON.parse(lines[2]!)).toEqual({ doc: await realpath(s.doc), event: "block_changed", data: { id: "e1", launch: { id: "l1", kind: "prompt", run: "r1" }, agents: [], changed: ["b1"], diff: "diff", current: { kind: "Ok", text: "new", sources: [] } } });
	expect(h.messages[0]!.options).toEqual({ deliverAs: "aside", triggerTurn: true });
	expect(s.frames.at(-1)).toMatchObject({ op: "ack", args: { event: "e1" } });
	s.push({ event: "interrupted", data: { block: "b1", request: "old" } } as EventPayload);
	await h.execute("playbook_run", { doc: s.doc, op: "list" }); expect(h.aborted).toBe(0); expect(h.messages).toHaveLength(1);
});

for (const run of [undefined, "r1"] as const) {
	test(`revision_requested fetches the submitted ${run === undefined ? "template" : "Run"} prompt before asking the coordinator to revise only the design`, async () => {
		const s = await service(); const h = await harness();
		await h.execute("playbook_open", { doc: s.doc });
		s.handler = () => {};
		const requested = s.nextFrame("revisions");
		const scope = run === undefined ? {} : { run };
		s.push({ event: "revision_requested", data: { ...scope, block: "b3", revision: 5 } } as EventPayload);
		const frame = await requested;
		expect(frame.args).toEqual({ ...scope, block: "b3", after: 4 });
		expect(h.messages).toEqual([]);
		const prompt = "Keep the requirement intact.\nRevise the failure path and label it clearly.";
		respond(s.sockets.at(-1)!, frame, { revisions: [
			{ seq: 6, at: 20, block: "b3", prompt: "A newer request, not the one submitted" },
			{ seq: 5, at: 10, block: "b3", prompt },
		] });
		await h.messageSent;
		expect(s.frames.map(item => item.op)).toEqual(["hello", "revisions"]);
		expect(h.messages).toHaveLength(1);
		const { message, options } = h.messages[0]!;
		expect(message.customType).toBe("playbook-event");
		expect(message.display).toBe(true);
		expect(options).toEqual({ deliverAs: "aside", triggerTurn: true });
		const lines = message.content.split("\n");
		expect(lines[0]).toBe("这是 Playbook 文档服务的通知，不是用户消息");
		expect(message.content).toContain(prompt);
		expect(message.content).not.toContain("A newer request");
		const instruction = lines.slice(1, -1).join("\n");
		expect(instruction).toContain("playbook_read");
		expect(instruction).toContain('block: "b3"');
		const history = `playbook_read {doc: ${JSON.stringify(await realpath(s.doc))}, ${run === undefined ? "" : `run: "${run}", `}op: "revisions", block: "b3"}`;
		expect(instruction).toContain(`需要以前的修改要求时用 ${history}。`);
		expect(instruction).toContain("修订设计");
		expect(instruction).toContain("playbook_edit");
		for (const op of ["write", "replace", "panel"]) expect(instruction).toContain(op);
		expect(instruction).toMatch(/不要改\s+requirement/);
		expect(instruction).not.toContain("playbook.run");
		expect(JSON.parse(lines.at(-1)!)).toEqual({ doc: await realpath(s.doc), event: "revision_requested", data: { ...scope, block: "b3", revision: 5 } });
	});

	test(`revision_requested keeps the ${run === undefined ? "template" : "Run"} document and block scope in the lookup-failure hint and history advice`, async () => {
		const s = await service(); const h = await harness();
		await h.execute("playbook_open", { doc: s.doc });
		s.handler = (frame, socket) => respond(socket, frame, { revisions: [] });
		const scope = run === undefined ? {} : { run };
		s.push({ event: "revision_requested", data: { ...scope, block: "b3", revision: 5 } } as EventPayload);
		await h.messageSent;
		expect(s.frames.map(item => item.op)).toEqual(["hello", "revisions"]);
		expect(s.frames.at(-1)!.args).toEqual({ ...scope, block: "b3", after: 4 });
		expect(h.messages).toHaveLength(1);
		const { message, options } = h.messages[0]!;
		expect(message.customType).toBe("playbook-event");
		expect(options).toEqual({ deliverAs: "aside", triggerTurn: true });
		const lines = message.content.split("\n");
		const instruction = lines.slice(1, -1).join("\n");
		const history = `playbook_read {doc: ${JSON.stringify(await realpath(s.doc))}, ${run === undefined ? "" : `run: "${run}", `}op: "revisions", block: "b3"}`;
		expect(instruction).toContain(`（读取失败，用 ${history} 查询）`);
		expect(instruction).toContain(`需要以前的修改要求时用 ${history}。`);
		expect(instruction).not.toContain("<prompt>");
		expect(JSON.parse(lines.at(-1)!)).toEqual({ doc: await realpath(s.doc), event: "revision_requested", data: { ...scope, block: "b3", revision: 5 } });
	});
}

test("add writes full text, quote and human origin; cancelling any message/run/kind/block menu suppresses post", async () => {
	const s = await service(); const h = await harness(); h.choices.push("assistant-1: FULL FIRST FULL SECOND");
	await h.command("playbook-add", s.doc);
	expect(s.frames.at(-1)).toMatchObject({ op: "post", args: { kind: "update", text: "FULL FIRST\nFULL SECOND", quote: "assistant-1", origin: "human" } });
	expect(h.notices.at(-1)!.message).toContain("7");
	for (let stage = 0; stage < 4; stage++) {
		h.choices.push(...Array<undefined>(stage).fill(undefined), null);
		const before = s.frames.filter(frame => frame.op === "post").length;
		await h.command("playbook-add", s.doc);
		expect(s.frames.filter(frame => frame.op === "post")).toHaveLength(before);
	}
	expect(() => h.tools.get("playbook_timeline")!.parameters.parse({ doc: s.doc, op: "post", run: "r1", kind: "result", text: "x", origin: "human" })).toThrow();
});

test("show calls a real tern child with the hello pane unchanged; add offers latest twenty textual user/assistant messages", async () => {
	const s = await service(); const tern = await fakeTern(); const h = await harness(); process.env.TERN_PANE = "coordinator-pane";
	await h.command("playbook-show", s.doc);
	expect(h.notices).toEqual([]); expect(await tern.args()).toEqual(["focus", "document-pane", "--json"]);
	expect(s.frames[0]).toMatchObject({ args: { pane: "coordinator-pane" } });
	h.branch = Array.from({ length: 25 }, (_, i): Entry => ({ type: "message", id: "message-" + i, message: { role: i % 2 ? "user" : "assistant", content: [{ type: "text", text: "text-" + i }] } }));
	h.branch = [...h.ctx.sessionManager.getBranch() as unknown as Entry[], { type: "custom", id: "custom" }, { type: "message", id: "empty", message: { role: "user", content: "" } }, { type: "message", id: "tool", message: { role: "toolResult", content: "ignore" } }];
	h.choices.push(null); await h.command("playbook-add");
	expect(h.menus[0]!.options).toHaveLength(20); expect(h.menus[0]!.options[0]).toBe("message-24: text-24");
	expect(h.menus[0]!.options.at(-1)).toBe("message-5: text-5"); expect(s.frames.some(frame => frame.op === "post")).toBe(false);
});

test("open starts the document service beside the coordinator pane and returns hello once it listens", async () => {
	const doc = (await temporaryDirectory()) + "/book.yaml"; await Bun.write(doc, "title: Book\nblocks: []\n");
	const tern = await fakeTern(0, '{"block": 42}'); process.env.TERN_PANE = "coordinator-pane"; const h = await harness();
	const split = fileAppears(tern.capture);
	const opening = h.execute("playbook_open", { doc });
	await split;
	const s = await service("document-pane", doc);
	const result = await opening;
	expect(result.isError).toBe(false);
	expect(JSON.parse(result.content[0]!.text!)).toMatchObject({ blocks: ["b1"], pane: "document-pane" });
	const real = await realpath(doc);
	expect(await tern.args()).toEqual(["split", "coordinator-pane", "right", "--cwd", dirname(real), "--json", "--", "bun", resolve(import.meta.dir, "../src/service/main.ts"), real]);
	expect(s.frames.map(frame => frame.op)).toEqual(["hello"]);
});

test("open reuses a running service without tern; with no service and no TERN_PANE it is StartFailed", async () => {
	const s = await service(); const tern = await fakeTern(0, '{"block": 42}'); const h = await harness();
	const running = await h.execute("playbook_open", { doc: s.doc });
	expect(running.isError).toBe(false); expect(await Bun.file(tern.capture).exists()).toBe(false);
	const doc = (await temporaryDirectory()) + "/idle.yaml"; await Bun.write(doc, "title: Idle\nblocks: []\n");
	const idle = await h.execute("playbook_open", { doc });
	expect(idle.isError).toBe(true); expect(JSON.parse(idle.content[0]!.text!).error.code).toBe("StartFailed");
	expect(await Bun.file(tern.capture).exists()).toBe(false);
});

test("a child session registers no tool or command and never connects (R4)", async () => {
	const s = await service();
	const h = await harness("sub"); await h.event("session_start");
	expect(h.registered).toEqual({ tools: [], commands: [] });
	expect(s.frames).toHaveLength(0);
});

for (const command of ["playbook-add", "playbook-show"]) {
	test(`${command}: absent doc and connections reports exact path prompt`, async () => {
		const h = await harness(); await h.command(command);
		expect(h.notices).toEqual([{ message: "请指定 Playbook 文件路径", type: "error" }]); expect(h.menus).toEqual([]);
	});
	test(`${command}: unique live connection is used; multiple connections prompt and allow cancellation`, async () => {
		const a = await service("pane-a"); const b = await service("pane-b"); const tern = await fakeTern(); process.env.TERN_PANE = "coordinator-pane"; const h = await harness();
		await h.execute("playbook_run", { doc: a.doc, op: "list" });
		await h.command(command); expect(h.menus.some(menu => menu.title === "Choose Playbook")).toBe(false);
		await h.execute("playbook_run", { doc: b.doc, op: "list" }); h.choices.push(await realpath(b.doc)); await h.command(command);
		expect(h.menus.find(menu => menu.title === "Choose Playbook")!.options).toEqual([await realpath(a.doc), await realpath(b.doc)]);
		if (command === "playbook-show") expect(await tern.args()).toEqual(["focus", "pane-a", "--json", "focus", "pane-b", "--json"]);
		else expect(b.frames.at(-1)!.op).toBe("post");
		const counts = [a.frames.length, b.frames.length]; h.choices.push(null); await h.command(command);
		expect([a.frames.length, b.frames.length]).toEqual(counts);
	});
}

test("show missing remote pane never invokes tern and gives exact daemon-pane notification", async () => {
	const s = await service(""); const tern = await fakeTern(); const h = await harness(); process.env.TERN_PANE = "coordinator-pane";
	await h.command("playbook-show", s.doc);
	expect(h.notices).toEqual([{ message: "文档服务不在 session daemon 托管的 pane 中", type: "error" }]); expect(await Bun.file(tern.capture).exists()).toBe(false);
});

test("show without local pane never invokes tern; child failures retain exit code and stderr", async () => {
	const s = await service(); const tern = await fakeTern(9); const h = await harness(); await h.command("playbook-show", s.doc);
	expect(await Bun.file(tern.capture).exists()).toBe(false); expect(h.notices.at(-1)!.message).toContain("coordinator Tern pane");
	process.env.TERN_PANE = "coordinator-pane"; await h.command("playbook-show", s.doc);
	expect(h.notices.at(-1)!.message).toContain("tern focus exited 9: focus failed"); expect(await tern.args()).toEqual(["focus", "document-pane", "--json"]);
});

for (const op of ["runs", "post"] as const) {
	for (const failure of ["protocol", "Disconnected", "NoService"] as const) {
		test(`add ${op} ${failure} notifies and stops without retry`, async () => {
			const s = await service(); const h = await harness(); const normal = (frame: Frame, socket: Socket) => respond(socket, frame, frame.op === "hello" ? { blocks: ["b1"], runs: [summary] } : frame.op === "runs" ? { runs: [summary] } : frame.op === "read" ? { title: "Book", blocks: [block] } : { seq: 7 });
			s.handler = (frame, socket) => {
				if (frame.op !== op || failure === "NoService") { normal(frame, socket); return; }
				if (failure === "Disconnected") socket.destroy();
				else socket.write(JSON.stringify({ id: frame.id, ok: false, error: { code: "BadValue", message: "rejected " + op } }) + "\n");
			};
			if (failure === "NoService") h.selectHook = async title => {
				if (title === (op === "runs" ? "Choose session message" : "Choose block")) { await s.disconnect(); await s.stop(); }
			};
			await h.command("playbook-add", s.doc);
			expect(h.notices.at(-1)!.type).toBe("error"); expect(h.notices.at(-1)!.message).toContain(failure === "protocol" ? "BadValue: rejected " + op : failure);
			expect(s.frames.filter(frame => frame.op === op)).toHaveLength(failure === "NoService" ? 0 : 1);
			if (op === "runs") expect(s.frames.some(frame => frame.op === "read" || frame.op === "post")).toBe(false);
		});
	}
}

test("add reconnects before runs and post when transport disappears during menu selection", async () => {
	const s = await service(); const h = await harness();
	h.selectHook = async title => {
		if (title === "Choose session message" || title === "Choose block") await s.disconnect();
	};
	await h.command("playbook-add", s.doc);
	expect(s.frames.map(frame => frame.op)).toEqual(["hello", "hello", "runs", "read", "hello", "post"]);
	expect(h.notices.at(-1)).toEqual({ message: "Playbook timeline entry 7 written", type: "info" });
});

test("client missing socket returns NoService; failed hello sends no target request", async () => {
	const missing = client("/tmp/no-pb-service-" + randomUUID()); const reply = await missing.request({ op: "runs", args: {} });
	expect(reply.ok).toBe(false); if (!reply.ok) expect(reply.error.code).toBe("NoService");
	const s = await service(); s.handler = (_frame, socket) => socket.destroy();
	const c = client(s.path); const beforeHello = await c.request({ op: "post", args: { run: runId, kind: "update", text: "x" } });
	expect(beforeHello.ok).toBe(false); if (!beforeHello.ok) expect(beforeHello.error.code).toBe("NoService"); expect(s.frames.map(frame => frame.op)).toEqual(["hello"]);
});

test("in-flight disconnect is Disconnected; automatic reconnect sends only hello; close stops retries", async () => {
	const s = await service(); s.handler = (frame, socket) => { if (frame.op === "hello") respond(socket, frame, { blocks: [], runs: [] }); else socket.destroy(); };
	const c = client(s.path); const reply = await c.request({ op: "post", args: { run: runId, kind: "update", text: "x" } });
	expect(reply.ok).toBe(false); if (!reply.ok) expect(reply.error.code).toBe("Disconnected");
	// Exercise the real platform reconnect deadline and prove close cancels that deadline.
	// Advancing fake timers does not reproduce Unix-socket I/O across transport lifetimes.
	await Bun.sleep(2150); expect(s.frames.map(frame => frame.op)).toEqual(["hello", "post", "hello"]);
	c.close(); await Bun.sleep(2150); expect(s.frames.map(frame => frame.op)).toEqual(["hello", "post", "hello"]);
});

test("tool calls require an unambiguous connected document when doc is omitted", async () => {
	const h = await harness();
	const none = await h.execute("playbook_read", {});
	expect(JSON.parse(none.content[0]!.text!).error.code).toBe("NoService");
	const a = await service(); const b = await service();
	await h.execute("playbook_open", { doc: a.doc });
	const read = await h.execute("playbook_read", { run: "r1", block: "b1" });
	expect(read.isError).toBe(false);
	expect(a.frames.at(-1)).toMatchObject({ op: "read", args: { run: "r1", block: "b1" } });
	await h.execute("playbook_open", { doc: b.doc });
	const counts = [a.frames.length, b.frames.length];
	const ambiguous = await h.execute("playbook_read", {});
	expect(JSON.parse(ambiguous.content[0]!.text!).error.code).toBe("NoService");
	expect([a.frames.length, b.frames.length]).toEqual(counts);
	await h.execute("playbook_read", { doc: b.doc });
	expect(b.frames.at(-1)).toMatchObject({ op: "read", args: {} });
});

for (const [tool, params, request] of [
	["playbook_edit", { op: "insert", run: "r1", after: "b1", title: "New", body: "Text" }, { op: "insert", args: { run: "r1", after: "b1", title: "New", content: { kind: "task", body: "Text" } } }],
	["playbook_edit", { op: "insert", title: "Configured", body: "Text", agent: " task:mid ", isolated: false }, { op: "insert", args: { title: "Configured", content: { kind: "task", body: "Text", agent: "task:mid", isolated: false } } }],
	["playbook_edit", { op: "insert_design", run: "r1", after: "b1", title: "New design", design: "## A Overview\nDraft" }, { op: "insert", args: { run: "r1", after: "b1", title: "New design", content: { kind: "design", design: "## A Overview\nDraft" } } }],
	["playbook_edit", { op: "insert_design", title: "Template design", design: "Draft" }, { op: "insert", args: { title: "Template design", content: { kind: "design", design: "Draft" } } }],
	["playbook_read", { op: "revisions" }, { op: "revisions", args: {} }],
	["playbook_read", { op: "revisions", run: "r1", block: "b3", after: 0 }, { op: "revisions", args: { run: "r1", block: "b3", after: 0 } }],
	["playbook_compile", { op: "compile", run: "r1", blocks: ["b1"] }, { op: "compile", args: { run: "r1", blocks: ["b1"] } }],
	["playbook_compile", { op: "refetch", targets: ["file:book.md"] }, { op: "refetch", args: { targets: ["file:book.md"] } }],
	["playbook_check", { op: "inspect", blocks: ["b1"] }, { op: "inspect", args: { blocks: ["b1"] } }],
	["playbook_check", { op: "report", run: "r1", blocks: ["b1"], version: "v", result: { kind: "answers", answers: { q1: 0.8 } } }, { op: "report", args: { run: "r1", blocks: ["b1"], version: "v", result: { kind: "answers", answers: { q1: 0.8 } } } }],
	["playbook_run", { op: "start", name: "Run", update_every: 30 }, { op: "start_run", args: { name: "Run", update_every: 30 } }],
	["playbook_run", { op: "finish", run: "r1" }, { op: "finish_run", args: { run: "r1" } }],
	["playbook_run", { op: "list" }, { op: "runs", args: {} }],
	["playbook_timeline", { op: "read", run: "r1", after: 0 }, { op: "timeline", args: { run: "r1", after: 0 } }],
	["playbook_timeline", { op: "post", run: "r1", kind: "result", text: "Answer", block: "b1", launch: "l1", quote: "message-1" }, { op: "post", args: { run: "r1", kind: "result", text: "Answer", block: "b1", launch: "l1", quote: "message-1" } }],
	["playbook_timeline", { op: "snooze", run: "r1", after: 30 }, { op: "snooze", args: { run: "r1", after: 30 } }],
	["playbook_launch", { op: "launch", run: "r1", blocks: ["b1"] }, { op: "launch", args: { run: "r1", blocks: ["b1"] } }],
	["playbook_launch", { op: "bind", launch: "l1", agent: "worker-1" }, { op: "bind", args: { launch: "l1", agent: "worker-1" } }],
	["playbook_launch", { op: "info", launch: "l1" }, { op: "launch_info", args: { launch: "l1" } }],
	["playbook_launch", { op: "rebase", launch: "l1" }, { op: "rebase", args: { launch: "l1" } }],
	["playbook_launch", { op: "close", launch: "l1" }, { op: "close", args: { launch: "l1" } }],
] as const) {
	test(`${tool} ${params.op} sends the scoped K1 request without editor-only fields`, async () => {
		const s = await service(); const h = await harness();
		const result = await h.execute(tool, { doc: s.doc, ...params });
		expect(result.isError).toBe(false);
		expect(s.frames.map(frame => frame.op)).toEqual(["hello", request.op]);
		expect(s.frames[1]).toMatchObject(request);
		expect(s.frames[1]!.args).toEqual(request.args);
	});
}

for (const orchestration of [false, true]) {
	test(`launch_requested selects ${orchestration ? "orchestration execution" : "prompt subagent execution"} from the requested Run blocks`, async () => {
		const s = await service(); const h = await harness();
		await h.execute("playbook_open", { doc: s.doc });
		s.handler = (frame, socket) => respond(socket, frame, {
			title: "Run copy", blocks: [
				{ ...block, body: orchestration ? "```js\nreturn 42;\n```" : "Prompt" },
				{ ...block, id: "b2", body: "```py\nprint(42)\n```" },
				designBlock,
			],
		});
		s.push({ event: "launch_requested", data: { run: "r1", blocks: ["b1"] } } as EventPayload);
		await h.messageSent;
		expect(s.frames.at(-1)).toMatchObject({ op: "read", args: { run: "r1" } });
		const lines = h.messages[0]!.message.content.split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe("这是 Playbook 文档服务的通知，不是用户消息");
		expect(lines[1]).toContain(orchestration ? "playbook_launch" : "await playbook.run(");
		if (orchestration) expect(lines[1]).toContain('await playbook.exec("l<n>")');
		else {
			expect(lines[1]).not.toContain("playbook_launch");
			expect(lines[1]).toContain("var worker = await playbook.agent(");
			expect(lines[1]).toContain("await playbook.result(worker)");
			expect(lines[1]).not.toContain("已预设");
		}
		expect(JSON.parse(lines[2]!)).toEqual({ doc: await realpath(s.doc), event: "launch_requested", data: { run: "r1", blocks: ["b1"] } });
		expect(h.messages[0]!.options).toEqual({ deliverAs: "aside", triggerTurn: true });
	});
}

test("launch_requested names a single block's preset agent and isolated", async () => {
	const s = await service(); const h = await harness();
	await h.execute("playbook_open", { doc: s.doc });
	s.handler = (frame, socket) => respond(socket, frame, { title: "Run copy", blocks: [{ ...block, body: "Prompt", agent: "task:mid", isolated: true }] });
	s.push({ event: "launch_requested", data: { run: "r1", blocks: ["b1"] } } as EventPayload);
	await h.messageSent;
	const lines = h.messages[0]!.message.content.split("\n");
	expect(lines[1]).toContain('块 b1 已预设 agent: "task:mid" isolated: true，不显式传参时 playbook.agent / playbook.run 自动使用。');
});

test("exec runs the latest rebased orchestration code, not the frozen snapshot", async () => {
	const s = await service(); const h = await harness();
	await h.execute("playbook_open", { doc: s.doc });
	const first = "```js\nreturn \"first\";\n```";
	const rebased = "```js\nreturn \"rebased\";\n```";
	s.handler = (frame, socket) => respond(socket, frame, { id: "l1", run: "r1", session: "session-test", kind: "orchestration", snapshot: { result: { text: first } }, baselines: [first, rebased] });
	const rewritten = await h.call({ language: "js", code: 'await playbook.exec("l1")' });
	if (!rewritten || !("input" in rewritten)) throw new Error("exec was not rewritten");
	expect(rewritten.input.code).toEndWith('return "rebased";');
});

test("launch_requested does not treat a requested design block as orchestration", async () => {
	const s = await service(); const h = await harness();
	await h.execute("playbook_open", { doc: s.doc });
	s.handler = (frame, socket) => respond(socket, frame, {
		title: "Run copy", blocks: [designBlock, { ...block, body: "```py\nprint(42)\n```" }],
	});
	s.push({ event: "launch_requested", data: { run: "r1", blocks: ["b3"] } } as EventPayload);
	await h.messageSent;
	expect(s.frames.at(-1)).toMatchObject({ op: "read", args: { run: "r1" } });
	const lines = h.messages[0]!.message.content.split("\n");
	expect(lines[1]).toContain("await playbook.run(");
	expect(lines[1]).not.toContain("playbook_launch");
	expect(lines[1]).not.toContain("playbook.exec");
	expect(JSON.parse(lines[2]!)).toEqual({ doc: await realpath(s.doc), event: "launch_requested", data: { run: "r1", blocks: ["b3"] } });
	expect(h.messages[0]!.options).toEqual({ deliverAs: "aside", triggerTurn: true });
});

for (const language of ["js", "py"] as const) {
	test(`whole exec rewrites ${language} orchestration from its frozen Launch snapshot`, async () => {
		const s = await service(); const h = await harness();
		await h.execute("playbook_open", { doc: s.doc });
		const doc = await realpath(s.doc);
		const source = language === "js" ? "return playbook.context;" : "print(PLAYBOOK_DOC, PLAYBOOK_RUN, PLAYBOOK_LAUNCH)";
		s.handler = (frame, socket) => respond(socket, frame, { id: "l1", run: "r1", session: "session-test", kind: "orchestration", snapshot: { result: { text: "```" + language + "\n" + source + "\n```" } } });
		const rewritten = await h.call({ language: "js", code: language === "js" ? 'await playbook.exec("l1")' : `await playbook.exec('l1', ${JSON.stringify(s.doc)})`, title: "Execute", timeout: 99, reset: true });
		expect(rewritten).toBeDefined();
		if (!rewritten || !("input" in rewritten)) throw new Error("exec was not rewritten");
		expect(rewritten.input).toMatchObject({ language, title: "Execute", timeout: 0, reset: true });
		expect(s.frames.at(-1)).toMatchObject({ op: "launch_info", args: { launch: "l1" } });
		if (language === "js") {
			const execute = new (Object.getPrototypeOf(async function () {}).constructor)("tool", "agent", rewritten.input.code) as (tool: Record<string, never>, agent: () => Promise<never>) => Promise<unknown>;
			expect(await execute({}, async () => { throw new Error("orchestration only reads context"); })).toEqual({ doc, run: "r1", launch: "l1" });
		} else {
			expect(rewritten.input.code.endsWith(`PLAYBOOK_DOC = ${JSON.stringify(doc)}\nPLAYBOOK_RUN = "r1"\nPLAYBOOK_LAUNCH = "l1"\n${source}`)).toBe(true);
		}
	});
}

for (const kind of ["prompt", "unknown", "unfenced"] as const) {
	test(`exec blocks a ${kind} Launch instead of executing arbitrary code`, async () => {
		const s = await service(); const h = await harness();
		await h.execute("playbook_open", { doc: s.doc });
		s.handler = (frame, socket) => {
			if (kind === "unknown") socket.write(JSON.stringify({ id: frame.id, ok: false, error: { code: "UnknownLaunch", message: "missing l1" } }) + "\n");
			else respond(socket, frame, { id: "l1", run: "r1", session: "session-test", kind: kind === "prompt" ? "prompt" : "orchestration", snapshot: { result: { text: kind === "prompt" ? "Task" : "return 42;" } } });
		};
		const result = await h.call({ language: "js", code: 'await playbook.exec("l1")' });
		if (!result || !("reason" in result)) throw new Error("unsafe exec was not blocked");
		expect(result.block).toBe(true);
		expect(typeof result.reason).toBe("string");
		if (kind === "unknown") expect(result.reason).toContain("UnknownLaunch");
	});
}

test("exec must be the whole cell and needs an unambiguous document", async () => {
	const h = await harness();
	expect(await h.call({ language: "js", code: 'const a = await playbook.exec("l1"); return a;' })).toMatchObject({ block: true });
	expect(structuredClone(await h.call({ language: "js", code: 'await playbook.exec("l1")' }))).toMatchObject({ block: true, reason: expect.stringContaining("NoService") });
	const a = await service(); const b = await service();
	await h.execute("playbook_open", { doc: a.doc }); await h.execute("playbook_open", { doc: b.doc });
	expect(structuredClone(await h.call({ language: "js", code: 'await playbook.exec("l1")' }))).toMatchObject({ block: true, reason: expect.stringContaining("several") });
	expect(a.frames.map(frame => frame.op)).toEqual(["hello"]); expect(b.frames.map(frame => frame.op)).toEqual(["hello"]);
});

for (const helper of ["run", "agent", "result", "spawn", "post", "timeline", "read", "context"]) {
	test(`JS ${helper} receives the prelude without reimporting or overriding an explicit timeout`, async () => {
		const h = await harness(); const code = helper === "context" ? "return playbook.context;" : `await playbook.${helper}({});`;
		const rewritten = await h.call({ language: "js", code });
		if (!rewritten || !("input" in rewritten)) throw new Error("helper was not rewritten");
		expect(rewritten.input.code).toEndWith(code);
		expect(rewritten.input.timeout).toBe(helper === "run" || helper === "result" ? 0 : undefined);
		expect(await h.call(rewritten.input)).toBeUndefined();
		const timed = await h.call({ language: "js", code, timeout: 17 });
		expect(timed).toMatchObject({ input: { timeout: 17 } });
	});
}

test("eval interception leaves subagents, other tools, Python helpers and unrelated code untouched", async () => {
	const h = await harness(); const sub = await harness("sub");
	const input = { language: "js", code: 'await playbook.exec("l1")' };
	expect(await sub.call(input)).toBeUndefined();
	expect(await h.call(input, "other_tool")).toBeUndefined();
	expect(await h.call({ language: "py", code: "playbook.run({})" })).toBeUndefined();
	expect(await h.call({ language: "js", code: "return 42;" })).toBeUndefined();
	expect(await h.call({ language: "js", code: "playbook.run({})", timeout: "bad" })).toBeUndefined();
});

test("eval prelude binds through the registered strict Launch tool before waiting and records the result", async () => {
	const s = await service(); const h = await harness();
	await h.execute("playbook_open", { doc: s.doc });
	s.handler = (frame, socket) => respond(socket, frame, frame.op === "launch" ? { launch: "l1", kind: "prompt", text: "Frozen task", agent: "task:mid" } : frame.op === "post" ? { seq: 7 } : undefined);
	const rewritten = await h.call({ language: "js", code: 'return await playbook.run({run:"r1", blocks:["b1"]});' });
	if (!rewritten || !("input" in rewritten)) throw new Error("run was not rewritten");
	const tool: Record<string, (params: Record<string, unknown>) => Promise<string>> = {};
	for (const name of ["playbook_launch", "playbook_timeline"]) tool[name] = async params => {
		h.tools.get(name)!.parameters.parse(params);
		const result = await h.execute(name, params);
		return result.content[0]!.text!;
	};
	const execute = new (Object.getPrototypeOf(async function () {}).constructor)("tool", "agent", rewritten.input.code) as (tools: Record<string, (params: Record<string, unknown>) => Promise<string>>, agent: (prompt: string, options: unknown) => Promise<{ id: string; wait(): Promise<string> }>) => Promise<string>;
	const spawned: { prompt: string; options: unknown }[] = [];
	expect(await execute(tool, async (prompt: string, options: unknown) => { spawned.push({ prompt, options }); return { id: "worker-1", async wait() {
		expect(s.frames.at(-1)).toMatchObject({ op: "bind", args: { launch: "l1", agent: "worker-1" } });
		return "Completed";
	} }; })).toBe("Completed");
	expect(spawned).toEqual([{ prompt: "Frozen task", options: { agent: "task:mid" } }]);
	expect(s.frames.map(frame => frame.op)).toEqual(["hello", "launch", "bind", "post", "close"]);
	expect(s.frames.at(-2)!.args).toEqual({ run: "r1", kind: "result", text: "Completed", launch: "l1", block: "b1" });
	expect(s.frames.at(-1)!.args).toEqual({ launch: "l1" });
});

test("a rejected edit still releases its lock and the next call receives a fresh lock id", async () => {
	const s = await service(); const h = await harness();
	await h.execute("playbook_open", { doc: s.doc });
	s.handler = (frame, socket) => {
		if (frame.op === "edit") socket.write(JSON.stringify({ id: frame.id, ok: false, error: { code: "BadValue", message: "find is not unique" } }) + "\n");
		else respond(socket, frame, frame.op === "lock" ? { block } : undefined);
	};
	const rejected = await h.execute("playbook_edit", { op: "replace", block: "b1", find: "Body", replace: "New" });
	expect(JSON.parse(rejected.content[0]!.text!)).toEqual({ error: { code: "BadValue", message: "find is not unique" } });
	await h.execute("playbook_edit", { op: "status", block: "b1", value: "done" });
	expect(s.frames.map(frame => frame.op)).toEqual(["hello", "lock", "edit", "unlock", "lock", "set", "unlock"]);
	expect(s.frames[1]!.args).toEqual({ block: "b1" });
	expect(s.frames[4]!.id).not.toBe(s.frames[1]!.id);
	expect(s.frames[3]!.args).toEqual({ block: "b1", request: s.frames[1]!.id });
	expect(s.frames[6]!.args).toEqual({ block: "b1", request: s.frames[4]!.id });
});
