// The pane endpoint of a main omp session: while the session lives, a document service can ask it to
// become a Playbook's coordinator (see `PaneRequest` in src/domain/protocol.ts). The endpoint belongs to
// this process; the host refuses a second listener on one that another live process answers on.
import { IpcServer, type IpcConnection } from "@oh-my-pi/pi-natives";
import type { PaneReply, PaneRequest } from "../domain/protocol";

export type PaneHandler = (request: PaneRequest) => Promise<PaneReply>;

export interface PaneListener {
	close(): void;
}

/** A request is one short JSON line; anything longer is not one. */
const MAX_REQUEST = 64 * 1024;

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

/** One request line, one reply line, then the session ends the connection. */
function answer(connection: IpcConnection, handle: PaneHandler): void {
	let answered = false;
	connection.start(
		line => {
			if (answered) return;
			answered = true;
			const request = parse(line);
			const reply: Promise<PaneReply> = request === null
				? Promise.resolve({ ok: false, error: { code: "BadRequest", message: "expected {op: ping} or {op: attach, doc}" } })
				: handle(request).catch((error: unknown) => ({ ok: false as const, error: { code: "Failed", message: error instanceof Error ? error.message : String(error) } }));
			void reply.then(result => { connection.send(JSON.stringify(result)); connection.end(); });
		},
		() => {},
	);
}

/** Listen at `endpoint` unless another live process already does; null then. */
export async function listenPane(endpoint: string, handle: PaneHandler): Promise<PaneListener | null> {
	let server: IpcServer;
	let closed = false;
	const connections = new Set<IpcConnection>();
	try {
		server = await IpcServer.listen(endpoint, { framing: "lines", maxFrameBytes: MAX_REQUEST }, connection => {
			// A connection accepted while the endpoint is closing has no later chance to be closed.
			if (closed) { connection.destroy(); return; }
			connections.add(connection);
			answer(connection, handle);
		});
	} catch (error) {
		// Another live process answers on this endpoint.
		if (typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE") return null;
		throw error;
	}
	return {
		close() {
			if (closed) return;
			closed = true;
			for (const connection of [...connections]) connection.destroy();
			void server.close();
		},
	};
}
