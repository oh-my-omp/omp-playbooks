import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { ptree } from "@oh-my-pi/pi-utils";
import { parseLaunchId, type BlockId, type RunId, type RecordKind } from "../domain/model";
import { paneSocketPath, socketPath, type EventPayload, type PaneReply, type PaneRequest, type Request, type ServerFrame } from "../domain/protocol";
import { K1Client, type Reply } from "./client";
import { splitPane } from "../service/panes";
import { ensureTernPlugin, type TernPluginState } from "./tern-setup";
import { availableAgents } from "./agents";
import { tr, withLanguage } from "../i18n";
import { listenPane, type PaneListener } from "./pane-listener";
import { playbookTopics } from "./topics";
import { toolParameters } from "./params";

/** A block body that is one fenced js/py code block is an orchestration block (launch-events.md §1). */
const ORCHESTRATION = /^\s*```(js|py)\s*\n([\s\S]*)\n```\s*$/;

/** The main session's notice for what Tern setup did; nothing when the daemon already ran this version. */
function ternNotice(state: TernPluginState): { readonly text: string; readonly level: "info" | "warning" } | null {
	switch (state.kind) {
		case "absent": return { text: tr("omp-playbooks: no `tern` command on this omp's PATH, so the Tern plugin is not linked and Playbook panes cannot open. Put Tern's `tern` on PATH and restart omp.", "omp-playbooks: 这个 omp 的 PATH 中没有 `tern` 命令，Tern 插件未链接，Playbook 面板无法打开。把 Tern 的 `tern` 加入 PATH 后重启 omp。"), level: "warning" };
		case "current": return null;
		case "reloaded": return { text: tr(`omp-playbooks: Tern plugin reloaded from ${state.from ?? "not loaded"} to ${state.to}`, `omp-playbooks: Tern 插件已从 ${state.from ?? "未加载"} 重新加载为 ${state.to}`), level: "info" };
		case "stale": return { text: tr(`omp-playbooks: Tern is still running plugin ${state.loaded ?? "not loaded"}; the disk has ${state.wanted}; run \`tern plugin reload\` manually to see why.\n${state.detail}`, `omp-playbooks: Tern 仍在运行插件 ${state.loaded ?? "未加载"}，磁盘上是 ${state.wanted}；手动执行 \`tern plugin reload\` 查看原因。\n${state.detail}`), level: "warning" };
		default: { const unreachable: never = state; return unreachable; }
	}
}

/**
 * The Tern pane this omp runs in: the session daemon sets TERN_PANE to the pane's numeric id, which
 * also names this session's pane socket. Any other value or none is not a Tern pane.
 */
function ternPane(): string | null {
	const pane = process.env.TERN_PANE;
	return pane !== undefined && /^[0-9]+$/.test(pane) ? pane : null;
}

export default async function (pi: ExtensionAPI): Promise<void> {
	// A Playbook lives in a Tern pane beside its coordinator: outside one, this extension adds no
	// tool, topic, command, notice or eval rewrite to the session. Wherever omp runs it with `tern`
	// on PATH, the factory links the Tern plugin (tern-setup.ts), inside a pane or not.
	const inTern = ternPane();
	if (inTern === null) { await ensureTernPlugin(); return; }
	const pane: string = inTern;
	const schemas = toolParameters(pi.zod);
	const { frames, readResult, revisionsResult, runsResult, helloResult, postResult, launchRecord, evalInput } = schemas.wire;
	/** The eight device schemas; `wire` holds the frames and results they are not. */
	type Tools = Omit<typeof schemas, "wire">;
	type InternalOf<K extends keyof Tools> = ReturnType<Tools[K]["toInternal"]>;

	const clients = new Map<string, K1Client>();
	let session: string | undefined;
	let stopped = false;

	type LaunchData = Extract<EventPayload, { event: "launch_requested" }>["data"];
	type QueuedLaunch = { readonly absolute: string; readonly data: LaunchData };
	// A Launch click reaches the model only at an input-ready state: requests made while this session
	// runs a turn wait here and leave together as one notice when the turn ends. `busy` follows the
	// session's own agent_start/agent_end; `delivering` keeps deliveries in order, one at a time.
	let launches: QueuedLaunch[] = [];
	let busy = false;
	let delivering: Promise<void> = Promise.resolve();

	/** Send every held launch request as one notice, unless a turn started meanwhile (its agent_end delivers them). */
	function deliverLaunches(ctx: ExtensionContext): Promise<void> {
		const delivered = delivering.then(async () => {
			if (busy || launches.length === 0) return;
			const batch = launches;
			launches = [];
			const content = await launchNotice(batch);
			// Still unwinding the ended turn: followUp waits for idle (or, after Esc, for the person's next prompt).
			pi.sendMessage({ customType: "playbook-event", content, display: true }, { deliverAs: ctx.isIdle() ? "aside" : "followUp", triggerTurn: true });
		});
		delivering = delivered.catch(() => undefined);
		return delivered;
	}

	/** Absolute Playbook path for a tool call: the given file, else the only connected document. */
	async function documentFor(file: string | undefined): Promise<string> {
		if (file !== undefined) {
			try { return await realpath(file); }
			catch { throw new Error(tr(`NoService: cannot resolve Playbook ${file}`, `NoService：无法解析 Playbook ${file}`)); }
		}
		const connected = [...clients.entries()].filter(([, client]) => client.connected).map(([path]) => path);
		if (connected.length === 1) return connected[0]!;
		throw new Error(connected.length === 0
			? tr("NoService: no Playbook is open in this session; pass doc or call xd://playbook_open first", "NoService：本会话没有打开的 Playbook；请传入 doc 或先调用 xd://playbook_open")
			: tr(`NoService: several Playbooks are open (${connected.join(", ")}); pass doc`, `NoService：打开了多个 Playbook（${connected.join("、")}）；请传入 doc`));
	}

	async function clientFor(absolute: string, ctx: ExtensionContext): Promise<K1Client> {
		if (stopped) throw new Error(tr("Disconnected: coordinator session has ended", "Disconnected：协调者会话已结束"));
		const currentSession = ctx.sessionManager.getSessionId();
		if (session !== undefined && session !== currentSession) {
			for (const client of clients.values()) client.close();
			clients.clear();
			launches = [];
		}
		session = currentSession;
		let client = clients.get(absolute);
		if (!client) {
			client = new K1Client(socketPath(tmpdir(), absolute), { session: currentSession, pane }, (input): ServerFrame => frames.parse(input) as ServerFrame /* omptype marks an optional-valued key as optional; the wire ok-frame always carries result */, async (event: EventPayload) => {
				// A human interrupt only revokes the lock of an in-flight playbook_edit, whose
				// mutation then fails with NotLocked; nothing else in this session depends on it.
				if (event.event === "interrupted") return;
				// A SUBAGENT dropdown opened: the extension answers from this session; the model is not involved.
				if (event.event === "agents_requested") {
					await clients.get(absolute)?.request({ op: "agents", args: { result: availableAgents(pi.getAllTools()) } });
					return;
				}
				if (event.event === "launch_requested") {
					launches.push({ absolute, data: event.data });
					return deliverLaunches(ctx);
				}
				pi.sendMessage({ customType: "playbook-event", content: await notice(absolute, event), display: true }, { deliverAs: "aside", triggerTurn: true });
			});
			clients.set(absolute, client);
		}
		return client;
	}

	async function request(file: string | undefined, ctx: ExtensionContext, payload: Request): Promise<Reply> {
		const absolute = await documentFor(file);
		return (await clientFor(absolute, ctx)).request(payload);
	}

	// K5: the document service shipped beside this extension in the same installation.
	const serviceEntry = resolve(import.meta.dir, "../service/main.ts");
	const preludeEntry = resolve(import.meta.dir, "eval-prelude.ts");
	const OPEN_WAIT_MS = 10_000;
	const startFailed = (message: string): Reply => ({ id: "", ok: false, error: { code: "StartFailed", message } });

	/** K2 `playbook_open`: connect, starting the service in a Tern pane beside this session when none listens. */
	async function open(file: string, ctx: ExtensionContext): Promise<Reply> {
		const absolute = await documentFor(file);
		const client = await clientFor(absolute, ctx);
		const ready = await client.connect();
		if (ready.ok || ready.error.code !== "NoService") return ready;
		const split = await splitPane(pane, dirname(absolute), withLanguage(["bun", serviceEntry, absolute]));
		if (!split.ok) return startFailed(split.error);
		const deadline = Date.now() + OPEN_WAIT_MS;
		for (;;) {
			await Bun.sleep(250);
			const next = await client.connect();
			if (next.ok || next.error.code !== "NoService") return next;
			if (Date.now() >= deadline) return startFailed(tr(`The document service in Tern pane ${split.pane} did not listen within ${OPEN_WAIT_MS / 1000} s; its pane shows why`, `Tern 面板 ${split.pane} 中的文档服务在 ${OPEN_WAIT_MS / 1000} 秒内没有监听；原因见该面板`));
		}
	}

	/** `playbook_edit` on an existing block: lock, change, unlock within this one call (K2). */
	async function editBlock(file: string | undefined, ctx: ExtensionContext, scope: { run?: RunId; block: BlockId }, change: Request): Promise<Reply> {
		const absolute = await documentFor(file);
		const client = await clientFor(absolute, ctx);
		const lockId = randomUUID();
		const locked = await client.request({ op: "lock", args: scope }, lockId);
		if (!locked.ok) return locked;
		const changed = await client.request(change);
		if (change.op !== "delete") await client.request({ op: "unlock", args: { ...scope, request: lockId } });
		if (!changed.ok && changed.error.code === "NotLocked") {
			return { ...changed, error: { ...changed.error, message: tr("The person took this block back (interrupt) before the change landed; nothing was applied. Read the block again before deciding whether to edit it.", "人在变更生效前通过打断收回了此块；没有应用任何修改。重新读取该块后再决定是否编辑。") } };
		}
		return changed;
	}

	const scoped = (value: RunId | undefined): { run?: RunId } => value === undefined ? {} : { run: value };

	type ToolResult = { content: { type: "text"; text: string }[]; isError: boolean };
	const reply = (value: Reply): ToolResult => ({ content: [{ type: "text", text: value.ok && value.raw !== undefined ? value.raw : JSON.stringify(value.ok ? value.result ?? null : { error: value.error }) }], isError: !value.ok });
	const failure = (thrown: unknown): ToolResult => {
		const message = thrown instanceof Error ? thrown.message : String(thrown);
		const code = message.startsWith("Disconnected:") ? "Disconnected" : "NoService";
		return reply({ id: "", ok: false, error: { code, message } });
	};

	// Model-facing text starts with the short purpose omp shows of a plugin device;
	// full descriptions end with pointers to the tool's own xd:// topics (./topics.ts).
	type Tool<K extends keyof Tools> = { readonly name: K; readonly label: string; readonly description: string; readonly parameters: Tools[K]["parameters"]; readonly toInternal: Tools[K]["toInternal"]; run(params: InternalOf<K>, ctx: ExtensionContext): Promise<Reply> };
	const tools = [
		{
			name: "playbook_open", label: tr("Playbook: open", "Playbook: 打开"), parameters: schemas.playbook_open.parameters, toInternal: schemas.playbook_open.toInternal,
			description: "Connect this session to a Playbook YAML as its coordinator, opening its Tern pane when none runs. Use to write, review or run multi-step agent work. → block ids, Runs.",
			run: (params, ctx) => open(params.doc, ctx),
		} satisfies Tool<"playbook_open">,
		{
			name: "playbook_read", label: tr("Playbook: read", "Playbook: 读取"), parameters: schemas.playbook_read.parameters, toInternal: schemas.playbook_read.toInternal,
			description: "Read committed blocks of the Playbook (or one Run): all blocks or one block; the revisions op lists a design block's change requests instead.",
			run: (params, ctx) => "op" in params
				? request(params.doc, ctx, { op: "revisions", args: { ...scoped(params.run), ...(params.block ? { block: params.block } : {}), ...(params.after !== undefined ? { after: params.after } : {}) } })
				: request(params.doc, ctx, { op: "read", args: { ...scoped(params.run), ...(params.block ? { block: params.block } : {}) } }),
		} satisfies Tool<"playbook_read">,
		{
			name: "playbook_edit", label: tr("Playbook: edit", "Playbook: 编辑"), parameters: schemas.playbook_edit.parameters, toInternal: schemas.playbook_edit.toInternal,
			description: "Change one block of the Playbook (or one Run). Each call locks the block; NotLocked means nothing was applied, so read it again. A design's requirement is the person's.",
			run: (params, ctx) => {
				switch (params.op) {
					case "insert": return request(params.doc, ctx, { op: "insert", args: { ...scoped(params.run), ...(params.after ? { after: params.after } : {}), title: params.title, content: { kind: "task", body: params.body, ...(params.agent !== undefined ? { agent: params.agent } : {}), ...(params.isolated !== undefined ? { isolated: params.isolated } : {}) } } });
					case "insert_design": return request(params.doc, ctx, { op: "insert", args: { ...scoped(params.run), ...(params.after ? { after: params.after } : {}), title: params.title, content: { kind: "design", design: params.design } } });
					case "write": return editBlock(params.doc, ctx, { ...scoped(params.run), block: params.block }, { op: "write", args: { ...scoped(params.run), block: params.block, text: params.text } });
					case "panel": return editBlock(params.doc, ctx, { ...scoped(params.run), block: params.block }, { op: "panel", args: { ...scoped(params.run), block: params.block, panel: params.panel, text: params.text } });
					case "title": return editBlock(params.doc, ctx, { ...scoped(params.run), block: params.block }, { op: "set", args: { ...scoped(params.run), block: params.block, field: "title", value: params.value } });
					case "status": return editBlock(params.doc, ctx, { ...scoped(params.run), block: params.block }, { op: "set", args: { ...scoped(params.run), block: params.block, field: "status", value: params.value } });
					case "task": return editBlock(params.doc, ctx, { ...scoped(params.run), block: params.block }, { op: "set", args: { ...scoped(params.run), block: params.block, field: "task", value: params.value } });
					case "replace": return editBlock(params.doc, ctx, { ...scoped(params.run), block: params.block }, { op: "edit", args: { ...scoped(params.run), block: params.block, find: params.find, replace: params.replace } });
					case "delete": return editBlock(params.doc, ctx, { ...scoped(params.run), block: params.block }, { op: "delete", args: { ...scoped(params.run), block: params.block } });
					case "move": return editBlock(params.doc, ctx, { ...scoped(params.run), block: params.block }, { op: "move", args: { ...scoped(params.run), block: params.block, after: params.after } });
					case "agent": return editBlock(params.doc, ctx, { ...scoped(params.run), block: params.block }, { op: "set", args: { ...scoped(params.run), block: params.block, field: "agent", value: params.value } });
					case "isolated": return editBlock(params.doc, ctx, { ...scoped(params.run), block: params.block }, { op: "set", args: { ...scoped(params.run), block: params.block, field: "isolated", value: params.value } });
				}
			},
		} satisfies Tool<"playbook_edit">,
		{
			name: "playbook_compile", label: tr("Playbook: compile", "Playbook: 编译"), parameters: schemas.playbook_compile.parameters, toInternal: schemas.playbook_compile.toInternal,
			description: "Render the exact prompt the blocks compile to without starting anything, or fetch their external references (files, GitHub, URLs) again.",
			run: (params, ctx) => params.op === "compile"
				? request(params.doc, ctx, { op: "compile", args: { ...scoped(params.run), blocks: params.blocks } })
				: request(params.doc, ctx, { op: "refetch", args: { ...scoped(params.run), targets: params.targets } }),
		} satisfies Tool<"playbook_compile">,
		{
			name: "playbook_check", label: tr("Playbook: check", "Playbook: 检查"), parameters: schemas.playbook_check.parameters, toInternal: schemas.playbook_check.toInternal,
			description: "Inspect blocks for deterministic findings and judge questions, then report the judge's answers. Checks never gate a launch.",
			run: (params, ctx) => params.op === "inspect"
				? request(params.doc, ctx, { op: "inspect", args: { ...scoped(params.run), blocks: params.blocks } })
				: request(params.doc, ctx, { op: "report", args: { ...scoped(params.run), blocks: params.blocks, version: params.version, result: params.result } }),
		} satisfies Tool<"playbook_check">,
		{
			name: "playbook_run", label: tr("Playbook: Run", "Playbook: 运行"), parameters: schemas.playbook_run.parameters, toInternal: schemas.playbook_run.toInternal,
			description: "Start, finish or list Runs. A Run is a clean copy of the Playbook for one execution; starting one starts no agent.",
			run: (params, ctx) => {
				switch (params.op) {
					case "start": return request(params.doc, ctx, { op: "start_run", args: { name: params.name, ...(params.update_every !== undefined ? { update_every: params.update_every } : {}) } });
					case "finish": return request(params.doc, ctx, { op: "finish_run", args: { run: params.run } });
					case "list": return request(params.doc, ctx, { op: "runs", args: {} });
				}
			},
		} satisfies Tool<"playbook_run">,
		{
			name: "playbook_timeline", label: tr("Playbook: timeline", "Playbook: 时间线"), parameters: schemas.playbook_timeline.parameters, toInternal: schemas.playbook_timeline.toInternal,
			description: "Read or append the Playbook's execution log (or one Run's), and postpone a Run's update reminder.",
			run: (params, ctx) => {
				switch (params.op) {
					case "read": return request(params.doc, ctx, { op: "timeline", args: { ...scoped(params.run), ...(params.after !== undefined ? { after: params.after } : {}), ...(params.limit !== undefined ? { limit: params.limit } : {}) } });
					case "post": {
						const { doc: _doc, op: _op, ...entry } = params;
						return request(params.doc, ctx, { op: "post", args: entry });
					}
					case "snooze": return request(params.doc, ctx, { op: "snooze", args: { run: params.run, after: params.after } });
				}
			},
		} satisfies Tool<"playbook_timeline">,
		{
			name: "playbook_launch", label: tr("Playbook: Launch", "Playbook: 启动"), parameters: schemas.playbook_launch.parameters, toInternal: schemas.playbook_launch.toInternal,
			description: "Freeze blocks' prompt into a Launch that subagents work from: create, bind, inspect, rebase or close one. It starts no subagent; prefer playbook.agent/playbook.run in eval.",
			run: (params, ctx) => {
				switch (params.op) {
					case "launch": return request(params.doc, ctx, { op: "launch", args: { ...scoped(params.run), blocks: params.blocks } });
					case "bind": return request(params.doc, ctx, { op: "bind", args: { launch: params.launch, agent: params.agent } });
					case "info": return request(params.doc, ctx, { op: "launch_info", args: { launch: params.launch } });
					case "rebase": return request(params.doc, ctx, { op: "rebase", args: { launch: params.launch } });
					case "close": return request(params.doc, ctx, { op: "close", args: { launch: params.launch } });
				}
			},
		} satisfies Tool<"playbook_launch">,
	] as const;
	type AnyTool = (typeof tools)[number];

	/**
	 * Registers the tools as `xd://` devices (`loadMode: "discoverable"`) once per extension binding.
	 * Called from the main session's session_start, after the session is built: omp installs a late
	 * registration into the live registry and mounts it with a hidden mount notice, so the system and
	 * tools prefix stays byte-stable and subagent sessions, which never register, carry none of them.
	 */
	let registered = false;
	function registerTools(entries: readonly AnyTool[]): void {
		if (registered) return;
		registered = true;
		const topics = playbookTopics();
		for (const tool of entries) {
			const ownTopics = topics.get(tool.name) ?? [];
			const pointers = ownTopics.map(topic => `- \`xd://${tool.name}/${topic.name}\` — ${topic.when}`);
			const definition = {
				name: tool.name, label: tool.label, parameters: tool.parameters, loadMode: "discoverable",
				description: tool.description + (pointers.length ? `\n\nTopics — read the one a call needs before making it:\n${pointers.join("\n")}` : ""),
				docTopics: () => Object.fromEntries(ownTopics.map(topic => [topic.name, topic.read()])),
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					try {
						// Each entry pairs its own schema with its own runner.
						const run = tool.run as (value: unknown, context: ExtensionContext) => Promise<Reply>;
						const parse = tool.parameters.parse as (value: unknown) => unknown;
						const toInternal = tool.toInternal as (value: unknown) => unknown;
						return reply(await run(toInternal(parse(params)), ctx));
					} catch (thrown) { return failure(thrown); }
				},
			} satisfies ToolDefinition<typeof tool.parameters> & { docTopics(): Readonly<Record<string, string>> };
			pi.registerTool(definition);
		}
	}

	const ternState = await ensureTernPlugin();

	const header = tr("This is a Playbook document service notice, not a user message", "这是 Playbook 文档服务的通知，不是用户消息");

	/** The next call for one launch request: which execution its blocks take and how to start it. */
	async function launchNext(absolute: string, data: LaunchData): Promise<string> {
		const docLiteral = JSON.stringify(absolute);
		const blocks = JSON.stringify(data.blocks);
		const bodies = await clients.get(absolute)?.request({ op: "read", args: scoped(data.run) });
		const parsed = bodies?.ok ? readResult.safeParse(bodies.result) : undefined;
		const requested = parsed?.success === true ? parsed.data.blocks.filter(item => data.blocks.includes(item.id)) : [];
		const orchestration = requested.some(item => item.kind === "task" && ORCHESTRATION.test(item.body));
		const only = requested.length === 1 && requested[0]!.kind === "task" ? requested[0]! : null;
		const preset = only && (only.agent !== undefined || only.isolated !== undefined)
			? tr(`Block ${only.id} has preset${only.agent !== undefined ? ` agent: "${only.agent}"` : ""}${only.isolated !== undefined ? ` isolated: ${only.isolated}` : ""}, so playbook.agent / playbook.run use it automatically when arguments are omitted.`, `块 ${only.id} 已预设${only.agent !== undefined ? ` agent: "${only.agent}"` : ""}${only.isolated !== undefined ? ` isolated: ${only.isolated}` : ""}，不显式传参时 playbook.agent / playbook.run 自动使用。`)
			: "";
		const where = data.run === undefined ? "Playbook" : `Run ${data.run}`;
		const runArg = data.run === undefined ? "" : `, run: "${data.run}"`;
		const call = `{ doc: ${docLiteral}${runArg}, blocks: ${blocks} }`;
		return orchestration
					? tr(`A person requested launching orchestration blocks ${blocks}. Next: call xd://playbook_launch {doc: ${docLiteral}, op: "launch"${runArg}, blocks: ${blocks}} to get l<n>, then send a separate eval whose code is only \`await playbook.exec("l<n>")\`.`, `人请求启动编排块 ${blocks}。下一步：调用 xd://playbook_launch {doc: ${docLiteral}, op: "launch"${runArg}, blocks: ${blocks}} 得到 l<n>，再单独发一个 eval，代码只写 \`await playbook.exec("l<n>")\`。`)
					: tr(`A person requested launching blocks ${blocks} of ${where === "Playbook" ? "the Playbook" : where}. ${preset ? `${preset} ` : ""}Next, choose one: ① Non-blocking: in eval, \`var worker = await playbook.agent(${call})\` returns as soon as the subagent is started and bound; wait for it with the top-level wait tool, which still lets you handle pane notices meanwhile; after it finishes, send another eval \`await playbook.result(worker)\` to record the result and close the Launch. ② Single step: \`await playbook.run(${call})\` starts, waits, records and closes. The subagent writes the block's status and completion report into the file itself; you do not write them for it. When the default subagent is disabled and the block has no preset agent, add \`agent: "<available agent>"\` (for example "task:mid"). The extension adds the \`var playbook = …\` line at the start of an eval cell automatically; do not write it yourself.`, `人请求启动 ${where} 的块 ${blocks}。${preset}下一步二选一：① 不阻塞：在 eval 中 \`var worker = await playbook.agent(${call})\`，启动并绑定后立即返回；用顶层 wait 等它，期间仍能处理面板通知；结束后另发 eval \`await playbook.result(worker)\` 记录结果并关闭 Launch。② 单步：\`await playbook.run(${call})\` 启动、等待、记录并关闭。subagent 自己把块的状态与完成报告写进文件，你不用代写。默认 subagent 被禁用且块没有预设 agent 时加上 \`agent: "<可用的 agent>"\`（例如 "task:mid"）。eval 单元开头那行 \`var playbook = …\` 由扩展自动加入，不要自己再写。`)
	}

	/**
	 * The launch requests of one delivery as one notice: a single request reads like every other
	 * notice; several (clicked while this session was busy) are numbered in click order, each with its
	 * own next call, followed by one data line per request.
	 */
	async function launchNotice(batch: readonly QueuedLaunch[]): Promise<string> {
		const nexts = await Promise.all(batch.map(item => launchNext(item.absolute, item.data)));
		const data = batch.map(item => JSON.stringify({ doc: item.absolute, event: "launch_requested", data: item.data }));
		if (batch.length === 1) return `${header}\n${nexts[0]}\n${data[0]}`;
		const intro = tr(`${batch.length} launch requests arrived while this session was busy, collected here in click order. Each is a separate Launch; handle them one by one:`, `本会话忙碌期间收到 ${batch.length} 个启动请求，按点击顺序合并在这里。它们是各自独立的 Launch，逐个处理：`);
		return [header, intro, ...nexts.map((next, index) => `${index + 1}. ${next}`), ...data].join("\n");
	}

	/** Event aside: header line, the next call to make, then the data (launch-events.md §6). */
	async function notice(absolute: string, event: Exclude<EventPayload, { event: "interrupted" | "agents_requested" | "launch_requested" }>): Promise<string> {
		const docLiteral = JSON.stringify(absolute);
		let next: string;
		switch (event.event) {
			case "stop_requested": {
				const stopCalls = event.data.launches.map(item => `\`await playbook.stop("${item.id}")\``);
				const stopsEn = stopCalls.join(", ");
				const stopsZh = stopCalls.join("、");
				const agents = event.data.launches.flatMap(item => item.agents);
				const launchesEn = event.data.launches.map(item => item.id).join(", ");
				const launchesZh = event.data.launches.map(item => item.id).join("、");
				const agentsEn = agents.join(", ");
				const agentsZh = agents.join("、");
				next = tr(`A person requested stopping execution of block ${event.data.block} (Launch ${launchesEn}${agents.length ? `, subagent ${agentsEn}` : ""}). Next: execute ${stopsEn} in eval: this cancels the subagents this session started for these Launches and sets blocks still running back to todo; any waiting playbook.result calls then record the failure and close the Launch. If a subagent was not started in this session through playbook.agent / playbook.spawn, stop it your own way first, then use xd://playbook_edit {op: "status", block: "${event.data.block}", status: "todo"${event.data.run === undefined ? "" : `, run: "${event.data.run}"`}} to set it back to todo.`, `人请求打断块 ${event.data.block} 的执行（Launch ${launchesZh}${agents.length ? `，subagent ${agentsZh}` : ""}）。下一步：在 eval 中执行 ${stopsZh}：它取消本会话为这些 Launch 启动的 subagent，并把仍在执行中的块改回 todo；等着的 playbook.result 随后记录失败并关闭 Launch。若 subagent 不是本会话通过 playbook.agent / playbook.spawn 启动的，先用你自己的方式停止它，再用 xd://playbook_edit {op: "status", block: "${event.data.block}", status: "todo"${event.data.run === undefined ? "" : `, run: "${event.data.run}"`}} 改回 todo。`);
				break;
			}
			case "block_changed":
				next = tr(`A person changed block ${JSON.stringify(event.data.changed)}, on which Launch ${event.data.launch.id} depends (see the diff below). You can: call xd://playbook_launch {op: "rebase", launch: "${event.data.launch.id}"} to accept the current text as the new baseline (then playbook.spawn and playbook.exec use it); notify the subagent that is still running; or do nothing.`, `人修改了 Launch ${event.data.launch.id} 依赖的块 ${JSON.stringify(event.data.changed)}（diff 见下）。可以：调用 xd://playbook_launch {op: "rebase", launch: "${event.data.launch.id}"} 接受当前文本为新基线（之后 playbook.spawn 与 playbook.exec 使用它）；告诉仍在运行的 subagent；或不处理。`);
				break;
			case "update_due":
				next = tr(`The status update for Run ${event.data.run} is due. Next: xd://playbook_timeline {op: "post", run: "${event.data.run}", kind: "update", text: ...} writes the update, or {op: "snooze", run: "${event.data.run}", after: <seconds>} postpones it.`, `Run ${event.data.run} 的状态更新到期。下一步：xd://playbook_timeline {op: "post", run: "${event.data.run}", kind: "update", text: ...} 写更新，或 {op: "snooze", run: "${event.data.run}", after: <秒数>} 推迟。`);
				break;
			case "revision_requested": {
				const where = event.data.run === undefined ? "Playbook" : `Run ${event.data.run}`;
				const scope = event.data.run === undefined ? "" : `run: "${event.data.run}", `;
				const answer = await clients.get(absolute)?.request({ op: "revisions", args: { ...scoped(event.data.run), block: event.data.block, after: event.data.revision - 1 } });
				const found = answer?.ok ? revisionsResult.safeParse(answer.result) : undefined;
				const prompt = found?.success ? found.data.revisions.find(item => item.seq === event.data.revision)?.prompt : undefined;
				const history = `xd://playbook_read {doc: ${docLiteral}, ${scope}op: "revisions", block: "${event.data.block}"}`;
				next = tr(`A person submitted change request #${event.data.revision} for the ${where} design block ${event.data.block}${prompt === undefined ? `(failed to read; query with ${history})` : `:\n<prompt>\n${prompt}\n</prompt>`}\nNext: read the requirement and current design with xd://playbook_read {doc: ${docLiteral}, ${scope}block: "${event.data.block}"}, then revise the design according to the change request: use xd://playbook_edit write, replace, or panel to change design; do not change requirement. Keep the revised design in the Where/What/How panel structure. When the prompt selects a value for a slot, change that slot fence's \`= \` line to that value; when the original value is not in the options, add a \`~ <original value>\` line. To retrieve previous change requests, use ${history}.`, `人对${where}的设计块 ${event.data.block} 提交了修改 prompt #${event.data.revision}${prompt === undefined ? `（读取失败，用 ${history} 查询）` : `：\n<prompt>\n${prompt}\n</prompt>`}\n下一步：xd://playbook_read {doc: ${docLiteral}, ${scope}block: "${event.data.block}"} 读需求与当前设计稿，按 prompt 修订设计：用 xd://playbook_edit 的 write、replace 或 panel 改 design；不要改 requirement。修订后的设计稿保持 Where/What/How 面板结构。prompt 选定了某个槽位的取值时，把那个 slot 围栏的 \`= \` 行改成该值；原来的值不在选项里时补一行 \`~ <原值>\`。需要以前的修改要求时用 ${history}。`);
				break;
			}
			case "status_changed":
				next = tr(`A person changed block ${event.data.block} to status ${event.data.status}. No action is needed.`, `人把块 ${event.data.block} 的状态改为 ${event.data.status}。无需动作。`);
				break;
		}
		return `${header}\n${next}\n${JSON.stringify({ doc: absolute, ...event })}`;
	}

	// The Playbook-specific eval layer (K2 "eval 辅助"): only in the coordinator session.
	const usesHelpers = /\bplaybook\.(?:run|agent|result|spawn|stop|post|timeline|read|context)\b/;
	const waits = /\bplaybook\.(?:run|result)\s*\(/;
	const execCall = /^\s*(?:await\s+)?playbook\.exec\(\s*["'](l[1-9][0-9]*)["']\s*(?:,\s*(["'])(.+?)\2\s*)?\)\s*;?\s*$/;
	// Code text for the eval kernel, not an import of this module: the kernel loads the helper
	// from this installation's path, which is known only at run time.
	const importLine = (context: Record<string, string>): string => `// Added by the omp-playbooks extension, not written by the model.\nvar playbook = (await import(${JSON.stringify(preludeEntry)})).createPlaybook({ tool, agent, ...${JSON.stringify(context)} });\n`;

	pi.on("tool_call", async (event, ctx) => {
		if (ctx.agent.kind !== "main" || event.toolName !== "eval") return;
		const parsed = evalInput.safeParse(event.input);
		if (!parsed.success) return;
		const input = parsed.data;
		const exec = execCall.exec(input.code);
		if (exec) {
			const launchId = parseLaunchId(exec[1]!);
			if (launchId === null) return { block: true, reason: tr(`${exec[1]} is not a Launch id`, `${exec[1]} 不是 Launch id`) };
			let absolute: string;
			try { absolute = await documentFor(exec[3]); }
			catch (thrown) { return { block: true, reason: thrown instanceof Error ? thrown.message : String(thrown) }; }
			const info = await (await clientFor(absolute, ctx)).request({ op: "launch_info", args: { launch: launchId } });
			if (!info.ok) return { block: true, reason: `${info.error.code}: ${info.error.message}` };
			const record = launchRecord.parse(info.result);
			if (record.kind !== "orchestration") return { block: true, reason: tr(`${launchId} is a prompt Launch; start its subagent with \`await playbook.spawn("${launchId}")\` or \`playbook.run\``, `${launchId} 是提示 Launch；请用 \`await playbook.spawn("${launchId}")\` 或 \`playbook.run\` 启动其 subagent`) };
			// The latest baseline: the frozen snapshot until a rebase accepted newer code.
			const fence = ORCHESTRATION.exec(record.baselines?.at(-1) ?? record.snapshot.result.text);
			if (!fence) return { block: true, reason: tr(`${launchId} has no fenced js/py code in its snapshot`, `${launchId} 的快照中没有带围栏的 js/py 代码`) };
			const context = { doc: absolute, ...(record.run === null ? {} : { run: record.run }), launch: launchId };
			const code = fence[1] === "js"
				? `// playbook.exec("${launchId}") replaced by the Launch's orchestration code (its latest baseline).\n` + importLine(context) + fence[2]!
				: `# Added by the omp-playbooks extension: playbook.exec("${launchId}") replaced by the Launch's orchestration code (its latest baseline).\nPLAYBOOK_DOC = ${JSON.stringify(absolute)}\nPLAYBOOK_RUN = ${record.run === null ? "None" : JSON.stringify(record.run)}\nPLAYBOOK_LAUNCH = ${JSON.stringify(launchId)}\n${fence[2]!}`;
			return { input: { ...input, language: fence[1], code, timeout: 0, title: input.title ?? `Playbook ${launchId}` } };
		}
		if (/\bplaybook\.exec\s*\(/.test(input.code)) {
			return { block: true, reason: tr("playbook.exec must be the whole eval code: `await playbook.exec(\"l<n>\")`", "playbook.exec 必须是完整的 eval 代码：`await playbook.exec(\"l<n>\")`") };
		}
		if (input.language !== "js" || !usesHelpers.test(input.code) || input.code.includes(preludeEntry)) return;
		return { input: { ...input, code: importLine({}) + input.code, ...(input.timeout === undefined && waits.test(input.code) ? { timeout: 0 } : {}) } };
	});

	/**
	 * A pane socket request from a document service: `attach` connects this session to that Playbook's
	 * service as its coordinator (what playbook_open does for an already running service), then tells the
	 * model so in the transcript without starting a turn.
	 */
	async function onPaneRequest(request: PaneRequest, ctx: ExtensionContext): Promise<PaneReply> {
		const here = { ok: true as const, session: ctx.sessionManager.getSessionId(), cwd: ctx.cwd };
		if (request.op === "ping") return here;
		if (stopped) return { ok: false, error: { code: "Disconnected", message: tr("coordinator session has ended", "协调者会话已结束") } };
		let absolute: string;
		try { absolute = await realpath(request.doc); }
		catch { return { ok: false, error: { code: "NoService", message: tr(`cannot resolve Playbook ${request.doc}`, `无法解析 Playbook ${request.doc}`) } }; }
		const ready = await (await clientFor(absolute, ctx)).connect();
		if (!ready.ok) return { ok: false, error: { code: ready.error.code, message: ready.error.message } };
		pi.sendMessage({ customType: "playbook-event", content: tr(`This is a Playbook document service notice, not a user message\nA person designated this session as the coordinator for ${absolute} in the Playbook pane; the extension is connected (equivalent to xd://playbook_open). Use xd://playbook_read {doc: ${JSON.stringify(absolute)}} to learn it; then follow the next step in each Playbook notice.`, `这是 Playbook 文档服务的通知，不是用户消息\n人在 Playbook 面板里指定本会话为 ${absolute} 的协调者，扩展已经连接（等同 xd://playbook_open）。用 xd://playbook_read {doc: ${JSON.stringify(absolute)}} 了解它；之后每收到 Playbook 通知，按通知里的下一步做。`), display: true });
		return here;
	}
	let paneListener: PaneListener | null = null;
	let paneContext: ExtensionContext | null = null;

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		registerTools(tools);
		registerCommands();
		const notice = ternNotice(ternState);
		if (notice) ctx.ui.notify(notice.text, notice.level);
		paneContext = ctx;
		busy = !ctx.isIdle();
		if (paneListener === null) paneListener = await listenPane(paneSocketPath(tmpdir(), pane), request => onPaneRequest(request, paneContext!));
	});

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.agent.kind === "main") busy = true;
	});

	// The turn ended at an input-ready state: deliver the launch requests held during it. An automatic
	// continuation keeps the turn going; a settle that only awaits background work leaves the session open for input.
	pi.on("agent_end", (event, ctx) => {
		if (ctx.agent.kind !== "main" || (event.willContinue === true && event.awaitingAsyncWork !== true)) return;
		busy = false;
		return deliverLaunches(ctx);
	});

	pi.on("session_shutdown", () => {
		stopped = true;
		paneListener?.close();
		paneListener = null;
		for (const client of clients.values()) client.close();
		clients.clear();
		launches = [];
	});

	async function commandClient(args: string, ctx: ExtensionContext): Promise<K1Client | undefined> {
		let file = args.trim();
		if (!file) {
			const connected = [...clients.entries()].filter(([, client]) => client.connected);
			if (connected.length === 1) file = connected[0]![0];
			else if (connected.length > 1) { const selected = await ctx.ui.select(tr("Choose Playbook", "选择 Playbook"), connected.map(([path]) => path)); if (selected === undefined) return; file = selected; }
			else { ctx.ui.notify(tr("Please specify the Playbook file path", "请指定 Playbook 文件路径"), "error"); return; }
		}
		const client = await clientFor(await documentFor(file), ctx);
		const ready = await client.connect();
		if (!ready.ok) throw new Error(`${ready.error.code}: ${ready.error.message}`);
		return client;
	}
	async function result(client: K1Client, payload: Request): Promise<unknown> {
		const answer = await client.request(payload);
		if (!answer.ok) throw new Error(`${answer.error.code}: ${answer.error.message}`);
		return answer.result;
	}

	function registerCommands(): void {
	pi.registerCommand("playbook-add", {
		description: tr("Add a recent session message to a Playbook's execution log (the Playbook's own, or a Run's)", "将最近的会话消息添加到 Playbook 的执行日志（Playbook 本身或 Run）"),
		handler: async (args, ctx) => {
			try {
				const client = await commandClient(args, ctx); if (!client) return;
				const messages = ctx.sessionManager.getBranch().flatMap(entry => {
					if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) return [];
					const content = entry.message.content;
					const text = typeof content === "string" ? content : content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
					return text ? [{ id: entry.id, text, label: `${entry.id}: ${text.replace(/\s+/g, " ").slice(0, 90)}` }] : [];
				}).slice(-20).reverse();
				if (!messages.length) { ctx.ui.notify(tr("No user or assistant messages with text", "没有包含文本的用户或助手消息"), "warning"); return; }
				const messageLabel = await ctx.ui.select(tr("Choose session message", "选择会话消息"), messages.map(message => message.label)); if (messageLabel === undefined) return;
				const message = messages.find(item => item.label === messageLabel); if (!message) throw new Error(tr("Unknown message selection", "消息选择无效"));
				const runs = runsResult.parse(await result(client, { op: "runs", args: {} })).runs;
				const statusLabels = { running: tr("Running", "运行中"), finished: tr("Finished", "已结束") };
				const targetChoices = [{ id: undefined, label: tr("Playbook itself", "Playbook 本身") }, ...runs.map(item => ({ id: item.id, label: `${item.id}: ${item.name} (${statusLabels[item.status]})` }))];
				const targetLabel = await ctx.ui.select(tr("Choose log", "选择日志"), targetChoices.map(item => item.label)); if (targetLabel === undefined) return;
				const target = targetChoices.find(item => item.label === targetLabel); if (!target) throw new Error(tr("Unknown log selection", "日志选择无效"));
				const kindChoices: readonly { value: RecordKind; label: string }[] = [
					{ value: "update", label: tr("Update", "进展") },
					{ value: "result", label: tr("Result", "结果") },
					{ value: "failure", label: tr("Failure", "失败") },
					{ value: "retrospective", label: tr("Retrospective", "复盘") },
				];
				const kindLabel = await ctx.ui.select(tr("Choose record kind", "选择记录类型"), kindChoices.map(item => item.label)); if (kindLabel === undefined) return;
				const chosenKind = kindChoices.find(item => item.label === kindLabel)?.value;
				if (chosenKind === undefined) throw new Error(tr("Unknown record kind selection", "记录类型选择无效"));
				const document = readResult.parse(await result(client, { op: "read", args: scoped(target.id) }));
				const blockChoices = document.blocks.map(item => ({ id: item.id, label: `${item.id}: ${item.title}` }));
				const noBlock = tr("Not about a block", "不关于块");
				const blockLabel = await ctx.ui.select(tr("Choose block", "选择块"), [noBlock, ...blockChoices.map(item => item.label)]); if (blockLabel === undefined) return;
				const chosenBlock = blockLabel === noBlock ? undefined : blockChoices.find(item => item.label === blockLabel)?.id;
				if (blockLabel !== noBlock && chosenBlock === undefined) throw new Error(tr("Unknown block selection", "块选择无效"));
				const posted = postResult.parse(await result(client, { op: "post", args: { ...scoped(target.id), kind: chosenKind, text: message.text, ...(chosenBlock ? { block: chosenBlock } : {}), quote: message.id, origin: "human" } }));
				ctx.ui.notify(tr(`Playbook timeline entry ${posted.seq} written`, `已写入 Playbook 时间线条目 ${posted.seq}`), "info");
			} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
		},
	});
	pi.registerCommand("playbook-show", {
		description: tr("Focus the Playbook document pane in Tern", "聚焦 Tern 中的 Playbook 文档面板"),
		handler: async (args, ctx) => {
			try {
				const client = await commandClient(args, ctx); if (!client) return;
				const hello = helloResult.parse(client.hello);
				if (!hello.pane) { ctx.ui.notify(tr("The document service is not in a pane managed by the session daemon", "文档服务不在 session daemon 托管的 pane 中"), "error"); return; }
				const { exitCode, stderr } = await ptree.exec(["tern", "focus", hello.pane, "--json"], { env: process.env, allowNonZero: true, stderr: "full" });
				if (exitCode !== 0) throw new Error(tr(`tern focus exited ${exitCode}: ${stderr.trim()}`, `tern focus 退出 ${exitCode}：${stderr.trim()}`));
			} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
		},
	});
	}
}
