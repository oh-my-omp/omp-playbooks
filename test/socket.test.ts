import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { dirname } from "node:path";
import type { Connection, K1Handler } from "../src/domain/ports";
import type { Outcome, Request } from "../src/domain/protocol";
import { parseRequest, revealService, serveK1, ServiceRunning } from "../src/service/socket";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempPath(): string {
	const dir = mkdtempSync("/tmp/tern-k1-");
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return `${dir}/nested/service.sock`;
}

async function client(path: string): Promise<{ socket: Socket; next(): Promise<unknown> }> {
	const socket = createConnection(path);
	cleanups.push(() => socket.destroy());
	socket.setEncoding("utf8");
	let buffer = "";
	const frames: unknown[] = [];
	const waiting: ((frame: unknown) => void)[] = [];
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		let newline: number;
		while ((newline = buffer.indexOf("\n")) !== -1) {
			const frame: unknown = JSON.parse(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			const resolve = waiting.shift();
			if (resolve) resolve(frame);
			else frames.push(frame);
		}
	});
	await once(socket, "connect");
	return {
		socket,
		next() {
			if (frames.length) return Promise.resolve(frames.shift());
			const next = Promise.withResolvers<unknown>();
			waiting.push(next.resolve);
			return next.promise;
		},
	};
}

async function start(path: string, handle: K1Handler["handle"], disconnected: K1Handler["disconnected"] = () => {}, connected: K1Handler["connected"] = () => {}) {
	const server = await serveK1(path, { connected, disconnected, handle });
	cleanups.push(() => server.close());
	return server;
}

const valid: readonly [string, unknown][] = [
	["hello", { session: "session", pane: "pane" }],
	["reveal", {}],
	["lock", { run: "r1", block: "b2" }],
	["unlock", { block: "b2", request: "lock-id" }],
	["read", { run: "r1", block: "b2" }],
	["set", { block: "b2", field: "title", value: "title" }],
	["set", { block: "b2", field: "status", value: "todo" }],
	["set", { block: "b2", field: "task", value: false }],
	["launch", { blocks: ["b2"] }],
	["timeline", {}],
	["post", { kind: "result", text: "Template result" }],
	["set", { block: "b2", field: "agent", value: "task:mid" }],
	["set", { block: "b2", field: "agent", value: null }],
	["set", { block: "b2", field: "isolated", value: true }],
	["set", { block: "b2", field: "isolated", value: null }],
	["edit", { block: "b2", find: "before", replace: "after" }],
	["insert", { after: "b2", title: "new", content: { kind: "task", body: "body" } }],
	["insert", { title: "configured", content: { kind: "task", body: "body", agent: "task:mid", isolated: false } }],
	["move", { run: "r1", block: "b2", after: "b1" }],
	["move", { block: "b2", after: null }],
	["insert", { title: "design", content: { kind: "design", design: "## A Panel" } }],
	["write", { block: "b2", text: "whole" }],
	["panel", { block: "b2", panel: "A", text: "## A Panel" }],
	["revisions", { block: "b2", after: 0 }],
	["delete", { block: "b2" }],
	["refetch", { targets: ["https://example.com", "./file.ts"] }],
	["compile", { blocks: ["b2"] }],
	["inspect", { blocks: ["b2"] }],
	["report", { blocks: ["b2"], version: "version", result: { kind: "answers", answers: { missing: 0.25 } } }],
	["report", { blocks: [], version: "version", result: { kind: "judge_unavailable" } }],
	["launch", { run: "r1", blocks: ["b2"] }],
	["bind", { launch: "l1", agent: "worker" }],
	["rebase", { launch: "l1" }],
	["close", { launch: "l1" }],
	["launch_info", { launch: "l1" }],
	["start_run", { name: "Run", update_every: 60 }],
	["finish_run", { run: "r1" }],
	["runs", {}],
	["timeline", { run: "r1", after: 0 }],
	["post", { run: "r1", kind: "update", text: "状态", block: "b2", launch: "l1", next: 30, quote: "message", origin: "human" }],
	["post", { run: "r1", kind: "result", text: "result" }],
	["post", { run: "r1", kind: "failure", text: "failure" }],
	["post", { run: "r1", kind: "retrospective", text: "review" }],
	["snooze", { run: "r1", after: 60 }],
	["ack", { event: "event-id" }],
];

describe("parseRequest", () => {
	for (const [op, args] of valid) {
		test(`constructs ${op} ${JSON.stringify(args)}`, () => {
			const parsed: unknown = parseRequest(op, args);
			expect(parsed).toEqual({ op, args });
		});
	}

	test("rejects unknown operations and non-object arguments", () => {
		expect(parseRequest("unknown", {})).toMatchObject({ code: "BadValue" });
		for (const args of [undefined, null, [], 3, "args", true]) {
			expect(parseRequest("read", args)).toMatchObject({ code: "BadValue" });
		}
	});

	test("rejects each required field when absent", () => {
		for (const [op, args] of valid) {
			if (typeof args !== "object" || args === null) throw new Error("invalid fixture");
			for (const key of Object.keys(args)) {
				if (["pane", "run", "after", "update_every", "next", "quote", "origin"].includes(key) && !(["finish_run", "snooze"].includes(op) && key === "run") && !(op === "snooze" && key === "after")) continue;
				if (key === "block" && (op === "read" || op === "post" || op === "revisions")) continue;
				if (key === "launch" && op === "post") continue;
				const incomplete = { ...args };
				Reflect.deleteProperty(incomplete, key);
				expect(parseRequest(op, incomplete)).toMatchObject({ code: "BadValue" });
			}
		}
	});

	test("rejects identifier format and optional field type boundaries", () => {
		for (const block of ["b0", "b01", "b-1", "b1.5", "b1x", "r1", 1, null]) expect(parseRequest("lock", { block })).toMatchObject({ code: "BadValue" });
		for (const run of ["r0", "r01", "r-1", "r1.5", "b1", 1, null]) expect(parseRequest("read", { run })).toMatchObject({ code: "BadValue" });
		for (const launch of ["l0", "l01", "l-1", "l1.5", "b1", 1, null]) expect(parseRequest("close", { launch })).toMatchObject({ code: "BadValue" });
		const invalid: readonly [string, unknown][] = [
			["hello", { session: "s", pane: 2 }], ["hello", { session: 2 }],
			["unlock", { block: "b1", request: 2 }], ["read", { block: null }],
			["set", { block: "b1", field: "body", value: "x" }], ["set", { block: "b1", field: "title", value: true }], ["set", { block: "b1", field: "done", value: "true" }],
			["edit", { block: "b1", find: 1, replace: "x" }], ["edit", { block: "b1", find: "x", replace: false }],
			["insert", { title: "x", content: { kind: "task", body: "x" }, after: "b0" }], ["insert", { title: 1, content: { kind: "task", body: "x" } }], ["insert", { title: "x", content: { kind: "task", body: 1 } }],
			["insert", { title: "x", body: "x" }], ["insert", { title: "x", content: { kind: "design", requirement: "r", design: "d" } }], ["insert", { title: "x", content: { kind: "other" } }],
			["write", { block: "b1", text: 1 }], ["panel", { block: "b1", panel: "a", text: "x" }], ["revisions", { after: -1 }],
			["refetch", { targets: "x" }], ["refetch", { targets: [3] }], ["compile", { blocks: "b1" }], ["inspect", { blocks: ["b0"] }],
			["report", { blocks: [], version: 2, result: { kind: "judge_unavailable" } }], ["report", { blocks: [], version: "v", result: { kind: "answers", answers: { missing: "0" } } }],
			["report", { blocks: [], version: "v", result: { kind: "answers", answers: [] } }], ["report", { blocks: [], version: "v", result: { kind: "other" } }],
			["bind", { launch: "l1", agent: 3 }], ["start_run", { name: false }],
			["post", { run: "r1", kind: "other", text: "x" }], ["post", { run: "r1", kind: "update", text: "x", origin: "coordinator" }],
			["post", { run: "r1", kind: "result", text: "x", next: 1 }], ["post", { run: "r1", kind: "update", text: "x", quote: 3 }],
			["post", { run: "r1", kind: "update", text: "x", launch: "l0" }], ["post", { run: "r1", kind: "update", text: "x", block: "b0" }],
			["ack", { event: 1 }],
			["set", { block: "b1", field: "agent", value: "   " }], ["set", { block: "b1", field: "agent", value: 3 }], ["set", { block: "b1", field: "isolated", value: "true" }],
			["insert", { title: "x", content: { kind: "task", body: "x", agent: " " } }], ["insert", { title: "x", content: { kind: "task", body: "x", isolated: "yes" } }],
			["insert", { title: "x", content: { kind: "design", design: "d", agent: "task:mid" } }], ["insert", { title: "x", content: { kind: "design", design: "d", isolated: true } }],
			["move", { block: "b2" }], ["move", { block: "b2", after: "b0" }], ["move", { block: "b2", after: 1 }],
		];
		for (const [op, args] of invalid) expect(parseRequest(op, args)).toMatchObject({ code: "BadValue" });
	});

	test("trims a task block's agent name at the boundary", () => {
		expect(parseRequest("set", { block: "b1", field: "agent", value: " task:mid " })).toEqual({ op: "set", args: { block: "b1", field: "agent", value: "task:mid" } });
		expect(parseRequest("insert", { title: "x", content: { kind: "task", body: "x", agent: "\ttask:low\n" } })).toEqual({ op: "insert", args: { title: "x", content: { kind: "task", body: "x", agent: "task:low" } } });
	});

	test("requires positive safe integer reminder durations", () => {
		for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
			expect(parseRequest("post", { run: "r1", kind: "update", text: "x", next: value })).toMatchObject({ code: "BadValue" });
			expect(parseRequest("start_run", { name: "Run", update_every: value })).toMatchObject({ code: "BadValue" });
			expect(parseRequest("snooze", { run: "r1", after: value })).toMatchObject({ code: "BadValue" });
		}
		for (const after of [-1, 1.5, NaN, "1"]) expect(parseRequest("timeline", { run: "r1", after })).toMatchObject({ code: "BadValue" });
	});

	test("does not perform document, run, or report business validation", () => {
		expect(parseRequest("launch", { blocks: [] })).toMatchObject({ op: "launch", args: { blocks: [] } });
		expect(parseRequest("launch", { run: "r1", blocks: [] })).toEqual({ op: "launch", args: { run: "r1", blocks: [] } });
		expect(parseRequest("read", { block: "b999" })).toMatchObject({ op: "read" });
		expect(parseRequest("post", { run: "r999", kind: "retrospective", text: "x" })).toMatchObject({ op: "post" });
		expect(parseRequest("report", { blocks: [], version: "v", result: { kind: "answers", answers: { unknown: 2 } } })).toMatchObject({ op: "report" });
	});
});

describe("serveK1 real Unix sockets", () => {
	test("serializes handler calls and responses, including invalid requests", async () => {
		const path = tempPath();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const calls: string[] = [];
		await start(path, async (_conn, id) => {
			calls.push(id);
			if (id === "first") { entered.resolve(); await release.promise; }
			return { ok: true, result: id };
		});
		const c = await client(path);
		c.socket.write('{"id":"first","op":"runs","args":{}}\n{"id":"bad","op":"set","args":{}}\n{"id":"second","op":"runs","args":{}}\n');
		await entered.promise;
		await setImmediate();
		expect(calls).toEqual(["first"]);
		release.resolve();
		expect(await c.next()).toEqual({ id: "first", ok: true, result: "first" });
		expect(await c.next()).toMatchObject({ id: "bad", ok: false, error: { code: "BadValue" } });
		expect(await c.next()).toEqual({ id: "second", ok: true, result: "second" });
		expect(calls).toEqual(["first", "second"]);
	});

	test("pushes events and preserves success-without-result and error frames", async () => {
		const path = tempPath();
		await start(path, async (conn, id): Promise<Outcome<unknown>> => {
			conn.send({ event: "status_changed", data: { run: "r1", block: "b1", status: "done" } });
			return id === "empty" ? { ok: true, result: undefined } : { ok: false, error: { code: "NotHello", message: "hello required" } };
		});
		const c = await client(path);
		c.socket.write('{"id":"empty","op":"runs","args":{}}\n');
		expect(await c.next()).toEqual({ event: "status_changed", data: { run: "r1", block: "b1", status: "done" } });
		expect(await c.next()).toEqual({ id: "empty", ok: true, result: null });
		c.socket.write('{"id":"error","op":"runs","args":{}}\n');
		await c.next();
		expect(await c.next()).toEqual({ id: "error", ok: false, error: { code: "NotHello", message: "hello required" } });
	});

	test("joins partial lines and split UTF-8 code points without premature handling", async () => {
		const path = tempPath();
		const requests: Request[] = [];
		await start(path, async (_conn, _id, request) => { requests.push(request); return { ok: true, result: request.args }; });
		const c = await client(path);
		const bytes = Buffer.from('{"id":"unicode","op":"hello","args":{"session":"你好🌟"}}\n');
		const split = bytes.indexOf(Buffer.from("好")) + 1;
		c.socket.write(bytes.subarray(0, split));
		await setImmediate();
		expect(requests).toHaveLength(0);
		c.socket.write(bytes.subarray(split, bytes.length - 1));
		await setImmediate();
		expect(requests).toHaveLength(0);
		c.socket.write("\n");
		expect(await c.next()).toEqual({ id: "unicode", ok: true, result: { session: "你好🌟" } });
		expect(requests).toEqual([{ op: "hello", args: { session: "你好🌟", pane: undefined } }]);
	});

	test("disconnects once and skips queued requests after a client closes mid-request", async () => {
		const path = tempPath();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<void>();
		const disconnected = Promise.withResolvers<Connection>();
		const calls: string[] = [];
		const closed: Connection[] = [];
		await start(path, async (_conn, id) => {
			calls.push(id); entered.resolve(); await release.promise; finished.resolve();
			return { ok: true, result: id };
		}, conn => { closed.push(conn); disconnected.resolve(conn); });
		const c = await client(path);
		c.socket.write('{"id":"first","op":"runs","args":{}}\n{"id":"second","op":"runs","args":{}}\n');
		await entered.promise;
		c.socket.destroy();
		const conn = await disconnected.promise;
		conn.close();
		conn.send({ event: "status_changed", data: { run: "r1", block: "b1", status: "todo" } });
		release.resolve();
		await finished.promise;
		await setImmediate();
		expect(calls).toEqual(["first"]);
		expect(closed).toEqual([conn]);
	});

	test("shutdown closes every connection and unlinks the socket", async () => {
		const path = tempPath();
		const closed: number[] = [];
		const server = await start(path, async () => ({ ok: true, result: null }), conn => closed.push(conn.id));
		const a = await client(path);
		const b = await client(path);
		const aClosed = once(a.socket, "close");
		const bClosed = once(b.socket, "close");
		server.close();
		server.close();
		await Promise.all([aClosed, bClosed]);
		expect(closed).toHaveLength(2);
		expect(new Set(closed).size).toBe(2);
		expect(existsSync(path)).toBe(false);
	});

	test("handles unidentifiable frames and unexpected handler failures as disconnects", async () => {
		for (const frame of ['not-json\n', '{"id":1,"op":"runs","args":{}}\n', '{"id":"throw","op":"runs","args":{}}\n']) {
			const path = tempPath();
			const disconnected = Promise.withResolvers<void>();
			await start(path, async () => { throw new Error("unexpected failure"); }, () => disconnected.resolve());
			const c = await client(path);
			const closed = once(c.socket, "close");
			c.socket.write(frame);
			await Promise.all([disconnected.promise, closed]);
		}
	});

	test("returns BadValue for identifiable malformed envelopes and continues", async () => {
		const path = tempPath();
		await start(path, async () => ({ ok: true, result: "continued" }));
		const c = await client(path);
		c.socket.write('{"id":"bad","op":3,"args":{}}\n{"id":"good","op":"runs","args":{}}\n');
		expect(await c.next()).toMatchObject({ id: "bad", ok: false, error: { code: "BadValue" } });
		expect(await c.next()).toEqual({ id: "good", ok: true, result: "continued" });
	});

	test("delivers large event frames without losing bytes under backpressure", async () => {
		const path = tempPath();
		const name = "状态".repeat(300_000);
		await start(path, async conn => {
			conn.send({ event: "revision_requested", data: { block: "b1", revision: 1, ...{ padding: name } } });
			conn.send({ event: "status_changed", data: { run: "r1", block: "b1", status: "todo" } });
			return { ok: true, result: "done" };
		});
		const c = await client(path);
		c.socket.write('{"id":"large","op":"runs","args":{}}\n');
		expect(await c.next()).toEqual({ event: "revision_requested", data: { block: "b1", revision: 1, ...{ padding: name } } });
		expect(await c.next()).toEqual({ event: "status_changed", data: { run: "r1", block: "b1", status: "todo" } });
		expect(await c.next()).toEqual({ id: "large", ok: true, result: "done" });
	});

	test("replaces a residual socket left by a killed process", async () => {
		const path = tempPath();
		mkdirSync(dirname(path), { recursive: true });
		const child = Bun.spawn([process.execPath, "-e", `Bun.listen({unix:${JSON.stringify(path)},socket:{data(){}}});console.log("ready")`], { stdout: "pipe", stderr: "inherit" });
		cleanups.push(() => child.kill("SIGKILL"));
		const reader = child.stdout.getReader();
		const ready = await reader.read();
		expect(new TextDecoder().decode(ready.value)).toContain("ready");
		reader.releaseLock();
		child.kill("SIGKILL");
		await child.exited;
		expect(existsSync(path)).toBe(true);
		await start(path, async () => ({ ok: true, result: "replaced" }));
		const c = await client(path);
		c.socket.write('{"id":"stale","op":"runs","args":{}}\n');
		expect(await c.next()).toEqual({ id: "stale", ok: true, result: "replaced" });
	});

	test("rejects a second live server without disrupting the first", async () => {
		const path = tempPath();
		await start(path, async () => ({ ok: true, result: "original" }));
		await expect(start(path, async () => ({ ok: true, result: "contender" }))).rejects.toBeInstanceOf(ServiceRunning);
		const c = await client(path);
		c.socket.write('{"id":"live","op":"runs","args":{}}\n');
		expect(await c.next()).toEqual({ id: "live", ok: true, result: "original" });
	});

	test("elects one live server when two claims race on a residual socket", async () => {
		const path = tempPath();
		mkdirSync(dirname(path), { recursive: true });
		const child = Bun.spawn([process.execPath, "-e", `Bun.listen({unix:${JSON.stringify(path)},socket:{data(){}}});console.log("ready")`], { stdout: "pipe", stderr: "inherit" });
		cleanups.push(() => child.kill("SIGKILL"));
		const reader = child.stdout.getReader();
		const ready = await reader.read();
		expect(new TextDecoder().decode(ready.value)).toContain("ready");
		reader.releaseLock();
		child.kill("SIGKILL");
		await child.exited;
		expect(existsSync(path)).toBe(true);
		const claims = await Promise.allSettled([
			start(path, async () => ({ ok: true, result: "winner-0" })),
			start(path, async () => ({ ok: true, result: "winner-1" })),
		]);
		expect(claims.filter(claim => claim.status === "fulfilled")).toHaveLength(1);
		const rejected = claims.filter(claim => claim.status === "rejected");
		expect(rejected).toHaveLength(1);
		for (const claim of rejected) expect(claim.reason).toBeInstanceOf(ServiceRunning);
		const winner = claims.findIndex(claim => claim.status === "fulfilled");
		const c = await client(path);
		c.socket.write('{"id":"race","op":"runs","args":{}}\n');
		expect(await c.next()).toEqual({ id: "race", ok: true, result: `winner-${winner}` });
	});

	test("does not delete non-socket files", async () => {
		const path = tempPath().replace("/nested/service.sock", "/ordinary");
		writeFileSync(path, "keep");
		await expect(serveK1(path, { connected() {}, disconnected() {}, async handle() { return { ok: true, result: null }; } })).rejects.toThrow(`Refusing to remove a non-socket file: ${path}`);
		expect(readFileSync(path, "utf8")).toBe("keep");
	});
});

describe("revealService real Unix sockets", () => {
	test("sends reveal and returns revealed for an ok reply", async () => {
		const path = tempPath();
		const requests: Request[] = [];
		await start(path, async (_conn, _id, request) => {
			requests.push(request);
			return { ok: true, result: null };
		});

		expect(await revealService(path)).toEqual({ kind: "revealed" });
		expect(requests).toEqual([{ op: "reveal", args: {} }]);
	});

	test("returns failed with the code and message from a RevealFailed reply", async () => {
		const path = tempPath();
		await start(path, async () => ({
			ok: false,
			error: { code: "RevealFailed", message: "pane could not be focused" },
		}));

		expect(await revealService(path)).toEqual({
			kind: "failed",
			message: "RevealFailed: pane could not be focused",
		});
	});

	test("returns absent when no service listens on the path", async () => {
		expect(await revealService(tempPath())).toEqual({ kind: "absent" });
	});

	test("returns failed when the service closes without replying", async () => {
		const path = tempPath();
		await start(path, async conn => {
			conn.close();
			return { ok: true, result: null };
		});
		const previous = process.env.OMOMP_LANG;
		process.env.OMOMP_LANG = "en";
		try {
			expect(await revealService(path)).toEqual({
				kind: "failed",
				message: "Connection closed before a reply",
			});
		} finally {
			if (previous === undefined) delete process.env.OMOMP_LANG;
			else process.env.OMOMP_LANG = previous;
		}
	});
});
