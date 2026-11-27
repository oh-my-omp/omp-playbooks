import type * as zod from "@oh-my-pi/omptype/zod";
import type { EvalToolParams } from "@oh-my-pi/pi-coding-agent";
import { tr } from "../../omomp-shared/i18n";
import { verbatim } from "../../omomp-shared/tool-entry";
import {
	type BlockId,
	type JudgeReport,
	type LaunchId,
	parseBlockId,
	parseLaunchId,
	parseRunId,
	type RecordKind,
	type RunId,
	type Status,
} from "../domain/model";

type Zod = typeof zod;

const BLOCK_ID = /^b[1-9][0-9]*$/;
const RUN_ID = /^r[1-9][0-9]*$/;
const LAUNCH_ID = /^l[1-9][0-9]*$/;
const PANEL_TARGET = /^(?:[A-Z][0-9]*|where|what|how)$/;

export function toolParameters(z: Zod) {
	const block = z
		.string()
		.regex(BLOCK_ID)
		.transform((value) => {
			const id = parseBlockId(value);
			if (id === null) throw new Error(tr("Invalid block id", "块 id 无效"));
			return id;
		});
	const run = z
		.string()
		.regex(RUN_ID)
		.transform((value) => {
			const id = parseRunId(value);
			if (id === null) throw new Error(tr("Invalid Run id", "Run id 无效"));
			return id;
		});
	const launch = z
		.string()
		.regex(LAUNCH_ID)
		.transform((value) => {
			const id = parseLaunchId(value);
			if (id === null) throw new Error(tr("Invalid Launch id", "Launch id 无效"));
			return id;
		});
	const positive = z.number().int().positive();
	const agentName = z.string().trim().min(1);

	const docField = z
		.string()
		.describe("Playbook file path. Omit while exactly one Playbook is open in this session; that one is used.")
		.optional();
	const runField = z.string().regex(RUN_ID).describe("Run id `r<n>` (for example `r2`). Omit to work in the Playbook itself.").optional();
	const blockField = z.string().regex(BLOCK_ID);
	const launchField = z.string().regex(LAUNCH_ID);
	const blocksField = z.array(z.string().regex(BLOCK_ID));
	const isolationField = z.enum(["none", "worktree"]);
	const statusField = z.enum(["todo", "running", "done"]);
	const recordKindField = z.enum(["update", "result", "failure", "retrospective"]);

	// Wire schemas for K1 IPC validation
	const site = z.object({ block, reference: z.string() });
	const compileError = z.union([
		z.object({ kind: z.literal("UnknownBlock"), block, at: site }),
		z.object({ kind: z.literal("UnknownTarget"), at: site }),
		z.object({ kind: z.literal("BadExpression"), reason: z.string(), at: site }),
		z.object({ kind: z.literal("Cycle"), path: z.array(block), at: site }),
		z.object({ kind: z.literal("TooDeep"), at: site }),
		z.object({ kind: z.literal("NoResult"), block, at: site }),
		z.object({ kind: z.literal("FetchFailed"), target: z.string(), error: z.string(), at: site }),
		z.object({ kind: z.literal("UnknownSlot"), block, slot: z.string(), at: site }),
	]);
	const sourceFields = { target: z.string(), expression: z.string().nullable() };
	const source = z.union([
		z.object({ kind: z.literal("block"), ...sourceFields }),
		z.object({
			kind: z.literal("result"),
			...sourceFields,
			seq: z.number(),
			origin: z.enum(["human", "coordinator", "disk", "service"]),
			launch: launch.nullable(),
		}),
		z.object({ kind: z.literal("external"), ...sourceFields, fetchedAt: z.number() }),
	]);
	const events = z.union([
		z.object({
			event: z.literal("block_changed"),
			data: z.object({
				id: z.string(),
				launch: z.object({ id: launch, kind: z.enum(["prompt", "orchestration"]), run: run.optional() }),
				agents: z.array(z.string()),
				changed: z.array(block),
				diff: z.string(),
				current: z.union([
					z.object({ kind: z.literal("Ok"), text: z.string(), sources: z.array(source) }),
					z.object({ kind: z.literal("Err"), error: compileError }),
				]),
			}),
		}),
		z.object({ event: z.literal("launch_requested"), data: z.object({ run: run.optional(), blocks: z.array(block) }) }),
		z.object({
			event: z.literal("stop_requested"),
			data: z.object({ run: run.optional(), block, launches: z.array(z.object({ id: launch, agents: z.array(z.string()) })) }),
		}),
		z.object({
			event: z.literal("status_changed"),
			data: z.object({ run: run.optional(), block, status: statusField }),
		}),
		z.object({ event: z.literal("update_due"), data: z.object({ run, due: z.number(), last_update: z.number().nullable() }) }),
		z.object({ event: z.literal("interrupted"), data: z.object({ run: run.optional(), block, request: z.string() }) }),
		z.object({ event: z.literal("revision_requested"), data: z.object({ run: run.optional(), block, revision: positive }) }),
		z.object({ event: z.literal("agents_requested"), data: z.object({}).strict() }),
	]);
	const error = z.object({
		code: z.enum([
			"Busy",
			"NotHello",
			"Locked",
			"NotLocked",
			"UnknownBlock",
			"UnknownRun",
			"RunFinished",
			"BadValue",
			"NotFound",
			"Ambiguous",
			"BadLaunch",
			"CompileError",
			"UnknownTarget",
			"BadReport",
			"UnknownLaunch",
			"NotOwner",
			"UnknownEvent",
			"RevealFailed",
		]),
		message: z.string(),
		detail: z.unknown().optional(),
	});
	const frames = z.union([
		events,
		z.object({ id: z.string(), ok: z.literal(true), result: z.unknown().optional() }).strict(),
		z.object({ id: z.string(), ok: z.literal(false), error }).strict(),
	]);
	const summary = z.object({
		id: run,
		name: z.string(),
		status: z.enum(["running", "finished"]),
		started_at: z.number(),
		finished_at: z.number().nullable(),
		done: z.number(),
		total: z.number(),
		update_due: z.number().nullable(),
		update_overdue: z.boolean(),
		retrospective: z.boolean(),
	});
	const runsResult = z.object({ runs: z.array(summary) });
	const helloResult = z.object({ blocks: z.array(block), runs: z.array(summary), pane: z.string().optional() });
	const progressFields = {
		status: statusField.optional(),
		report: z.string().optional(),
		task: z.literal(false).optional(),
	};
	const wireBlock = z.union([
		z.object({
			id: block,
			kind: z.literal("task"),
			title: z.string(),
			body: z.string(),
			agent: z.string().optional(),
			isolated: z.boolean().optional(),
			...progressFields,
		}),
		z.object({ id: block, kind: z.literal("design"), title: z.string(), requirement: z.string(), design: z.string(), ...progressFields }),
	]);
	const readResult = z.object({ title: z.string(), blocks: z.array(wireBlock) });
	const revisionsResult = z.object({ revisions: z.array(z.object({ seq: positive, at: z.number(), block, prompt: z.string() })) });
	const postResult = z.object({ seq: positive });
	const launchRecord = z.object({
		id: launch,
		run: run.nullable(),
		session: z.string(),
		kind: z.enum(["prompt", "orchestration"]),
		snapshot: z.object({ result: z.object({ text: z.string() }) }),
		baselines: z.array(z.string()).optional(),
	});
	const evalInput: zod.ZodLikeSchema<EvalToolParams> = z.object({
		language: z.enum(["js", "py"]),
		code: z.string(),
		title: z.string().optional(),
		timeout: z.number().optional(),
		reset: z.boolean().optional(),
	});

	// Flat tool parameter schemas (zero `op` enums)
	const openParams = z
		.object({
			doc: z.string().describe("Playbook file path to open, for example `/home/me/book.yaml`."),
		})
		.strict();

	const editContentParams = z
		.object({
			doc: docField,
			run: runField,
			block: blockField.describe("Block id `b<n>` to edit (for example `b3`)."),
			title: z.string().describe("New block title.").optional(),
			body: z.string().describe("Replace the entire body of a task block (Markdown).").optional(),
			design: z.string().describe("Replace the entire design of a design block (draft format). Never edits requirement.").optional(),
			panel: z
				.string()
				.regex(PANEL_TARGET)
				.describe("Panel letter ID (`A`, `B`, `A1`, …) or role (`where`, `what`, `how`) to replace with `text`.")
				.optional(),
			text: z
				.string()
				.describe("Replacement text: whole block body/design, or whole panel starting with `## <ID> Title` when `panel` is set.")
				.optional(),
			find: verbatim(z.string().describe("Exact text occurring once in the block's body or design (requires `replace`).").optional()),
			replace: verbatim(z.string().describe("Replacement text for `find`.").optional()),
		})
		.strict();

	const editStructureParams = z
		.object({
			doc: docField,
			run: runField,
			add: z
				.object({
					title: z.string().describe("Title of the new block."),
					body: z.string().describe("Task block body (Markdown). Provide either `body` or `design`, not both.").optional(),
					design: z
						.string()
						.describe("Design block initial draft (requirement starts empty). Provide either `body` or `design`.")
						.optional(),
					after: blockField.describe("Insert after block `b<n>`. Omit to append at the end.").optional(),
					at_top: z.boolean().describe("Insert at the top of the Playbook (cannot be combined with `after`).").optional(),
					agent: z.string().describe("Default subagent name for a new task block.").optional(),
					isolation: isolationField.describe('Worktree isolation preset for a new task block: `"none"` or `"worktree"`.').optional(),
				})
				.strict()
				.describe("Add a new task or design block.")
				.optional(),
			move: z
				.object({
					block: blockField.describe("Block id `b<n>` to move."),
					after: blockField.describe("Place the moved block after `b<n>`.").optional(),
					at_top: z.boolean().describe("Move the block to the top (cannot be combined with `after`).").optional(),
				})
				.strict()
				.describe("Reorder an existing block.")
				.optional(),
			remove_block: blockField.describe("Block id `b<n>` to remove.").optional(),
			meta: z
				.object({
					block: blockField.describe("Block id `b<n>` whose metadata to update."),
					agent: z.string().describe("Default subagent name for a task block. Omit for no change; blank means omitted.").optional(),
					clear_agent: z
						.literal(true)
						.describe("Set `true` to clear the block's default subagent preset (cannot be combined with `agent`).")
						.optional(),
					isolation: z
						.enum(["none", "worktree", "clear"])
						.describe('Worktree isolation: `"worktree"`, `"none"`, or `"clear"` to remove the preset.')
						.optional(),
					status: statusField
						.describe("Override block status (`todo`, `running`, `done`). Subagents set their own status normally.")
						.optional(),
					tracked: z
						.boolean()
						.describe("`false` marks a task block untracked (`task: false`); `true` tracks it again from `todo`.")
						.optional(),
				})
				.strict()
				.describe("Update block metadata (agent, isolation, status, tracked).")
				.optional(),
		})
		.strict();

	const compileParams = z
		.object({
			doc: docField,
			run: runField,
			blocks: blocksField.describe('Block ids `b<n>` to compile into their final prompt, e.g. `["b1", "b3"]`.').optional(),
			targets: z
				.array(z.string())
				.describe("External reference targets to refetch (`file:<path>` or `https://` URL); pair with `refetch: true`.")
				.optional(),
			refetch: z.boolean().describe("Set `true` to refetch external `targets` before/instead of compiling.").optional(),
		})
		.strict();

	const checkParams = z
		.object({
			doc: docField,
			run: runField,
			blocks: blocksField.describe("Block ids `b<n>` that were inspected. Omit to target all blocks.").optional(),
			no_blocks: z
				.literal(true)
				.describe("Set `true` to report zero inspected blocks (cannot be combined with `blocks`; omit both to target all blocks).")
				.optional(),
			version: z.string().describe("Version hash returned by `read playbook://<doc>[/<run>]/checks`."),
			result: z
				.enum(["answers", "pass", "fail", "judge_unavailable"])
				.describe('Verdict: `"answers"` (with `answers` map), `"pass"`, `"fail"`, or `"judge_unavailable"`.'),
			answers: z
				.record(z.string(), z.number().min(0).max(1))
				.describe("Map of question id → yes probability (0–1; >= 0.5 fails). Required when `result` is `answers`.")
				.optional(),
		})
		.strict();

	const runParams = z
		.object({
			doc: docField,
			start_name: z.string().describe("Start a new Run with this name (copies Playbook with fresh `todo` status).").optional(),
			update_every: z.number().int().positive().describe("Seconds between update reminders in the new Run (with `start_name`).").optional(),
			finish_run: z.string().regex(RUN_ID).describe("Run id `r<n>` to finish (closes Launches and locks blocks).").optional(),
		})
		.strict();

	const timelineParams = z
		.object({
			doc: docField,
			run: runField,
			snooze_seconds: z.number().int().positive().describe("Postpone this Run's update reminder by N seconds (requires `run`).").optional(),
			kind: recordKindField.describe("Record kind to append (requires `text`).").optional(),
			text: z.string().describe("Record text to append (requires `kind`).").optional(),
			block: blockField.describe("Block id `b<n>` the record is about.").optional(),
			launch: launchField.describe("Launch id `l<n>` the record is about.").optional(),
			next: z.number().int().positive().describe("Seconds until the next update reminder (for a Run's `update`).").optional(),
			quote: z.string().describe("Session message id this record quotes.").optional(),
		})
		.strict();

	const launchParams = z
		.object({
			doc: docField,
			run: runField,
			blocks: blocksField.describe('Root block ids `b<n>` to freeze into a new Launch, e.g. `["b1", "b3"]`.').optional(),
			bind_launch: launchField.describe("Existing Launch id `l<n>` to bind `agent` to.").optional(),
			agent: z.string().describe("Subagent id/name working from `bind_launch`.").optional(),
			rebase_launch: launchField.describe("Existing Launch id `l<n>` to rebase to current block text.").optional(),
			close_launch: launchField.describe("Existing Launch id `l<n>` to close.").optional(),
		})
		.strict();

	// Converters to clean typed internal representations
	function parseOptRun(value: string | undefined): RunId | undefined {
		return value === undefined ? undefined : run.parse(value);
	}
	function parseReqBlock(value: string): BlockId {
		return block.parse(value);
	}
	function parseOptBlock(value: string | undefined): BlockId | undefined {
		return value === undefined ? undefined : block.parse(value);
	}
	function parseReqLaunch(value: string): LaunchId {
		return launch.parse(value);
	}
	function parseOptLaunch(value: string | undefined): LaunchId | undefined {
		return value === undefined ? undefined : launch.parse(value);
	}

	type EditContentInternal = {
		readonly doc?: string;
		readonly run?: RunId;
		readonly block: BlockId;
		readonly title?: string;
		readonly change?:
			| { readonly kind: "write"; readonly text: string }
			| { readonly kind: "panel"; readonly panel: string; readonly text: string }
			| { readonly kind: "replace"; readonly find: string; readonly replace: string };
	};

	function editContentToInternal(flat: ReturnType<typeof editContentParams.parse>): EditContentInternal {
		const hasFind = flat.find !== undefined;
		const hasReplace = flat.replace !== undefined;
		if (hasFind !== hasReplace) {
			throw new Error(
				tr("playbook_edit_content requires both find and replace together", "playbook_edit_content 的 find 和 replace 必须同时提供"),
			);
		}
		if (flat.panel !== undefined && flat.text === undefined) {
			throw new Error(tr("playbook_edit_content with panel requires text", "playbook_edit_content 传 panel 时必须同时提供 text"));
		}
		const changes: NonNullable<EditContentInternal["change"]>[] = [];
		if (hasFind && hasReplace) changes.push({ kind: "replace", find: flat.find!, replace: flat.replace! });
		if (flat.panel !== undefined && flat.text !== undefined) changes.push({ kind: "panel", panel: flat.panel, text: flat.text });
		if (flat.body !== undefined) changes.push({ kind: "write", text: flat.body });
		if (flat.design !== undefined) changes.push({ kind: "write", text: flat.design });
		if (flat.panel === undefined && flat.text !== undefined) changes.push({ kind: "write", text: flat.text });
		if (changes.length > 1) {
			throw new Error(
				tr(
					"playbook_edit_content accepts only one content change per call (find+replace, panel+text, body, design, or text)",
					"playbook_edit_content 每次调用只接受一种内容修改（find+replace、panel+text、body、design 或 text）",
				),
			);
		}
		if (flat.title === undefined && changes.length === 0) {
			throw new Error(
				tr(
					"playbook_edit_content requires at least one of title, body, design, text, panel+text, or find+replace",
					"playbook_edit_content 至少需要提供 title、body、design、text、panel+text 或 find+replace 之一",
				),
			);
		}
		const parsedRun = parseOptRun(flat.run);
		return {
			...(flat.doc !== undefined ? { doc: flat.doc } : {}),
			...(parsedRun !== undefined ? { run: parsedRun } : {}),
			block: parseReqBlock(flat.block),
			...(flat.title !== undefined ? { title: flat.title } : {}),
			...(changes[0] !== undefined ? { change: changes[0] } : {}),
		};
	}

	type EditStructureInternal =
		| {
				readonly kind: "insert_task";
				readonly doc?: string;
				readonly run?: RunId;
				readonly title: string;
				readonly body: string;
				readonly after?: BlockId;
				readonly at_top?: boolean;
				readonly agent?: string;
				readonly isolated?: boolean;
		  }
		| {
				readonly kind: "insert_design";
				readonly doc?: string;
				readonly run?: RunId;
				readonly title: string;
				readonly design: string;
				readonly after?: BlockId;
				readonly at_top?: boolean;
		  }
		| {
				readonly kind: "move";
				readonly doc?: string;
				readonly run?: RunId;
				readonly block: BlockId;
				readonly after: BlockId | null;
		  }
		| {
				readonly kind: "delete";
				readonly doc?: string;
				readonly run?: RunId;
				readonly block: BlockId;
		  }
		| {
				readonly kind: "meta";
				readonly doc?: string;
				readonly run?: RunId;
				readonly block: BlockId;
				readonly agent?: string | null;
				readonly isolated?: boolean | null;
				readonly status?: Status;
				readonly tracked?: boolean;
		  };

	function editStructureToInternal(flat: ReturnType<typeof editStructureParams.parse>): EditStructureInternal {
		const actions = [flat.add !== undefined, flat.move !== undefined, flat.remove_block !== undefined, flat.meta !== undefined].filter(
			Boolean,
		).length;
		if (actions !== 1) {
			throw new Error(
				tr(
					"playbook_edit_structure requires exactly one of add, move, remove_block, or meta",
					"playbook_edit_structure 必须且只能提供 add、move、remove_block 或 meta 之一",
				),
			);
		}
		const base = {
			...(flat.doc !== undefined ? { doc: flat.doc } : {}),
			...(flat.run !== undefined ? { run: parseOptRun(flat.run) } : {}),
		};
		if (flat.add !== undefined) {
			const add = flat.add;
			const hasBody = add.body !== undefined;
			const hasDesign = add.design !== undefined;
			if (hasBody === hasDesign) {
				throw new Error(
					tr(
						"playbook_edit_structure add requires either body (task block) or design (design block), not both",
						"playbook_edit_structure 的 add 必须提供 body（任务块）或 design（设计块）之一，不能同时提供",
					),
				);
			}
			if (add.at_top === true && add.after !== undefined) {
				throw new Error(
					tr("playbook_edit_structure add with at_top takes no after", "playbook_edit_structure 的 add 在 at_top 为 true 时不接受 after"),
				);
			}
			const after = parseOptBlock(add.after);
			if (hasDesign) {
				if (add.agent !== undefined || add.isolation !== undefined) {
					throw new Error(tr("a design block has no execution contract (agent, isolation)", "设计块没有执行配置（agent、isolation）"));
				}
				return {
					kind: "insert_design",
					...base,
					title: add.title,
					design: add.design!,
					...(after !== undefined ? { after } : {}),
					...(add.at_top === true ? { at_top: true } : {}),
				};
			}
			const parsedAgent = add.agent !== undefined ? agentName.parse(add.agent) : undefined;
			return {
				kind: "insert_task",
				...base,
				title: add.title,
				body: add.body!,
				...(after !== undefined ? { after } : {}),
				...(add.at_top === true ? { at_top: true } : {}),
				...(parsedAgent !== undefined ? { agent: parsedAgent } : {}),
				...(add.isolation !== undefined ? { isolated: add.isolation === "worktree" } : {}),
			};
		}
		if (flat.move !== undefined) {
			const move = flat.move;
			if (move.at_top === true && move.after !== undefined) {
				throw new Error(
					tr("playbook_edit_structure move with at_top takes no after", "playbook_edit_structure 的 move 在 at_top 为 true 时不接受 after"),
				);
			}
			if (move.at_top !== true && move.after === undefined) {
				throw new Error(
					tr(
						"playbook_edit_structure move requires either at_top: true or after",
						"playbook_edit_structure 的 move 需要 at_top: true 或 after",
					),
				);
			}
			return {
				kind: "move",
				...base,
				block: parseReqBlock(move.block),
				after: move.at_top === true ? null : parseReqBlock(move.after!),
			};
		}
		if (flat.remove_block !== undefined) {
			return { kind: "delete", ...base, block: parseReqBlock(flat.remove_block) };
		}
		const meta = flat.meta!;
		const hasAny =
			meta.agent !== undefined ||
			meta.clear_agent !== undefined ||
			meta.isolation !== undefined ||
			meta.status !== undefined ||
			meta.tracked !== undefined;
		if (!hasAny) {
			throw new Error(
				tr(
					"playbook_edit_structure meta requires at least one of agent, clear_agent, isolation, status, or tracked",
					"playbook_edit_structure 的 meta 至少需要提供 agent、clear_agent、isolation、status 或 tracked 之一",
				),
			);
		}
		if (meta.agent !== undefined && meta.clear_agent !== undefined) {
			throw new Error(
				tr(
					"playbook_edit_structure meta accepts either agent or clear_agent, not both",
					"playbook_edit_structure 的 meta 只能提供 agent 或 clear_agent 之一，不能同时提供",
				),
			);
		}
		const parsedAgent = meta.clear_agent === true ? null : meta.agent === undefined ? undefined : agentName.parse(meta.agent);
		const parsedIsolated = meta.isolation === undefined ? undefined : meta.isolation === "clear" ? null : meta.isolation === "worktree";
		return {
			kind: "meta",
			...base,
			block: parseReqBlock(meta.block),
			...(parsedAgent !== undefined ? { agent: parsedAgent } : {}),
			...(parsedIsolated !== undefined ? { isolated: parsedIsolated } : {}),
			...(meta.status !== undefined ? { status: meta.status } : {}),
			...(meta.tracked !== undefined ? { tracked: meta.tracked } : {}),
		};
	}

	type CompileInternal =
		| { readonly kind: "compile"; readonly doc?: string; readonly run?: RunId; readonly blocks: readonly BlockId[] }
		| { readonly kind: "refetch"; readonly doc?: string; readonly run?: RunId; readonly targets: readonly string[] }
		| {
				readonly kind: "refetch_and_compile";
				readonly doc?: string;
				readonly run?: RunId;
				readonly targets: readonly string[];
				readonly blocks: readonly BlockId[];
		  };

	function compileToInternal(flat: ReturnType<typeof compileParams.parse>): CompileInternal {
		const base = {
			...(flat.doc !== undefined ? { doc: flat.doc } : {}),
			...(flat.run !== undefined ? { run: parseOptRun(flat.run) } : {}),
		};
		const parsedBlocks = flat.blocks?.map(parseReqBlock);
		if (flat.refetch === true) {
			if (flat.targets === undefined) {
				throw new Error(tr("playbook_compile with refetch: true requires targets", "playbook_compile 在 refetch 为 true 时需要 targets"));
			}
			return parsedBlocks !== undefined
				? { kind: "refetch_and_compile", ...base, targets: flat.targets, blocks: parsedBlocks }
				: { kind: "refetch", ...base, targets: flat.targets };
		}
		if (flat.targets !== undefined && parsedBlocks !== undefined) {
			throw new Error(
				tr(
					"playbook_compile with both targets and blocks requires refetch: true",
					"playbook_compile 同时传 targets 和 blocks 时必须设置 refetch: true",
				),
			);
		}
		if (flat.targets !== undefined) {
			return { kind: "refetch", ...base, targets: flat.targets };
		}
		if (parsedBlocks !== undefined) {
			return { kind: "compile", ...base, blocks: parsedBlocks };
		}
		throw new Error(
			tr("playbook_compile requires blocks or refetch with targets", "playbook_compile 需要提供 blocks 或 refetch + targets"),
		);
	}

	type CheckInternal = {
		readonly doc?: string;
		readonly run?: RunId;
		readonly blocks?: readonly BlockId[];
		readonly version: string;
		readonly result: JudgeReport;
	};

	function checkToInternal(flat: ReturnType<typeof checkParams.parse>): CheckInternal {
		if (flat.blocks !== undefined && flat.no_blocks !== undefined) {
			throw new Error(
				tr("playbook_check accepts either blocks or no_blocks, not both", "playbook_check 只能提供 blocks 或 no_blocks 之一，不能同时提供"),
			);
		}
		const explicitBlocks = flat.no_blocks === true ? [] : flat.blocks?.map(parseReqBlock);
		const base = {
			...(flat.doc !== undefined ? { doc: flat.doc } : {}),
			...(flat.run !== undefined ? { run: parseOptRun(flat.run) } : {}),
			...(explicitBlocks !== undefined ? { blocks: explicitBlocks } : {}),
			version: flat.version,
		};
		if (flat.result === "judge_unavailable") {
			if (flat.answers !== undefined) {
				throw new Error(
					tr("playbook_check result judge_unavailable takes no answers", "playbook_check 的 judge_unavailable 不接受 answers"),
				);
			}
			return { ...base, result: { kind: "judge_unavailable" } };
		}
		if (flat.result === "answers") {
			if (flat.answers === undefined) {
				throw new Error(tr("playbook_check with result answers requires answers", "playbook_check 在 result 为 answers 时需要 answers"));
			}
			return { ...base, result: { kind: "answers", answers: flat.answers } };
		}
		const fallback = flat.result === "pass" ? { missing: 0 } : { missing: 1 };
		return { ...base, result: { kind: "answers", answers: flat.answers ?? fallback } };
	}

	type RunInternal =
		| { readonly kind: "start"; readonly doc?: string; readonly name: string; readonly update_every?: number }
		| { readonly kind: "finish"; readonly doc?: string; readonly run: RunId };

	function runToInternal(flat: ReturnType<typeof runParams.parse>): RunInternal {
		const hasStart = flat.start_name !== undefined;
		const hasFinish = flat.finish_run !== undefined;
		if (hasStart === hasFinish) {
			throw new Error(
				tr("playbook_run requires either start_name or finish_run, not both", "playbook_run 必须且只能提供 start_name 或 finish_run 之一"),
			);
		}
		const base = flat.doc !== undefined ? { doc: flat.doc } : {};
		if (hasStart) {
			return {
				kind: "start",
				...base,
				name: flat.start_name!,
				...(flat.update_every !== undefined ? { update_every: flat.update_every } : {}),
			};
		}
		if (flat.update_every !== undefined) {
			throw new Error(
				tr("playbook_run update_every is only valid with start_name", "playbook_run 的 update_every 只能和 start_name 一起使用"),
			);
		}
		return { kind: "finish", ...base, run: run.parse(flat.finish_run!) };
	}

	type TimelineInternal =
		| { readonly kind: "snooze"; readonly doc?: string; readonly run: RunId; readonly after: number }
		| {
				readonly kind: "post";
				readonly doc?: string;
				readonly run?: RunId;
				readonly recordKind: RecordKind;
				readonly text: string;
				readonly block?: BlockId;
				readonly launch?: LaunchId;
				readonly next?: number;
				readonly quote?: string;
		  };

	function timelineToInternal(flat: ReturnType<typeof timelineParams.parse>): TimelineInternal {
		const base = flat.doc !== undefined ? { doc: flat.doc } : {};
		if (flat.snooze_seconds !== undefined) {
			if (
				flat.kind !== undefined ||
				flat.text !== undefined ||
				flat.block !== undefined ||
				flat.launch !== undefined ||
				flat.next !== undefined ||
				flat.quote !== undefined
			) {
				throw new Error(
					tr(
						"playbook_timeline snooze_seconds cannot be combined with post fields",
						"playbook_timeline 的 snooze_seconds 不能与发帖字段混用",
					),
				);
			}
			if (flat.run === undefined) {
				throw new Error(tr("playbook_timeline snooze_seconds requires run", "playbook_timeline 的 snooze_seconds 需要 run"));
			}
			return { kind: "snooze", ...base, run: run.parse(flat.run), after: flat.snooze_seconds };
		}
		if (flat.kind === undefined || flat.text === undefined) {
			throw new Error(
				tr(
					"playbook_timeline requires either snooze_seconds (with run) or kind and text",
					"playbook_timeline 需要提供 snooze_seconds（带 run）或同时提供 kind 和 text",
				),
			);
		}
		const parsedRun = parseOptRun(flat.run);
		const parsedBlock = parseOptBlock(flat.block);
		const parsedLaunch = parseOptLaunch(flat.launch);
		return {
			kind: "post",
			...base,
			...(parsedRun !== undefined ? { run: parsedRun } : {}),
			recordKind: flat.kind,
			text: flat.text,
			...(parsedBlock !== undefined ? { block: parsedBlock } : {}),
			...(parsedLaunch !== undefined ? { launch: parsedLaunch } : {}),
			...(flat.next !== undefined ? { next: flat.next } : {}),
			...(flat.quote !== undefined ? { quote: flat.quote } : {}),
		};
	}

	type LaunchInternal =
		| { readonly kind: "launch"; readonly doc?: string; readonly run?: RunId; readonly blocks: readonly BlockId[] }
		| { readonly kind: "bind"; readonly doc?: string; readonly launch: LaunchId; readonly agent: string }
		| { readonly kind: "rebase"; readonly doc?: string; readonly launch: LaunchId }
		| { readonly kind: "close"; readonly doc?: string; readonly launch: LaunchId };

	function launchToInternal(flat: ReturnType<typeof launchParams.parse>): LaunchInternal {
		const actions = [
			flat.blocks !== undefined,
			flat.bind_launch !== undefined,
			flat.rebase_launch !== undefined,
			flat.close_launch !== undefined,
		].filter(Boolean).length;
		if (actions !== 1) {
			throw new Error(
				tr(
					"playbook_launch requires exactly one of blocks, bind_launch, rebase_launch, or close_launch",
					"playbook_launch 必须且只能提供 blocks、bind_launch、rebase_launch 或 close_launch 之一",
				),
			);
		}
		const base = flat.doc !== undefined ? { doc: flat.doc } : {};
		if (flat.blocks !== undefined) {
			if (flat.agent !== undefined) {
				throw new Error(tr("playbook_launch agent is only valid with bind_launch", "playbook_launch 的 agent 只能和 bind_launch 一起使用"));
			}
			const parsedRun = parseOptRun(flat.run);
			return {
				kind: "launch",
				...base,
				...(parsedRun !== undefined ? { run: parsedRun } : {}),
				blocks: flat.blocks.map(parseReqBlock),
			};
		}
		if (flat.run !== undefined) {
			throw new Error(
				tr(
					"playbook_launch run is only valid when creating a Launch with blocks",
					"playbook_launch 的 run 只在用 blocks 创建 Launch 时有效",
				),
			);
		}
		if (flat.bind_launch !== undefined) {
			if (flat.agent === undefined) {
				throw new Error(tr("playbook_launch bind_launch requires agent", "playbook_launch 的 bind_launch 需要 agent"));
			}
			return { kind: "bind", ...base, launch: parseReqLaunch(flat.bind_launch), agent: flat.agent };
		}
		if (flat.agent !== undefined) {
			throw new Error(tr("playbook_launch agent is only valid with bind_launch", "playbook_launch 的 agent 只能和 bind_launch 一起使用"));
		}
		if (flat.rebase_launch !== undefined) {
			return { kind: "rebase", ...base, launch: parseReqLaunch(flat.rebase_launch) };
		}
		return { kind: "close", ...base, launch: parseReqLaunch(flat.close_launch!) };
	}

	const openInternal = z.object({ doc: z.string() }).strict();

	return {
		playbook_open: { parameters: openParams, toInternal: (flat: ReturnType<typeof openParams.parse>) => openInternal.parse(flat) },
		playbook_edit_content: { parameters: editContentParams, toInternal: editContentToInternal },
		playbook_edit_structure: { parameters: editStructureParams, toInternal: editStructureToInternal },
		playbook_compile: { parameters: compileParams, toInternal: compileToInternal },
		playbook_check: { parameters: checkParams, toInternal: checkToInternal },
		playbook_run: { parameters: runParams, toInternal: runToInternal },
		playbook_timeline: { parameters: timelineParams, toInternal: timelineToInternal },
		playbook_launch: { parameters: launchParams, toInternal: launchToInternal },
		wire: {
			site,
			compileError,
			source,
			events,
			error,
			frames,
			summary,
			runsResult,
			helloResult,
			wireBlock,
			readResult,
			revisionsResult,
			postResult,
			launchRecord,
			evalInput,
		},
	};
}
