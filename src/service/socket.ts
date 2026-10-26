import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import { parseBlockId, parseLaunchId, parseRunId, type BlockId, type JudgeReport } from "../domain/model";
import type { Connection, K1Handler } from "../domain/ports";
import type { ProtocolError, Request, ServerFrame } from "../domain/protocol";
import { tr } from "../i18n";

class BadInput extends Error {}

function object(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BadInput(tr(`${name} must be an object`, `${name} 必须是对象`));
	return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
	if (typeof value !== "string") throw new BadInput(tr(`${name} must be a string`, `${name} 必须是字符串`));
	return value;
}

function optional<T>(value: unknown, parse: (value: unknown) => T): T | undefined {
	return value === undefined ? undefined : parse(value);
}

function flag(value: unknown, name: string): boolean {
	if (typeof value !== "boolean") throw new BadInput(tr(`${name} must be a boolean`, `${name} 必须是布尔值`));
	return value;
}

/** A task block's default agent: a non-blank name, trimmed. */
function agentName(value: unknown): string {
	const name = string(value, "agent").trim();
	if (name === "") throw new BadInput(tr("agent must not be blank", "agent 不能为空"));
	return name;
}

function block(value: unknown): BlockId {
	const id = parseBlockId(string(value, "block"));
	if (id === null) throw new BadInput(tr("block must be b followed by a positive integer", "block 必须是 b 后跟正整数"));
	return id;
}

function run(value: unknown) {
	const id = parseRunId(string(value, "run"));
	if (id === null) throw new BadInput(tr("run must be r followed by a positive integer", "run 必须是 r 后跟正整数"));
	return id;
}

function launch(value: unknown) {
	const id = parseLaunchId(string(value, "launch"));
	if (id === null) throw new BadInput(tr("launch must be l followed by a positive integer", "launch 必须是 l 后跟正整数"));
	return id;
}

function integer(value: unknown, name: string, minimum = 1): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
		throw new BadInput(tr(`${name} must be ${minimum === 0 ? "a nonnegative" : "a positive"} safe integer`, `${name} 必须是${minimum === 0 ? "非负" : "正"}安全整数`));
	}
	return value;
}

function array<T>(value: unknown, name: string, parse: (item: unknown) => T): readonly T[] {
	if (!Array.isArray(value)) throw new BadInput(tr(`${name} must be an array`, `${name} 必须是数组`));
	return value.map((item: unknown) => parse(item));
}

function report(value: unknown): JudgeReport {
	const result = object(value, "result");
	switch (result.kind) {
		case "judge_unavailable": return { kind: "judge_unavailable" };
		case "answers": {
			const values = object(result.answers, "answers");
			const answers: Record<string, number> = Object.create(null);
			for (const [key, answer] of Object.entries(values)) {
				if (typeof answer !== "number" || !Number.isFinite(answer)) throw new BadInput(tr("answers must contain finite numbers", "answers 必须包含有限数字"));
				answers[key] = answer;
			}
			return { kind: "answers", answers };
		}
		default: throw new BadInput(tr("result kind must be answers or judge_unavailable", "result kind 必须是 answers 或 judge_unavailable"));
	}
}

/** Parse transport input only; existence, ownership, and other business rules belong to the handler. */
export function parseRequest(op: string, args: unknown): Request | ProtocolError {
	try {
		const a = object(args, "args");
		switch (op) {
			case "hello": return { op, args: { session: string(a.session, "session"), pane: optional(a.pane, v => string(v, "pane")) } };
			case "lock":
			case "delete": return { op, args: { run: optional(a.run, run), block: block(a.block) } };
			case "unlock": return { op, args: { run: optional(a.run, run), block: block(a.block), request: string(a.request, "request") } };
			case "read": return { op, args: { run: optional(a.run, run), block: optional(a.block, block) } };
			case "set": {
				const target = { run: optional(a.run, run), block: block(a.block) };
				switch (a.field) {
					case "title": return { op, args: { ...target, field: "title", value: string(a.value, "value") } };
					case "status": {
						const value = a.value;
						if (value !== "todo" && value !== "running" && value !== "done") throw new BadInput(tr("status value must be todo, running or done", "status 值必须是 todo、running 或 done"));
						return { op, args: { ...target, field: "status", value } };
					}
					case "task": return { op, args: { ...target, field: "task", value: flag(a.value, "task value") } };
					case "agent": return { op, args: { ...target, field: "agent", value: a.value === null ? null : agentName(a.value) } };
					case "isolated": return { op, args: { ...target, field: "isolated", value: a.value === null ? null : flag(a.value, "isolated value") } };
					default: throw new BadInput(tr("field must be title, status, task, agent or isolated", "field 必须是 title、status、task、agent 或 isolated"));
				}
			}
			case "edit": return { op, args: { run: optional(a.run, run), block: block(a.block), find: string(a.find, "find"), replace: string(a.replace, "replace") } };
			case "write": return { op, args: { run: optional(a.run, run), block: block(a.block), text: string(a.text, "text") } };
			case "panel": {
				const panel = string(a.panel, "panel");
				if (!/^[A-Z][0-9]*$/.test(panel)) throw new BadInput(tr("panel must be a panel letter ID such as A", "panel 必须是类似 A 的面板字母 ID"));
				return { op, args: { run: optional(a.run, run), block: block(a.block), panel, text: string(a.text, "text") } };
			}
			case "insert": {
				const content = object(a.content, "content");
				switch (content.kind) {
					case "task": return {
						op,
						args: {
							run: optional(a.run, run), after: optional(a.after, block), title: string(a.title, "title"),
							content: {
								kind: "task",
								body: string(content.body, "body"),
								...(content.agent === undefined ? {} : { agent: agentName(content.agent) }),
								...(content.isolated === undefined ? {} : { isolated: flag(content.isolated, "isolated") }),
							},
						},
					};
					case "design":
						if (content.requirement !== undefined) throw new BadInput(tr("a design block's requirement belongs to the person; insert it with an empty requirement", "设计块的 requirement 属于用户；插入时必须为空"));
						if (content.agent !== undefined || content.isolated !== undefined) throw new BadInput(tr("a design block has no execution contract (agent, isolated)", "设计块没有执行配置（agent、isolated）"));
						return { op, args: { run: optional(a.run, run), after: optional(a.after, block), title: string(a.title, "title"), content: { kind: "design", design: string(content.design, "design") } } };
					default: throw new BadInput(tr("content kind must be task or design", "content kind 必须是 task 或 design"));
				}
			}
			case "move":
				if (a.after === undefined) throw new BadInput(tr("after must be a block id, or null for the top", "after 必须是块 ID，或使用 null 表示顶部"));
				return { op, args: { run: optional(a.run, run), block: block(a.block), after: a.after === null ? null : block(a.after) } };
			case "revisions": return { op, args: { run: optional(a.run, run), block: optional(a.block, block), after: optional(a.after, v => integer(v, "after", 0)) } };
			case "refetch": return { op, args: { run: optional(a.run, run), targets: array(a.targets, "targets", v => string(v, "target")) } };
			case "compile":
			case "inspect": return { op, args: { run: optional(a.run, run), blocks: array(a.blocks, "blocks", block) } };
			case "report": return { op, args: { run: optional(a.run, run), blocks: array(a.blocks, "blocks", block), version: string(a.version, "version"), result: report(a.result) } };
			case "launch": return { op, args: { run: optional(a.run, run), blocks: array(a.blocks, "blocks", block) } };
			case "bind": return { op, args: { launch: launch(a.launch), agent: string(a.agent, "agent") } };
			case "rebase":
			case "close":
			case "launch_info": return { op, args: { launch: launch(a.launch) } };
			case "start_run": return { op, args: { name: string(a.name, "name"), update_every: optional(a.update_every, v => integer(v, "update_every")) } };
			case "finish_run": return { op, args: { run: run(a.run) } };
			case "runs": return { op, args: {} };
			case "timeline": return { op, args: { run: optional(a.run, run), after: optional(a.after, v => integer(v, "after", 0)) } };
			case "post": {
				const kind = a.kind;
				if (kind !== "update" && kind !== "result" && kind !== "failure" && kind !== "retrospective") throw new BadInput(tr("unknown post kind", "未知的 post kind"));
				if (a.origin !== undefined && a.origin !== "human") throw new BadInput(tr("origin must be human", "origin 必须是 human"));
				const next = optional(a.next, v => integer(v, "next"));
				if (next !== undefined && kind !== "update") throw new BadInput(tr("next is only valid for update records", "next 只用于 update 记录"));
				return { op, args: { run: optional(a.run, run), kind, text: string(a.text, "text"), block: optional(a.block, block), launch: optional(a.launch, launch), next, quote: optional(a.quote, v => string(v, "quote")), origin: a.origin } };
			}
			case "snooze": return { op, args: { run: run(a.run), after: integer(a.after, "after") } };
			case "ack": return { op, args: { event: string(a.event, "event") } };
			case "agents": {
				const result = object(a.result, "result");
				switch (result.kind) {
					case "listed": return { op, args: { result: { kind: "listed", names: array(result.names, "names", v => agentName(v)) } } };
					case "unavailable": return { op, args: { result: { kind: "unavailable", reason: string(result.reason, "reason") } } };
					default: throw new BadInput(tr("result kind must be listed or unavailable", "result kind 必须是 listed 或 unavailable"));
				}
			}
			case "reveal": return { op, args: {} };
			default: throw new BadInput(tr(`Unknown operation: ${op}`, `未知操作：${op}`));
		}
	} catch (error) {
		if (error instanceof BadInput) return { code: "BadValue", message: error.message };
		throw error;
	}
}

interface SocketState {
	readonly conn: Connection;
	readonly decoder: TextDecoder;
	buffer: string;
	tail: Promise<void>;
	closed: boolean;
	readonly outgoing: Uint8Array[];
	offset: number;
}

/** Another document service already listens for this document (design/README.md I1). */
export class ServiceRunning extends Error {}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function listening(path: string): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const probe = createConnection(path);
	probe.once("connect", () => { probe.destroy(); resolve(true); });
	probe.once("error", () => resolve(false));
	return promise;
}

/**
 * Claims the document's socket path for this process. The bind itself arbitrates: a live
 * listener makes this process refuse; a socket file nobody listens on is moved aside by an
 * atomic rename of exactly that inode, so concurrent starters cannot both win (I1).
 */
async function claim(path: string, listen: () => { close(): void }): Promise<{ close(): void }> {
	mkdirSync(dirname(path), { recursive: true });
	for (;;) {
		const existing = lstatSync(path, { throwIfNoEntry: false });
		if (existing) {
			if (!existing.isSocket()) throw new Error(`Refusing to remove a non-socket file: ${path}`);
			if (await listening(path)) throw new ServiceRunning(`A document service is already listening at ${path}`);
			const aside = `${path}.stale-${randomUUID()}`;
			try { renameSync(path, aside); } catch (error) { if (errorCode(error) === "ENOENT") continue; throw error; }
			if (lstatSync(aside).ino !== existing.ino) { renameSync(aside, path); continue; }
			unlinkSync(aside);
			continue;
		}
		try { return listen(); } catch (error) { if (errorCode(error) === "EADDRINUSE") continue; throw error; }
	}
}

/** A newline JSON adapter. Core owns hello admission and all document state. */
export function serveK1(path: string, handler: K1Handler): Promise<{ close(): void }> {
	return claim(path, () => listenK1(path, handler));
}

/** Result of asking the document's service to show its pane (contracts.md K1 `reveal`). */
export type RevealOutcome = { readonly kind: "revealed" } | { readonly kind: "absent" } | { readonly kind: "failed"; readonly message: string };

/** One-shot K1 client: `reveal` needs no hello and never becomes the coordinator. */
export function revealService(path: string): Promise<RevealOutcome> {
	const { promise, resolve } = Promise.withResolvers<RevealOutcome>();
	const socket = createConnection(path);
	let buffer = "";
	let connected = false;
	socket.setEncoding("utf8");
	socket.once("connect", () => {
		connected = true;
		socket.write(`${JSON.stringify({ id: "reveal", op: "reveal", args: {} })}\n`);
	});
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		const end = buffer.indexOf("\n");
		if (end < 0) return;
		socket.destroy();
		try {
			const reply: unknown = JSON.parse(buffer.slice(0, end));
			const frame = object(reply, "reply");
			if (frame.ok === true) { resolve({ kind: "revealed" }); return; }
			const error = object(frame.error, "error");
			resolve({ kind: "failed", message: `${string(error.code, "code")}: ${string(error.message, "message")}` });
		} catch (error) {
			resolve({ kind: "failed", message: tr(`Invalid reveal reply: ${error instanceof Error ? error.message : String(error)}`, `显示回复无效：${error instanceof Error ? error.message : String(error)}`) });
		}
	});
	socket.once("error", error => resolve(connected ? { kind: "failed", message: tr(`Reveal failed: ${error.message}`, `显示失败：${error.message}`) } : { kind: "absent" }));
	socket.once("close", () => resolve(connected ? { kind: "failed", message: tr("Connection closed before a reply", "连接在收到回复前关闭") } : { kind: "absent" }));
	return promise;
}

function listenK1(path: string, handler: K1Handler): { close(): void } {
	let nextConnection = 1;
	const connections = new Set<Bun.Socket<SocketState>>();
	const encoder = new TextEncoder();

	function flush(socket: Bun.Socket<SocketState>): void {
		const state = socket.data;
		while (!state.closed && state.outgoing.length > 0) {
			const bytes = state.outgoing[0]!;
			const written = socket.write(bytes.subarray(state.offset));
			if (written < 0) { disconnect(socket); socket.terminate(); return; }
			state.offset += written;
			if (state.offset < bytes.length) return;
			state.outgoing.shift();
			state.offset = 0;
		}
	}

	function send(socket: Bun.Socket<SocketState>, frame: ServerFrame): void {
		if (socket.data.closed) return;
		socket.data.outgoing.push(encoder.encode(`${JSON.stringify(frame)}\n`));
		flush(socket);
	}

	function disconnect(socket: Bun.Socket<SocketState>): void {
		const state = socket.data;
		if (state.closed) return;
		state.closed = true;
		state.buffer = "";
		state.outgoing.length = 0;
		connections.delete(socket);
		handler.disconnected(state.conn);
	}

	async function processLine(socket: Bun.Socket<SocketState>, line: string): Promise<void> {
		if (socket.data.closed) return;
		let frame: Record<string, unknown>;
		try {
			const value: unknown = JSON.parse(line);
			frame = object(value, "request");
			string(frame.id, "id");
		} catch {
			// There is no request id to correlate a response with.
			socket.data.conn.close();
			return;
		}
		const id = string(frame.id, "id");
		if (typeof frame.op !== "string") {
			send(socket, { id, ok: false, error: { code: "BadValue", message: tr("op must be a string", "op 必须是字符串") } });
			return;
		}
		const request = parseRequest(frame.op, frame.args);
		if ("code" in request) {
			send(socket, { id, ok: false, error: request });
			return;
		}
		const outcome = await handler.handle(socket.data.conn, id, request);
		send(socket, outcome.ok ? { id, ok: true, result: outcome.result === undefined ? null : outcome.result } : { id, ok: false, error: outcome.error });
	}

	const listener = Bun.listen<SocketState>({
		unix: path,
		socket: {
			open(socket) {
				const conn: Connection = {
					id: nextConnection++,
					send: frame => send(socket, frame),
					close: () => { disconnect(socket); socket.terminate(); },
				};
				socket.data = { conn, decoder: new TextDecoder(), buffer: "", tail: Promise.resolve(), closed: false, outgoing: [], offset: 0 };
				connections.add(socket);
				handler.connected(conn);
			},
			data(socket, bytes) {
				const state = socket.data;
				if (state.closed) return;
				state.buffer += state.decoder.decode(bytes, { stream: true });
				let newline: number;
				while ((newline = state.buffer.indexOf("\n")) !== -1) {
					const line = state.buffer.slice(0, newline);
					state.buffer = state.buffer.slice(newline + 1);
					state.tail = state.tail.then(() => processLine(socket, line)).catch(() => state.conn.close());
				}
			},
			drain: flush,
			close: disconnect,
			end(socket) { socket.data.conn.close(); },
			error(socket) { socket.data.conn.close(); },
		},
	});
	return {
		close() {
			for (const socket of connections) socket.data.conn.close();
			listener.stop(true);
		},
	};
}
