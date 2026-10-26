// The pane socket of a main omp session: while the session lives, a document service can ask it to become
// a Playbook's coordinator (see `PaneRequest` in src/domain/protocol.ts). The socket belongs to this
// process; a path another live process answers on is never taken over.
import { mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { PaneReply, PaneRequest } from "../domain/protocol";

export type PaneHandler = (request: PaneRequest) => Promise<PaneReply>;

export interface PaneListener {
	close(): void;
}

const PROBE_MS = 500;
/** A request is one short JSON line; anything longer is not one. */
const MAX_REQUEST = 64 * 1024;
/** Whether some live process accepts connections at `path`. */
async function answers(path: string): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const timer = setTimeout(() => resolve(false), PROBE_MS);
	Bun.connect({
		unix: path,
		socket: { open(socket) { clearTimeout(timer); socket.end(); resolve(true); }, data() {}, error() {}, close() {} },
	}).catch(() => { clearTimeout(timer); resolve(false); });
	return promise;
}

function parse(line: string): PaneRequest | null {
	try {
		const value: unknown = JSON.parse(line);
		if (typeof value !== "object" || value === null || !("op" in value)) return null;
		if (value.op === "ping") return { op: "ping" };
		if (value.op === "attach" && "doc" in value && typeof value.doc === "string" && value.doc) return { op: "attach", doc: value.doc };
		return null;
	} catch {
		return null;
	}
}

/** Listen at `path` unless another live process already does; null then. */
export async function listenPane(path: string, handle: PaneHandler): Promise<PaneListener | null> {
	if (await answers(path)) return null;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	try { unlinkSync(path); } catch { /* no stale file */ }
	const buffers = new WeakMap<object, string>();
	const server = Bun.listen({
		unix: path,
		socket: {
			data(socket, chunk) {
				const text = (buffers.get(socket) ?? "") + new TextDecoder().decode(chunk);
				const end = text.indexOf("\n");
				if (end < 0) {
					if (text.length > MAX_REQUEST) { buffers.delete(socket); socket.end(); return; }
					buffers.set(socket, text);
					return;
				}
				buffers.delete(socket);
				const request = parse(text.slice(0, end));
				const reply: Promise<PaneReply> = request === null
					? Promise.resolve({ ok: false, error: { code: "BadRequest", message: "expected {op: ping} or {op: attach, doc}" } })
					: handle(request).catch((error: unknown) => ({ ok: false as const, error: { code: "Failed", message: error instanceof Error ? error.message : String(error) } }));
				void reply.then(answer => { socket.write(`${JSON.stringify(answer)}\n`); socket.end(); });
			},
			error() {},
		},
	});
	return {
		close() {
			server.stop(true);
			try { unlinkSync(path); } catch { /* already gone */ }
		},
	};
}
