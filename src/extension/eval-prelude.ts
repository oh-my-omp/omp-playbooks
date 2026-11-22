import { tr } from "../../omomp-shared/i18n";

type ToolCall = (args: Record<string, unknown>) => Promise<unknown>;
type AgentHandle = { readonly id: string; wait(timeout?: number): Promise<unknown>; cancel(): unknown };
type AgentOptions = {
	readonly agent?: string;
	readonly label?: string;
	readonly schema?: unknown;
	readonly schemaMode?: string;
	readonly isolated?: boolean;
};
type Spawn = (prompt: string, options?: AgentOptions) => Promise<AgentHandle>;
type RecordKind = "update" | "result" | "failure" | "retrospective";

export type PlaybookContext = { readonly doc?: string; readonly run?: string; readonly launch?: string };

export type PlaybookDeps = PlaybookContext & {
	readonly tool: Readonly<Record<string, ToolCall>>;
	readonly agent: Spawn;
};

export type Spawned = {
	readonly doc?: string;
	readonly run?: string;
	readonly launch: string;
	readonly blocks: readonly string[];
	readonly ownsLaunch: boolean;
	readonly id: string;
	readonly handle: AgentHandle;
};

export type AgentRequest = AgentOptions & { readonly doc?: string; readonly run?: string; readonly blocks: readonly string[] };

class PlaybookError extends Error {}

const started = new Map<string, Spawned[]>();

type Created = {
	readonly launch: string;
	readonly kind: string;
	readonly text: string;
	readonly agent?: string;
	readonly isolated?: boolean;
};
type LaunchInfo = {
	readonly run: string | null;
	readonly kind: string;
	readonly text: string;
	readonly blocks: readonly string[];
	readonly closed: boolean;
};

function objectOf(value: unknown): object {
	if (typeof value !== "object" || value === null)
		throw new PlaybookError(tr(`Unexpected tool result: ${JSON.stringify(value)}`, `工具返回了意外结果：${JSON.stringify(value)}`));
	return value;
}
function stringAt(value: object, key: string): string {
	const field: unknown = key in value ? Reflect.get(value, key) : undefined;
	if (typeof field !== "string") throw new PlaybookError(tr(`Tool result has no string field ${key}`, `工具结果没有字符串字段 ${key}`));
	return field;
}

function decode(value: unknown): unknown {
	const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
	if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
		const error: unknown = parsed.error;
		const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "Error";
		const message =
			typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
				? error.message
				: JSON.stringify(error);
		throw new PlaybookError(`${code}: ${message}`);
	}
	return parsed;
}
function created(value: unknown): Created {
	const result = objectOf(value);
	const agent: unknown = "agent" in result ? result.agent : undefined;
	const isolated: unknown = "isolated" in result ? result.isolated : undefined;
	if (agent !== undefined && typeof agent !== "string")
		throw new PlaybookError(tr("Launch result's agent is not a string", "启动结果中的 agent 不是字符串"));
	if (isolated !== undefined && typeof isolated !== "boolean")
		throw new PlaybookError(tr("Launch result's isolated is not a boolean", "启动结果中的 isolated 不是布尔值"));
	return {
		launch: stringAt(result, "launch"),
		kind: stringAt(result, "kind"),
		text: stringAt(result, "text"),
		...(agent === undefined ? {} : { agent }),
		...(isolated === undefined ? {} : { isolated }),
	};
}
function strings(value: unknown, key: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
		throw new PlaybookError(tr(`Tool result has no string list field ${key}`, `工具结果没有字符串列表 ${key}`));
	return value;
}
function launchInfo(value: unknown): LaunchInfo {
	const record = objectOf(value);
	const snapshot = objectOf("snapshot" in record ? record.snapshot : undefined);
	const result = objectOf("result" in snapshot ? snapshot.result : undefined);
	const baselines = strings("baselines" in record ? record.baselines : undefined, "baselines");
	const closed: unknown = "closed" in record ? record.closed : undefined;
	const run: unknown = "run" in record ? record.run : undefined;
	if (run !== null && typeof run !== "string")
		throw new PlaybookError(tr("Launch info's run is neither a Run ID nor null", "启动信息中的 run 既不是 Run id，也不是 null"));
	return {
		run,
		kind: stringAt(record, "kind"),
		text: baselines.at(-1) ?? stringAt(result, "text"),
		blocks: strings("blocks" in record ? record.blocks : undefined, "blocks"),
		closed: closed !== null && closed !== undefined,
	};
}

function shellJson(value: Record<string, unknown>): string {
	return `'${JSON.stringify(value).replaceAll("'", "'\\''")}'`;
}

function textOf(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function unwrap(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

export function createPlaybook(deps: PlaybookDeps) {
	const context: PlaybookContext = {
		...(deps.doc ? { doc: deps.doc } : {}),
		...(deps.run ? { run: deps.run } : {}),
		...(deps.launch ? { launch: deps.launch } : {}),
	};
	const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
		const tool = deps.tool[name];
		if (!tool) throw new PlaybookError(tr(`Tool ${name} is not available in this session`, `本会话没有可用的 ${name} 工具`));
		return decode(await tool(args));
	};
	const docArg = (doc: string | undefined): { doc?: string } => {
		const file = doc ?? context.doc;
		return file === undefined ? {} : { doc: file };
	};
	const scope = (doc: string | undefined, run: string | undefined): { doc?: string; run?: string } => {
		const chosen = run ?? context.run;
		return { ...docArg(doc), ...(chosen ? { run: chosen } : {}) };
	};
	const readUrl = (
		doc: string | undefined,
		run: string | undefined,
		path?: string,
		query?: Readonly<Record<string, string | number | undefined>>,
	): Promise<unknown> => {
		const file = doc ?? context.doc;
		const host = file !== undefined ? encodeURIComponent(file) : "current";
		const segments: string[] = [];
		if (run) segments.push(run);
		if (path) segments.push(path);
		const pathname = segments.length > 0 ? `/${segments.join("/")}` : "";
		const search = new URLSearchParams();
		if (query) {
			for (const [key, value] of Object.entries(query)) {
				if (value !== undefined) search.set(key, String(value));
			}
		}
		const qs = search.toString();
		return call("read", { path: `playbook://${host}${pathname}${qs ? `?${qs}` : ""}:raw` });
	};
	const agentOptions = (request: AgentOptions): AgentOptions => {
		const { agent, label, schema, schemaMode, isolated } = request;
		return {
			...(agent !== undefined ? { agent } : {}),
			...(label !== undefined ? { label } : {}),
			...(schema !== undefined ? { schema } : {}),
			...(schemaMode !== undefined ? { schemaMode } : {}),
			...(isolated !== undefined ? { isolated } : {}),
		};
	};

	async function start(
		target: { doc?: string; run?: string },
		launch: string,
		blocks: readonly string[],
		prompt: string,
		options: AgentOptions,
		fresh: boolean,
	): Promise<Spawned> {
		let handle: AgentHandle;
		try {
			handle = await deps.agent(prompt, options);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (fresh) await call("playbook_launch", { ...docArg(target.doc), close_launch: launch });
			throw new PlaybookError(
				tr(
					`agent() failed for Launch ${launch}${fresh ? " (closed)" : ""}: ${reason}. When the default subagent is disabled, pass agent: "<name>", for example agent: "task:mid".`,
					`Launch ${launch}${fresh ? "（已关闭）" : ""} 的 agent() 失败：${reason}。默认 subagent 被禁用时，请传入 agent: "<name>"，例如 agent: "task:mid"。`,
				),
			);
		}
		await call("playbook_launch", { ...docArg(target.doc), bind_launch: launch, agent: handle.id });
		const spawned: Spawned = { ...target, launch, blocks, ownsLaunch: fresh, id: handle.id, handle };
		started.set(launch, [...(started.get(launch) ?? []), spawned]);
		return spawned;
	}

	async function agent(request: AgentRequest): Promise<Spawned> {
		const target = scope(request.doc, request.run);
		const launch = created(await call("playbook_launch", { ...target, blocks: [...request.blocks] }));
		if (launch.kind === "orchestration") {
			await call("playbook_launch", { ...docArg(target.doc), close_launch: launch.launch });
			const launchCmd = `playbook_launch --json ${shellJson({ ...target, blocks: [...request.blocks] })}`;
			throw new PlaybookError(
				tr(
					`${request.blocks.join(", ")} is an orchestration block (Launch ${launch.launch} closed): start it with \`${launchCmd}\` and run \`await playbook.exec("l<n>")\` as its own eval call`,
					`${request.blocks.join("、")} 是编排块（Launch ${launch.launch} 已关闭）：请用 \`${launchCmd}\` 启动，然后单独发一个 eval 执行 \`await playbook.exec("l<n>")\``,
				),
			);
		}
		const defaults: AgentOptions = {
			...(launch.agent !== undefined ? { agent: launch.agent } : {}),
			...(launch.isolated !== undefined ? { isolated: launch.isolated } : {}),
		};
		return start(target, launch.launch, request.blocks, launch.text, { ...defaults, ...agentOptions(request) }, true);
	}

	async function result(spawned: Spawned, options: { readonly block?: string; readonly close?: boolean } = {}): Promise<unknown> {
		const target = { ...docArg(spawned.doc), ...(spawned.run ? { run: spawned.run } : {}) };
		const block = options.block ?? (spawned.blocks.length === 1 ? spawned.blocks[0] : undefined);
		const about = { launch: spawned.launch, ...(block ? { block } : {}) };
		const finish = async (kind: "result" | "failure", text: string): Promise<void> => {
			await call("playbook_timeline", { ...target, kind, text, ...about });
			if (options.close ?? spawned.ownsLaunch) await call("playbook_launch", { ...docArg(spawned.doc), close_launch: spawned.launch });
		};
		let value: unknown;
		try {
			value = unwrap(await spawned.handle.wait());
		} catch (error) {
			await finish("failure", error instanceof Error ? error.message : String(error));
			throw error;
		}
		await finish("result", textOf(value));
		return value;
	}

	return {
		context,
		agent,
		result,

		async spawn(launch: string, request: AgentOptions & { readonly doc?: string } = {}): Promise<Spawned> {
			const info = launchInfo(await readUrl(request.doc, undefined, `launches/${launch}`));
			if (info.closed)
				throw new PlaybookError(tr(`${launch} is closed; start a new Launch instead`, `${launch} 已关闭；请改为启动新的 Launch`));
			if (info.kind === "orchestration")
				throw new PlaybookError(
					tr(`${launch} is an orchestration Launch; it is not a subagent prompt`, `${launch} 是编排 Launch，不是 subagent prompt`),
				);
			return start(scope(request.doc, info.run ?? undefined), launch, info.blocks, info.text, agentOptions(request), false);
		},

		async stop(launch: string, request: { readonly doc?: string } = {}): Promise<{ readonly cancelled: readonly string[] }> {
			const workers = started.get(launch) ?? [];
			if (workers.length === 0)
				throw new PlaybookError(
					tr(
						`No subagent of ${launch} was started in this session; stop it where it runs, then set its blocks back to todo with \`playbook_edit_structure --json '{"meta":{"block":"<id>","status":"todo"}}'\``,
						`本会话没有启动 ${launch} 的 subagent；请在其运行处停止它，然后用 \`playbook_edit_structure --json '{"meta":{"block":"<id>","status":"todo"}}'\` 将其块改回 todo`,
					),
				);
			for (const worker of workers) await worker.handle.cancel();
			started.delete(launch);
			const info = launchInfo(await readUrl(request.doc, undefined, `launches/${launch}`));
			const where = { ...docArg(request.doc), ...(info.run === null ? {} : { run: info.run }) };
			for (const block of info.blocks) {
				const current = objectOf(await readUrl(request.doc, info.run ?? undefined, block));
				if ("status" in current && current.status === "running")
					await call("playbook_edit_structure", { ...where, meta: { block, status: "todo" } });
			}
			return { cancelled: workers.map((worker) => worker.id) };
		},

		async run(request: AgentRequest & { readonly block?: string }): Promise<unknown> {
			const spawned = await agent(request);
			return result(spawned, request.block ? { block: request.block } : {});
		},

		post(request: {
			readonly doc?: string;
			readonly run?: string;
			readonly kind: RecordKind;
			readonly text: string;
			readonly block?: string;
			readonly launch?: string;
			readonly next?: number;
		}): Promise<unknown> {
			const { doc, run, ...entry } = request;
			return call("playbook_timeline", { ...scope(doc, run), ...entry });
		},

		timeline(
			request: { readonly doc?: string; readonly run?: string; readonly after?: number; readonly limit?: number } = {},
		): Promise<unknown> {
			const { doc, run, after, limit } = request;
			const chosen = run ?? context.run;
			return readUrl(doc, chosen, "timeline", { after, limit });
		},

		read(request: { readonly doc?: string; readonly run?: string; readonly block?: string } = {}): Promise<unknown> {
			const { doc, run, block } = request;
			const chosen = run ?? context.run;
			return readUrl(doc, chosen, block);
		},
	};
}
