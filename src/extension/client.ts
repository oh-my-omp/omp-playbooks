import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { tr } from "../i18n";
import type { EventPayload, ProtocolError, Request, ServerFrame } from "../domain/protocol";

export type ClientError = ProtocolError | { readonly code: "NoService" | "Disconnected" | "StartFailed"; readonly message: string };
export type Reply = { readonly id: string; readonly ok: true; readonly result: unknown } | { readonly id: string; readonly ok: false; readonly error: ClientError };
type Pending = { readonly resolve: (reply: Reply) => void };
type Link = { readonly socket: Socket; readonly pending: Map<string, Pending> };
type State = { readonly kind: "disconnected" } | { readonly kind: "connecting"; readonly link: Link; readonly ready: Promise<Reply> } | { readonly kind: "connected"; readonly link: Link; readonly hello: unknown } | { readonly kind: "closed" };

/** One document connection. Requests are never replayed across transports. */
export class K1Client {
	private state: State = { kind: "disconnected" };
	private reconnect: NodeJS.Timeout | undefined;
	constructor(
		readonly path: string,
		private readonly helloArgs: Extract<Request, { op: "hello" }>["args"],
		private readonly parseFrame: (input: unknown) => ServerFrame,
		private readonly onEvent: (event: EventPayload) => void | Promise<void>,
		/** Runs each time the service accepts this session's hello. */
		private readonly onConnected: () => void,
	) {}

	get connected(): boolean { return this.state.kind === "connected"; }
	get hello(): unknown { return this.state.kind === "connected" ? this.state.hello : undefined; }

	async connect(): Promise<Reply> {
		switch (this.state.kind) {
			case "closed": return this.failure("", "Disconnected");
			case "connected": return { id: "", ok: true, result: this.state.hello };
			case "connecting": return this.state.ready;
			case "disconnected": break;
		}
		if (this.reconnect !== undefined) { clearTimeout(this.reconnect); this.reconnect = undefined; }
		const socket = createConnection(this.path);
		const link: Link = { socket, pending: new Map() };
		const ready = Promise.withResolvers<Reply>();
		this.state = { kind: "connecting", link, ready: ready.promise };
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("connect", async () => {
			const reply = await this.sendOn(link, { op: "hello", args: this.helloArgs });
			if (this.owns(link) && reply.ok) { this.state = { kind: "connected", link, hello: reply.result }; this.onConnected(); }
			else if (this.owns(link)) socket.destroy();
			ready.resolve(!reply.ok && reply.error.code === "Disconnected" ? this.failure("", "NoService") : reply);
		});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			for (;;) {
				const end = buffer.indexOf("\n");
				if (end < 0) break;
				const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
				try {
					const frame = this.parseFrame(JSON.parse(line));
					if ("event" in frame) {
						void this.deliver(link, frame).catch(() => socket.destroy());
					} else {
						const pending = link.pending.get(frame.id);
						if (pending) { link.pending.delete(frame.id); pending.resolve(frame); }
					}
				} catch { socket.destroy(); break; }
			}
		});
		const disconnect = () => {
			for (const [id, item] of link.pending) item.resolve(this.failure(id, "Disconnected"));
			link.pending.clear();
			ready.resolve(this.failure("", "NoService"));
			if (!this.owns(link)) return;
			this.state = { kind: "disconnected" };
			this.scheduleReconnect();
		};
		socket.on("error", disconnect);
		socket.on("close", disconnect);
		return ready.promise;
	}

	async request(request: Request, id = randomUUID()): Promise<Reply> {
		const ready = await this.connect();
		if (!ready.ok) return { ...ready, id };
		if (this.state.kind !== "connected") return this.failure(id, "Disconnected");
		return this.sendOn(this.state.link, request, id);
	}

	close(): void {
		if (this.reconnect !== undefined) { clearTimeout(this.reconnect); this.reconnect = undefined; }
		const state = this.state;
		this.state = { kind: "closed" };
		if (state.kind === "connecting" || state.kind === "connected") state.link.socket.destroy();
	}

	private owns(link: Link): boolean {
		return (this.state.kind === "connecting" || this.state.kind === "connected") && this.state.link === link;
	}
	private failure(id: string, code: "NoService" | "Disconnected"): Reply {
		return { id, ok: false, error: { code, message: code === "NoService" ? tr("No Playbook document service is listening at this socket", "此 socket 没有 Playbook 文档服务在监听") : tr("Connection ended before a response; the operation may have been applied", "连接在收到响应前结束；操作可能已经应用") } };
	}
	private sendOn(link: Link, request: Request, id = randomUUID()): Promise<Reply> {
		if (!this.owns(link) || link.socket.destroyed) return Promise.resolve(this.failure(id, "Disconnected"));
		const pending = Promise.withResolvers<Reply>();
		link.pending.set(id, { resolve: pending.resolve });
		link.socket.write(JSON.stringify({ id, op: request.op, args: request.args }) + "\n");
		return pending.promise;
	}
	private async deliver(link: Link, event: EventPayload): Promise<void> {
		await this.onEvent(event);
		if (event.event === "block_changed" && this.owns(link)) {
			await this.sendOn(link, { op: "ack", args: { event: event.data.id } });
		}
	}
	private scheduleReconnect(): void {
		if (this.reconnect !== undefined || this.state.kind === "closed") return;
		this.reconnect = setTimeout(() => { this.reconnect = undefined; void this.connect(); }, 2_000);
		this.reconnect.unref();
	}
}
