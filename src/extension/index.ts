import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { parseBlockId, parseLaunchId, parseRunId, type BlockId, type LaunchId, type RunId } from "../domain/model";
import { socketPath, type EventPayload, type Request, type ServerFrame } from "../domain/protocol";
import { K1Client, type Reply } from "./client";
import { splitPane } from "../service/panes";
import { ensureTernPlugin, type TernPluginState } from "./tern-setup";

/** A block body that is one fenced js/py code block is an orchestration block (launch-events.md §1). */
const ORCHESTRATION = /^\s*```(js|py)\s*\n([\s\S]*)\n```\s*$/;

/** The main session's notice for what Tern setup did; nothing when the daemon already ran this version. */
function ternNotice(state: TernPluginState): { readonly text: string; readonly level: "info" | "warning" } | null {
	switch (state.kind) {
		case "current": return null;
		case "reloaded": return { text: `omp-playbooks: Tern 插件已从 ${state.from ?? "未加载"} 重新加载为 ${state.to}`, level: "info" };
		case "stale": return { text: `omp-playbooks: Tern 仍在运行插件 ${state.loaded ?? "未加载"}，磁盘上是 ${state.wanted}；手动执行 \`tern plugin reload\` 查看原因。\n${state.detail}`, level: "warning" };
		default: { const unreachable: never = state; return unreachable; }
	}
}

export default async function (pi: ExtensionAPI): Promise<void> {
	const ternState = await ensureTernPlugin();
	const z = pi.zod;
	const block = z.string().regex(/^b[1-9][0-9]*$/).transform(value => {
		const id = parseBlockId(value); if (id === null) throw new Error("Invalid block id"); return id;
	});
	const run = z.string().regex(/^r[1-9][0-9]*$/).transform(value => {
		const id = parseRunId(value); if (id === null) throw new Error("Invalid Run id"); return id;
	});
	const launch = z.string().regex(/^l[1-9][0-9]*$/).transform(value => {
		const id = parseLaunchId(value); if (id === null) throw new Error("Invalid Launch id"); return id;
	});
	const kind = z.enum(["update", "result", "failure", "retrospective"]);
	/** A task block's default agent, as K1 stores it: trimmed and not blank. */
	const agentName = z.string().trim().min(1);
	const positive = z.number().int().positive();
	const doc = z.string().optional();
	const report = z.union([
		z.object({ kind: z.literal("answers"), answers: z.record(z.string(), z.number()) }).strict(),
		z.object({ kind: z.literal("judge_unavailable") }).strict(),
	]);

	// K2 tools: one per authoritative object, each a closed `op` union with flat fields.
	const openParams = z.object({ doc: z.string() }).strict();
	const readParams = z.union([
		z.object({ doc, run: run.optional(), block: block.optional() }).strict(),
		z.object({ doc, run: run.optional(), op: z.literal("revisions"), block: block.optional(), after: z.number().int().nonnegative().optional() }).strict(),
	]);
	const editParams = z.union([
		z.object({ doc, run: run.optional(), op: z.literal("title"), block, value: z.string() }).strict(),
		z.object({ doc, run: run.optional(), op: z.literal("done"), block, value: z.boolean() }).strict(),
		z.object({ doc, run: run.optional(), op: z.literal("replace"), block, find: z.string(), replace: z.string() }).strict(),
		z.object({ doc, run: run.optional(), op: z.literal("write"), block, text: z.string() }).strict(),
		z.object({ doc, run: run.optional(), op: z.literal("panel"), block, panel: z.string().regex(/^[A-Z][0-9]*$/), text: z.string() }).strict(),
		z.object({ doc, run: run.optional(), op: z.literal("insert"), after: block.optional(), title: z.string(), body: z.string(), agent: agentName.optional(), isolated: z.boolean().optional() }).strict(),
		z.object({ doc, run: run.optional(), op: z.literal("insert_design"), after: block.optional(), title: z.string(), design: z.string() }).strict(),
		z.object({ doc, run: run.optional(), op: z.literal("delete"), block }).strict(),
		z.object({ doc, run: run.optional(), op: z.literal("move"), block, after: block.nullable() }).strict(),
		z.object({ doc, run: run.optional(), op: z.literal("agent"), block, value: agentName.nullable() }).strict(),
		z.object({ doc, run: run.optional(), op: z.literal("isolated"), block, value: z.boolean().nullable() }).strict(),
	]);
	const compileParams = z.union([
		z.object({ doc, run: run.optional(), op: z.literal("compile"), blocks: z.array(block) }).strict(),
		z.object({ doc, run: run.optional(), op: z.literal("refetch"), targets: z.array(z.string()) }).strict(),
	]);
	const checkParams = z.union([
		z.object({ doc, run: run.optional(), op: z.literal("inspect"), blocks: z.array(block) }).strict(),
		z.object({ doc, run: run.optional(), op: z.literal("report"), blocks: z.array(block), version: z.string(), result: report }).strict(),
	]);
	const runParams = z.union([
		z.object({ doc, op: z.literal("start"), name: z.string(), update_every: positive.optional() }).strict(),
		z.object({ doc, op: z.literal("finish"), run }).strict(),
		z.object({ doc, op: z.literal("list") }).strict(),
	]);
	const timelineParams = z.union([
		z.object({ doc, op: z.literal("read"), run, after: z.number().int().nonnegative().optional() }).strict(),
		z.object({ doc, op: z.literal("post"), run, kind, text: z.string(), block: block.optional(), launch: launch.optional(), next: positive.optional(), quote: z.string().optional() }).strict(),
		z.object({ doc, op: z.literal("snooze"), run, after: positive }).strict(),
	]);
	const launchParams = z.union([
		z.object({ doc, op: z.literal("launch"), run, blocks: z.array(block) }).strict(),
		z.object({ doc, op: z.literal("bind"), launch, agent: z.string() }).strict(),
		z.object({ doc, op: z.literal("info"), launch }).strict(),
		z.object({ doc, op: z.literal("rebase"), launch }).strict(),
		z.object({ doc, op: z.literal("close"), launch }).strict(),
	]);

	const site = z.object({ block, reference: z.string() });
	const compileError = z.union([
		z.object({ kind: z.literal("UnknownBlock"), block, at: site }),
		z.object({ kind: z.literal("UnknownTarget"), at: site }),
		z.object({ kind: z.literal("BadExpression"), reason: z.string(), at: site }),
		z.object({ kind: z.literal("Cycle"), path: z.array(block), at: site }),
		z.object({ kind: z.literal("TooDeep"), at: site }),
		z.object({ kind: z.literal("NoResult"), block, at: site }),
		z.object({ kind: z.literal("FetchFailed"), target: z.string(), error: z.string(), at: site }),
	]);
	const sourceFields = { target: z.string(), expression: z.string().nullable() };
	const source = z.union([
		z.object({ kind: z.literal("block"), ...sourceFields }),
		z.object({ kind: z.literal("result"), ...sourceFields, seq: z.number(), origin: z.enum(["human", "coordinator", "disk", "service"]), launch: launch.nullable() }),
		z.object({ kind: z.literal("external"), ...sourceFields, fetchedAt: z.number() }),
	]);
	const events = z.union([
		z.object({ event: z.literal("block_changed"), data: z.object({ id: z.string(), launch: z.object({ id: launch, kind: z.enum(["prompt", "orchestration"]), run }), agents: z.array(z.string()), changed: z.array(block), diff: z.string(), current: z.union([
			z.object({ kind: z.literal("Ok"), text: z.string(), sources: z.array(source) }),
			z.object({ kind: z.literal("Err"), error: compileError }),
		]) }) }),
		z.object({ event: z.literal("launch_requested"), data: z.object({ run, blocks: z.array(block) }) }),
		z.object({ event: z.literal("check_requested"), data: z.object({ run: run.nullable(), blocks: z.array(block) }) }),
		z.object({ event: z.literal("run_started"), data: z.object({ run, name: z.string() }) }),
		z.object({ event: z.literal("run_finished"), data: z.object({ run }) }),
		z.object({ event: z.literal("done_changed"), data: z.object({ run, block, done: z.boolean() }) }),
		z.object({ event: z.literal("update_due"), data: z.object({ run, due: z.number(), last_update: z.number().nullable() }) }),
		z.object({ event: z.literal("interrupted"), data: z.object({ run: run.optional(), block, request: z.string() }) }),
		z.object({ event: z.literal("revision_requested"), data: z.object({ run: run.optional(), block, revision: positive }) }),
	]);
	const error = z.object({ code: z.enum(["Busy", "NotHello", "Locked", "NotLocked", "UnknownBlock", "UnknownRun", "RunFinished", "BadValue", "NotFound", "Ambiguous", "BadLaunch", "CompileError", "UnknownTarget", "BadReport", "UnknownLaunch", "NotOwner", "UnknownEvent", "RevealFailed"]), message: z.string(), detail: z.unknown().optional() });
	const frames = z.union([events, z.object({ id: z.string(), ok: z.literal(true), result: z.unknown().optional() }).strict().transform(frame => ({ ...frame, result: frame.result })), z.object({ id: z.string(), ok: z.literal(false), error }).strict()]);
	const summary = z.object({ id: run, name: z.string(), status: z.enum(["running", "finished"]), started_at: z.number(), finished_at: z.number().nullable(), done: z.number(), total: z.number(), update_due: z.number().nullable(), update_overdue: z.boolean(), retrospective: z.boolean() });
	const runsResult = z.object({ runs: z.array(summary) });
	const helloResult = z.object({ blocks: z.array(block), runs: z.array(summary), pane: z.string().optional() });
	const wireBlock = z.union([
		z.object({ id: block, kind: z.literal("task"), title: z.string(), body: z.string(), agent: z.string().optional(), isolated: z.boolean().optional(), done: z.boolean() }),
		z.object({ id: block, kind: z.literal("design"), title: z.string(), requirement: z.string(), design: z.string(), done: z.boolean() }),
	]);
	const readResult = z.object({ title: z.string(), blocks: z.array(wireBlock) });
	const revisionsResult = z.object({ revisions: z.array(z.object({ seq: positive, at: z.number(), block, prompt: z.string() })) });
	const postResult = z.object({ seq: positive });
	const launchRecord = z.object({ id: launch, run, session: z.string(), kind: z.enum(["prompt", "orchestration"]), snapshot: z.object({ result: z.object({ text: z.string() }) }), baselines: z.array(z.string()).optional() });
	const evalInput = z.object({ language: z.enum(["js", "py"]), code: z.string(), title: z.string().optional(), timeout: z.number().optional(), reset: z.boolean().optional() });

	const clients = new Map<string, K1Client>();
	let session: string | undefined;
	let stopped = false;

	/** Absolute Playbook path for a tool call: the given file, else the only connected document. */
	async function documentFor(file: string | undefined): Promise<string> {
		if (file !== undefined) {
			try { return await realpath(file); }
			catch { throw new Error(`NoService: cannot resolve Playbook ${file}`); }
		}
		const connected = [...clients.entries()].filter(([, client]) => client.connected).map(([path]) => path);
		if (connected.length === 1) return connected[0]!;
		throw new Error(connected.length === 0 ? "NoService: no Playbook is open in this session; pass doc or call playbook_open first" : `NoService: several Playbooks are open (${connected.join(", ")}); pass doc`);
	}

	async function clientFor(absolute: string, ctx: ExtensionContext): Promise<K1Client> {
		if (stopped) throw new Error("Disconnected: coordinator session has ended");
		const currentSession = ctx.sessionManager.getSessionId();
		if (session !== undefined && session !== currentSession) {
			for (const client of clients.values()) client.close();
			clients.clear();
		}
		session = currentSession;
		let client = clients.get(absolute);
		if (!client) {
			client = new K1Client(socketPath(tmpdir(), absolute), { session: currentSession, ...(process.env.TERN_PANE ? { pane: process.env.TERN_PANE } : {}) }, (input): ServerFrame => frames.parse(input), async (event: EventPayload) => {
				// A human interrupt only revokes the lock of an in-flight playbook_edit, whose
				// mutation then fails with NotLocked; nothing else in this session depends on it.
				if (event.event === "interrupted") return;
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
		const pane = process.env.TERN_PANE;
		if (!pane) return startFailed("omp is not running in a Tern pane hosted by the session daemon (no TERN_PANE), so it cannot open the document service beside this session. Start it yourself in a Tern pane with `bun " + serviceEntry + " <playbook.yaml>`, then call playbook_open again from this session to connect");
		const split = await splitPane(pane, dirname(absolute), ["bun", serviceEntry, absolute]);
		if (!split.ok) return startFailed(split.error);
		const deadline = Date.now() + OPEN_WAIT_MS;
		for (;;) {
			await Bun.sleep(250);
			const next = await client.connect();
			if (next.ok || next.error.code !== "NoService") return next;
			if (Date.now() >= deadline) return startFailed(`The document service in Tern pane ${split.pane} did not listen within ${OPEN_WAIT_MS / 1000} s; its pane shows why`);
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
			return { ...changed, error: { ...changed.error, message: "The person took this block back (interrupt) before the change landed; nothing was applied. Read the block again before deciding whether to edit it." } };
		}
		return changed;
	}

	const scoped = (value: RunId | undefined): { run?: RunId } => value === undefined ? {} : { run: value };

	type ToolResult = { content: { type: "text"; text: string }[]; isError: boolean };
	const reply = (value: Reply): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value.ok ? value.result ?? null : { error: value.error }) }], isError: !value.ok });
	const failure = (thrown: unknown): ToolResult => {
		const message = thrown instanceof Error ? thrown.message : String(thrown);
		const code = message.startsWith("Disconnected:") ? "Disconnected" : "NoService";
		return reply({ id: "", ok: false, error: { code, message } });
	};

	// Model-facing text: what the Playbook is, then the one working order across the tools.
	const overview = "omp-playbooks: a Playbook is a YAML prompt document the user and you edit together; a document service shows it as form cards in a Tern pane beside this session. Use the playbook_* tools when the user wants to write, review or run multi-step agent work as a Playbook, or points at a Playbook .yaml file.";
	const format = "File format: `title: <text>` and `blocks:` a list of blocks of two kinds, each written as YAML block scalars (`|`). A task block `{id: b<n>, title, body, done: false}` is a prompt that runs: `body` is Markdown and may reference `((b2))` (another block), `((file:path | lines(1..40)))` (path relative to the Playbook) or `((https://github.com/o/r/issues/1))`; a body that is exactly one ```js or ```py fenced block is an orchestration block. A design block `{id: b<n>, title, requirement, design, done: false}` is one design or business unit: `requirement` is the person's, written only by them; `design` is yours, written in answer-me-with-html draft format (optional `---` frontmatter with template sheet|doc, title, subtitle, cols; a lead; `## A Panel title {span=2 meta=\"…\"}` panels; Markdown with tables (status words ok/no/warn), `$…$`/`$$` math and `![alt](path)` images; fences flow, er, sequence, tree, timeline, limits, annot, kv, callout, ask, diff, html, svg, and code blocks with src=/lines=/hl=; flow/er/tree lines may start with `+ ` `- ` `~ ` change markers) and drawn in the pane; it never expands `((…))`. Task blocks pull designs in by reference: `((b3))` (requirement and design), `((b3 | requirement))`, `((b3 | design))` or `((b3 | panel(A)))`, where A is a letter ID written in that panel's heading (write IDs on every panel a task may reference). Design blocks cannot be launched themselves.";
	const order = "Order: write the YAML, playbook_open it, playbook_read/playbook_edit blocks, playbook_run {op:\"start\"} to copy the template into a Run (r<n>), then run blocks of that Run from eval: a prompt block with `var worker = await playbook.agent({ run: \"r1\", blocks: [\"b2\"] })` (returns once the subagent is started and bound) and, after it finishes, `await playbook.result(worker)` in a later eval (records the result on the block and closes the Launch), or in one blocking call `await playbook.run({ run: \"r1\", blocks: [\"b2\"] })`; an orchestration block with playbook_launch {op:\"launch\"} and then an eval whose whole code is `await playbook.exec(\"l<n>\")`. `doc` may be omitted while exactly one Playbook is open.";
	const evalHelp = "In eval, `playbook` is provided automatically: the extension adds the `var playbook = …` first line to any JS cell that uses it, so do not write that line yourself. playbook.agent({run, blocks, agent?, isolated?, label?, schema?}) → {launch, blocks, id, handle} without waiting: keep it in a top-level `var` and wait with the top-level `wait` tool, so panel notices (revision requests, block changes) still reach you while the subagent works; then `await playbook.result(worker, {block?, close?})` in a later eval records the result (or failure) on the given block, by default the Launch's only block, and closes the Launch that playbook.agent created. Options left out come from the block's preset `agent`/`isolated`; pass agent: \"<name>\" (for example \"task:mid\") when the default subagent is disabled and the block sets none. playbook.run({...}) = agent + result in one blocking call. playbook.spawn(launch, {...}) adds a subagent to an open prompt Launch using its current baseline (after rebase, the rebased text); its result does not close the shared Launch unless {close: true}. playbook.post({run, kind, text, block?, launch?}); playbook.timeline({run, after?}); playbook.read({run?, block?}); inside an orchestration Launch, playbook.context is {doc, run, launch}.";

	type Tool<T> = { readonly name: string; readonly label: string; readonly description: string; readonly parameters: { parse(value: unknown): T }; run(params: T, ctx: ExtensionContext): Promise<Reply> };
	const tools = [
		{
			name: "playbook_open", label: "Playbook: open", parameters: openParams,
			description: `${overview} ${format} ${order} ${evalHelp} playbook_open {doc} connects this session to the Playbook file, opening its document service in a new Tern pane beside this session when none runs; this session then is the Playbook's coordinator. Result: the template's block ids and the Runs.`,
			run: (params, ctx) => open(params.doc, ctx),
		} satisfies Tool<{ doc: string }>,
		{
			name: "playbook_read", label: "Playbook: read", parameters: readParams,
			description: "Read a Playbook's committed blocks: all blocks `{title, blocks}` (with the Run's state when `run` is given) or one `block`; each block has `kind` task (body) or design (requirement, design). Omit `run` for the template. No lock needed. op revisions {block?, after?} returns the person's change requests for design blocks `{revisions: [{seq, at, block, prompt}]}` — they are not part of a normal read; query them when a revision_requested notice arrives or you need the history.",
			run: (params, ctx) => "op" in params
				? request(params.doc, ctx, { op: "revisions", args: { ...scoped(params.run), ...(params.block ? { block: params.block } : {}), ...(params.after !== undefined ? { after: params.after } : {}) } })
				: request(params.doc, ctx, { op: "read", args: { ...scoped(params.run), ...(params.block ? { block: params.block } : {}) } }),
		} satisfies Tool<ReturnType<typeof readParams.parse>>,
		{
			name: "playbook_edit", label: "Playbook: edit", parameters: editParams,
			description: "Change one block of the template (or of Run `run`). op title {block, value}; done {block, value: boolean}; replace {block, find, replace} where find occurs exactly once in your field (a task's body, a design's draft); write {block, text} replaces your field whole; panel {block, panel, text} replaces one design panel addressed by the letter ID its heading writes, `text` being that whole panel starting with `## <ID> Title`; insert {after?, title, body, agent?, isolated?} adds a task block, insert_design {after?, title, design} adds a design block whose requirement starts empty (the person writes it) → {block}; delete {block}; move {block, after: <block> or null for the top} reorders; agent {block, value: <agent name> or null} and isolated {block, value: boolean or null} set or clear a task block's execution contract, the defaults playbook.agent/playbook.run use for its subagent (design blocks have none). A design's requirement is never yours to change. Each call locks the block, applies the change and unlocks it; `Locked` means the person is editing that block now, so read it later instead of retrying at once.",
			run: (params, ctx) => {
				switch (params.op) {
					case "insert": return request(params.doc, ctx, { op: "insert", args: { ...scoped(params.run), ...(params.after ? { after: params.after } : {}), title: params.title, content: { kind: "task", body: params.body, ...(params.agent !== undefined ? { agent: params.agent } : {}), ...(params.isolated !== undefined ? { isolated: params.isolated } : {}) } } });
					case "insert_design": return request(params.doc, ctx, { op: "insert", args: { ...scoped(params.run), ...(params.after ? { after: params.after } : {}), title: params.title, content: { kind: "design", design: params.design } } });
					case "write": return editBlock(params.doc, ctx, { ...scoped(params.run), block: params.block }, { op: "write", args: { ...scoped(params.run), block: params.block, text: params.text } });
					case "panel": return editBlock(params.doc, ctx, { ...scoped(params.run), block: params.block }, { op: "panel", args: { ...scoped(params.run), block: params.block, panel: params.panel, text: params.text } });
					case "title": return editBlock(params.doc, ctx, { ...scoped(params.run), block: params.block }, { op: "set", args: { ...scoped(params.run), block: params.block, field: "title", value: params.value } });
					case "done": return editBlock(params.doc, ctx, { ...scoped(params.run), block: params.block }, { op: "set", args: { ...scoped(params.run), block: params.block, field: "done", value: params.value } });
					case "replace": return editBlock(params.doc, ctx, { ...scoped(params.run), block: params.block }, { op: "edit", args: { ...scoped(params.run), block: params.block, find: params.find, replace: params.replace } });
					case "delete": return editBlock(params.doc, ctx, { ...scoped(params.run), block: params.block }, { op: "delete", args: { ...scoped(params.run), block: params.block } });
					case "move": return editBlock(params.doc, ctx, { ...scoped(params.run), block: params.block }, { op: "move", args: { ...scoped(params.run), block: params.block, after: params.after } });
					case "agent": return editBlock(params.doc, ctx, { ...scoped(params.run), block: params.block }, { op: "set", args: { ...scoped(params.run), block: params.block, field: "agent", value: params.value } });
					case "isolated": return editBlock(params.doc, ctx, { ...scoped(params.run), block: params.block }, { op: "set", args: { ...scoped(params.run), block: params.block, field: "isolated", value: params.value } });
				}
			},
		} satisfies Tool<ReturnType<typeof editParams.parse>>,
		{
			name: "playbook_compile", label: "Playbook: compile", parameters: compileParams,
			description: "compile {blocks} returns the exact prompt the blocks produce (references expanded), without starting anything; refetch {targets} fetches external references (GitHub, URLs) again.",
			run: (params, ctx) => params.op === "compile"
				? request(params.doc, ctx, { op: "compile", args: { ...scoped(params.run), blocks: params.blocks } })
				: request(params.doc, ctx, { op: "refetch", args: { ...scoped(params.run), targets: params.targets } }),
		} satisfies Tool<ReturnType<typeof compileParams.parse>>,
		{
			name: "playbook_check", label: "Playbook: check", parameters: checkParams,
			description: "inspect {blocks} returns the blocks' deterministic findings, the judge questions and a `version`; answer the questions with `judge` in eval, then report {blocks, version, result: {kind: \"answers\", answers: {<question id>: P(yes)}} or {kind: \"judge_unavailable\"}}.",
			run: (params, ctx) => params.op === "inspect"
				? request(params.doc, ctx, { op: "inspect", args: { ...scoped(params.run), blocks: params.blocks } })
				: request(params.doc, ctx, { op: "report", args: { ...scoped(params.run), blocks: params.blocks, version: params.version, result: params.result } }),
		} satisfies Tool<ReturnType<typeof checkParams.parse>>,
		{
			name: "playbook_run", label: "Playbook: Run", parameters: runParams,
			description: "start {name, update_every?} copies the template into a new Run and returns its id; finish {run} ends it; list returns the Run summaries.",
			run: (params, ctx) => {
				switch (params.op) {
					case "start": return request(params.doc, ctx, { op: "start_run", args: { name: params.name, ...(params.update_every !== undefined ? { update_every: params.update_every } : {}) } });
					case "finish": return request(params.doc, ctx, { op: "finish_run", args: { run: params.run } });
					case "list": return request(params.doc, ctx, { op: "runs", args: {} });
				}
			},
		} satisfies Tool<ReturnType<typeof runParams.parse>>,
		{
			name: "playbook_timeline", label: "Playbook: timeline", parameters: timelineParams,
			description: "A Run's timeline. read {run, after?} returns entries after a sequence number; post {run, kind: update|result|failure|retrospective, text, block?, launch?, next?, quote?} writes a record (`next`: seconds until the next update, only for update); snooze {run, after} postpones the update reminder by `after` seconds.",
			run: (params, ctx) => {
				switch (params.op) {
					case "read": return request(params.doc, ctx, { op: "timeline", args: { run: params.run, ...(params.after !== undefined ? { after: params.after } : {}) } });
					case "post": {
						const { doc: _doc, op: _op, ...entry } = params;
						return request(params.doc, ctx, { op: "post", args: entry });
					}
					case "snooze": return request(params.doc, ctx, { op: "snooze", args: { run: params.run, after: params.after } });
				}
			},
		} satisfies Tool<ReturnType<typeof timelineParams.parse>>,
		{
			name: "playbook_launch", label: "Playbook: Launch", parameters: launchParams,
			description: "A Launch is the frozen prompt of Run blocks that subagents work from; the person's later edits to those blocks arrive here as block_changed notices. launch {run, blocks} → {launch, kind, text, agent?, isolated?} (agent/isolated: the execution contract every block presets; prefer `playbook.agent`/`playbook.run` in eval, which also start and bind the subagent and apply that contract); bind {launch, agent}; info {launch} → the full record; rebase {launch} accepts the current text as the new baseline, which playbook.spawn and playbook.exec then use; close {launch} ends it (playbook.result closes the Launch playbook.agent created).",
			run: (params, ctx) => {
				switch (params.op) {
					case "launch": return request(params.doc, ctx, { op: "launch", args: { run: params.run, blocks: params.blocks } });
					case "bind": return request(params.doc, ctx, { op: "bind", args: { launch: params.launch, agent: params.agent } });
					case "info": return request(params.doc, ctx, { op: "launch_info", args: { launch: params.launch } });
					case "rebase": return request(params.doc, ctx, { op: "rebase", args: { launch: params.launch } });
					case "close": return request(params.doc, ctx, { op: "close", args: { launch: params.launch } });
				}
			},
		} satisfies Tool<ReturnType<typeof launchParams.parse>>,
	] as const;

	function registerTools(): void {
		for (const tool of tools) {
			pi.registerTool({
				name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					try {
						// Each entry pairs its own schema with its own runner.
						const run = tool.run as (value: unknown, context: ExtensionContext) => Promise<Reply>;
						return reply(await run(tool.parameters.parse(params), ctx));
					} catch (thrown) { return failure(thrown); }
				},
			});
		}
	}

	/** Event aside: header line, the next call to make, then the data (launch-events.md §6). */
	async function notice(absolute: string, event: Exclude<EventPayload, { event: "interrupted" }>): Promise<string> {
		const header = "这是 Playbook 文档服务的通知，不是用户消息";
		const docLiteral = JSON.stringify(absolute);
		let next: string;
		switch (event.event) {
			case "launch_requested": {
				const blocks = JSON.stringify(event.data.blocks);
				const bodies = await clients.get(absolute)?.request({ op: "read", args: { run: event.data.run } });
				const parsed = bodies?.ok ? readResult.safeParse(bodies.result) : undefined;
				const requested = parsed?.success === true ? parsed.data.blocks.filter(item => event.data.blocks.includes(item.id)) : [];
				const orchestration = requested.some(item => item.kind === "task" && ORCHESTRATION.test(item.body));
				const only = requested.length === 1 && requested[0]!.kind === "task" ? requested[0]! : null;
				const preset = only && (only.agent !== undefined || only.isolated !== undefined)
					? `块 ${only.id} 已预设${only.agent !== undefined ? ` agent: "${only.agent}"` : ""}${only.isolated !== undefined ? ` isolated: ${only.isolated}` : ""}，不显式传参时 playbook.agent / playbook.run 自动使用。`
					: "";
				const call = `{ doc: ${docLiteral}, run: "${event.data.run}", blocks: ${blocks} }`;
				next = orchestration
					? `人请求启动编排块 ${blocks}。下一步：调用 playbook_launch {doc: ${docLiteral}, op: "launch", run: "${event.data.run}", blocks: ${blocks}} 得到 l<n>，再单独发一个 eval，代码只写 \`await playbook.exec("l<n>")\`。`
					: `人请求启动 Run ${event.data.run} 的块 ${blocks}。${preset}下一步二选一：① 不阻塞：在 eval 中 \`var worker = await playbook.agent(${call})\`，启动并绑定后立即返回；用顶层 wait 等它，期间仍能处理面板通知；结束后另发 eval \`await playbook.result(worker)\` 记录结果并关闭 Launch。② 单步：\`await playbook.run(${call})\` 启动、等待、记录并关闭。默认 subagent 被禁用且块没有预设 agent 时加上 \`agent: "<可用的 agent>"\`（例如 "task:mid"）。eval 单元开头那行 \`var playbook = …\` 由扩展自动加入，不要自己再写。`;
				break;
			}
			case "block_changed":
				next = `人修改了 Launch ${event.data.launch.id} 依赖的块 ${JSON.stringify(event.data.changed)}（diff 见下）。可以：调用 playbook_launch {op: "rebase", launch: "${event.data.launch.id}"} 接受当前文本为新基线（之后 playbook.spawn 与 playbook.exec 使用它）；告诉仍在运行的 subagent；或不处理。`;
				break;
			case "check_requested":
				next = `人请求检查块 ${JSON.stringify(event.data.blocks)}。下一步：playbook_check {op: "inspect"} 取得问题与 version，在 eval 中用 judge 回答，再 playbook_check {op: "report"}。`;
				break;
			case "update_due":
				next = `Run ${event.data.run} 的状态更新到期。下一步：playbook_timeline {op: "post", run: "${event.data.run}", kind: "update", text: ...} 写更新，或 {op: "snooze"} 推迟。`;
				break;
			case "revision_requested": {
				const where = event.data.run === undefined ? "模板" : `Run ${event.data.run}`;
				const scope = event.data.run === undefined ? "" : `run: "${event.data.run}", `;
				const answer = await clients.get(absolute)?.request({ op: "revisions", args: { ...scoped(event.data.run), block: event.data.block, after: event.data.revision - 1 } });
				const found = answer?.ok ? revisionsResult.safeParse(answer.result) : undefined;
				const prompt = found?.success ? found.data.revisions.find(item => item.seq === event.data.revision)?.prompt : undefined;
				const history = `playbook_read {doc: ${docLiteral}, ${scope}op: "revisions", block: "${event.data.block}"}`;
				next = `人对${where}的设计块 ${event.data.block} 提交了修改 prompt #${event.data.revision}${prompt === undefined ? `（读取失败，用 ${history} 查询）` : `：\n<prompt>\n${prompt}\n</prompt>`}\n下一步：playbook_read {doc: ${docLiteral}, ${scope}block: "${event.data.block}"} 读需求与当前设计稿，按 prompt 修订设计：用 playbook_edit 的 write、replace 或 panel 改 design；不要改 requirement。prompt 回答了设计稿中的 \`ask\` 时，把那个 ask 围栏替换为对应的设计结论。需要以前的修改要求时用 ${history}。`;
				break;
			}
			case "run_started": case "run_finished": case "done_changed":
				next = "无需动作；需要时用 playbook_timeline 记录。";
				break;
		}
		return `${header}\n${next}\n${JSON.stringify({ doc: absolute, ...event })}`;
	}

	// The Playbook-specific eval layer (K2 "eval 辅助"): only in the coordinator session.
	const usesHelpers = /\bplaybook\.(?:run|agent|result|spawn|post|timeline|read|context)\b/;
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
			if (launchId === null) return { block: true, reason: `${exec[1]} is not a Launch id` };
			let absolute: string;
			try { absolute = await documentFor(exec[3]); }
			catch (thrown) { return { block: true, reason: thrown instanceof Error ? thrown.message : String(thrown) }; }
			const info = await (await clientFor(absolute, ctx)).request({ op: "launch_info", args: { launch: launchId } });
			if (!info.ok) return { block: true, reason: `${info.error.code}: ${info.error.message}` };
			const record = launchRecord.parse(info.result);
			if (record.kind !== "orchestration") return { block: true, reason: `${launchId} is a prompt Launch; start its subagent with \`await playbook.spawn("${launchId}")\` or \`playbook.run\`` };
			// The latest baseline: the frozen snapshot until a rebase accepted newer code.
			const fence = ORCHESTRATION.exec(record.baselines?.at(-1) ?? record.snapshot.result.text);
			if (!fence) return { block: true, reason: `${launchId} has no fenced js/py code in its snapshot` };
			const context = { doc: absolute, run: record.run, launch: launchId };
			const code = fence[1] === "js"
				? `// playbook.exec("${launchId}") replaced by the Launch's orchestration code (its latest baseline).\n` + importLine(context) + fence[2]!
				: `# Added by the omp-playbooks extension: playbook.exec("${launchId}") replaced by the Launch's orchestration code (its latest baseline).\nPLAYBOOK_DOC = ${JSON.stringify(absolute)}\nPLAYBOOK_RUN = ${JSON.stringify(record.run)}\nPLAYBOOK_LAUNCH = ${JSON.stringify(launchId)}\n${fence[2]!}`;
			return { input: { ...input, language: fence[1], code, timeout: 0, title: input.title ?? `Playbook ${launchId}` } };
		}
		if (/\bplaybook\.exec\s*\(/.test(input.code)) {
			return { block: true, reason: "playbook.exec must be the whole eval code: `await playbook.exec(\"l<n>\")`" };
		}
		if (input.language !== "js" || !usesHelpers.test(input.code) || input.code.includes(preludeEntry)) return;
		return { input: { ...input, code: importLine({}) + input.code, ...(input.timeout === undefined && waits.test(input.code) ? { timeout: 0 } : {}) } };
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent.kind !== "main") return;
		registerTools();
		registerCommands();
		const notice = ternNotice(ternState);
		if (notice) ctx.ui.notify(notice.text, notice.level);
	});

	pi.on("session_shutdown", () => {
		stopped = true;
		for (const client of clients.values()) client.close();
		clients.clear();
	});

	async function commandClient(args: string, ctx: ExtensionContext): Promise<K1Client | undefined> {
		let file = args.trim();
		if (!file) {
			const connected = [...clients.entries()].filter(([, client]) => client.connected);
			if (connected.length === 1) file = connected[0]![0];
			else if (connected.length > 1) { const selected = await ctx.ui.select("Choose Playbook", connected.map(([path]) => path)); if (selected === undefined) return; file = selected; }
			else { ctx.ui.notify("请指定 Playbook 文件路径", "error"); return; }
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
		description: "Add a recent session message to a Playbook Run timeline",
		handler: async (args, ctx) => {
			try {
				const client = await commandClient(args, ctx); if (!client) return;
				const messages = ctx.sessionManager.getBranch().flatMap(entry => {
					if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) return [];
					const content = entry.message.content;
					const text = typeof content === "string" ? content : content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
					return text ? [{ id: entry.id, text, label: `${entry.id}: ${text.replace(/\s+/g, " ").slice(0, 90)}` }] : [];
				}).slice(-20).reverse();
				if (!messages.length) { ctx.ui.notify("No user or assistant messages with text", "warning"); return; }
				const messageLabel = await ctx.ui.select("Choose session message", messages.map(message => message.label)); if (messageLabel === undefined) return;
				const message = messages.find(item => item.label === messageLabel); if (!message) throw new Error("Unknown message selection");
				const runs = runsResult.parse(await result(client, { op: "runs", args: {} })).runs;
				if (!runs.length) { ctx.ui.notify("This Playbook has no Runs", "warning"); return; }
				const runChoices = runs.map(item => ({ id: item.id, label: `${item.id}: ${item.name} (${item.status})` }));
				const runLabel = await ctx.ui.select("Choose Run", runChoices.map(item => item.label)); if (runLabel === undefined) return;
				const chosenRun = runChoices.find(item => item.label === runLabel); if (!chosenRun) throw new Error("Unknown Run selection");
				const kindLabel = await ctx.ui.select("Choose record kind", ["update", "result", "failure", "retrospective"]); if (kindLabel === undefined) return;
				const chosenKind = kind.parse(kindLabel);
				const document = readResult.parse(await result(client, { op: "read", args: { run: chosenRun.id } }));
				const blockChoices = document.blocks.map(item => ({ id: item.id, label: `${item.id}: ${item.title}` }));
				const blockLabel = await ctx.ui.select("Choose block", ["不关于块", ...blockChoices.map(item => item.label)]); if (blockLabel === undefined) return;
				const chosenBlock = blockLabel === "不关于块" ? undefined : blockChoices.find(item => item.label === blockLabel)?.id;
				if (blockLabel !== "不关于块" && chosenBlock === undefined) throw new Error("Unknown block selection");
				const posted = postResult.parse(await result(client, { op: "post", args: { run: chosenRun.id, kind: chosenKind, text: message.text, ...(chosenBlock ? { block: chosenBlock } : {}), quote: message.id, origin: "human" } }));
				ctx.ui.notify(`Playbook timeline entry ${posted.seq} written`, "info");
			} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
		},
	});
	pi.registerCommand("playbook-show", {
		description: "Focus the Playbook document pane in Tern",
		handler: async (args, ctx) => {
			try {
				const client = await commandClient(args, ctx); if (!client) return;
				const hello = helloResult.parse(client.hello);
				if (!hello.pane) { ctx.ui.notify("文档服务不在 session daemon 托管的 pane 中", "error"); return; }
				if (!process.env.TERN_PANE) throw new Error("Playbook focus requires a coordinator Tern pane");
				const child = Bun.spawn(["tern", "focus", hello.pane, "--json"], { env: process.env, stdout: "pipe", stderr: "pipe" });
				const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
				if (exit !== 0) throw new Error(`tern focus exited ${exit}: ${stderr.trim()}`);
			} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
		},
	});
	}
}
