import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { z as zod } from "@oh-my-pi/omptype/zod";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionCompactingEvent,
	SessionCompactingResult,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import { IpcConnection, IpcServer } from "@oh-my-pi/pi-natives";
import {
	type CompactExtensionAPI,
	type CompactPluginContext,
	getSharedCompactCoordinator,
	isCompacting,
	releaseCompactionBarrier,
} from "../omomp-shared/compact-handoff";
import { documentEndpoint, type EventPayload, paneEndpoint, type Request } from "../src/domain/protocol";
import extension, { createPlaybookCompactHandoff } from "../src/extension/index";
import { formatPlaybookUrl } from "../src/extension/playbook-url";

type Cleanup = () => void | Promise<void>;
const cleanup: Cleanup[] = [];

let originalTernPane: string | undefined;
let pane: string;

beforeEach(() => {
	originalTernPane = process.env.TERN_PANE;
	pane = String(800_000_000 + Math.floor(Math.random() * 99_999_999));
	process.env.TERN_PANE = pane;
});

afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
	if (originalTernPane === undefined) delete process.env.TERN_PANE;
	else process.env.TERN_PANE = originalTernPane;
});

async function temporaryDirectory(): Promise<string> {
	const dir = await mkdtemp("/tmp/pb-compact-");
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function makeCompactContext(cwd = "/tmp"): CompactPluginContext {
	return { cwd, branchEntries: [], messagesToSummarize: [] };
}

type Frame = Request & { readonly id: string };

async function mockPlaybookService() {
	const dir = await temporaryDirectory();
	const doc = `${dir}/book.yaml`;
	await Bun.write(doc, "title: Book\nblocks: []\n");
	const realDoc = await realpath(doc);
	const endpoint = documentEndpoint(realDoc);
	const connections: IpcConnection[] = [];
	const server = await IpcServer.listen(endpoint, { framing: "lines" }, (connection) => {
		connections.push(connection);
		connection.start(
			(line) => {
				const frame = JSON.parse(line) as Frame;
				const result =
					frame.op === "hello"
						? { blocks: ["b1"], runs: [], pane: "doc-pane" }
						: frame.op === "read"
							? { title: "Book", blocks: [{ id: "b1", kind: "task", title: "Task", body: "Do it", status: "todo" }] }
							: undefined;
				connection.send(JSON.stringify({ id: frame.id, ok: true, result }));
			},
			() => {},
		);
	});
	cleanup.push(async () => {
		for (const conn of connections) conn.destroy();
		await server.close();
	});
	return {
		doc: realDoc,
		push(payload: EventPayload) {
			connections.at(-1)?.send(JSON.stringify(payload));
		},
	};
}

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

async function extensionHarness() {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, EventHandler[]>();
	const messages: { message: { customType: string; content: string; display: boolean }; options: unknown }[] = [];
	const waiters: (() => void)[] = [];

	const ctx = {
		cwd: "/tmp",
		agent: { kind: "main" },
		model: undefined,
		sessionManager: {
			getSessionId: () => "session-compact-test",
			getBranch: () => [],
			getEntries: () => [],
			getLeafId: () => null,
		},
		isIdle: () => true,
		ui: {
			notify: () => {},
			select: async () => undefined,
		},
	} as unknown as ExtensionContext;

	const api = {
		zod,
		registerTool: (tool: ToolDefinition) => {
			tools.set(tool.name, tool);
		},
		getAllTools: () => [...tools.keys()].map((name) => ({ name, sourceInfo: { source: "extension" } })),
		on: (event: string, handler: EventHandler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: () => {},
		sendMessage: (message: { customType: string; content: string; display: boolean }, options: unknown) => {
			messages.push({ message, options });
			for (const resolve of waiters.splice(0)) resolve();
		},
	} as unknown as ExtensionAPI;

	await extension(api);

	async function emit(name: string, payload: unknown = {}): Promise<unknown> {
		let last: unknown;
		for (const handler of handlers.get(name) ?? []) {
			const out = await handler(payload, ctx);
			if (out !== undefined) last = out;
		}
		return last;
	}

	cleanup.push(async () => {
		await emit("session_shutdown");
	});

	await emit("session_start");

	return {
		ctx,
		messages,
		emit,
		nextMessage(): Promise<void> {
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push(resolve);
			return promise;
		},
		execute(name: string, params: unknown) {
			return tools.get(name)!.execute("tool-1", params as never, undefined, undefined, ctx);
		},
	};
}

describe("omp-playbooks compact handoff", () => {
	test("createPlaybookCompactHandoff returns null when 0 Playbooks are connected (silent gating)", () => {
		const handoff = createPlaybookCompactHandoff(() => []);
		expect(handoff.pluginId).toBe("omp-playbooks");
		expect(handoff.captureState(makeCompactContext())).toBeNull();

		const coordinator = getSharedCompactCoordinator();
		coordinator.resetForTest();
		coordinator.register(handoff);
		const prepared = coordinator.prepareSnapshot(makeCompactContext(), {
			totalInputPaths: 0,
			strippedQueryCount: 0,
			filteredNoiseCount: 0,
			keptUniqueCandidateCount: 0,
			selectedCount: 0,
			repoSourcePathsSelected: [],
			selectedPaths: [],
		});
		expect(prepared.activeHandoffs).toEqual([]);
		expect(prepared.inactiveStatefulPluginIds).toEqual(["omp-playbooks"]);
		expect(prepared.compactingResult.context?.join("\n")).not.toContain("omp-playbooks");
	});

	test("createPlaybookCompactHandoff emits harness-provided claim and delta-stream injection when Playbooks are connected", async () => {
		const docs = ["/workspace/a/deploy.yaml", "/workspace/b/deploy.yaml"];
		const handoff = createPlaybookCompactHandoff(() => docs);
		const state = handoff.captureState(makeCompactContext());
		expect(state).toEqual({ docs });

		const claim = handoff.renderCompactPromptClaim(state!);
		expect(claim).toContain("omp-playbooks");
		expect(claim).toContain('source="omp-playbooks/active-runs"');
		expect(claim).toContain("playbook://");

		const injection = handoff.renderPostCompactInjection(state!);
		expect(injection.source).toBe("omp-playbooks/active-runs");
		expect(injection.delivery).toBe("delta-stream");
		for (const doc of docs) {
			expect(injection.content).toContain(doc);
			expect(injection.content).toContain(formatPlaybookUrl(doc, docs));
		}

		const coordinator = getSharedCompactCoordinator();
		coordinator.resetForTest();
		const hostHandlers = new Map<string, EventHandler[]>();
		const hostPi: CompactExtensionAPI = {
			on(event: string, handler: unknown) {
				const list = hostHandlers.get(event) ?? [];
				list.push(handler as EventHandler);
				hostHandlers.set(event, list);
			},
		};
		coordinator.register(handoff);
		coordinator.attachToHost(hostPi);

		const ctx = {
			cwd: "/workspace",
			model: undefined,
			sessionManager: {
				getEntries: () => [],
				getLeafId: () => null,
			},
		} as unknown as ExtensionContext;

		const emitHost = async (name: string, event: unknown) => {
			let result: unknown;
			for (const h of hostHandlers.get(name) ?? []) {
				const r = await h(event, ctx);
				if (r !== undefined) result = r;
			}
			return result;
		};

		await emitHost("session_before_compact", {
			preparation: {
				messagesToSummarize: [],
				turnPrefixMessages: [],
				fileOps: { read: new Set(), edited: new Set(), written: new Set() },
			},
			branchEntries: [],
		} as unknown as SessionBeforeCompactEvent);
		expect(coordinator.isCompacting(ctx.sessionManager)).toBe(true);

		const compacting = (await emitHost("session.compacting", {
			sessionId: "s1",
			messages: [],
		} satisfies Partial<SessionCompactingEvent>)) as SessionCompactingResult;
		expect(compacting.context?.join("\n")).toContain("harness-provided [omp-playbooks]");
		expect(compacting.context?.join("\n")).toContain('source="omp-playbooks/active-runs"');

		await emitHost("session_compact", {
			compactionEntry: { id: "c1" },
		} as Partial<SessionCompactEvent>);
		expect(coordinator.isCompacting(ctx.sessionManager)).toBe(false);

		const start = (await emitHost("before_agent_start", {})) as { message?: { customType: string; content: string } } | undefined;
		expect(start?.message?.customType).toBe("omomp.shared.compact-handoff");
		expect(start?.message?.content).toContain('<system-reminder source="omp-playbooks/active-runs">');
		for (const doc of docs) {
			expect(start?.message?.content).toContain(doc);
			expect(start?.message?.content).toContain(formatPlaybookUrl(doc, docs));
		}
	});

	test("compaction barrier suppresses launch playbook-event delivery during compaction and flushes on releaseCompactionBarrier", async () => {
		const service = await mockPlaybookService();
		const h = await extensionHarness();
		await h.execute("playbook_open", { doc: service.doc });

		await h.emit("session_before_compact", {
			preparation: {
				messagesToSummarize: [],
				turnPrefixMessages: [],
				fileOps: { read: new Set(), edited: new Set(), written: new Set() },
			},
			branchEntries: [],
		});
		expect(isCompacting(h.ctx.sessionManager)).toBe(true);

		const compacting = (await h.emit("session.compacting", {
			sessionId: "session-compact-test",
			messages: [],
		})) as SessionCompactingResult;
		expect(compacting.context?.join("\n")).toContain("[omp-playbooks]");

		service.push({ event: "launch_requested", data: { blocks: ["b1"] } });
		await Bun.sleep(60);
		expect(h.messages).toHaveLength(0);

		const flushed = h.nextMessage();
		expect(releaseCompactionBarrier(h.ctx.sessionManager)).toBe(1);
		expect(isCompacting(h.ctx.sessionManager)).toBe(false);
		await flushed;

		expect(h.messages).toHaveLength(1);
		expect(h.messages[0]!.message.customType).toBe("playbook-event");
		expect(h.messages[0]!.message.content).toContain("await playbook.run(");

		await h.emit("session_compact", { compactionEntry: { id: "c-launch" } });
		const injected = (await h.emit("before_agent_start", {})) as { message?: { content: string } } | undefined;
		expect(injected?.message?.content).toContain(service.doc);
		expect(injected?.message?.content).toContain("playbook://book.yaml");
	});

	test("compaction barrier defers pane attach playbook-event during compaction and flushes on session_compact", async () => {
		const service = await mockPlaybookService();
		const h = await extensionHarness();

		await h.emit("auto_compaction_start", {});
		expect(isCompacting(h.ctx.sessionManager)).toBe(true);

		const conn = await IpcConnection.connect(paneEndpoint(pane), { framing: "lines" });
		cleanup.push(() => conn.destroy());
		const replyPromise = Promise.withResolvers<Record<string, unknown>>();
		conn.start(
			(line) => replyPromise.resolve(JSON.parse(line) as Record<string, unknown>),
			() => {},
		);
		conn.send(JSON.stringify({ op: "attach", doc: service.doc }));

		const reply = await replyPromise.promise;
		expect(reply.ok).toBe(true);
		await Bun.sleep(40);
		expect(h.messages).toHaveLength(0);

		await h.emit("session_compact", { compactionEntry: { id: "c-pane" } });
		expect(isCompacting(h.ctx.sessionManager)).toBe(false);
		expect(h.messages).toHaveLength(1);
		expect(h.messages[0]!.message.customType).toBe("playbook-event");
		expect(h.messages[0]!.message.content).toContain("playbook://book.yaml");
	});
});
