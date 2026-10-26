import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { ReadStream } from "node:tty";
import { createTspSession } from "../src/service/tsp.ts";
import type { FrameOp, TspEvent, TspInput, TspSession } from "../src/service/tsp-types.ts";

const ESC = "\x1b";
const ST = `${ESC}\\`;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

class FakeInput extends ReadStream {
	override isTTY = true as const;
	readonly rawChanges: boolean[] = [];
	constructor() { super(0); }
	override setRawMode(mode: boolean): this { this.rawChanges.push(mode); return this; }
	override resume(): this { return this; }
	feed(bytes: string | Buffer): void { this.emit("data", bytes); }
}

interface Harness {
	readonly input: FakeInput;
	readonly output: string[];
	readonly received: TspInput[];
	readonly session: TspSession;
}

function harness(): Harness {
	const input = new FakeInput();
	const output: string[] = [];
	const received: TspInput[] = [];
	const session = createTspSession(bytes => output.push(bytes), input);
	session.start("transport-test", value => received.push(value));
	session.open("form", "Transport test", ".button { color: red }");
	return { input, output, received, session };
}

const add: FrameOp = ["add", "a.card", "main", null, { id: "a.card", k: "card" }];

function event(input: FakeInput, body: unknown): void {
	input.feed(`${ESC}_tsp;e;${JSON.stringify(body)}${ST}`);
}

describe("TSP wire and input", () => {
	test("opens screen, sends stylesheet and blob before sequenced frames", () => {
		const { input, output, session } = harness();
		const bytes = Buffer.from("<svg/>");
		const id = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		session.blob(id, "image/svg+xml", bytes);
		expect(session.frame([add], ["a"])).toBe(1);
		expect(session.frame([["set", "a.card", { head: "Changed" }]], ["a"])).toBe(2);
		expect(output).toEqual([
			`${ESC}_tsp;q;{"q":"hello","v":[1],"app":"transport-test","features":["edit","undo"]}${ST}`,
			`${ESC}[c`,
			`${ESC}_tsp;o;{"id":"form","mode":"screen","title":"Transport test"}${ST}`,
			`${ESC}_tsp;s;{"sf":"form","name":"main","css":".button { color: red }"}${ST}`,
			`${ESC}_tsp;b;id=${id};mime=image/svg+xml;PHN2Zy8+${ST}`,
			`${ESC}_tsp;f;{"sf":"form","s":1,"ops":${JSON.stringify([add])}}${ST}`,
			`${ESC}_tsp;f;{"sf":"form","s":2,"ops":[["set","a.card",{"head":"Changed"}]]}${ST}`,
		]);
		expect(input.rawChanges).toEqual([true]);
		input.emit("end");
	});

	test("separates byte-fragmented APC and DA from ordinary UTF8 and escape keys", () => {
		const { input, received } = harness();
		const action: TspEvent = { ev: "action", mods: [], id: "a.button", act: "launch" };
		const wire = Buffer.from(`好${ESC}[A${ESC}_tsp;r;{"r":"hello","dark":false}${ST}x${ESC}[?62;4c${ESC}_tsp;e;${JSON.stringify(action)}${ST}尾${ESC}[200~paste${ESC}[201~`);
		for (const byte of wire) input.feed(Buffer.from([byte]));
		expect(received.filter(value => value.kind !== "keys")).toEqual([
			{ kind: "hello", dark: false }, { kind: "event", event: action },
		]);
		expect(received.flatMap(value => value.kind === "keys" ? [value.bytes] : []).join("")).toBe(`好${ESC}[Ax尾${ESC}[200~paste${ESC}[201~`);
		input.emit("end");
	});

	test("keeps ordinary escape key sequences together around protocol messages", () => {
		const { input, received } = harness();
		input.feed(`${ESC}[A${ESC}[200~paste${ESC}[201~${ESC}_tsp;e;{"ev":"undo","id":"a.body"}${ST}${ESC}[B`);
		expect(received).toEqual([
			{ kind: "keys", bytes: `${ESC}[A${ESC}[200~paste${ESC}[201~` },
			{ kind: "event", event: { ev: "undo", id: "a.body" } },
			{ kind: "keys", bytes: `${ESC}[B` },
		]);
		input.emit("end");
	});

	test("standalone Escape reaches key handler without waiting for more input", () => {
		const { input, received } = harness();
		input.feed(ESC);
		vi.advanceTimersByTime(25);
		expect(received).toEqual([{ kind: "keys", bytes: ESC }]);
		input.emit("end");
	});

	test("parses all contract events, retaining unknown and malformed payloads as other", () => {
		const { input, received } = harness();
		const bodies: readonly TspEvent[] = [
			{ ev: "ack", s: 1 }, { ev: "error", s: 1, op: 0, msg: "bad" },
			{ ev: "theme", dark: true }, { ev: "focus", id: "a.title" },
			{ ev: "action", mods: [], id: "a.button", act: "run" },
			{ ev: "change", id: "a.done", checked: false, value: "no", text: "text" },
			{ ev: "edit", id: "a.body", from: 0, to: 1, text: "好", cursor: 1, len: 2 },
			{ ev: "undo", id: "a.body" }, { ev: "toggle", id: "a.ref", collapsed: true, key: "ref" },
		];
		for (const body of bodies) event(input, body);
		const unknown = { ev: "resize", cols: 80 };
		const malformed = { ev: "edit", id: "a.body", from: "0" };
		event(input, unknown);
		event(input, malformed);
		input.feed(`${ESC}_tsp;e;not-json${ST}`);
		const expected: TspEvent[] = [
			...bodies, { ev: "other", body: unknown }, { ev: "other", body: malformed }, { ev: "other", body: "not-json" },
		];
		expect(received.flatMap(value => value.kind === "event" ? [value.event] : [])).toEqual(expected);
		input.emit("end");
	});

	test("chunks long UTF8 frames at the negotiated limit and preserves parameter-like text", () => {
		const { input, output, session } = harness();
		input.feed(`${ESC}_tsp;r;{"r":"hello","dark":true,"apc":32}${ST}`);
		const text = "好x=1;y".repeat(50);
		const ops: readonly FrameOp[] = [["set", "a.card", { text }]];
		const before = output.length;
		session.frame(ops, ["a"]);
		const chunks = output.slice(before);
		expect(chunks.length).toBeGreaterThan(1);
		let joined = "";
		for (const [i, chunk] of chunks.entries()) {
			const match = /^\x1b_tsp;f;c=(p\d+);(m=1;)?([\s\S]*)\x1b\\$/.exec(chunk);
			expect(match).not.toBeNull();
			const body = match![3]!;
			expect(Buffer.byteLength(body)).toBeLessThanOrEqual(32);
			expect(body).not.toContain("�");
			expect(body).not.toMatch(/^[A-Za-z0-9_-]+=[\x21-\x3a\x3c-\x7e]*;/);
			expect(Boolean(match![2])).toBe(i < chunks.length - 1);
			joined += body;
		}
		expect(JSON.parse(joined)).toEqual({ sf: "form", s: 1, ops });
		input.emit("end");
	});
});

describe("TSP render facts", () => {
	test("maps sole-block and indexed multi-block errors, ignores stale errors on replaced blocks", () => {
		const { input, session } = harness();
		const a = session.frame([add], ["a"]);
		event(input, { ev: "error", s: a, msg: "whole frame rejected" });
		expect(session.status("a").blockError).toBe(true);
		const both = session.frame([["set", "a.card", { head: "A" }], ["set", "b.card", { head: "B" }]], ["a", "b"]);
		expect(session.status("a").blockError).toBe(false);
		event(input, { ev: "error", s: a, op: 0 });
		expect(session.status("a").blockError).toBe(false);
		event(input, { ev: "error", s: both, op: 1 });
		expect(session.status("b").blockError).toBe(true);
		expect(session.status("a").blockError).toBe(false);
		expect(session.status("b").documentError).toBe(false);
		input.emit("end");
	});

	test("document errors require an acknowledged subsequent full redraw, not incremental ack", () => {
		const { input, session } = harness();
		const old = session.frame([add], ["a"]);
		event(input, { ev: "error", msg: "bad blob" });
		session.fullRedraw(old);
		event(input, { ev: "ack", s: old });
		expect(session.status("a").documentError).toBe(true);
		const incremental = session.frame([["set", "a.card", { head: "A" }]], ["a"]);
		event(input, { ev: "ack", s: incremental });
		expect(session.status("a").documentError).toBe(true);
		const redraw = session.frame([add], ["a"]);
		session.fullRedraw(redraw);
		expect(session.status("a").documentError).toBe(true);
		event(input, { ev: "ack", s: redraw });
		expect(session.status("a").documentError).toBe(false);
		const mixed = session.frame([["set", "main", { head: "document" }]], ["a", "b"]);
		event(input, { ev: "error", s: mixed, op: 0 });
		expect(session.status("a").documentError).toBe(true);
		expect(session.status("b").documentError).toBe(true);
		input.emit("end");
	});

	test("a later document error invalidates an in-flight redraw as recovery", () => {
		const { input, session } = harness();
		session.frame([add], ["a"]);
		event(input, { ev: "error", msg: "first" });
		const redraw = session.frame([add], ["a"]);
		session.fullRedraw(redraw);
		event(input, { ev: "error", msg: "later" });
		event(input, { ev: "ack", s: redraw });
		expect(session.status("a").documentError).toBe(true);
		input.emit("end");
	});

	test("overdue notification uses latest block frame and cumulative acknowledgements", () => {
		const { input, session } = harness();
		const changes: string[][] = [];
		session.onStatusChange(blocks => changes.push([...blocks]));
		session.frame([add], ["a"]);
		session.frame([["set", "b.card", { head: "B" }]], ["b"]);
		vi.advanceTimersByTime(1_100);
		const latest = session.frame([["set", "a.card", { head: "A" }]], ["a"]);
		expect(session.status("a").pendingOverdue).toBe(false);
		changes.length = 0;
		vi.advanceTimersByTime(899);
		expect(session.status("b").pendingOverdue).toBe(false);
		expect(changes).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(session.status("a").pendingOverdue).toBe(false);
		expect(session.status("b").pendingOverdue).toBe(true);
		expect(changes).toEqual([["b"]]);
		vi.advanceTimersByTime(1_099);
		expect(session.status("a").pendingOverdue).toBe(false);
		vi.advanceTimersByTime(1);
		expect(session.status("a").pendingOverdue).toBe(true);
		expect(changes).toEqual([["b"], ["a"]]);
		event(input, { ev: "ack", s: latest });
		expect(session.status("a").pendingOverdue).toBe(false);
		expect(session.status("b").pendingOverdue).toBe(false);
		expect(changes.at(-1)).toEqual(["a", "b"]);
		input.emit("end");
	});
});
