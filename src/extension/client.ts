import { randomUUID } from "node:crypto";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { tr } from "../i18n";
import type { EventPayload, ProtocolError, Request, ServerFrame } from "../domain/protocol";

export type ClientError = ProtocolError | { readonly code: "NoService" | "Disconnected" | "StartFailed"; readonly message: string };
export type Reply = { readonly id: string; readonly ok: true; readonly result: unknown; readonly raw?: string } | { readonly id: string; readonly ok: false; readonly error: ClientError };
type Pending = { readonly resolve: (reply: Reply) => void };
type Deferred = { readonly promise: Promise<Reply>; readonly resolve: (reply: Reply) => void };
type Link = { readonly connection: IpcConnection; readonly ready: Deferred; readonly pending: Map<string, Pending>; dead: boolean };
type State =
	| { readonly kind: "disconnected" }
	/** Dialing the endpoint; no connection exists yet. */
	| { readonly kind: "dialing"; readonly ready: Deferred }
	/** Connected, hello in flight. */
	| { readonly kind: "connecting"; readonly link: Link }
	| { readonly kind: "connected"; readonly link: Link; readonly hello: unknown }
	| { readonly kind: "closed" };

/**
 * The `result` field's already-serialized text inside an ok-reply line, or undefined when the line
 * is not in the deterministic shape `{"id":<id>,"ok":true,"result":<result>}` the service writes.
 */
function rawResult(line: string, id: string): string | undefined {
	const prefix = `{"id":${JSON.stringify(id)},"ok":true,"result":`;
	return line.startsWith(prefix) && line.endsWith("}") ? line.slice(prefix.length, -1) : undefined;
}

/** One document connection. Requests are never replayed across transports. */
export class K1Client {
	private state: State = { kind: "disconnected" };
	private reconnect: NodeJS.Timeout | undefined;
	constructor(
		readonly endpoint: string,
		private readonly helloArgs: Extract<Request, { op: "hello" }>["args"],
		private readonly parseFrame: (input: unknown) => ServerFrame,
		private readonly onEvent: (event: EventPayload) => void | Promise<void>,
	) {}

	get connected(): boolean { return this.state.kind === "connected"; }
	get hello(): unknown { return this.state.kind === "connected" ? this.state.hello : undefined; }

	async connect(): Promise<Reply> {
		switch (this.state.kind) {
			case "closed": return this.failure("", "Disconnected");
			case "connected": return { id: "", ok: true, result: this.state.hello };
			case "dialing": return this.state.ready.promise;
			case "connecting": return this.state.link.ready.promise;
			case "disconnected": break;
		}
		if (this.reconnect !== undefined) { clearTimeout(this.reconnect); this.reconnect = undefined; }
		const ready: Deferred = Promise.withResolvers<Reply>();
		this.state = { kind: "dialing", ready };
		let connection: IpcConnection;
		try {
			connection = await IpcConnection.connect(this.endpoint, { framing: "lines" });
		} catch {
			// No endpoint, or nobody listening on it: the same answer as a connection that ended first.
			if (this.state.kind === "dialing" && this.state.ready === ready) {
				this.state = { kind: "disconnected" };
				this.scheduleReconnect();
			}
			ready.resolve(this.failure("", "NoService"));
			return ready.promise;
		}
		const link: Link = { connection, ready, pending: new Map(), dead: false };
		// close() ran while this dial was in flight: this connection is nobody's now.
		const state = this.state as State;
		if (state.kind !== "dialing" || state.ready !== ready) {
			connection.destroy();
			ready.resolve(this.failure("", state.kind === "closed" ? "Disconnected" : "NoService"));
			return ready.promise;
		}
		this.state = { kind: "connecting", link };
		connection.start(line => this.receive(link, line), () => this.disconnect(link));
		const reply = await this.sendOn(link, { op: "hello", args: this.helloArgs });
		if (this.owns(link) && reply.ok) this.state = { kind: "connected", link, hello: reply.result };
		else if (this.owns(link)) connection.destroy();
		ready.resolve(!reply.ok && reply.error.code === "Disconnected" ? this.failure("", "NoService") : reply);
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
		if (state.kind === "connecting" || state.kind === "connected") state.link.connection.destroy();
		if (state.kind === "dialing") state.ready.resolve(this.failure("", "Disconnected"));
	}

	private owns(link: Link): boolean {
		return (this.state.kind === "connecting" || this.state.kind === "connected") && this.state.link === link;
	}
	private failure(id: string, code: "NoService" | "Disconnected"): Reply {
		return { id, ok: false, error: { code, message: code === "NoService" ? tr("No Playbook document service is listening at this endpoint", "此端点没有 Playbook 文档服务在监听") : tr("Connection ended before a response; the operation may have been applied", "连接在收到响应前结束；操作可能已经应用") } };
	}
	/** Frames arrive in order; a frame the parser rejects ends the connection like any other framing error. */
	private receive(link: Link, line: string): void {
		if (link.dead) return;
		try {
			const frame = this.parseFrame(JSON.parse(line));
			if ("event" in frame) {
				void this.deliver(link, frame).catch(() => link.connection.destroy());
				return;
			}
			const pending = link.pending.get(frame.id);
			if (pending) { link.pending.delete(frame.id); pending.resolve(frame.ok ? { ...frame, raw: rawResult(line, frame.id) } : frame); }
		} catch {
			link.dead = true;
			link.connection.destroy();
		}
	}
	private disconnect(link: Link): void {
		for (const [id, item] of link.pending) item.resolve(this.failure(id, "Disconnected"));
		link.pending.clear();
		link.ready.resolve(this.failure("", "NoService"));
		if (!this.owns(link)) return;
		this.state = { kind: "disconnected" };
		this.scheduleReconnect();
	}
	private sendOn(link: Link, request: Request, id = randomUUID()): Promise<Reply> {
		if (!this.owns(link) || link.connection.closed) return Promise.resolve(this.failure(id, "Disconnected"));
		const pending = Promise.withResolvers<Reply>();
		link.pending.set(id, { resolve: pending.resolve });
		link.connection.send(JSON.stringify({ id, op: request.op, args: request.args }));
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
