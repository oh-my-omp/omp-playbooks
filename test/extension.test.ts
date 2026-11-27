import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, watch } from "node:fs";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z as zod } from "@oh-my-pi/omptype/zod";
import type {
	AgentToolResult,
	EvalToolParams,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
	SessionMessageEntry,
	ToolCallEventResult,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import { InternalUrlRouter, parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { defaultFormData, type HtmlFormData } from "@oh-my-pi/pi-coding-agent/tools/html-form/data";
import { parseHtmlForm, spansText } from "@oh-my-pi/pi-coding-agent/tools/html-form/parse";
import { type IpcConnection, IpcServer } from "@oh-my-pi/pi-natives";
import { language } from "../omomp-shared/i18n";
import { listToolTopics, resolveToolTopic } from "../omomp-shared/internal-url";
import { readPluginManifest } from "../omomp-shared/tern-plugin";
import { parseRunId } from "../src/domain/model";
import { documentEndpoint, type EventPayload, type Request, type ServerFrame } from "../src/domain/protocol";
import type { ToolDescription } from "../src/extension/agents";
import { K1Client } from "../src/extension/client";
import extension from "../src/extension/index";
import { ensureTernPlugin } from "../src/extension/tern-setup";
import { playbookTopics } from "../src/extension/topics";

const LEGACY_SCHEME = `${"xd"}://`;
const LEGACY_TOOL_SCHEME = `${"tool"}://`;
const summary = {
	id: "r1",
	name: "Run",
	status: "running",
	started_at: 1,
	finished_at: null,
	done: 0,
	total: 1,
	update_due: null,
	update_overdue: false,
	retrospective: false,
};
const block = { id: "b1", kind: "task", title: "Block", body: "Body", status: "todo" };
const builtinTask: ToolDescription = {
	name: "task",
	description: "Spawn subagents.\n# Available Agents\n- `task:low`: Lowest tier\n- `task:mid`: Mid tier\n# Delegation",
	sourceInfo: { source: "builtin", path: "<builtin:task>", scope: "temporary", origin: "package" },
};
const designBlock = {
	id: "b3",
	kind: "design",
	title: "Design",
	requirement: "Human requirement",
	design: "```js\nreturn 42;\n```",
	status: "todo",
};
type Frame = Request & { readonly id: string };
type Cleanup = () => void | Promise<void>;
const cleanup: Cleanup[] = [];
let ternConfig: string;
beforeAll(async () => {
	ternConfig = await mkdtemp("/tmp/pb-ext-tern-");
	process.env.TERN_CONFIG_DIR = ternConfig;
	process.env.TERN_DAEMON_SOCKET = `${ternConfig}/daemon.sock`;
	const plugins = `${ternConfig}/plugins`;
	const manifest = await readPluginManifest(resolve(import.meta.dir, "../tern-plugin"), "omp-playbooks");
	if (!manifest.ok) throw new Error(`tern-plugin manifest: ${JSON.stringify(manifest.error)}`);
	const version = manifest.value.version;
	const bin = `${ternConfig}/bin`;
	await Bun.write(
		`${bin}/tern`,
		`#!/bin/sh
case "$2" in
	dir) printf '{\\n  "dir": "${plugins}"\\n}\\n' ;;
	link) mkdir -p '${plugins}'; printf '%s' "$3" > '${plugins}/omp-playbooks.path'; printf '{}\\n' ;;
	list) printf '{"plugins":[{"id":"omp-playbooks","version":"${version}","css":"","status":"ready"}]}\\n' ;;
	reload) printf '{}\\n' ;;
esac
`,
	);
	await chmod(`${bin}/tern`, 0o755);
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path ?? ""}`;
	try {
		await ensureTernPlugin();
	} finally {
		if (path === undefined) delete process.env.PATH;
		else process.env.PATH = path;
	}
});
afterAll(() => rm(ternConfig, { recursive: true, force: true }));
let pane: string;
beforeEach(() => {
	const original = { PATH: process.env.PATH, TERN_PANE: process.env.TERN_PANE };
	pane = String(900_000_000 + Math.floor(Math.random() * 99_999_999));
	process.env.TERN_PANE = pane;
	cleanup.push(() => {
		for (const key of ["PATH", "TERN_PANE"] as const) {
			const value = original[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
});
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function temporaryDirectory(): Promise<string> {
	const dir = await mkdtemp("/tmp/pb-ext-");
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}
function respond(connection: IpcConnection, frame: Frame, result?: unknown): void {
	connection.send(JSON.stringify({ id: frame.id, ok: true, result }));
}
async function service(pane: string | undefined = "document-pane", existingDoc?: string) {
	const doc = existingDoc ?? `${await temporaryDirectory()}/book.yaml`;
	if (!existingDoc) await Bun.write(doc, "title: Book\nblocks: []\n");
	const endpoint = documentEndpoint(await realpath(doc));
	const frames: Frame[] = [];
	const connections: IpcConnection[] = [];
	const closings = new Map<IpcConnection, Promise<void>>();
	const received = new Map<Request["op"], ((frame: Frame) => void)[]>();
	let handler = (frame: Frame, connection: IpcConnection): void => {
		const result =
			frame.op === "hello"
				? { blocks: ["b1"], runs: [summary], ...(pane ? { pane } : {}) }
				: frame.op === "lock"
					? { block }
					: frame.op === "runs"
						? { runs: [summary] }
						: frame.op === "read"
							? { title: "Book", blocks: [block] }
							: frame.op === "post"
								? { seq: 7 }
								: undefined;
		respond(connection, frame, result);
	};
	const server = await IpcServer.listen(endpoint, { framing: "lines" }, (connection) => {
		const closed = Promise.withResolvers<void>();
		closings.set(connection, closed.promise);
		connections.push(connection);
		connection.start(
			(line) => {
				const frame = JSON.parse(line) as Frame;
				frames.push(frame);
				handler(frame, connection);
				for (const resolve of received.get(frame.op) ?? []) resolve(frame);
				received.delete(frame.op);
			},
			() => closed.resolve(),
		);
	});
	let listening = true;
	async function stop(): Promise<void> {
		for (const connection of connections) connection.destroy();
		if (!listening) return;
		listening = false;
		await server.close();
	}
	async function disconnect(): Promise<void> {
		const connection = connections.at(-1)!;
		connection.end();
		await closings.get(connection);
	}
	function nextFrame(op: Request["op"]): Promise<Frame> {
		const next = Promise.withResolvers<Frame>();
		received.set(op, [...(received.get(op) ?? []), next.resolve]);
		return next.promise;
	}
	cleanup.push(stop);
	return {
		doc,
		endpoint,
		frames,
		connections,
		stop,
		disconnect,
		nextFrame,
		set handler(value: typeof handler) {
			handler = value;
		},
		push(frame: EventPayload) {
			connections.at(-1)!.send(JSON.stringify(frame));
		},
	};
}

type Message = Extract<SessionMessageEntry["message"], { role: string }>;
type Assistant = Extract<Message, { role: "assistant" }>;
type TextPart = Extract<Assistant["content"][number], { type: "text" | "thinking" }>;
type Tool = Omit<ToolDefinition, "parameters"> & {
	parameters: { parse(value: unknown): unknown };
	docTopics?: () => Readonly<Record<string, string>>;
};
type ToolCallResult = (Omit<ToolCallEventResult, "input"> & { input?: EvalToolParams }) | undefined;
type Handler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
const USAGE: Assistant["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function entryFields(): Pick<SessionEntry, "parentId" | "timestamp"> {
	return { parentId: null, timestamp: new Date(0).toISOString() };
}
function userEntry(id: string, content: Extract<Message, { role: "user" }>["content"]): SessionEntry {
	return { type: "message", id, ...entryFields(), message: { role: "user", content, timestamp: 0 } };
}
function assistantEntry(id: string, content: TextPart[]): SessionEntry {
	return {
		type: "message",
		id,
		...entryFields(),
		message: {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: USAGE,
			stopReason: "stop",
			timestamp: 0,
		},
	};
}
function resultText(result: AgentToolResult): string {
	const part = result.content[0];
	if (part?.type !== "text") throw new Error("expected a text result");
	return part.text;
}
async function harness(kind: "main" | "sub" = "main", builtins: readonly ToolDescription[] = []) {
	const tools = new Map<string, Tool>();
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
	const messages: { message: { customType: string; content: string; display: boolean }; options: unknown }[] = [];
	const notices: { message: string; type: string }[] = [];
	const menus: { title: string; options: string[] }[] = [];
	const choices: (string | null | undefined)[] = [];
	const sent = Promise.withResolvers<void>();
	let aborted = 0;
	let idle = true;
	const forms: string[] = [];
	const answers: (Answer | null)[] = [];
	let formHook: ((index: number) => Promise<void>) | undefined;
	const formDialog = async (html: string) => {
		const index = forms.length;
		forms.push(html);
		await formHook?.(index);
		const next = answers.shift();
		return next === null ? undefined : { data: next ? next(html) : defaultFormData(parseHtmlForm(html)) };
	};
	const ui = {
		select: async (title: string, options: string[]) => {
			menus.push({ title, options });
			const choice = choices.shift();
			return choice === null ? undefined : typeof choice === "string" ? choice : options[0];
		},
		notify: (message: string, type: string) => {
			notices.push({ message, type });
		},
		formDialog: formDialog as typeof formDialog | undefined,
	};
	let branch: SessionEntry[] = [
		userEntry("user-1", "USER"),
		assistantEntry("assistant-1", [
			{ type: "text", text: "FULL FIRST" },
			{ type: "thinking", thinking: "NO" },
			{ type: "text", text: "FULL SECOND" },
		]),
	];
	const ctx = {
		agent: { kind },
		sessionManager: { getSessionId: () => "session-test", getBranch: () => branch },
		abort: () => {
			aborted++;
		},
		isIdle: () => idle,
		ui,
	} as unknown as ExtensionCommandContext;
	const waiting: (() => void)[] = [];
	const warnings: string[] = [];
	const api = {
		zod,
		registerTool: (value: Tool) => {
			tools.set(value.name, value);
		},
		getAllTools: () => [...[...tools.keys()].map((name) => ({ name, sourceInfo: { source: "extension" } })), ...builtins],
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		registerCommand: (name: string, value: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) => {
			commands.set(name, value);
		},
		sendMessage: (message: { customType: string; content: string; display: boolean }, options: unknown) => {
			messages.push({ message, options });
			sent.resolve();
			for (const resolve of waiting.splice(0)) resolve();
		},
		logger: {
			warn: (message: string) => {
				warnings.push(message);
			},
		},
	} as unknown as ExtensionAPI;
	await extension(api);
	let started = false;
	async function event(name: string, payload: unknown = {}): Promise<unknown> {
		if (name === "session_start") started = true;
		return handlers.get(name)?.(payload, ctx);
	}
	async function start(): Promise<void> {
		if (!started) await event("session_start");
	}
	cleanup.push(async () => {
		await event("session_shutdown");
	});
	return {
		ctx,
		messages,
		notices,
		menus,
		choices,
		forms,
		answers,
		event,
		tools,
		warnings,
		messageSent: sent.promise,
		get aborted() {
			return aborted;
		},
		get registered() {
			return { tools: [...tools.keys()], commands: [...commands.keys()] };
		},
		set idle(value: boolean) {
			idle = value;
		},
		nextMessage: (): Promise<void> => {
			const next = Promise.withResolvers<void>();
			waiting.push(next.resolve);
			return next.promise;
		},
		set branch(value: SessionEntry[]) {
			branch = value;
		},
		set formHook(value: typeof formHook) {
			formHook = value;
		},
		set hostForms(value: boolean) {
			ui.formDialog = value ? formDialog : undefined;
		},
		execute: async (name: string, params: unknown) => {
			await start();
			return tools.get(name)!.execute("tool", params, undefined, undefined, ctx);
		},
		call: async (input: unknown, toolName = "eval"): Promise<ToolCallResult> => {
			await start();
			return (await event("tool_call", { toolName, input })) as ToolCallResult;
		},
		command: async (name: string, doc = "") => {
			await start();
			return commands.get(name)!.handler(doc, ctx);
		},
	};
}
type Answer = (html: string) => HtmlFormData;
function choose(...values: string[]): Answer {
	return (html) => {
		const form = parseHtmlForm(html);
		const data = defaultFormData(form);
		for (const value of values) {
			const field = form.fields.find((item) => item.kind === "choice" && item.options.some((option) => option.value === value));
			if (field?.kind !== "choice") throw new Error(`no option carries ${value}`);
			data[field.name] = value;
		}
		return data;
	};
}
function optionsOf(html: string, name: string): string[] {
	const field = parseHtmlForm(html).fields.find((item) => item.name === name);
	if (field?.kind !== "choice") throw new Error(`no choice field ${name}`);
	return field.options.map((option) => spansText(option.label));
}
async function fakeTern(exit = 0, stdout = "") {
	const dir = await temporaryDirectory();
	const capture = `${dir}/args`;
	await Bun.write(
		`${dir}/tern`,
		`#!/bin/sh\nprintf '%s\\n' "$@" >> '${capture}'\nprintf '%s' '${stdout}'\nprintf 'focus failed' >&2\nexit ${exit}\n`,
	);
	await chmod(`${dir}/tern`, 0o755);
	process.env.PATH = `${dir}:${process.env.PATH}`;
	return { capture, args: async () => (await Bun.file(capture).text()).trim().split("\n") };
}
function fileAppears(path: string): Promise<void> {
	const appeared = Promise.withResolvers<void>();
	const watcher = watch(dirname(path), () => {
		if (existsSync(path)) {
			watcher.close();
			appeared.resolve();
		}
	});
	cleanup.push(() => watcher.close());
	if (existsSync(path)) {
		watcher.close();
		appeared.resolve();
	}
	return appeared.promise;
}
function parseFrame(value: unknown): ServerFrame {
	return value as ServerFrame;
}
function client(path: string): K1Client {
	const value = new K1Client(path, { session: "client-test" }, parseFrame, () => {});
	cleanup.push(() => value.close());
	return value;
}
const runId = parseRunId("r1")!;

for (const [tool, label, fields, mutation, args] of [
	["playbook_edit_content", "title", { block: "b1", title: "Renamed" }, "set", { field: "title", value: "Renamed" }],
	["playbook_edit_content", "replace", { block: "b1", find: "Body", replace: "New" }, "edit", { find: "Body", replace: "New" }],
	["playbook_edit_content", "design", { block: "b1", design: "New design" }, "write", { text: "New design" }],
	[
		"playbook_edit_content",
		"panel",
		{ block: "b1", panel: "A", text: "## A Revised\nNew design" },
		"panel",
		{ panel: "A", text: "## A Revised\nNew design" },
	],
	["playbook_edit_structure", "status", { meta: { block: "b1", status: "done" } }, "set", { field: "status", value: "done" }],
	["playbook_edit_structure", "delete", { remove_block: "b1" }, "delete", {}],
	["playbook_edit_structure", "move top", { move: { block: "b1", at_top: true } }, "move", { after: null }],
	["playbook_edit_structure", "move after", { move: { block: "b1", after: "b2" } }, "move", { after: "b2" }],
	["playbook_edit_structure", "agent set", { meta: { block: "b1", agent: " task:mid " } }, "set", { field: "agent", value: "task:mid" }],
	["playbook_edit_structure", "agent clear", { meta: { block: "b1", clear_agent: true } }, "set", { field: "agent", value: null }],
	["playbook_edit_structure", "isolation none", { meta: { block: "b1", isolation: "none" } }, "set", { field: "isolated", value: false }],
	["playbook_edit_structure", "isolation clear", { meta: { block: "b1", isolation: "clear" } }, "set", { field: "isolated", value: null }],
] as const) {
	test(`${tool} ${label} locks, changes and releases only its own lock`, async () => {
		const s = await service();
		const h = await harness();
		await h.execute("playbook_open", { doc: s.doc });
		const result = await h.execute(tool, { doc: s.doc, run: "r1", ...fields });
		expect(result.isError).toBe(false);
		expect(s.frames.map((frame) => frame.op)).toEqual(
			label === "delete" ? ["hello", "lock", mutation] : ["hello", "lock", mutation, "unlock"],
		);
		expect(s.frames[0]).toMatchObject({ args: { session: "session-test" } });
		expect(s.frames[1]!.args).toEqual({ run: "r1", block: "b1" });
		expect(s.frames[2]!.args).toEqual({ run: "r1", block: "b1", ...args });
		if (label !== "delete") expect(s.frames[3]!.args).toEqual({ run: "r1", block: "b1", request: s.frames[1]!.id });
		await h.event("session_shutdown");
		expect(s.frames).toHaveLength(label === "delete" ? 3 : 4);
	});
}

test("playbook_edit_content resolves role panel names (where/what/how) from the locked block", async () => {
	const s = await service();
	const h = await harness();
	const outlined = {
		...block,
		body: "## A Where · Scope\nHere\n\n## B What · Goal\nDo it\n\n## C How · Steps\nRun it\n",
	};
	s.handler = (frame, connection) =>
		respond(connection, frame, frame.op === "hello" ? { blocks: ["b1"], runs: [] } : frame.op === "lock" ? { block: outlined } : null);
	await h.execute("playbook_open", { doc: s.doc });
	const result = await h.execute("playbook_edit_content", {
		doc: s.doc,
		block: "b1",
		panel: "what",
		text: "## B What · Updated\nNew goal",
	});
	expect(result.isError).toBe(false);
	expect(s.frames.map((frame) => frame.op)).toEqual(["hello", "lock", "panel", "unlock"]);
	expect(s.frames[2]!.args).toEqual({ block: "b1", panel: "B", text: "## B What · Updated\nNew goal" });
});

test("a call whose parameters do not parse fails as BadValue, not NoService, before any request", async () => {
	const s = await service();
	const h = await harness();
	await h.execute("playbook_open", { doc: s.doc });
	const result = await h.execute("playbook_edit_content", { doc: s.doc, block: "b1", find: "x" });
	expect(result.isError).toBe(true);
	expect(JSON.parse(resultText(result)).error.code).toBe("BadValue");
	expect(s.frames.map((frame) => frame.op)).toEqual(["hello"]);
});

test("playbook_edit_structure rejects invalid combinations before any request", async () => {
	const s = await service();
	const h = await harness();
	await h.execute("playbook_open", { doc: s.doc });
	for (const params of [
		{ meta: { block: "b1", agent: "   " } },
		{ move: { block: "b1" } },
		{ move: { block: "b1", at_top: true, after: "b2" } },
		{ add: { title: "T", design: "D", agent: "task:mid" } },
	]) {
		const result = await h.execute("playbook_edit_structure", { doc: s.doc, ...params });
		expect(result.isError).toBe(true);
	}
	expect(s.frames.map((frame) => frame.op)).toEqual(["hello"]);
});

test("playbook_edit_structure with a host-level invalid enum is refused before reaching the plugin", async () => {
	const s = await service();
	const h = await harness();
	await h.execute("playbook_open", { doc: s.doc });
	let threw: unknown;
	try {
		await h.execute("playbook_edit_structure", { doc: s.doc, meta: { block: "b1", isolation: "yes" } });
	} catch (thrown) {
		threw = thrown;
	}
	expect(String(threw)).toContain('Validation failed for tool "playbook_edit_structure"');
	expect(s.frames.map((frame) => frame.op)).toEqual(["hello"]);
});

test("blank argument values behave as omitted: empty agent presets nothing, blank run/doc/title fields drop out", async () => {
	const s = await service();
	const h = await harness();
	await h.execute("playbook_open", { doc: s.doc });
	const inserted = await h.execute("playbook_edit_structure", {
		doc: s.doc,
		run: "  ",
		add: { title: "T", body: "B", agent: "" },
	});
	expect(inserted.isError).toBe(false);
	expect(s.frames.at(-1)!.args).toEqual({ title: "T", content: { kind: "task", body: "B" } });
	const compiled = await h.execute("playbook_compile", { doc: s.doc, run: "", blocks: ["b1"] });
	expect(compiled.isError).toBe(false);
	expect(s.frames.at(-1)!.args).toEqual({ blocks: ["b1"] });
});

test("playbook_edit_content find/replace keep whitespace text and refuse empty array elements", async () => {
	const s = await service();
	const h = await harness();
	const spaced = { ...block, body: "alpha  beta" };
	s.handler = (frame, connection) =>
		respond(connection, frame, frame.op === "hello" ? { blocks: ["b1"], runs: [] } : frame.op === "lock" ? { block: spaced } : null);
	await h.execute("playbook_open", { doc: s.doc });
	const result = await h.execute("playbook_edit_content", { doc: s.doc, run: "r1", block: "b1", find: "  ", replace: " " });
	expect(result.isError).toBe(false);
	expect(s.frames[2]!.args).toEqual({ run: "r1", block: "b1", find: "  ", replace: " " });
	let threw: unknown;
	try {
		await h.execute("playbook_compile", { doc: s.doc, blocks: ["b1", "  "] });
	} catch (thrown) {
		threw = thrown;
	}
	expect(String(threw)).toContain('Validation failed for tool "playbook_compile"');
	expect(String(threw)).toContain("array element must not be empty");
});

test("playbook_check no_blocks reports zero blocks while omitted blocks target all blocks of the document", async () => {
	const s = await service();
	const h = await harness();
	await h.execute("playbook_open", { doc: s.doc });
	const empty = await h.execute("playbook_check", { doc: s.doc, no_blocks: true, version: "v1", result: "pass" });
	expect(empty.isError).toBe(false);
	expect(s.frames.at(-1)).toMatchObject({ op: "report", args: { blocks: [], version: "v1" } });
	const all = await h.execute("playbook_check", { doc: s.doc, version: "v1", result: "pass" });
	expect(all.isError).toBe(false);
	const reads = s.frames.map((frame) => frame.op);
	expect(reads).toContain("read");
	expect(s.frames.at(-1)).toMatchObject({ op: "report", args: { blocks: ["b1"], version: "v1" } });
});

test("playbook:// read returns task blocks carrying agent and isolated", async () => {
	const s = await service();
	const h = await harness();
	const configured = { ...block, agent: "task:mid", isolated: true };
	s.handler = (frame, connection) =>
		respond(connection, frame, frame.op === "hello" ? { blocks: ["b1"], runs: [] } : { title: "Book", blocks: [configured] });
	await h.execute("playbook_open", { doc: s.doc });
	const resource = await InternalUrlRouter.instance().resolve(`playbook://${encodeURIComponent(s.doc)}`);
	expect(JSON.parse(resource.content as string)).toEqual({ title: "Book", blocks: [configured] });
});

test("interruption revokes an in-flight edit without aborting the coordinator; Locked never sends a mutation", async () => {
	const s = await service();
	const h = await harness();
	await h.execute("playbook_open", { doc: s.doc });
	s.handler = (frame, connection) => {
		if (frame.op === "lock") {
			respond(connection, frame, { block });
			connection.send(JSON.stringify({ event: "interrupted", data: { run: "r1", block: "b1", request: frame.id } }));
		} else if (frame.op === "set") {
			connection.send(JSON.stringify({ id: frame.id, ok: false, error: { code: "NotLocked", message: "lock revoked" } }));
		} else respond(connection, frame);
	};
	const changed = await h.execute("playbook_edit_content", { run: "r1", block: "b1", title: "New" });
	expect(changed.isError).toBe(true);
	expect(structuredClone(JSON.parse(resultText(changed)).error)).toMatchObject({
		code: "NotLocked",
		message: expect.stringContaining("人在变更生效前通过打断收回了此块"),
	});
	expect(s.frames.map((frame) => frame.op)).toEqual(["hello", "lock", "set", "unlock"]);
	expect(h.aborted).toBe(0);
	expect(h.messages).toEqual([]);
	s.handler = (frame, connection) =>
		connection.send(
			JSON.stringify({ id: frame.id, ok: false, error: { code: "Locked", message: "human editing", detail: { block: "b1" } } }),
		);
	const locked = await h.execute("playbook_edit_structure", { remove_block: "b1" });
	expect(JSON.parse(resultText(locked))).toEqual({ error: { code: "Locked", message: "human editing", detail: { block: "b1" } } });
	expect(s.frames.map((frame) => frame.op)).toEqual(["hello", "lock", "set", "unlock", "lock"]);
});

test("event aside precedes block_changed ack; unrelated interruption is ignored", async () => {
	const s = await service();
	const h = await harness();
	await h.execute("playbook_open", { doc: s.doc });
	let deliveredBeforeAck = false;
	s.handler = (frame, connection) => {
		if (frame.op === "ack") deliveredBeforeAck = h.messages.length === 1;
		respond(connection, frame, frame.op === "runs" ? { runs: [summary] } : undefined);
	};
	const ack = s.nextFrame("ack");
	s.push({
		event: "block_changed",
		data: {
			id: "e1",
			launch: { id: "l1", kind: "prompt", run: "r1" },
			agents: [],
			changed: ["b1"],
			diff: "diff",
			current: { kind: "Ok", text: "new", sources: [] },
		},
	} as EventPayload);
	await ack;
	expect(deliveredBeforeAck).toBe(true);
	expect(h.messages[0]!.message.customType).toBe("playbook-event");
	expect(h.messages[0]!.message.content.split("\n")[0]).toBe("这是 Playbook 文档服务的通知，不是用户消息");
	const lines = h.messages[0]!.message.content.split("\n");
	expect(lines).toHaveLength(3);
	expect(lines[1]).toContain('playbook_launch --json \'{"rebase_launch":"l1"}\'');
	expect(lines[1]).not.toContain(LEGACY_SCHEME);
	expect(JSON.parse(lines[2]!)).toEqual({
		doc: await realpath(s.doc),
		event: "block_changed",
		data: {
			id: "e1",
			launch: { id: "l1", kind: "prompt", run: "r1" },
			agents: [],
			changed: ["b1"],
			diff: "diff",
			current: { kind: "Ok", text: "new", sources: [] },
		},
	});
	expect(h.messages[0]!.options).toEqual({ deliverAs: "aside", triggerTurn: true });
	expect(s.frames.at(-1)).toMatchObject({ op: "ack", args: { event: "e1" } });
	s.push({ event: "interrupted", data: { block: "b1", request: "old" } } as EventPayload);
	await InternalUrlRouter.instance().resolve("playbook://");
	expect(h.aborted).toBe(0);
	expect(h.messages).toHaveLength(1);
});

for (const run of [undefined, "r1"] as const) {
	test(`revision_requested fetches the submitted ${run === undefined ? "template" : "Run"} prompt before asking the coordinator to revise only the design`, async () => {
		const s = await service();
		const h = await harness();
		await h.execute("playbook_open", { doc: s.doc });
		s.handler = () => {};
		const requested = s.nextFrame("revisions");
		const scope = run === undefined ? {} : { run };
		s.push({ event: "revision_requested", data: { ...scope, block: "b3", revision: 5 } } as EventPayload);
		const frame = await requested;
		expect(frame.args).toEqual({ ...scope, block: "b3", after: 4 });
		expect(h.messages).toEqual([]);
		const prompt = "Keep the requirement intact.\nRevise the failure path and label it clearly.";
		respond(s.connections.at(-1)!, frame, {
			revisions: [
				{ seq: 6, at: 20, block: "b3", prompt: "A newer request, not the one submitted" },
				{ seq: 5, at: 10, block: "b3", prompt },
			],
		});
		await h.messageSent;
		expect(s.frames.map((item) => item.op)).toEqual(["hello", "revisions"]);
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
		const prefix = run === undefined ? "playbook://book.yaml" : `playbook://book.yaml/${run}`;
		expect(instruction).toContain(`read ${prefix}/b3`);
		const history = `read ${prefix}/revisions?block=b3`;
		expect(instruction).toContain(`需要以前的修改要求时用 \`${history}\`。`);
		expect(instruction).not.toContain(LEGACY_SCHEME);
		expect(instruction).toContain("修订设计");
		expect(instruction).toContain("playbook_edit_content");
		for (const field of ["design", "find", "replace", "panel"]) expect(instruction).toContain(field);
		expect(instruction).toMatch(/不要改\s+requirement/);
		expect(instruction).not.toContain("playbook.run");
		expect(JSON.parse(lines.at(-1)!)).toEqual({
			doc: await realpath(s.doc),
			event: "revision_requested",
			data: { ...scope, block: "b3", revision: 5 },
		});
	});

	test(`revision_requested keeps the ${run === undefined ? "template" : "Run"} document and block scope in the lookup-failure hint and history advice`, async () => {
		const s = await service();
		const h = await harness();
		await h.execute("playbook_open", { doc: s.doc });
		s.handler = (frame, connection) => respond(connection, frame, { revisions: [] });
		const scope = run === undefined ? {} : { run };
		s.push({ event: "revision_requested", data: { ...scope, block: "b3", revision: 5 } } as EventPayload);
		await h.messageSent;
		expect(s.frames.map((item) => item.op)).toEqual(["hello", "revisions"]);
		expect(s.frames.at(-1)!.args).toEqual({ ...scope, block: "b3", after: 4 });
		expect(h.messages).toHaveLength(1);
		const { message, options } = h.messages[0]!;
		expect(message.customType).toBe("playbook-event");
		expect(options).toEqual({ deliverAs: "aside", triggerTurn: true });
		const lines = message.content.split("\n");
		const instruction = lines.slice(1, -1).join("\n");
		const prefix = run === undefined ? "playbook://book.yaml" : `playbook://book.yaml/${run}`;
		const history = `read ${prefix}/revisions?block=b3`;
		expect(instruction).toContain(`（读取失败，用 \`${history}\` 查询）`);
		expect(instruction).toContain(`需要以前的修改要求时用 \`${history}\`。`);
		expect(instruction).not.toContain(LEGACY_SCHEME);
		expect(instruction).not.toContain("<prompt>");
		expect(JSON.parse(lines.at(-1)!)).toEqual({
			doc: await realpath(s.doc),
			event: "revision_requested",
			data: { ...scope, block: "b3", revision: 5 },
		});
	});
}

test("add asks two forms (message, log and kind, then block) and writes full text, quote and human origin", async () => {
	const s = await service();
	const h = await harness();
	h.answers.push(choose("assistant-1", "playbook", "update"), choose("none"));
	await h.command("playbook-add", s.doc);
	expect(h.menus).toEqual([]);
	expect(s.frames.map((frame) => frame.op)).toEqual(["hello", "runs", "read", "post"]);
	expect(h.forms).toHaveLength(2);
	const first = parseHtmlForm(h.forms[0]!);
	expect(first.fields.map((field) => field.name)).toEqual(["message", "log", "kind"]);
	expect(first.sections.filter((section) => section.blocks.some((block) => block.kind === "field"))).toHaveLength(1);
	expect(parseHtmlForm(h.forms[1]!).fields.map((field) => field.name)).toEqual(["block"]);
	expect(s.frames.at(-1)).toMatchObject({
		op: "post",
		args: { kind: "update", text: "FULL FIRST\nFULL SECOND", quote: "assistant-1", origin: "human" },
	});
	expect(s.frames.at(-1)!.args).not.toHaveProperty("block");
	expect(h.notices.at(-1)!.message).toContain("7");
	for (const answers of [[null], [choose("assistant-1", "playbook", "update"), null]]) {
		h.answers.push(...answers);
		const before = s.frames.filter((frame) => frame.op === "post").length;
		await h.command("playbook-add", s.doc);
		expect(s.frames.filter((frame) => frame.op === "post")).toHaveLength(before);
	}
	expect(h.notices.filter((notice) => notice.type === "error")).toEqual([]);
	expect(() =>
		h.tools.get("playbook_timeline")!.parameters.parse({ doc: s.doc, run: "r1", kind: "result", text: "x", origin: "human" }),
	).toThrow();
});

test("add shows message text as label text: markup characters are not parsed as HTML", async () => {
	const s = await service();
	const h = await harness();
	h.branch = [assistantEntry("assistant-1", [{ type: "text", text: 'FULL <FIRST> & "SECOND"' }])];
	h.answers.push(choose("assistant-1", "playbook", "update"));
	await h.command("playbook-add", s.doc);
	expect(optionsOf(h.forms[0]!, "message")).toEqual(['assistant-1: FULL <FIRST> & "SECOND"']);
	expect(s.frames.at(-1)).toMatchObject({ op: "post", args: { text: 'FULL <FIRST> & "SECOND"' } });
});

test("add rejects a record kind typed outside the offered options and posts nothing", async () => {
	const s = await service();
	const h = await harness();
	h.answers.push((html) => ({ ...choose("assistant-1", "playbook")(html), kind: "typed by hand" }));
	await h.command("playbook-add", s.doc);
	expect(h.notices.at(-1)).toEqual({ message: "记录类型选择无效", type: "error" });
	expect(s.frames.some((frame) => frame.op === "post")).toBe(false);
});

test("add on a host without formDialog reports one error and asks nothing", async () => {
	const s = await service();
	const h = await harness();
	h.hostForms = false;
	await h.command("playbook-add", s.doc);
	expect(h.notices).toEqual([{ message: "这个 omp 无法显示表单（ui.formDialog），/playbook-add 无法提问", type: "error" }]);
	expect(h.forms).toEqual([]);
	expect(s.frames.filter((frame) => frame.op !== "hello")).toEqual([]);
});

for (const lang of ["en", "zh"] as const) {
	test(`add renders ${lang} labels while posting the stable record kind`, async () => {
		const previous = process.env.OMOMP_LANG;
		process.env.OMOMP_LANG = lang;
		cleanup.push(() => {
			if (previous === undefined) delete process.env.OMOMP_LANG;
			else process.env.OMOMP_LANG = previous;
		});
		const s = await service();
		const h = await harness();
		h.answers.push(choose("playbook", "result"), choose());
		await h.command("playbook-add", s.doc);
		expect(optionsOf(h.forms[0]!, "log")).toContain(`r1: Run (${lang === "zh" ? "运行中" : "Running"})`);
		expect(optionsOf(h.forms[0]!, "kind")).toEqual(
			lang === "zh" ? ["进展", "结果", "失败", "复盘"] : ["Update", "Result", "Failure", "Retrospective"],
		);
		expect(s.frames.at(-1)).toMatchObject({ op: "post", args: { kind: "result", origin: "human" } });
	});
}

test("show calls a real tern child with the hello pane unchanged; add offers latest twenty textual user/assistant messages", async () => {
	const s = await service();
	const tern = await fakeTern();
	const h = await harness();
	await h.command("playbook-show", s.doc);
	expect(h.notices).toEqual([]);
	expect(await tern.args()).toEqual(["focus", "document-pane", "--json"]);
	expect(s.frames[0]).toMatchObject({ args: { pane } });
	h.branch = Array.from(
		{ length: 25 },
		(_, i): SessionEntry =>
			i % 2 ? userEntry(`message-${i}`, `text-${i}`) : assistantEntry(`message-${i}`, [{ type: "text", text: `text-${i}` }]),
	);
	h.branch = [
		...h.ctx.sessionManager.getBranch(),
		{ type: "custom", id: "custom", ...entryFields(), customType: "test" },
		userEntry("empty", ""),
		{
			type: "message",
			id: "tool",
			...entryFields(),
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "eval",
				content: [{ type: "text", text: "ignore" }],
				isError: false,
				timestamp: 0,
			},
		},
	];
	h.answers.push(null);
	await h.command("playbook-add");
	const messages = optionsOf(h.forms[0]!, "message");
	expect(messages).toHaveLength(20);
	expect(messages[0]).toBe("message-24: text-24");
	expect(messages.at(-1)).toBe("message-5: text-5");
	expect(s.frames.some((frame) => frame.op === "post")).toBe(false);
});

test("open starts the document service beside the coordinator pane and returns hello once it listens", async () => {
	const doc = `${await temporaryDirectory()}/book.yaml`;
	await Bun.write(doc, "title: Book\nblocks: []\n");
	const tern = await fakeTern(0, '{"block": 42}');
	const h = await harness();
	const split = fileAppears(tern.capture);
	const opening = h.execute("playbook_open", { doc });
	await split;
	const s = await service("document-pane", doc);
	const result = await opening;
	expect(result.isError).toBe(false);
	expect(JSON.parse(resultText(result))).toMatchObject({
		blocks: ["b1"],
		pane: "document-pane",
		doc: await realpath(doc),
		urls: { runs: "playbook://" },
		topics: ["help://playbook_open/format-outline", "help://playbook_open/slots-references", "help://playbook_open/execution"],
	});
	const real = await realpath(doc);
	expect(await tern.args()).toEqual([
		"split",
		pane,
		"right",
		"--cwd",
		dirname(real),
		"--json",
		"--",
		"omp",
		"bash",
		"-c",
		`OMOMP_LANG=${language()} 'bun' '${resolve(import.meta.dir, "../src/service/main.ts")}' '${real}'`,
	]);
	expect(s.frames.map((frame) => frame.op)).toEqual(["hello"]);
});

test("open reuses a running service without tern", async () => {
	const s = await service();
	const tern = await fakeTern(0, '{"block": 42}');
	const h = await harness();
	const running = await h.execute("playbook_open", { doc: s.doc });
	expect(running.isError).toBe(false);
	expect(await Bun.file(tern.capture).exists()).toBe(false);
	expect(s.frames.map((frame) => frame.op)).toEqual(["hello"]);
});

test("a child session registers no tool or command, and never connects (R4)", async () => {
	const s = await service();
	const h = await harness("sub");
	await h.event("session_start");
	expect(h.registered).toEqual({ tools: [], commands: [] });
	expect(s.frames).toHaveLength(0);
});

const documentToolNames = [
	"playbook_edit_content",
	"playbook_edit_structure",
	"playbook_compile",
	"playbook_check",
	"playbook_run",
	"playbook_timeline",
	"playbook_launch",
];

for (const value of [undefined, "coordinator-pane"]) {
	test(`outside a Tern pane (TERN_PANE ${value ?? "unset"}) the extension adds nothing to the session`, async () => {
		if (value === undefined) delete process.env.TERN_PANE;
		else process.env.TERN_PANE = value;
		const s = await service();
		const h = await harness();
		await h.event("session_start");
		expect(h.registered).toEqual({ tools: [], commands: [] });
		expect(InternalUrlRouter.instance().getHandler("playbook")).toBeUndefined();
		expect(listToolTopics("playbook_open")).toEqual([]);
		expect(h.warnings).toEqual([]);
		expect(h.notices).toEqual([]);
		expect(await h.event("tool_call", { toolName: "eval", input: { language: "js", code: "await playbook.run({})" } })).toBeUndefined();
		expect(s.frames).toHaveLength(0);
	});
}

test("a main session in a daemon Tern pane registers all eight tools as discoverable commands only at session_start, once", async () => {
	const h = await harness();
	expect(h.registered.tools).toEqual([]);
	await h.event("session_start");
	expect(h.registered.tools).toEqual(["playbook_open", ...documentToolNames]);
	expect(h.tools.has("playbook_read")).toBe(false);
	expect(h.tools.has("playbook_edit")).toBe(false);
	for (const tool of h.tools.values()) {
		expect(tool.loadMode).toBe("discoverable");
		expect(tool.defaultInactive).toBeUndefined();
		expect(typeof tool.docTopics).toBe(tool.name === "playbook_open" ? "function" : "undefined");
	}
	const first = [...h.tools.values()];
	await h.event("session_start");
	[...h.tools.values()].forEach((tool, index) => {
		expect(tool).toBe(first[index]!);
	});
});

test("every tool keeps its entire description <= 200 chars with zero legacy scheme links", async () => {
	const h = await harness();
	await h.event("session_start");
	for (const tool of h.tools.values()) {
		expect(tool.description.length).toBeLessThanOrEqual(200);
		expect(tool.description).not.toBe("");
		expect(tool.description).not.toContain(LEGACY_SCHEME);
		expect(tool.description).not.toContain(LEGACY_TOOL_SCHEME);
	}
	expect(h.tools.get("playbook_open")!.description).toContain("help://playbook_open/");
});

test("topics are consolidated into 3 help://playbook_open/* entries via docTopics and registerToolTopics", async () => {
	const h = await harness();
	await h.event("session_start");
	expect(h.warnings).toEqual([]);
	expect(InternalUrlRouter.instance().getHandler("tool")).toBeUndefined();
	const topics = playbookTopics();
	expect(topics.map((doc) => `${doc.tool}/${doc.topic}`)).toEqual([
		"playbook_open/execution",
		"playbook_open/format-outline",
		"playbook_open/slots-references",
	]);
	const hubDocs = listToolTopics("playbook_open");
	expect(hubDocs.map((doc) => doc.topic)).toEqual(["execution", "format-outline", "slots-references"]);
	const openDocTopics = h.tools.get("playbook_open")!.docTopics!();
	expect(Object.keys(openDocTopics)).toEqual(["execution", "format-outline", "slots-references"]);
	for (const doc of hubDocs) {
		const resolved = resolveToolTopic(doc.tool, doc.topic);
		expect(resolved).toBeDefined();
		expect(openDocTopics[doc.topic]).toBe(resolved!.content);
		expect(resolved!.content.trim()).not.toBe("");
		expect(resolved!.content).not.toStartWith("---");
		expect(resolved!.content).not.toContain(LEGACY_SCHEME);
		expect(resolved!.content).not.toContain(LEGACY_TOOL_SCHEME);
	}
	expect(openDocTopics["format-outline"]).toStartWith("# Playbook file format\n");
	expect(openDocTopics["format-outline"]).toContain("help://playbook_open/slots-references");
	expect(openDocTopics["format-outline"]).toContain("help://playbook_open/execution");
	expect(openDocTopics.execution).toContain("block_changed");
	expect(openDocTopics.execution).toContain("# Language");
});

test("help://playbook_open/execution and format-outline regenerate language guidance afresh on every read", async () => {
	const original = process.env.OMOMP_LANG;
	cleanup.push(() => {
		if (original === undefined) delete process.env.OMOMP_LANG;
		else process.env.OMOMP_LANG = original;
	});
	const h = await harness();
	await h.event("session_start");
	const openTool = h.tools.get("playbook_open")!;
	process.env.OMOMP_LANG = "en";
	expect(openTool.docTopics!().execution).toContain("in English");
	expect(openTool.docTopics!()["format-outline"]).toContain("in English");
	expect(resolveToolTopic("playbook_open", "execution")!.content).toContain("in English");
	process.env.OMOMP_LANG = "zh";
	expect(openTool.docTopics!().execution).toContain("in Chinese");
	expect(openTool.docTopics!()["format-outline"]).toContain("in Chinese");
	expect(resolveToolTopic("playbook_open", "execution")!.content).toContain("in Chinese");
	process.env.OMOMP_LANG = "en";
	expect(openTool.docTopics!().execution).toContain("in English");
});

test("playbook:// registers without promptDoc, serves all read/write routes, and unregisters on shutdown", async () => {
	const s = await service();
	const h = await harness();
	await h.execute("playbook_open", { doc: s.doc });
	const router = InternalUrlRouter.instance();
	const handler = router.getHandler("playbook");
	expect(handler).toBeDefined();
	expect(handler!.promptDoc).toBeUndefined();
	expect(handler!.spec.write).toBeDefined();
	expect(handler!.spec.write!.via).toBe("handler");
	expect(handler!.spec.write!.payload).toBe("verbatim");
	expect(handler!.spec.write!.scope).toBe("coordination");
	expect(handler!.spec.write!.tier(parseInternalUrl("playbook://book.yaml/timeline"), "", undefined)).toBe("read");

	// read playbook:// -> runs
	const runsRes = await router.resolve("playbook://");
	expect(JSON.parse(runsRes.content as string)).toEqual({ runs: [summary] });
	expect(s.frames.at(-1)).toMatchObject({ op: "runs", args: {} });

	// read playbook://<doc>/<run>/<block>
	const blockRes = await router.resolve("playbook://book.yaml/r1/b1");
	expect(JSON.parse(blockRes.content as string)).toEqual({ title: "Book", blocks: [block] });
	expect(s.frames.at(-1)).toMatchObject({ op: "read", args: { run: "r1", block: "b1" } });

	// read playbook:///<abs>/<run>/revisions?after=2&block=b3
	s.handler = (frame, connection) =>
		respond(
			connection,
			frame,
			frame.op === "revisions"
				? { revisions: [{ seq: 3, at: 10, block: "b3", prompt: "Fix" }] }
				: frame.op === "timeline"
					? { entries: [{ seq: 7 }], next_after: 7 }
					: frame.op === "launch_info"
						? { id: "l1", run: "r1", kind: "prompt", blocks: ["b1"] }
						: frame.op === "inspect"
							? { blocks: ["b1", "b2"], findings: {}, version: "ver-123" }
							: frame.op === "post"
								? { seq: 9 }
								: { title: "Book", blocks: [block] },
		);
	const revRes = await router.resolve(`playbook://${await realpath(s.doc)}/r1/revisions?after=2&block=b3`);
	expect(JSON.parse(revRes.content as string)).toEqual({ revisions: [{ seq: 3, at: 10, block: "b3", prompt: "Fix" }] });
	expect(s.frames.at(-1)).toMatchObject({ op: "revisions", args: { run: "r1", block: "b3", after: 2 } });

	// read playbook://<doc>/<run>/timeline?after=6&limit=200
	const tlRes = await router.resolve("playbook://book.yaml/r1/timeline?after=6&limit=200");
	expect(tlRes.content as string).toBe('{"entries":[{"seq":7}],"next_after":7}');
	expect(s.frames.at(-1)).toMatchObject({ op: "timeline", args: { run: "r1", after: 6, limit: 200 } });

	// read playbook://<doc>/<run>/launches/<launchId>
	const launchRes = await router.resolve("playbook://book.yaml/r1/launches/l1");
	expect(JSON.parse(launchRes.content as string)).toEqual({ id: "l1", run: "r1", kind: "prompt", blocks: ["b1"] });
	expect(s.frames.at(-1)).toMatchObject({ op: "launch_info", args: { launch: "l1" } });

	// read playbook://<doc>/<run>/checks?blocks=b1,b2 (includes inline playbook_check hint)
	const checksRes = await router.resolve("playbook://book.yaml/r1/checks?blocks=b1,b2");
	expect(checksRes.content as string).toContain('"version": "ver-123"');
	expect(checksRes.content as string).toContain("playbook_check");
	expect(s.frames.at(-1)).toMatchObject({ op: "inspect", args: { run: "r1", blocks: ["b1", "b2"] } });

	// write playbook://<doc>/<run>/timeline?kind=note&block=b1&launch=l1&next=60&quote=m-1
	const writeResult = await handler!.write!(
		parseInternalUrl("playbook://book.yaml/r1/timeline?kind=note&block=b1&launch=l1&next=60&quote=m-1"),
		"Progress update",
	);
	expect(writeResult?.content[0]).toEqual({ type: "text", text: '{"seq":9}' });
	expect(s.frames.at(-1)).toMatchObject({
		op: "post",
		args: { run: "r1", kind: "update", text: "Progress update", block: "b1", launch: "l1", next: 60, quote: "m-1" },
	});

	// write on non-timeline fails
	await expect(handler!.write!(parseInternalUrl("playbook://book.yaml/r1/b1"), "nope")).rejects.toThrow();

	// shutdown cleans up scheme and topics
	await h.event("session_shutdown");
	expect(router.getHandler("playbook")).toBeUndefined();
	expect(listToolTopics("playbook_open")).toEqual([]);
});

for (const command of ["playbook-add", "playbook-show"]) {
	test(`${command}: absent doc and connections reports exact path prompt`, async () => {
		const h = await harness();
		await h.command(command);
		expect(h.notices).toEqual([{ message: "请指定 Playbook 文件路径", type: "error" }]);
		expect(h.menus).toEqual([]);
	});
	test(`${command}: unique live connection is used; multiple connections prompt and allow cancellation`, async () => {
		const a = await service("pane-a");
		const b = await service("pane-b");
		const tern = await fakeTern();
		const h = await harness();
		await h.execute("playbook_open", { doc: a.doc });
		if (command === "playbook-add") h.answers.push(null);
		await h.command(command);
		expect(h.menus.some((menu) => menu.title === "选择 Playbook")).toBe(false);
		await h.execute("playbook_open", { doc: b.doc });
		h.choices.push(await realpath(b.doc));
		if (command === "playbook-add") h.answers.push(choose("playbook", "update"));
		await h.command(command);
		expect(h.menus.find((menu) => menu.title === "选择 Playbook")!.options).toEqual([await realpath(a.doc), await realpath(b.doc)]);
		if (command === "playbook-show") expect(await tern.args()).toEqual(["focus", "pane-a", "--json", "focus", "pane-b", "--json"]);
		else expect(b.frames.at(-1)!.op).toBe("post");
		const counts = [a.frames.length, b.frames.length];
		h.choices.push(null);
		await h.command(command);
		expect([a.frames.length, b.frames.length]).toEqual(counts);
	});
}

test("show missing remote pane never invokes tern and gives exact daemon-pane notification", async () => {
	const s = await service("");
	const tern = await fakeTern();
	const h = await harness();
	await h.command("playbook-show", s.doc);
	expect(h.notices).toEqual([{ message: "文档服务不在 session daemon 托管的 pane 中", type: "error" }]);
	expect(await Bun.file(tern.capture).exists()).toBe(false);
});

test("show keeps a failing tern child's exit code and stderr", async () => {
	const s = await service();
	const tern = await fakeTern(9);
	const h = await harness();
	await h.command("playbook-show", s.doc);
	expect(h.notices.at(-1)!.message).toContain("tern focus 退出 9：focus failed");
	expect(await tern.args()).toEqual(["focus", "document-pane", "--json"]);
});

for (const op of ["runs", "post"] as const) {
	for (const failure of ["protocol", "Disconnected", "NoService"] as const) {
		test(`add ${op} ${failure} notifies and stops without retry`, async () => {
			const s = await service();
			const h = await harness();
			h.answers.push(choose("playbook", "update"), choose());
			const normal = (frame: Frame, connection: IpcConnection) =>
				respond(
					connection,
					frame,
					frame.op === "hello"
						? { blocks: ["b1"], runs: [summary] }
						: frame.op === "runs"
							? { runs: [summary] }
							: frame.op === "read"
								? { title: "Book", blocks: [block] }
								: { seq: 7 },
				);
			s.handler = (frame, connection) => {
				if (frame.op !== op || failure === "NoService") {
					normal(frame, connection);
					return;
				}
				if (failure === "Disconnected") connection.destroy();
				else connection.send(JSON.stringify({ id: frame.id, ok: false, error: { code: "BadValue", message: `rejected ${op}` } }));
			};
			if (failure === "NoService" && op === "runs") await s.stop();
			if (failure === "NoService" && op === "post")
				h.formHook = async (index) => {
					if (index === 1) {
						await s.disconnect();
						await s.stop();
					}
				};
			await h.command("playbook-add", s.doc);
			expect(h.notices.at(-1)!.type).toBe("error");
			expect(h.notices.at(-1)!.message).toContain(failure === "protocol" ? `BadValue: rejected ${op}` : failure);
			expect(s.frames.filter((frame) => frame.op === op)).toHaveLength(failure === "NoService" ? 0 : 1);
			if (op === "runs") expect(s.frames.some((frame) => frame.op === "read" || frame.op === "post")).toBe(false);
		});
	}
}

test("add reconnects before read and post when transport disappears while a form is open", async () => {
	const s = await service();
	const h = await harness();
	h.answers.push(choose("playbook", "update"), choose());
	h.formHook = async () => {
		await s.disconnect();
	};
	await h.command("playbook-add", s.doc);
	expect(s.frames.map((frame) => frame.op)).toEqual(["hello", "runs", "hello", "read", "hello", "post"]);
	expect(h.notices.at(-1)).toEqual({ message: "已写入 Playbook 时间线条目 7", type: "info" });
});

test("client without a service returns NoService; failed hello sends no target request", async () => {
	const missing = client(`/tmp/no-pb-service-${randomUUID()}`);
	const reply = await missing.request({ op: "runs", args: {} });
	expect(reply.ok).toBe(false);
	if (!reply.ok) expect(reply.error.code).toBe("NoService");
	const s = await service();
	s.handler = (_frame, connection) => connection.destroy();
	const c = client(s.endpoint);
	const beforeHello = await c.request({ op: "post", args: { run: runId, kind: "update", text: "x" } });
	expect(beforeHello.ok).toBe(false);
	if (!beforeHello.ok) expect(beforeHello.error.code).toBe("NoService");
	expect(s.frames.map((frame) => frame.op)).toEqual(["hello"]);
});

test("in-flight disconnect is Disconnected; automatic reconnect sends only hello; close stops retries", async () => {
	const s = await service();
	s.handler = (frame, connection) => {
		if (frame.op === "hello") respond(connection, frame, { blocks: [], runs: [] });
		else connection.destroy();
	};
	const c = client(s.endpoint);
	const reply = await c.request({ op: "post", args: { run: runId, kind: "update", text: "x" } });
	expect(reply.ok).toBe(false);
	if (!reply.ok) expect(reply.error.code).toBe("Disconnected");
	await Bun.sleep(2150);
	expect(s.frames.map((frame) => frame.op)).toEqual(["hello", "post", "hello"]);
	c.close();
	await Bun.sleep(2150);
	expect(s.frames.map((frame) => frame.op)).toEqual(["hello", "post", "hello"]);
});

test("tool calls require an unambiguous connected document when doc is omitted", async () => {
	const h = await harness();
	const none = await h.execute("playbook_compile", { blocks: ["b1"] });
	const noneError = JSON.parse(resultText(none)).error;
	expect(noneError.code).toBe("NoService");
	expect(noneError.message).toContain("playbook_open --json");
	expect(noneError.message).not.toContain(LEGACY_SCHEME);
	const a = await service();
	const b = await service();
	await h.execute("playbook_open", { doc: a.doc });
	const compiled = await h.execute("playbook_compile", { run: "r1", blocks: ["b1"] });
	expect(compiled.isError).toBe(false);
	expect(a.frames.at(-1)).toMatchObject({ op: "compile", args: { run: "r1", blocks: ["b1"] } });
	await h.execute("playbook_open", { doc: b.doc });
	const counts = [a.frames.length, b.frames.length];
	const ambiguous = await h.execute("playbook_compile", { blocks: ["b1"] });
	expect(JSON.parse(resultText(ambiguous)).error.code).toBe("NoService");
	expect([a.frames.length, b.frames.length]).toEqual(counts);
	await h.execute("playbook_compile", { doc: b.doc, blocks: ["b1"] });
	expect(b.frames.at(-1)).toMatchObject({ op: "compile", args: { blocks: ["b1"] } });
});

for (const [tool, label, params, request] of [
	[
		"playbook_edit_structure",
		"add task",
		{ run: "r1", add: { after: "b1", title: "New", body: "Text" } },
		{ op: "insert", args: { run: "r1", after: "b1", title: "New", content: { kind: "task", body: "Text" } } },
	],
	[
		"playbook_edit_structure",
		"add configured task",
		{ add: { title: "Configured", body: "Text", agent: " task:mid ", isolation: "none" } },
		{ op: "insert", args: { title: "Configured", content: { kind: "task", body: "Text", agent: "task:mid", isolated: false } } },
	],
	[
		"playbook_edit_structure",
		"add design in run",
		{ run: "r1", add: { after: "b1", title: "New design", design: "## A Overview\nDraft" } },
		{ op: "insert", args: { run: "r1", after: "b1", title: "New design", content: { kind: "design", design: "## A Overview\nDraft" } } },
	],
	[
		"playbook_edit_structure",
		"add template design",
		{ add: { title: "Template design", design: "Draft" } },
		{ op: "insert", args: { title: "Template design", content: { kind: "design", design: "Draft" } } },
	],
	["playbook_compile", "compile", { run: "r1", blocks: ["b1"] }, { op: "compile", args: { run: "r1", blocks: ["b1"] } }],
	["playbook_compile", "refetch", { refetch: true, targets: ["file:book.md"] }, { op: "refetch", args: { targets: ["file:book.md"] } }],
	[
		"playbook_check",
		"report answers",
		{ run: "r1", blocks: ["b1"], version: "v", result: "answers", answers: { q1: 0.8 } },
		{ op: "report", args: { run: "r1", blocks: ["b1"], version: "v", result: { kind: "answers", answers: { q1: 0.8 } } } },
	],
	[
		"playbook_check",
		"report pass",
		{ run: "r1", blocks: ["b1"], version: "v", result: "pass" },
		{ op: "report", args: { run: "r1", blocks: ["b1"], version: "v", result: { kind: "answers", answers: { missing: 0 } } } },
	],
	["playbook_run", "start", { start_name: "Run", update_every: 30 }, { op: "start_run", args: { name: "Run", update_every: 30 } }],
	["playbook_run", "finish", { finish_run: "r1" }, { op: "finish_run", args: { run: "r1" } }],
	[
		"playbook_timeline",
		"post",
		{ run: "r1", kind: "result", text: "Answer", block: "b1", launch: "l1", quote: "message-1" },
		{ op: "post", args: { run: "r1", kind: "result", text: "Answer", block: "b1", launch: "l1", quote: "message-1" } },
	],
	["playbook_timeline", "snooze", { run: "r1", snooze_seconds: 30 }, { op: "snooze", args: { run: "r1", after: 30 } }],
	["playbook_launch", "launch", { run: "r1", blocks: ["b1"] }, { op: "launch", args: { run: "r1", blocks: ["b1"] } }],
	["playbook_launch", "bind", { bind_launch: "l1", agent: "worker-1" }, { op: "bind", args: { launch: "l1", agent: "worker-1" } }],
	["playbook_launch", "rebase", { rebase_launch: "l1" }, { op: "rebase", args: { launch: "l1" } }],
	["playbook_launch", "close", { close_launch: "l1" }, { op: "close", args: { launch: "l1" } }],
] as const) {
	test(`${tool} (${label}) sends the scoped K1 request without editor-only fields`, async () => {
		const s = await service();
		const h = await harness();
		await h.execute("playbook_open", { doc: s.doc });
		const result = await h.execute(tool, { doc: s.doc, ...params });
		expect(result.isError).toBe(false);
		expect(s.frames.map((frame) => frame.op)).toEqual(["hello", request.op]);
		expect(s.frames[1]).toMatchObject(request);
		expect(s.frames[1]!.args).toEqual(request.args);
	});
}

for (const orchestration of [false, true]) {
	test(`launch_requested selects ${orchestration ? "orchestration execution" : "prompt subagent execution"} from the requested Run blocks`, async () => {
		const s = await service();
		const h = await harness();
		await h.execute("playbook_open", { doc: s.doc });
		s.handler = (frame, connection) =>
			respond(connection, frame, {
				title: "Run copy",
				blocks: [
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
		expect(lines[1]).toContain(orchestration ? "playbook_launch --json '" : "await playbook.run(");
		expect(lines[1]).not.toContain(LEGACY_SCHEME);
		if (orchestration) expect(lines[1]).toContain('await playbook.exec("l<n>")');
		else {
			expect(lines[1]).not.toContain("playbook_launch");
			expect(lines[1]).toContain("var worker = await playbook.agent(");
			expect(lines[1]).toContain("await playbook.result(worker)");
			expect(lines[1]).not.toContain("已预设");
			expect(lines[1]).toContain('`agent: "<可用的 agent>"`（例如 "task:mid"）');
			expect(lines[1]).not.toContain("<subagent>");
		}
		expect(JSON.parse(lines[2]!)).toEqual({ doc: await realpath(s.doc), event: "launch_requested", data: { run: "r1", blocks: ["b1"] } });
		expect(h.messages[0]!.options).toEqual({ deliverAs: "aside", triggerTurn: true });
	});
}

test("launch_requested names a single block's preset agent and isolated", async () => {
	const s = await service();
	const h = await harness("main", [builtinTask]);
	await h.execute("playbook_open", { doc: s.doc });
	s.handler = (frame, connection) =>
		respond(connection, frame, { title: "Run copy", blocks: [{ ...block, body: "Prompt", agent: "task:mid", isolated: true }] });
	s.push({ event: "launch_requested", data: { run: "r1", blocks: ["b1"] } } as EventPayload);
	await h.messageSent;
	const lines = h.messages[0]!.message.content.split("\n");
	expect(lines[1]).toContain('块 b1 已预设 agent: "task:mid" isolated: true，不显式传参时 playbook.agent / playbook.run 自动使用。');
	expect(lines[1]).toContain("playbook.agent({ doc: ");
	expect(lines[1]).toContain(', blocks: ["b1"] })');
	expect(lines[1]).not.toContain("<subagent>");
});

test("launch_requested without a preset agent names the subagents this session can start", async () => {
	const s = await service();
	const h = await harness("main", [builtinTask]);
	await h.execute("playbook_open", { doc: s.doc });
	s.handler = (frame, connection) =>
		respond(connection, frame, {
			title: "Run copy",
			blocks: [
				{ ...block, body: "Prompt" },
				{ ...block, id: "b2", body: "Second", agent: "task:mid" },
			],
		});
	s.push({ event: "launch_requested", data: { run: "r1", blocks: ["b1", "b2"] } } as EventPayload);
	await h.messageSent;
	const lines = h.messages[0]!.message.content.split("\n");
	const call = `{ doc: ${JSON.stringify(await realpath(s.doc))}, run: "r1", blocks: ["b1","b2"], agent: "<subagent>" }`;
	expect(lines[1]).toContain(`var worker = await playbook.agent(${call})`);
	expect(lines[1]).toContain(`await playbook.run(${call})`);
	expect(lines[1]).toContain('本会话可启动的 subagent 之一："task:low"、"task:mid"。');
	expect(lines[1]).not.toContain("<可用的 agent>");
});

for (const [agents, listed] of [
	[["task:low", "task:mid"], true],
	[["task:mid", "task:mid"], false],
] as const) {
	test(`launch_requested for blocks presetting ${listed ? "different agents" : "the same agent"} ${listed ? "names" : "does not name"} startable subagents`, async () => {
		const s = await service();
		const h = await harness("main", [builtinTask]);
		await h.execute("playbook_open", { doc: s.doc });
		s.handler = (frame, connection) =>
			respond(connection, frame, {
				title: "Book",
				blocks: [
					{ ...block, body: "Prompt", agent: agents[0] },
					{ ...block, id: "b2", body: "Second", agent: agents[1] },
				],
			});
		s.push({ event: "launch_requested", data: { blocks: ["b1", "b2"] } } as EventPayload);
		await h.messageSent;
		const lines = h.messages[0]!.message.content.split("\n");
		if (listed) {
			expect(lines[1]).toContain('blocks: ["b1","b2"], agent: "<subagent>" })');
			expect(lines[1]).toContain('"task:low"、"task:mid"');
		} else {
			expect(lines[1]).toContain('blocks: ["b1","b2"] })');
			expect(lines[1]).not.toContain("<subagent>");
		}
	});
}

test("launch requests made during a turn wait for its end and arrive as one notice", async () => {
	const s = await service();
	const h = await harness();
	await h.execute("playbook_open", { doc: s.doc });
	const doc = await realpath(s.doc);
	s.handler = (frame, connection) =>
		respond(
			connection,
			frame,
			frame.op === "runs" ? { runs: [summary] } : { title: "Book", blocks: [block, { ...block, id: "b2", body: "Second" }] },
		);
	await h.event("agent_start");
	s.push({ event: "launch_requested", data: { blocks: ["b1"] } } as EventPayload);
	s.push({ event: "launch_requested", data: { run: "r1", blocks: ["b2"] } } as EventPayload);
	await InternalUrlRouter.instance().resolve("playbook://");
	await h.event("agent_end", { messages: [], willContinue: true });
	expect(h.messages).toHaveLength(0);
	h.idle = false;
	await h.event("agent_end", { messages: [] });
	expect(h.messages).toHaveLength(1);
	expect(h.messages[0]!.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
	const lines = h.messages[0]!.message.content.split("\n");
	expect(lines).toHaveLength(6);
	expect(lines[0]).toBe("这是 Playbook 文档服务的通知，不是用户消息");
	expect(lines[1]).toBe("本会话忙碌期间收到 2 个启动请求，按点击顺序合并在这里。它们是各自独立的 Launch，逐个处理：");
	expect(lines[2]).toStartWith(`1. 人请求启动 Playbook 的块 ["b1"]`);
	expect(lines[3]).toStartWith(`2. 人请求启动 Run r1 的块 ["b2"]`);
	expect(lines[3]).toContain(`run: "r1"`);
	expect(lines.slice(4).map((line) => JSON.parse(line))).toEqual([
		{ doc, event: "launch_requested", data: { blocks: ["b1"] } },
		{ doc, event: "launch_requested", data: { run: "r1", blocks: ["b2"] } },
	]);
	h.idle = true;
	const delivered = h.nextMessage();
	s.push({ event: "launch_requested", data: { blocks: ["b2"] } } as EventPayload);
	await delivered;
	expect(h.messages).toHaveLength(2);
	expect(h.messages[1]!.options).toEqual({ deliverAs: "aside", triggerTurn: true });
	expect(h.messages[1]!.message.content.split("\n")).toHaveLength(3);
});

test("exec runs the latest rebased orchestration code, not the frozen snapshot", async () => {
	const s = await service();
	const h = await harness();
	await h.execute("playbook_open", { doc: s.doc });
	const first = '```js\nreturn "first";\n```';
	const rebased = '```js\nreturn "rebased";\n```';
	s.handler = (frame, connection) =>
		respond(connection, frame, {
			id: "l1",
			run: "r1",
			session: "session-test",
			kind: "orchestration",
			snapshot: { result: { text: first } },
			baselines: [first, rebased],
		});
	const rewritten = await h.call({ language: "js", code: 'await playbook.exec("l1")' });
	if (rewritten?.input === undefined) throw new Error("exec was not rewritten");
	expect(rewritten.input.code).toEndWith('return "rebased";');
});

test("launch_requested does not treat a requested design block as orchestration", async () => {
	const s = await service();
	const h = await harness();
	await h.execute("playbook_open", { doc: s.doc });
	s.handler = (frame, connection) =>
		respond(connection, frame, {
			title: "Run copy",
			blocks: [designBlock, { ...block, body: "```py\nprint(42)\n```" }],
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
		const s = await service();
		const h = await harness();
		await h.execute("playbook_open", { doc: s.doc });
		const doc = await realpath(s.doc);
		const source = language === "js" ? "return playbook.context;" : "print(PLAYBOOK_DOC, PLAYBOOK_RUN, PLAYBOOK_LAUNCH)";
		s.handler = (frame, connection) =>
			respond(connection, frame, {
				id: "l1",
				run: "r1",
				session: "session-test",
				kind: "orchestration",
				snapshot: { result: { text: `\`\`\`${language}\n${source}\n\`\`\`` } },
			});
		const rewritten = await h.call({
			language: "js",
			code: language === "js" ? 'await playbook.exec("l1")' : `await playbook.exec('l1', ${JSON.stringify(s.doc)})`,
			title: "Execute",
			timeout: 99,
			reset: true,
		});
		expect(rewritten).toBeDefined();
		if (rewritten?.input === undefined) throw new Error("exec was not rewritten");
		expect(rewritten.input).toMatchObject({ language, title: "Execute", timeout: 0, reset: true });
		expect(s.frames.at(-1)).toMatchObject({ op: "launch_info", args: { launch: "l1" } });
		if (language === "js") {
			const execute = new (Object.getPrototypeOf(async () => {}).constructor)("tool", "agent", rewritten.input.code) as (
				tool: Record<string, never>,
				agent: () => Promise<never>,
			) => Promise<unknown>;
			expect(
				await execute({}, async () => {
					throw new Error("orchestration only reads context");
				}),
			).toEqual({ doc, run: "r1", launch: "l1" });
		} else {
			expect(
				rewritten.input.code.endsWith(`PLAYBOOK_DOC = ${JSON.stringify(doc)}\nPLAYBOOK_RUN = "r1"\nPLAYBOOK_LAUNCH = "l1"\n${source}`),
			).toBe(true);
		}
	});
}

for (const kind of ["prompt", "unknown", "unfenced"] as const) {
	test(`exec blocks a ${kind} Launch instead of executing arbitrary code`, async () => {
		const s = await service();
		const h = await harness();
		await h.execute("playbook_open", { doc: s.doc });
		s.handler = (frame, connection) => {
			if (kind === "unknown")
				connection.send(JSON.stringify({ id: frame.id, ok: false, error: { code: "UnknownLaunch", message: "missing l1" } }));
			else
				respond(connection, frame, {
					id: "l1",
					run: "r1",
					session: "session-test",
					kind: kind === "prompt" ? "prompt" : "orchestration",
					snapshot: { result: { text: kind === "prompt" ? "Task" : "return 42;" } },
				});
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
	expect(structuredClone(await h.call({ language: "js", code: 'await playbook.exec("l1")' }))).toMatchObject({
		block: true,
		reason: expect.stringContaining("NoService"),
	});
	const a = await service();
	const b = await service();
	await h.execute("playbook_open", { doc: a.doc });
	await h.execute("playbook_open", { doc: b.doc });
	expect(structuredClone(await h.call({ language: "js", code: 'await playbook.exec("l1")' }))).toMatchObject({
		block: true,
		reason: expect.stringContaining("打开了多个"),
	});
	expect(a.frames.map((frame) => frame.op)).toEqual(["hello"]);
	expect(b.frames.map((frame) => frame.op)).toEqual(["hello"]);
});

for (const helper of ["run", "agent", "result", "spawn", "post", "timeline", "read", "context"]) {
	test(`JS ${helper} receives the prelude without reimporting or overriding an explicit timeout`, async () => {
		const h = await harness();
		const code = helper === "context" ? "return playbook.context;" : `await playbook.${helper}({});`;
		const rewritten = await h.call({ language: "js", code });
		if (rewritten?.input === undefined) throw new Error("helper was not rewritten");
		expect(rewritten.input.code).toEndWith(code);
		expect(rewritten.input.timeout).toBe(helper === "run" || helper === "result" ? 0 : undefined);
		expect(await h.call(rewritten.input)).toBeUndefined();
		const timed = await h.call({ language: "js", code, timeout: 17 });
		expect(timed).toMatchObject({ input: { timeout: 17 } });
	});
}

test("eval interception leaves subagents, other tools, Python helpers and unrelated code untouched", async () => {
	const h = await harness();
	const sub = await harness("sub");
	const input = { language: "js", code: 'await playbook.exec("l1")' };
	expect(await sub.call(input)).toBeUndefined();
	expect(await h.call(input, "other_tool")).toBeUndefined();
	expect(await h.call({ language: "py", code: "playbook.run({})" })).toBeUndefined();
	expect(await h.call({ language: "js", code: "return 42;" })).toBeUndefined();
	expect(await h.call({ language: "js", code: "playbook.run({})", timeout: "bad" })).toBeUndefined();
});

test("eval prelude binds through the registered strict Launch tool before waiting and records the result", async () => {
	const s = await service();
	const h = await harness();
	await h.execute("playbook_open", { doc: s.doc });
	s.handler = (frame, connection) =>
		respond(
			connection,
			frame,
			frame.op === "launch"
				? { launch: "l1", kind: "prompt", text: "Frozen task", agent: "task:mid" }
				: frame.op === "post"
					? { seq: 7 }
					: undefined,
		);
	const rewritten = await h.call({ language: "js", code: 'return await playbook.run({run:"r1", blocks:["b1"]});' });
	if (rewritten?.input === undefined) throw new Error("run was not rewritten");
	const tool: Record<string, (params: Record<string, unknown>) => Promise<string>> = {};
	for (const name of ["playbook_launch", "playbook_timeline"])
		tool[name] = async (params) => {
			h.tools.get(name)!.parameters.parse(params);
			const result = await h.execute(name, params);
			return resultText(result);
		};
	const execute = new (Object.getPrototypeOf(async () => {}).constructor)("tool", "agent", rewritten.input.code) as (
		tools: Record<string, (params: Record<string, unknown>) => Promise<string>>,
		agent: (prompt: string, options: unknown) => Promise<{ id: string; wait(): Promise<string> }>,
	) => Promise<string>;
	const spawned: { prompt: string; options: unknown }[] = [];
	expect(
		await execute(tool, async (prompt: string, options: unknown) => {
			spawned.push({ prompt, options });
			return {
				id: "worker-1",
				async wait() {
					expect(s.frames.at(-1)).toMatchObject({ op: "bind", args: { launch: "l1", agent: "worker-1" } });
					return "Completed";
				},
			};
		}),
	).toBe("Completed");
	expect(spawned).toEqual([{ prompt: "Frozen task", options: { agent: "task:mid" } }]);
	expect(s.frames.map((frame) => frame.op)).toEqual(["hello", "launch", "bind", "post", "close"]);
	expect(s.frames.at(-2)!.args).toEqual({ run: "r1", kind: "result", text: "Completed", launch: "l1", block: "b1" });
	expect(s.frames.at(-1)!.args).toEqual({ launch: "l1" });
});

test("a rejected edit still releases its lock and the next call receives a fresh lock id", async () => {
	const s = await service();
	const h = await harness();
	await h.execute("playbook_open", { doc: s.doc });
	s.handler = (frame, connection) => {
		if (frame.op === "edit")
			connection.send(JSON.stringify({ id: frame.id, ok: false, error: { code: "BadValue", message: "find is not unique" } }));
		else respond(connection, frame, frame.op === "lock" ? { block } : undefined);
	};
	const rejected = await h.execute("playbook_edit_content", { block: "b1", find: "Body", replace: "New" });
	expect(JSON.parse(resultText(rejected))).toEqual({ error: { code: "BadValue", message: "find is not unique" } });
	await h.execute("playbook_edit_structure", { meta: { block: "b1", status: "done" } });
	expect(s.frames.map((frame) => frame.op)).toEqual(["hello", "lock", "edit", "unlock", "lock", "set", "unlock"]);
	expect(s.frames[1]!.args).toEqual({ block: "b1" });
	expect(s.frames[4]!.id).not.toBe(s.frames[1]!.id);
	expect(s.frames[3]!.args).toEqual({ block: "b1", request: s.frames[1]!.id });
	expect(s.frames[6]!.args).toEqual({ block: "b1", request: s.frames[4]!.id });
});

test("playbook:// timeline read forwards after and limit to the K1 request", async () => {
	const s = await service();
	const h = await harness();
	await h.execute("playbook_open", { doc: s.doc });
	s.handler = (frame, connection) => respond(connection, frame, { entries: [{ seq: 7 }], next_after: 7 });
	const res = await InternalUrlRouter.instance().resolve(`playbook://${encodeURIComponent(s.doc)}/r1/timeline?after=6&limit=200`);
	expect(s.frames.at(-1)).toMatchObject({ op: "timeline", args: { run: "r1", after: 6, limit: 200 } });
	expect(res.content).toBe('{"entries":[{"seq":7}],"next_after":7}');
});

test("tool output passes the reply's serialized result through byte-identically, canonical or not", async () => {
	const s = await service();
	const h = await harness();
	await h.execute("playbook_open", { doc: s.doc });
	s.handler = (frame, connection) => connection.send(`{"id":${JSON.stringify(frame.id)},"ok":true,"result":{ "entries" : [{"seq":9}] }}`);
	const result = await h.execute("playbook_compile", { doc: s.doc, blocks: ["b1"] });
	expect(result.isError).toBe(false);
	expect(resultText(result)).toBe('{ "entries" : [{"seq":9}] }');
});

test("a large reply frame far above the host's write high-water mark reassembles", async () => {
	const s = await service();
	const h = await harness();
	await h.execute("playbook_open", { doc: s.doc });
	const text = `你好🌟${"x".repeat(5 * 1024 * 1024)}`;
	s.handler = (frame, connection) => connection.send(JSON.stringify({ id: frame.id, ok: true, result: { entries: [{ seq: 1, text }] } }));
	const res = await InternalUrlRouter.instance().resolve(`playbook://${encodeURIComponent(s.doc)}/timeline`);
	expect(res.content).toBe(JSON.stringify({ entries: [{ seq: 1, text }] }));
});

test("a bad reply line closes the connection and in-flight requests fail Disconnected", async () => {
	const s = await service();
	const h = await harness();
	await h.execute("playbook_open", { doc: s.doc });
	s.handler = (_frame, connection) => connection.send("not-json");
	const result = await h.execute("playbook_compile", { doc: s.doc, blocks: ["b1"] });
	expect(result.isError).toBe(true);
	expect(JSON.parse(resultText(result))).toMatchObject({ error: { code: "Disconnected" } });
	expect(s.frames.at(-1)!.op).toBe("compile");
});
