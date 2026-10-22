// Domain model of omp-playbooks. Every type here mirrors a definition in design/.
// Rules live in the design; comments name the owning section.

/** `b<positive integer>` (README §定义). */
export type BlockId = `b${number}`;
/** `r<positive integer>` (runs.md §2). */
export type RunId = `r${number}`;
/** `l<positive integer>` (launch-events.md §1). */
export type LaunchId = `l${number}`;

const BLOCK_ID = /^b([1-9][0-9]*)$/;
const RUN_ID = /^r([1-9][0-9]*)$/;
const LAUNCH_ID = /^l([1-9][0-9]*)$/;

export function parseBlockId(value: string): BlockId | null {
	return BLOCK_ID.test(value) ? (value as BlockId) : null;
}
export function parseRunId(value: string): RunId | null {
	return RUN_ID.test(value) ? (value as RunId) : null;
}
export function parseLaunchId(value: string): LaunchId | null {
	return LAUNCH_ID.test(value) ? (value as LaunchId) : null;
}
export function idNumber(id: BlockId | RunId | LaunchId): number {
	return Number(id.slice(1));
}

/**
 * What a block holds. A task block is a prompt that can run, optionally carrying the execution
 * contract its Launch defaults to (`agent`, `isolated`); a design block pairs the person's
 * requirement with the coordinator's design draft.
 */
export type BlockContent =
	| { readonly kind: "task"; readonly body: string; readonly agent?: string; readonly isolated?: boolean }
	| { readonly kind: "design"; readonly requirement: string; readonly design: string };

/** A task block's execution contract: the coordinator's defaults when it starts the block's Launch. */
export type TaskConfig = Pick<Extract<BlockContent, { kind: "task" }>, "agent" | "isolated">;

/** A block (README §定义 块). */
export interface Block {
	readonly id: BlockId;
	readonly title: string;
	readonly done: boolean;
	readonly content: BlockContent;
}

/** Persisted text fields of a block. `body` exists on task blocks, `requirement` and `design` on design blocks. */
export type BlockField = "title" | "body" | "requirement" | "design";
/** Fields a person edits through a draft: `prompt` is a design block's change request, never persisted in the block. */
export type HumanField = "title" | "body" | "requirement" | "prompt";

/** The text of `field` on `block`, or null when the block's kind has no such field. */
export function fieldText(block: Block, field: BlockField): string | null {
	if (field === "title") return block.title;
	const content = block.content;
	switch (content.kind) {
		case "task": return field === "body" ? content.body : null;
		case "design": return field === "requirement" ? content.requirement : field === "design" ? content.design : null;
	}
}

/** `block` with `field` set to `text`, or null when the block's kind has no such field. */
export function withField(block: Block, field: BlockField, text: string): Block | null {
	if (field === "title") return { ...block, title: text };
	const content = block.content;
	switch (content.kind) {
		case "task": return field === "body" ? { ...block, content: { ...content, body: text } } : null;
		case "design":
			if (field === "requirement") return { ...block, content: { ...content, requirement: text } };
			if (field === "design") return { ...block, content: { ...content, design: text } };
			return null;
	}
}

/** The field the coordinator writes as a block's main text: a task's body, a design's draft. */
export function coordinatorField(content: BlockContent): "body" | "design" {
	return content.kind === "task" ? "body" : "design";
}

/** Whether a person may hold a draft of `field` on a block of this kind. */
export function humanFieldValid(content: BlockContent, field: HumanField): boolean {
	switch (field) {
		case "title": return true;
		case "body": return content.kind === "task";
		case "requirement": case "prompt": return content.kind === "design";
	}
}

/** One submitted change request for a design block (append-only, one journal per document). */
export interface Revision {
	readonly seq: number;
	readonly at: number;
	readonly block: BlockId;
	readonly prompt: string;
}

/** The serialized Playbook document (README §S2). */
export interface PlaybookDoc {
	readonly title: string;
	readonly blocks: readonly Block[];
}

export type RunStatus = "running" | "finished";

/** The `run` mapping of a Run file (runs.md §1, §6). Times are epoch milliseconds. */
export interface RunMeta {
	readonly id: RunId;
	readonly name: string;
	readonly status: RunStatus;
	readonly startedAt: number;
	readonly finishedAt: number | null;
	/** Seconds, or null when the Run has no status-update reminder. */
	readonly updateEvery: number | null;
	readonly updateDue: number | null;
}

/** A document the service holds: the template or one Run. */
export type DocRef = { readonly kind: "template" } | { readonly kind: "run"; readonly run: RunId };

/** Who applied an edit (launch-events.md §3). */
export type EditOrigin = "human" | "coordinator" | "disk";
/** Timeline entry origin (runs.md §3). */
export type EntryOrigin = EditOrigin | "service";

/** Block lock (README §定义 块锁). */
export type BlockLock =
	| { readonly kind: "none" }
	| { readonly kind: "human"; readonly field: HumanField; readonly draft: string }
	| { readonly kind: "coordinator"; readonly request: string };

// ---------------------------------------------------------------- references

/** Target kinds (references.md §2). */
export type Target =
	| { readonly kind: "block"; readonly block: BlockId }
	| { readonly kind: "result"; readonly block: BlockId }
	| { readonly kind: "issue"; readonly owner: string; readonly repo: string; readonly number: number; readonly url: string }
	| { readonly kind: "pull"; readonly owner: string; readonly repo: string; readonly number: number; readonly url: string }
	| { readonly kind: "file"; readonly path: string };

export type ExternalTarget = Extract<Target, { kind: "issue" | "pull" | "file" }>;

/** Selectors of a slice expression (references.md §3). */
export type Selector =
	| { readonly kind: "lines"; readonly from: number; readonly to: number }
	| { readonly kind: "section"; readonly heading: string }
	| { readonly kind: "title" }
	| { readonly kind: "body" }
	| { readonly kind: "comments" }
	| { readonly kind: "commentsLast"; readonly count: number }
	| { readonly kind: "commentsRange"; readonly from: number; readonly to: number }
	/** Design blocks only: the person's requirement, the whole draft, or one panel by its written letter ID. */
	| { readonly kind: "requirement" }
	| { readonly kind: "design" }
	| { readonly kind: "panel"; readonly id: string };

/** One `((target))` or `((target | expression))` occurrence in a block body. */
export interface Reference {
	/** Exact source text including the parentheses. */
	readonly text: string;
	/** Raw target text as written. */
	readonly targetText: string;
	/** Raw expression text, or null when absent. */
	readonly expressionText: string | null;
	/** UTF-16 offset of the reference in the body. */
	readonly offset: number;
}

export interface IssueComment {
	readonly author: string;
	readonly createdAt: string;
	readonly body: string;
}
export interface IssueValue {
	readonly title: string;
	readonly body: string;
	readonly comments: readonly IssueComment[];
}

/** Result of fetching one external target (references.md §5, contracts.md K3). */
export type FetchOutcome =
	| { readonly ok: true; readonly at: number; readonly value: { readonly kind: "issue"; readonly issue: IssueValue } | { readonly kind: "file"; readonly text: string } }
	| { readonly ok: false; readonly at: number; readonly error: string };

/** Key of a fetch table: the canonical target text. */
export type TargetKey = string;
export type FetchTable = ReadonlyMap<TargetKey, FetchOutcome>;

/** One entry of the block result table (references.md §4). */
export interface BlockResult {
	readonly text: string;
	readonly at: number;
	readonly seq: number;
	readonly origin: EntryOrigin;
	readonly launch: LaunchId | null;
}
export type ResultTable = ReadonlyMap<BlockId, BlockResult>;

/** Compile errors (references.md §4), closed. */
export type CompileError =
	| { readonly kind: "UnknownBlock"; readonly block: BlockId; readonly at: ErrorSite }
	| { readonly kind: "UnknownTarget"; readonly at: ErrorSite }
	| { readonly kind: "BadExpression"; readonly reason: string; readonly at: ErrorSite }
	| { readonly kind: "Cycle"; readonly path: readonly BlockId[]; readonly at: ErrorSite }
	| { readonly kind: "TooDeep"; readonly at: ErrorSite }
	| { readonly kind: "NoResult"; readonly block: BlockId; readonly at: ErrorSite }
	| { readonly kind: "FetchFailed"; readonly target: TargetKey; readonly error: string; readonly at: ErrorSite };

export interface ErrorSite {
	readonly block: BlockId;
	readonly reference: string;
}

export type Source =
	| { readonly kind: "block"; readonly target: TargetKey; readonly expression: string | null }
	| { readonly kind: "result"; readonly target: TargetKey; readonly expression: string | null; readonly seq: number; readonly origin: EntryOrigin; readonly launch: LaunchId | null }
	| { readonly kind: "external"; readonly target: TargetKey; readonly expression: string | null; readonly fetchedAt: number };

export type CompileResult =
	| { readonly kind: "Ok"; readonly text: string; readonly sources: readonly Source[] }
	| { readonly kind: "Err"; readonly error: CompileError };

/** Input the pure compiler reads (references.md §4). */
export interface CompileInput {
	readonly blocks: ReadonlyMap<BlockId, BlockContent>;
	readonly fetches: FetchTable;
	readonly results: ResultTable;
	/** True when compiling a template, where block results are `NoResult`. */
	readonly inTemplate: boolean;
}

// ---------------------------------------------------------------- launches

export type LaunchKind = "prompt" | "orchestration";

export type LaunchCloser = "coordinator" | "human" | "run_finished";

export interface PendingEvent {
	readonly event: string;
	readonly maxSeq: number;
	readonly result: CompileResult;
}

/** Launch record (launch-events.md §1). */
export interface Launch {
	readonly id: LaunchId;
	readonly run: RunId;
	readonly session: string;
	readonly blocks: readonly BlockId[];
	readonly kind: LaunchKind;
	readonly snapshot: {
		readonly result: Extract<CompileResult, { kind: "Ok" }>;
		readonly fetches: readonly (readonly [TargetKey, FetchOutcome])[];
		readonly results: readonly (readonly [BlockId, BlockResult])[];
	};
	readonly agents: readonly string[];
	readonly baselines: readonly string[];
	readonly notified: CompileResult | null;
	/** Block id → sequence number of its latest human/disk edit. */
	readonly dirty: readonly (readonly [BlockId, number])[];
	readonly fetches: readonly (readonly [TargetKey, FetchOutcome])[];
	readonly closed: { readonly at: number; readonly by: LaunchCloser } | null;
}

// ---------------------------------------------------------------- timeline

export type RecordKind = "update" | "result" | "failure" | "retrospective";

/** Timeline entry payloads (runs.md §3), closed. */
export type EntryData =
	| { readonly type: "run_started"; readonly name: string }
	| { readonly type: "run_finished" }
	| { readonly type: "block_edited"; readonly block: BlockId; readonly field: BlockField; readonly text: string; readonly edit: number }
	| { readonly type: "block_added"; readonly block: BlockId; readonly title: string; readonly content: BlockContent }
	| { readonly type: "block_deleted"; readonly block: BlockId; readonly title: string; readonly content: BlockContent }
	/** A disk edit switched the block between task and design, or a task block's execution contract changed. */
	| { readonly type: "content_replaced"; readonly block: BlockId; readonly content: BlockContent }
	| { readonly type: "blocks_reordered"; readonly order: readonly BlockId[] }
	| { readonly type: "done_changed"; readonly block: BlockId; readonly done: boolean }
	| { readonly type: "launch_created"; readonly launch: LaunchId; readonly kind: LaunchKind; readonly blocks: readonly BlockId[] }
	| { readonly type: "agent_bound"; readonly launch: LaunchId; readonly agent: string }
	| { readonly type: "launch_closed"; readonly launch: LaunchId }
	| { readonly type: "event_sent"; readonly event: EventName; readonly data: unknown }
	| { readonly type: "interrupted"; readonly block: BlockId; readonly request: string }
	| { readonly type: "check_reported"; readonly blocks: readonly BlockId[]; readonly version: string; readonly result: JudgeReport }
	| {
			readonly type: "post";
			readonly kind: RecordKind;
			readonly text: string;
			readonly block?: BlockId;
			readonly launch?: LaunchId;
			readonly quote?: string;
			readonly session?: string;
	  }
	| { readonly type: "update_due"; readonly due: number }
	| { readonly type: "update_snoozed"; readonly due: number };

export interface TimelineEntry {
	readonly seq: number;
	readonly at: number;
	readonly origin: EntryOrigin;
	readonly data: EntryData;
}

// ---------------------------------------------------------------- checks

export type JudgeReport = { readonly kind: "answers"; readonly answers: Readonly<Record<string, number>> } | { readonly kind: "judge_unavailable" };

export type FindingName = "compile" | "empty_expansion" | "render_error" | "render_pending" | "chart" | "draft";
export type Findings = Readonly<Record<FindingName, boolean>>; // true = fails

// ---------------------------------------------------------------- events (K1)

export type EventName = "block_changed" | "launch_requested" | "check_requested" | "run_started" | "run_finished" | "done_changed" | "update_due" | "interrupted" | "revision_requested";
