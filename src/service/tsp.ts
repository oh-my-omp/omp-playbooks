import { StringDecoder } from "node:string_decoder";
import type { FrameOp, FrameStatus, TspEvent, TspInput, TspSession } from "./tsp-types.ts";

const ESC = "\x1b";
const APC = `${ESC}_tsp;`;
const ST = `${ESC}\\`;
const OVERDUE_MS = 2_000;

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function index(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Unknown and malformed events remain observable, but never become trusted domain events. */
function parseEvent(body: unknown): TspEvent {
	const event = record(body);
	if (event) {
		const id = event.id;
		switch (event.ev) {
			case "ack":
				if (index(event.s)) return { ev: "ack", s: event.s };
				break;
			case "error":
				if ((event.s === undefined || index(event.s)) && (event.op === undefined || index(event.op)) && (event.msg === undefined || typeof event.msg === "string")) {
					return { ev: "error", s: event.s, op: event.op, msg: event.msg };
				}
				break;
			case "theme":
				if (typeof event.dark === "boolean") return { ev: "theme", dark: event.dark };
				break;
			case "focus":
			case "undo":
				if (typeof id === "string") return { ev: event.ev, id };
				break;
			case "action": {
				// `mods` lists held modifiers (`shift`, `ctrl`, `alt`, `meta`) and is absent when none is.
				const mods = event.mods === undefined ? [] : Array.isArray(event.mods) ? event.mods.filter((mod): mod is string => typeof mod === "string") : null;
				if (typeof id === "string" && typeof event.act === "string" && mods !== null) return { ev: "action", id, act: event.act, mods };
				break;
			}
			case "change":
				if (typeof id === "string" && (event.checked === undefined || typeof event.checked === "boolean") && (event.value === undefined || typeof event.value === "string") && (event.text === undefined || typeof event.text === "string")) {
					return { ev: "change", id, checked: event.checked, value: event.value, text: event.text };
				}
				break;
			case "edit":
				if (typeof id === "string" && index(event.from) && index(event.to) && event.from <= event.to && typeof event.text === "string" && index(event.cursor) && index(event.len)) {
					return { ev: "edit", id, from: event.from, to: event.to, text: event.text, cursor: event.cursor, len: event.len };
				}
				break;
			case "toggle":
				if (typeof id === "string" && typeof event.collapsed === "boolean" && (event.key === undefined || typeof event.key === "string")) {
					return { ev: "toggle", id, collapsed: event.collapsed, key: event.key };
				}
				break;
		}
	}
	return { ev: "other", body };
}

interface SentFrame {
	readonly blocks: readonly string[];
	readonly operations: readonly (string | undefined)[];
}

interface BlockRender {
	readonly sequence: number;
	readonly sent: number;
	blockError: boolean;
	timer: NodeJS.Timeout | undefined;
}

function operationBlock(op: FrameOp, blocks: readonly string[]): string | undefined {
	const id = op[1];
	if (id === null) return undefined;
	const matches = blocks.filter(block => id.startsWith(`${block}.`));
	return matches.length === 1 ? matches[0] : undefined;
}

export function createTspSession(out: (s: string) => void = s => { process.stdout.write(s); }, input: NodeJS.ReadStream = process.stdin): TspSession {
	let surface: string | undefined;
	let sequence = 0;
	let acknowledged = 0;
	let apcLimit = 65_536;
	let chunkSequence = 0;
	let documentError = false;
	let documentErrorAfter = 0;
	let redrawToClear: number | undefined;
	let onInput: ((input: TspInput) => void) | undefined;
	const frames = new Map<number, SentFrame>();
	const renders = new Map<string, BlockRender>();
	const listeners: ((blocks: readonly string[]) => void)[] = [];
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	let escapeTimer: NodeJS.Timeout | undefined;

	function notify(blocks: readonly string[]): void {
		for (const listener of listeners) listener(blocks);
	}

	function send(verb: string, body: string, parameters = ""): void {
		const bytes = Buffer.from(body);
		if (bytes.length <= apcLimit) {
			out(`${APC}${verb};${parameters}${body}${ST}`);
			return;
		}
		const chunk = `p${++chunkSequence}`;
		let start = 0;
		while (start < bytes.length) {
			let end = Math.min(start + apcLimit, bytes.length);
			while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
			let part = bytes.subarray(start, end).toString("utf8");
			// A chunk starting with a parameter-shaped segment must end before its semicolon.
			// With no following semicolon Tern correctly treats that segment as body text.
			const parameter = /^[A-Za-z0-9_-]+=[\x21-\x3a\x3c-\x7e]*;/.exec(part);
			if (parameter) {
				end = start + Buffer.byteLength(parameter[0]) - 1;
				part = bytes.subarray(start, end).toString("utf8");
			}
			out(`${APC}${verb};c=${chunk};${end < bytes.length ? "m=1;" : ""}${start === 0 ? parameters : ""}${part}${ST}`);
			start = end;
		}
	}

	function json(verb: string, body: unknown): void {
		send(verb, JSON.stringify(body));
	}

	function applyEvent(event: TspEvent): void {
		switch (event.ev) {
			case "ack": {
				acknowledged = Math.max(acknowledged, event.s);
				const affected = new Set<string>();
				for (const [s, frame] of frames) if (s <= event.s) for (const block of frame.blocks) affected.add(block);
				for (const render of renders.values()) {
					if (render.sequence <= acknowledged && render.timer) {
						clearTimeout(render.timer);
						render.timer = undefined;
					}
				}
				if (documentError && redrawToClear !== undefined && redrawToClear <= acknowledged) {
					documentError = false;
					redrawToClear = undefined;
					for (const block of renders.keys()) affected.add(block);
				}
				notify([...affected]);
				break;
			}
			case "error": {
				const frame = event.s === undefined ? undefined : frames.get(event.s);
				const block = frame?.blocks.length === 1 ? frame.blocks[0] : event.op === undefined ? undefined : frame?.operations[event.op];
				if (block !== undefined && event.s !== undefined) {
					const render = renders.get(block);
					if (render && event.s >= render.sequence) {
						render.blockError = true;
						notify([block]);
					}
				} else {
					documentError = true;
					documentErrorAfter = sequence;
					redrawToClear = undefined;
					notify([...renders.keys()]);
				}
				break;
			}
			case "other": case "theme": case "focus": case "action": case "change": case "edit": case "undo": case "toggle":
				break;
		}
	}

	function message(wire: string): void {
		const verb = wire.slice(0, 1);
		const text = wire.slice(2);
		let body: unknown;
		try { body = JSON.parse(text); } catch { body = text; }
		const reply = record(body);
		if (verb === "r" && reply?.r === "hello" && typeof reply.dark === "boolean") {
			if (index(reply.apc) && reply.apc >= 4) apcLimit = reply.apc;
			onInput?.({ kind: "hello", dark: reply.dark });
		} else {
			const event = verb === "e" ? parseEvent(body) : { ev: "other" as const, body };
			applyEvent(event);
			onInput?.({ kind: "event", event });
		}
	}

	function keys(bytes: string): void {
		if (bytes) onInput?.({ kind: "keys", bytes });
	}

	function parseInput(): void {
		clearTimeout(escapeTimer);
		escapeTimer = undefined;
		let keyBytes = "";
		while (buffer) {
			const escape = buffer.indexOf(ESC);
			if (escape < 0) { keyBytes += buffer; buffer = ""; break; }
			if (escape > 0) { keyBytes += buffer.slice(0, escape); buffer = buffer.slice(escape); }
			if (buffer.startsWith(APC)) {
				const end = buffer.indexOf(ST, APC.length);
				keys(keyBytes);
				keyBytes = "";
				if (end < 0) return;
				const wire = buffer.slice(APC.length, end);
				buffer = buffer.slice(end + ST.length);
				message(wire);
				continue;
			}
			const da = /^\x1b\[\?[0-9;:]*c/.exec(buffer);
			if (da) { buffer = buffer.slice(da[0].length); continue; }
			if (APC.startsWith(buffer) || `${ESC}[?`.startsWith(buffer) || /^\x1b\[\?[0-9;:]*$/.test(buffer)) {
				keys(keyBytes);
				// ESC is also a standalone key; only its ambiguous prefix gets a short delay.
				if (buffer === ESC || buffer === `${ESC}[`) {
					escapeTimer = setTimeout(() => { const bytes = buffer; buffer = ""; escapeTimer = undefined; keys(bytes); }, 25);
					escapeTimer.unref();
				}
				return;
			}
			keyBytes += ESC;
			buffer = buffer.slice(1);
		}
		keys(keyBytes);
	}

	return {
		start(app, listener) {
			if (onInput) throw new Error("TSP session already started");
			onInput = listener;
			if (input.isTTY) input.setRawMode(true);
			input.on("data", (chunk: Buffer | string) => { buffer += typeof chunk === "string" ? chunk : decoder.write(chunk); parseInput(); });
			input.on("end", () => {
				buffer += decoder.end();
				parseInput();
				clearTimeout(escapeTimer);
				escapeTimer = undefined;
				if (!buffer.startsWith(APC) && !buffer.startsWith(`${ESC}[?`)) keys(buffer);
				buffer = "";
				for (const render of renders.values()) clearTimeout(render.timer);
			});
			input.resume();
			json("q", { q: "hello", v: [1], app, features: ["edit", "undo"] });
			out(`${ESC}[c`);
		},
		open(id, title, css) {
			surface = id;
			json("o", { id, mode: "screen", title });
			json("s", { sf: id, name: "main", css });
		},
		blob(id, mime, bytes) {
			send("b", Buffer.from(bytes).toString("base64"), `id=${id};mime=${mime};`);
		},
		frame(ops, blocks) {
			if (surface === undefined) throw new Error("Open a TSP surface before sending frames");
			const s = ++sequence;
			const frameBlocks = [...new Set(blocks)];
			frames.set(s, { blocks: frameBlocks, operations: ops.map(op => operationBlock(op, frameBlocks)) });
			for (const block of frameBlocks) {
				const previous = renders.get(block);
				clearTimeout(previous?.timer);
				const render: BlockRender = { sequence: s, sent: Date.now(), blockError: false, timer: undefined };
				renders.set(block, render);
				render.timer = setTimeout(() => {
					render.timer = undefined;
					if (s > acknowledged && renders.get(block) === render) notify([block]);
				}, OVERDUE_MS);
				render.timer.unref();
			}
			json("f", { sf: surface, s, ops });
			notify(frameBlocks);
			return s;
		},
		status(block): FrameStatus {
			const render = renders.get(block);
			return { blockError: render?.blockError ?? false, documentError, pendingOverdue: render !== undefined && render.sequence > acknowledged && Date.now() - render.sent >= OVERDUE_MS };
		},
		fullRedraw(s) {
			if (documentError && s > documentErrorAfter && frames.has(s)) {
				redrawToClear = s;
				if (s <= acknowledged) {
					documentError = false;
					redrawToClear = undefined;
					notify([...renders.keys()]);
				}
			}
		},
		onStatusChange(listener) { listeners.push(listener); },
	};
}
