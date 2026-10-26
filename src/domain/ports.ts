// Contracts between the document service modules. The core (src/service/core.ts) owns state;
// every other module is either a pure function set it calls, an IO adapter it calls, or a
// front end (TSP UI, K1 socket) that calls the core.
import type {
	AgentList,
	BlockContent,
	BlockId,
	BlockResult,
	HumanField,
	Revision,
	CompileInput,
	CompileResult,
	DocRef,
	ExternalTarget,
	FetchOutcome,
	FetchTable,
	FindingName,
	Findings,
	JudgeReport,
	Launch,
	LaunchId,
	PlaybookDoc,
	Reference,
	RunId,
	RunMeta,
	Status,
	Target,
	TargetKey,
	TimelineEntry,
	Block,
} from "./model";
import type { EventPayload, Outcome, Request } from "./protocol";

// ---------------------------------------------------------------- references (pure) — src/service/references.ts

export interface ReferencesModule {
	/** All references in a body, in order, skipping fenced and inline code (references.md §1). */
	parseReferences(body: string): Reference[];
	/** Classify a target text (references.md §2); null = UnknownTarget. */
	parseTarget(text: string): Target | null;
	/** Canonical key of a target; used for fetch tables. */
	targetKey(target: Target): TargetKey;
	/** Dependency closure (launch-events.md §3): the roots plus ids reachable through block references of task bodies (design blocks are leaves), including missing ids. */
	closure(roots: readonly BlockId[], contents: ReadonlyMap<BlockId, BlockContent>): Set<BlockId>;
	/** External targets referenced anywhere in the closure of `roots`, deduplicated by key. */
	externalTargets(roots: readonly BlockId[], contents: ReadonlyMap<BlockId, BlockContent>): ExternalTarget[];
	/** Block ids whose `.result` is referenced in the closure of `roots`. */
	resultTargets(roots: readonly BlockId[], contents: ReadonlyMap<BlockId, BlockContent>): BlockId[];
	/** Pure compile (references.md §4). */
	compile(order: readonly BlockId[], input: CompileInput): CompileResult;
	/** Expansion of one reference written in `block` (references.md §5, rendered view). */
	expandOne(block: BlockId, reference: Reference, input: CompileInput): CompileResult;
	/** Unified diff from `before` to `after` (launch-events.md §4). */
	unifiedDiff(before: string, after: string): string;
	/** A design draft with the panel whose heading writes `id` replaced by `replacement` (itself one panel with that ID). */
	replacePanel(design: string, id: string, replacement: string): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly code: "NotFound" | "BadValue"; readonly reason: string };
}

// ---------------------------------------------------------------- fetching (IO) — src/service/fetch.ts

export interface Fetcher {
	/** Fetch one external target (contracts.md K3; `file:` relative to `baseDir`). Never throws. */
	fetch(target: ExternalTarget, baseDir: string): Promise<FetchOutcome>;
}

// ---------------------------------------------------------------- persistence (IO) — src/service/store.ts

/** Service record line (README §定义 服务记录文件). */
export type ServiceRecord = { readonly kind: "block"; readonly id: BlockId } | { readonly kind: "run"; readonly id: RunId } | { readonly kind: "launch"; readonly id: LaunchId };

export type ParsedFile = { readonly ok: true; readonly doc: PlaybookDoc; readonly run: RunMeta | null } | { readonly ok: false; readonly error: string };

export interface Store {
	readonly templatePath: string;
	/** Directory the template lives in (base for `file:` targets and `tern split --cwd`). */
	readonly baseDir: string;
	/** Absolute path of a document's file: the template, or `<name>.runs/<run>.yaml`. */
	path(ref: DocRef): string;
	/** Read and parse the template; null run. */
	readTemplate(): ParsedFile;
	/** Read and parse every Run file under `<name>.runs/`. */
	readRuns(): Map<RunId, ParsedFile>;
	/** Serialize (README §S2, runs.md §1). Block bodies as YAML block scalars. */
	serialize(doc: PlaybookDoc, run: RunMeta | null): string;
	/** Parse text in the same format; used for disk edits. */
	parse(text: string, expectRun: boolean): ParsedFile;
	/** Atomic write through a temp file in the same directory; returns the written text. */
	write(ref: DocRef, text: string): void;
	/** Current file text and mtime, or null when the file is missing. */
	stat(ref: DocRef): { readonly text: string; readonly mtimeMs: number } | null;
	/** Service record file (append-only). */
	readServiceRecords(): ServiceRecord[];
	appendServiceRecord(record: ServiceRecord): void;
	/** Execution log of a document (`<file>.log.jsonl` for the template, `<runs>/<run>.jsonl` for a Run): entries and launch lines (runs.md §3). */
	readLog(ref: DocRef): { readonly entries: TimelineEntry[]; readonly launches: Map<LaunchId, Launch> };
	appendEntry(ref: DocRef, entry: TimelineEntry): void;
	appendLaunch(ref: DocRef, launch: Launch): void;
	/** Revision journal of a document (`<file>.revisions.jsonl`, `<runs>/<run>.revisions.jsonl`): every submitted design change request, append-only. */
	readRevisions(ref: DocRef): Revision[];
	appendRevision(ref: DocRef, revision: Revision): void;
	/**
	 * Keep image bytes next to the Playbook as `<file>.assets/<sha256>.<extension>`, unchanged and
	 * never rewritten (the name is the content); returns the path relative to `baseDir`.
	 */
	saveAsset(bytes: Uint8Array, extension: string): string;
}

// ---------------------------------------------------------------- checks (pure) — src/service/checks.ts

/** What the UI reports about frames for one block (contracts.md K4 块检查的输入). */
export interface RenderStatus {
	/** An `error` event mapped to this block in the current view. */
	readonly blockError: boolean;
	/** An unmapped `error` event since the last fully acked redraw. */
	readonly documentError: boolean;
	/** The newest frame containing this block was sent ≥ 2 s ago and is not acked. */
	readonly pendingOverdue: boolean;
	/** Text of `md` nodes and alt of `image` nodes the view holds for this block (checks.md §1 `view`). */
	readonly view: { readonly md: readonly string[]; readonly images: readonly string[] };
	/** Error findings the component renderers reported while drawing the block (a missing file, an oversized image). */
	readonly draftErrors: number;
}

export interface ChecksModule {
	/** Deterministic checks for one block (checks.md §2). `expansions` = each reference's expansion text or error (empty for design blocks). */
	findings(input: {
		readonly compiled: CompileResult;
		readonly expansions: readonly CompileResult[];
		readonly content: BlockContent;
		readonly render: RenderStatus;
	}): Findings;
	/** SHA-256 version (checks.md §1). */
	version(input: { readonly closure: ReadonlyMap<BlockId, string | null>; readonly results: readonly BlockResult[]; readonly compiled: CompileResult }): string;
	/** Validate a report against the question table (checks.md §3, §5). */
	validateReport(result: JudgeReport): boolean;
	/** The closed question table (checks.md §3). */
	readonly questions: readonly { readonly id: string; readonly type: "bool"; readonly instructions: string; readonly threshold: number }[];
}

export type { FindingName };

// ---------------------------------------------------------------- core API — implemented by src/service/core.ts

export interface BlockView {
	readonly block: Block;
	/** A launch request was sent for this block and no Launch has been created from it since. */
	readonly launchPending: boolean;
}

export interface DocView {
	readonly ref: DocRef;
	readonly title: string;
	readonly run: RunMeta | null;
	readonly blocks: readonly BlockView[];
	readonly errors: readonly string[];
}

export interface CoordinatorStatus {
	readonly connected: boolean;
	readonly session: string | null;
	readonly pane: string | null;
}

/**
 * Human operations from the TSP UI (contracts.md K4). Each applies at once or is refused with a message;
 * there are no drafts. A person's change to a block the coordinator holds takes the block back first.
 */
export interface HumanCommands {
	/** Replace `field` whole with `text`, refused when it no longer equals `expected` (the text the person edited). */
	edit(ref: DocRef, block: BlockId, field: HumanField, expected: string, text: string): string | null;
	/** Replace the document title, refused when it no longer equals `expected`. */
	setTitle(ref: DocRef, expected: string, text: string): string | null;
	/** Submit a change request for a design block and notify the coordinator (refused without one). */
	requestRevision(ref: DocRef, block: BlockId, text: string): string | null;
	setStatus(ref: DocRef, block: BlockId, status: Status): string | null;
	/** A task block's default agent; null clears it. */
	setAgent(ref: DocRef, block: BlockId, agent: string | null): string | null;
	setIsolated(ref: DocRef, block: BlockId, isolated: boolean): string | null;
	deleteBlock(ref: DocRef, block: BlockId): string | null;
	/** Ask the coordinator to run `blocks` together (refused without one). */
	requestLaunch(ref: DocRef, blocks: readonly BlockId[]): string | null;
	/** Ask the coordinator to stop the block's open Launches; with none open the block goes back to todo at once. */
	requestStop(ref: DocRef, block: BlockId): string | null;
	/** Keep a pasted image beside the Playbook; the path is relative to the Playbook's directory, for `![…](path)`. */
	saveImage(bytes: Uint8Array, mimeType: string): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string };
}

export interface CoreApi extends HumanCommands {
	view(ref: DocRef): DocView;
	coordinator(): CoordinatorStatus;
	/** The coordinator's latest answer about launchable subagents. */
	agents(): AgentList;
	/** Ask the coordinator for that list again (a SUBAGENT dropdown opened); a no-op without a coordinator. */
	requestAgents(): void;
	focusCoordinator(): Promise<string | null>;
	/** Document-level messages (disk parse errors, unmapped TSP errors, K5 errors). */
	errors(): readonly string[];
	/** Subscribe to state changes; the UI redraws the affected document (null = everything). */
	onChange(listener: (ref: DocRef | null) => void): () => void;
	/** UI reports render status per block so the core can compute findings. */
	setRenderStatus(ref: DocRef, block: BlockId, status: RenderStatus): void;
}

// ---------------------------------------------------------------- K1 transport — src/service/socket.ts

export interface Connection {
	readonly id: number;
	send(frame: EventPayload): void;
	close(): void;
}

/** Implemented by the core; called by the socket server for each request in arrival order. */
export interface K1Handler {
	connected(conn: Connection): void;
	disconnected(conn: Connection): void;
	handle(conn: Connection, requestId: string, request: Request): Promise<Outcome<unknown>>;
}

/** Re-exported for modules that need the fetch table type. */
export type { FetchTable };
