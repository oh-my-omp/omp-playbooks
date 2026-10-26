// K1 document service ⇄ coordinator extension (contracts.md §K1).
import type { BlockId, CompileResult, EventName, JudgeReport, LaunchId, LaunchKind, RecordKind, RunId, RunStatus, Status } from "./model";

/** Requests, closed. `run` absent = template. */
export type Request =
	| { readonly op: "hello"; readonly args: { readonly session: string; readonly pane?: string } }
	| { readonly op: "lock"; readonly args: { readonly run?: RunId; readonly block: BlockId } }
	| { readonly op: "unlock"; readonly args: { readonly run?: RunId; readonly block: BlockId; readonly request: string } }
	| { readonly op: "read"; readonly args: { readonly run?: RunId; readonly block?: BlockId } }
	| {
		readonly op: "set";
		readonly args:
			| { readonly run?: RunId; readonly block: BlockId; readonly field: "title"; readonly value: string }
			| { readonly run?: RunId; readonly block: BlockId; readonly field: "status"; readonly value: Status }
			/** `false` declares a task block untracked (not a piece of work); `true` tracks it again from todo. */
			| { readonly run?: RunId; readonly block: BlockId; readonly field: "task"; readonly value: boolean }
			/** A task block's default agent; null clears it. */
			| { readonly run?: RunId; readonly block: BlockId; readonly field: "agent"; readonly value: string | null }
			/** Whether a task block's workers default to their own worktree; null clears it. */
			| { readonly run?: RunId; readonly block: BlockId; readonly field: "isolated"; readonly value: boolean | null };
	}
	/** Replace the find text, found exactly once, in the block's coordinator field (task body, design draft). */
	| { readonly op: "edit"; readonly args: { readonly run?: RunId; readonly block: BlockId; readonly find: string; readonly replace: string } }
	/** Replace the block's coordinator field (task body, design draft) whole. */
	| { readonly op: "write"; readonly args: { readonly run?: RunId; readonly block: BlockId; readonly text: string } }
	/** Replace one panel of a design draft, addressed by the letter ID its heading writes. */
	| { readonly op: "panel"; readonly args: { readonly run?: RunId; readonly block: BlockId; readonly panel: string; readonly text: string } }
	/** Insert a block; a design block's requirement belongs to the person and starts empty. */
	| { readonly op: "insert"; readonly args: { readonly run?: RunId; readonly after?: BlockId; readonly title: string; readonly content: InsertContent } }
	/** Move a held block to the top (`after: null`) or directly after another block. */
	| { readonly op: "move"; readonly args: { readonly run?: RunId; readonly block: BlockId; readonly after: BlockId | null } }
	| { readonly op: "revisions"; readonly args: { readonly run?: RunId; readonly block?: BlockId; readonly after?: number } }
	| { readonly op: "delete"; readonly args: { readonly run?: RunId; readonly block: BlockId } }
	| { readonly op: "refetch"; readonly args: { readonly run?: RunId; readonly targets: readonly string[] } }
	| { readonly op: "compile"; readonly args: { readonly run?: RunId; readonly blocks: readonly BlockId[] } }
	| { readonly op: "inspect"; readonly args: { readonly run?: RunId; readonly blocks: readonly BlockId[] } }
	| { readonly op: "report"; readonly args: { readonly run?: RunId; readonly blocks: readonly BlockId[]; readonly version: string; readonly result: JudgeReport } }
	| { readonly op: "launch"; readonly args: { readonly run?: RunId; readonly blocks: readonly BlockId[] } }
	| { readonly op: "bind"; readonly args: { readonly launch: LaunchId; readonly agent: string } }
	| { readonly op: "rebase"; readonly args: { readonly launch: LaunchId } }
	| { readonly op: "close"; readonly args: { readonly launch: LaunchId } }
	| { readonly op: "launch_info"; readonly args: { readonly launch: LaunchId } }
	| { readonly op: "start_run"; readonly args: { readonly name: string; readonly update_every?: number } }
	| { readonly op: "finish_run"; readonly args: { readonly run: RunId } }
	| { readonly op: "runs"; readonly args: Record<string, never> }
	| { readonly op: "timeline"; readonly args: { readonly run?: RunId; readonly after?: number } }
	| {
			readonly op: "post";
			readonly args: {
				readonly run?: RunId;
				readonly kind: RecordKind;
				readonly text: string;
				readonly block?: BlockId;
				readonly launch?: LaunchId;
				readonly next?: number;
				readonly quote?: string;
				readonly origin?: "human";
			};
	  }
	| { readonly op: "snooze"; readonly args: { readonly run: RunId; readonly after: number } }
	| { readonly op: "ack"; readonly args: { readonly event: string } }
	/** The coordinator's answer to `agents_requested`: the subagent types its session can launch now. */
	| { readonly op: "agents"; readonly args: { readonly result: AgentAnswer } }
	/** Show the document service's own pane; any connection may send it without hello (contracts.md K1). */
	| { readonly op: "reveal"; readonly args: Record<string, never> };

export type Op = Request["op"];
export type ArgsOf<O extends Op> = Extract<Request, { op: O }>["args"];

/** K1 errors, closed (contracts.md K1 错误). */
export type ErrorCode =
	| "Busy"
	| "NotHello"
	| "Locked"
	| "NotLocked"
	| "UnknownBlock"
	| "UnknownRun"
	| "RunFinished"
	| "BadValue"
	| "NotFound"
	| "Ambiguous"
	| "BadLaunch"
	| "CompileError"
	| "UnknownTarget"
	| "BadReport"
	| "UnknownLaunch"
	| "NotOwner"
	| "UnknownEvent"
	| "RevealFailed";

export interface ProtocolError {
	readonly code: ErrorCode;
	readonly message: string;
	readonly detail?: unknown;
}

export type Outcome<T> = { readonly ok: true; readonly result: T } | { readonly ok: false; readonly error: ProtocolError };

export function ok<T>(result: T): Outcome<T> {
	return { ok: true, result };
}
export function fail(code: ErrorCode, message: string, detail?: unknown): Outcome<never> {
	return { ok: false, error: detail === undefined ? { code, message } : { code, message, detail } };
}

/** Run summary (runs.md §5). */
export interface RunSummary {
	readonly id: RunId;
	readonly name: string;
	readonly status: RunStatus;
	readonly started_at: number;
	readonly finished_at: number | null;
	readonly done: number;
	readonly total: number;
	readonly update_due: number | null;
	readonly update_overdue: boolean;
	/** Only meaningful for finished Runs. */
	readonly retrospective: boolean;
}

/** Event payloads pushed to the coordinator (launch-events.md §4–§6, runs.md §2, §6, checks.md §4). */
export type EventPayload =
	| {
			readonly event: "block_changed";
			readonly data: {
				readonly id: string;
				readonly launch: { readonly id: LaunchId; readonly kind: LaunchKind; readonly run?: RunId };
				readonly agents: readonly string[];
				readonly changed: readonly BlockId[];
				readonly diff: string;
				readonly current: CompileResult;
			};
	  }
	| { readonly event: "launch_requested"; readonly data: { readonly run?: RunId; readonly blocks: readonly BlockId[] } }
	/** The person asked to stop the block's execution; `launches` are its open root Launches with their bound agents. */
	| { readonly event: "stop_requested"; readonly data: { readonly run?: RunId; readonly block: BlockId; readonly launches: readonly { readonly id: LaunchId; readonly agents: readonly string[] }[] } }
	| { readonly event: "status_changed"; readonly data: { readonly run?: RunId; readonly block: BlockId; readonly status: Status } }
	| { readonly event: "update_due"; readonly data: { readonly run: RunId; readonly due: number; readonly last_update: number | null } }
	| { readonly event: "interrupted"; readonly data: { readonly run?: RunId; readonly block: BlockId; readonly request: string } }
	/** The person submitted a change request for a design block; read it with `revisions`. */
	| { readonly event: "revision_requested"; readonly data: { readonly run?: RunId; readonly block: BlockId; readonly revision: number } }
	/** The person opened a SUBAGENT dropdown; answer with `agents`. A query, not a document event: it is not logged. */
	| { readonly event: "agents_requested"; readonly data: Record<string, never> };

export type AgentAnswer = { readonly kind: "listed"; readonly names: readonly string[] } | { readonly kind: "unavailable"; readonly reason: string };

export type InsertContent =
	| { readonly kind: "task"; readonly body: string; readonly agent?: string; readonly isolated?: boolean }
	| { readonly kind: "design"; readonly design: string };

// Compile-time check that EventPayload covers exactly EventName.
type _EventsCovered = [EventName] extends [EventPayload["event"]] ? ([EventPayload["event"]] extends [EventName] ? true : never) : never;
const _eventsCovered: _EventsCovered = true;
void _eventsCovered;

/** Wire frames. */
export type ClientFrame = { readonly id: string; readonly op: string; readonly args: unknown };
export type ServerFrame = { readonly id: string; readonly ok: true; readonly result: unknown } | { readonly id: string; readonly ok: false; readonly error: ProtocolError } | EventPayload;

/** Socket path (contracts.md K1 交换). */
export function socketPath(tmpdir: string, playbookAbsPath: string): string {
	const hash = new Bun.CryptoHasher("sha256").update(playbookAbsPath).digest("hex");
	return `${tmpdir.replace(/\/$/, "")}/omp-playbooks/${hash}.sock`;
}
