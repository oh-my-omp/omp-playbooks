// Document service core: the single owner of Playbook, Run, Launch, lock and timeline state.
// Rules come from design/; section references are given at each rule.
import type {
	AgentList,
	Block,
	BlockContent,
	BlockField,
	BlockId,
	BlockLock,
	BlockResult,
	CompileInput,
	CompileResult,
	DocRef,
	EditOrigin,
	EntryData,
	EntryOrigin,
	ExternalTarget,
	FetchOutcome,
	Findings,
	HumanField,
	JudgeReport,
	Launch,
	LaunchCloser,
	LaunchId,
	LaunchKind,
	PlaybookDoc,
	Progress,
	RecordKind,
	Revision,
	RunId,
	RunMeta,
	Status,
	TargetKey,
	TaskConfig,
	TimelineEntry,
} from "../domain/model";
import { coordinatorField, fieldText, freshProgress, humanFieldValid, idNumber, withField } from "../domain/model";
import type {
	BlockView,
	ChecksModule,
	Connection,
	CoordinatorStatus,
	CoreApi,
	DocView,
	Fetcher,
	K1Handler,
	ReferencesModule,
	RenderStatus,
	ServiceRecord,
	Store,
} from "../domain/ports";
import type { EventPayload, Outcome, Request, RunSummary } from "../domain/protocol";
import { fail, ok } from "../domain/protocol";
import { launchFooter } from "./footer";

export interface PaneControl {
	ownPane(): string | null;
	focusPane(pane: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface CoreDeps {
	readonly store: Store;
	readonly references: ReferencesModule;
	readonly fetcher: Fetcher;
	readonly checks: ChecksModule;
	readonly panes: PaneControl;
	readonly now?: () => number;
}

type DocKey = "template" | RunId;

interface DocState {
	readonly ref: DocRef;
	title: string;
	blocks: Block[];
	run: RunMeta | null;
	locks: Map<BlockId, BlockLock>;
	/** Text and parsed form of the file as last written or read (README §S2). */
	lastText: string;
	lastDoc: PlaybookDoc;
	lastMtime: number;
	writeTimer: Timer | undefined;
	parseError: string | null;
	findings: Map<BlockId, Findings>;
	render: Map<BlockId, RenderStatus>;
	/** Per block-set key: last inspect version, whether its inputs changed since (checks.md §5), and the accepted report. */
	inspections: Map<string, { blocks: BlockId[]; version: string; stale: boolean; report: JudgeReport | null }>;
	/** The document's revision journal (authoritative copy on disk; append-only). */
	revisions: Revision[];
}

/** A document's execution log: the template's and every Run's. */
interface DocLog {
	entries: TimelineEntry[];
}

interface LaunchState {
	record: Launch;
	pending: { event: string; maxSeq: number; result: CompileResult } | null;
	deadline: number | null;
	timer: Timer | undefined;
	/** Incremented to discard in-flight judgments (rebase, close, disconnect). */
	generation: number;
	judging: boolean;
}

interface ConnState {
	conn: Connection;
	session: string | null;
	pane: string | null;
	/** The coordinator's answer about launchable subagents; it belongs to this connection and ends with it. */
	agents: AgentList;
}

const JUDGE_DELAY_MS = 2_000;
const WRITE_DELAY_MS = 1_000;
const DISK_POLL_MS = 1_000;

function keyOf(ref: DocRef): DocKey {
	return ref.kind === "template" ? "template" : ref.run;
}
function refOf(key: DocKey): DocRef {
	return key === "template" ? { kind: "template" } : { kind: "run", run: key };
}
/** The document a Launch or an event belongs to: its Run, or the template when it names none. */
function keyOfRun(run: RunId | null | undefined): DocKey {
	return run ?? "template";
}
/** `run` as optional event/request field: present only for a Run. */
function runField(doc: { readonly run: RunMeta | null }): { run?: RunId } {
	return doc.run ? { run: doc.run.id } : {};
}
function sameResult(a: CompileResult | null, b: CompileResult | null): boolean {
	if (a === null || b === null) return a === b;
	if (a.kind !== b.kind) return false;
	if (a.kind === "Ok" && b.kind === "Ok") return a.text === b.text;
	return JSON.stringify(a) === JSON.stringify(b);
}
function sameProgress(a: Progress, b: Progress): boolean {
	if (a.kind === "untracked" || b.kind === "untracked") return a.kind === b.kind;
	return a.status === b.status && a.report === b.report;
}
/** Blocks a logged `launch_requested` payload names; the log keeps event data as it was sent. */
function requestedBlocks(data: unknown): readonly string[] {
	if (typeof data !== "object" || data === null || !("blocks" in data) || !Array.isArray(data.blocks)) return [];
	return data.blocks.filter((value): value is string => typeof value === "string");
}
/** Orchestration block: a task block whose whole body is one `js` or `py` fenced code block (README §定义). */
export function isOrchestration(content: BlockContent): boolean {
	if (content.kind !== "task") return false;
	return /^(`{3,}|~{3,})(js|py)[ \t]*\n[\s\S]*?\n\1[ \t]*\n?$/.test(content.body.trim() + "\n");
}

/** A block as K1 sends it: content and progress fields flattened beside `kind`, as the file writes them. */
export function wireBlock(block: Block): Record<string, unknown> {
	const content = block.content;
	const progress = block.progress.kind === "untracked"
		? { task: false }
		: { status: block.progress.status, ...(block.progress.report === null ? {} : { report: block.progress.report }) };
	switch (content.kind) {
		case "task": return {
			id: block.id, kind: "task", title: block.title, body: content.body,
			...(content.agent === undefined ? {} : { agent: content.agent }),
			...(content.isolated === undefined ? {} : { isolated: content.isolated }),
			...progress,
		};
		case "design": return { id: block.id, kind: "design", title: block.title, requirement: content.requirement, design: content.design, ...progress };
	}
}

/** A block's execution contract; a design block has none. */
function taskConfig(content: BlockContent): TaskConfig {
	return content.kind === "task" ? { agent: content.agent, isolated: content.isolated } : {};
}

/** Task content carrying exactly `config`; unset keys are absent, not undefined. */
function withConfig(content: Extract<BlockContent, { kind: "task" }>, config: TaskConfig): BlockContent {
	return {
		kind: "task",
		body: content.body,
		...(config.agent === undefined ? {} : { agent: config.agent }),
		...(config.isolated === undefined ? {} : { isolated: config.isolated }),
	};
}

/** The contract every root shares: a key is returned only when all roots set it to the same value. */
function sharedConfig(contents: readonly BlockContent[]): TaskConfig {
	const configs = contents.map(taskConfig);
	const shared = <K extends keyof TaskConfig>(key: K): TaskConfig[K] => {
		const first = configs[0]?.[key];
		return first !== undefined && configs.every(config => config[key] === first) ? first : undefined;
	};
	const agent = shared("agent");
	const isolated = shared("isolated");
	return { ...(agent === undefined ? {} : { agent }), ...(isolated === undefined ? {} : { isolated }) };
}

/** Three-way merge of one value: the disk's change wins unless the disk still has the last written value. */
function merged<T>(disk: T, written: T, current: T): T {
	return disk === written || disk === current ? current : disk;
}

export class Core implements CoreApi, K1Handler {
	readonly #store: Store;
	readonly #refs: ReferencesModule;
	readonly #fetcher: Fetcher;
	readonly #checks: ChecksModule;
	readonly #panes: PaneControl;
	readonly #now: () => number;

	readonly #docs = new Map<DocKey, DocState>();
	readonly #logs = new Map<DocKey, DocLog>();
	readonly #launches = new Map<LaunchId, LaunchState>();
	/** Document fetch table (references.md §5); not persisted. */
	readonly #fetches = new Map<TargetKey, FetchOutcome>();
	readonly #inflight = new Map<TargetKey, Promise<FetchOutcome>>();
	readonly #listeners = new Set<(ref: DocRef | null) => void>();
	readonly #reminders = new Map<RunId, Timer>();
	readonly #errors: string[] = [];

	#maxBlock = 0;
	#maxRun = 0;
	#maxLaunch = 0;
	#editSeq = 0;
	#eventSeq = 0;
	#conn: ConnState | null = null;
	#diskTimer: Timer | undefined;

	constructor(deps: CoreDeps) {
		this.#store = deps.store;
		this.#refs = deps.references;
		this.#fetcher = deps.fetcher;
		this.#checks = deps.checks;
		this.#panes = deps.panes;
		this.#now = deps.now ?? Date.now;
	}

	// ============================================================ loading

	/** Load template, Runs, service records and execution logs; start disk polling and reminders. */
	load(): string | null {
		const template = this.#store.readTemplate();
		if (!template.ok) return template.error;
		this.#docs.set("template", this.#newDocState({ kind: "template" }, template.doc, null));
		for (const record of this.#store.readServiceRecords()) this.#noteRecord(record);
		for (const [run, parsed] of this.#store.readRuns()) {
			if (!parsed.ok || parsed.run === null) {
				this.#errors.push(`Run ${run} 的文件不能解析：${parsed.ok ? "缺少 run 映射" : parsed.error}`);
				continue;
			}
			this.#docs.set(run, this.#newDocState({ kind: "run", run }, parsed.doc, parsed.run));
			this.#maxRun = Math.max(this.#maxRun, idNumber(run));
		}
		for (const [key, doc] of this.#docs) {
			const log = this.#store.readLog(doc.ref);
			this.#logs.set(key, { entries: log.entries });
			for (const launch of log.launches.values()) {
				this.#maxLaunch = Math.max(this.#maxLaunch, idNumber(launch.id));
				this.#launches.set(launch.id, { record: launch, pending: null, deadline: null, timer: undefined, generation: 0, judging: false });
				// Dirty entries are ordered against new edits, so edit numbers continue above every persisted one.
				for (const [, seq] of launch.dirty) this.#editSeq = Math.max(this.#editSeq, seq);
			}
			for (const entry of log.entries) if (entry.data.type === "block_edited") this.#editSeq = Math.max(this.#editSeq, entry.data.edit);
		}
		for (const doc of this.#docs.values()) for (const block of doc.blocks) this.#maxBlock = Math.max(this.#maxBlock, idNumber(block.id));
		for (const doc of this.#docs.values()) if (doc.run?.status === "running") this.#scheduleReminder(doc.run.id, true);
		this.#diskTimer = setInterval(() => this.#pollDisk(), DISK_POLL_MS);
		for (const key of this.#docs.keys()) void this.#recomputeChecks(key);
		return null;
	}

	stop(): void {
		clearInterval(this.#diskTimer);
		for (const timer of this.#reminders.values()) clearTimeout(timer);
		for (const launch of this.#launches.values()) clearTimeout(launch.timer);
		for (const doc of this.#docs.values()) {
			if (doc.writeTimer) {
				clearTimeout(doc.writeTimer);
				this.#writeNow(doc);
			}
		}
	}

	#newDocState(ref: DocRef, doc: PlaybookDoc, run: RunMeta | null): DocState {
		const text = this.#store.serialize(doc, run);
		const stat = this.#store.stat(ref);
		return {
			ref,
			title: doc.title,
			blocks: [...doc.blocks],
			run,
			locks: new Map(doc.blocks.map(block => [block.id, { kind: "none" }])),
			lastText: stat?.text ?? text,
			lastDoc: doc,
			lastMtime: stat?.mtimeMs ?? 0,
			writeTimer: undefined,
			parseError: null,
			findings: new Map(),
			render: new Map(),
			inspections: new Map(),
			revisions: this.#store.readRevisions(ref),
		};
	}

	#noteRecord(record: ServiceRecord): void {
		switch (record.kind) {
			case "block":
				this.#maxBlock = Math.max(this.#maxBlock, idNumber(record.id));
				return;
			case "run":
				this.#maxRun = Math.max(this.#maxRun, idNumber(record.id));
				return;
			case "launch":
				this.#maxLaunch = Math.max(this.#maxLaunch, idNumber(record.id));
				return;
		}
	}

	// ============================================================ lookup helpers

	#doc(ref: DocRef): DocState | null {
		return this.#docs.get(keyOf(ref)) ?? null;
	}
	#block(doc: DocState, id: BlockId): Block | null {
		return doc.blocks.find(block => block.id === id) ?? null;
	}
	#contents(doc: DocState): Map<BlockId, BlockContent> {
		return new Map(doc.blocks.map(block => [block.id, block.content]));
	}
	#isFinished(doc: DocState): boolean {
		return doc.run !== null && doc.run.status === "finished";
	}
	#emit(ref: DocRef | null): void {
		for (const listener of this.#listeners) listener(ref);
	}

	// ============================================================ execution log

	#append(key: DocKey, origin: EntryOrigin, data: EntryData): TimelineEntry {
		const log = this.#logs.get(key);
		if (!log) throw new Error(`no log for ${key}`);
		const entry: TimelineEntry = { seq: (log.entries.at(-1)?.seq ?? 0) + 1, at: this.#now(), origin, data };
		log.entries.push(entry);
		this.#store.appendEntry(refOf(key), entry);
		return entry;
	}

	/** Block result table of a document (references.md §4). */
	#results(key: DocKey): Map<BlockId, BlockResult> {
		const table = new Map<BlockId, BlockResult>();
		for (const entry of this.#logs.get(key)?.entries ?? []) {
			const data = entry.data;
			if (data.type === "post" && data.kind === "result" && data.block !== undefined) {
				table.set(data.block, { text: data.text, at: entry.at, seq: entry.seq, origin: entry.origin, launch: data.launch ?? null });
			}
		}
		return table;
	}

	// ============================================================ fetching and compiling

	async #fetchTarget(target: ExternalTarget, replace: boolean): Promise<FetchOutcome> {
		const key = this.#refs.targetKey(target);
		const existing = this.#fetches.get(key);
		if (existing && !replace) return existing;
		const inflight = this.#inflight.get(key);
		if (inflight) return inflight;
		const promise = this.#fetcher.fetch(target, this.#store.baseDir).then(outcome => {
			this.#fetches.set(key, outcome);
			this.#inflight.delete(key);
			if (replace) {
				for (const doc of this.#docs.values()) {
					this.#invalidateInspections(doc, blocks => this.#refs.externalTargets(blocks, this.#contents(doc)).some(other => this.#refs.targetKey(other) === key));
				}
			}
			return outcome;
		});
		this.#inflight.set(key, promise);
		this.#emit(null);
		return promise;
	}

	/** Fetch every external target the closure of `roots` references that is missing from the document table. */
	async #ensureFetched(doc: DocState, roots: readonly BlockId[]): Promise<void> {
		const targets = this.#refs.externalTargets(roots, this.#contents(doc));
		await Promise.all(targets.filter(target => !this.#fetches.has(this.#refs.targetKey(target))).map(target => this.#fetchTarget(target, false)));
	}

	#input(doc: DocState, fetches: ReadonlyMap<TargetKey, FetchOutcome>, contents?: ReadonlyMap<BlockId, BlockContent>, results?: ReadonlyMap<BlockId, BlockResult>): CompileInput {
		return {
			blocks: contents ?? this.#contents(doc),
			fetches,
			results: results ?? this.#results(keyOf(doc.ref)),
		};
	}

	/** Compile after fetching missing targets; the compile itself runs synchronously on current state. */
	async #compileNow(doc: DocState, blocks: readonly BlockId[]): Promise<CompileResult> {
		await this.#ensureFetched(doc, blocks);
		return this.#refs.compile(blocks, this.#input(doc, this.#fetches));
	}

	// ============================================================ edits

	/**
	 * Apply one edit and its consequences: timeline entry, dirty tracking for Launches
	 * (launch-events.md §3), write-back scheduling (README §S2), checks and redraw.
	 */
	#applyEdit(doc: DocState, origin: EditOrigin, change: EditChange): number {
		const seq = ++this.#editSeq;
		const key = keyOf(doc.ref);
		const beforeContents = this.#contents(doc);
		let touched: BlockId | null = null;
		let contentOrExistence = false;
		// A coordinator's task edit is its own work and does not notify it back; a design is the input
		// of the task blocks that reference it, so the coordinator's design edits reach their Launches.
		let notifies = origin !== "coordinator";
		switch (change.kind) {
			case "field": {
				const index = doc.blocks.findIndex(block => block.id === change.block);
				const next = withField(doc.blocks[index]!, change.field, change.text);
				if (next === null) throw new Error(`block ${change.block} has no field ${change.field}`);
				doc.blocks[index] = next;
				touched = change.block;
				contentOrExistence = change.field !== "title";
				if (change.field === "design") notifies = true;
				this.#append(key, origin, { type: "block_edited", block: change.block, field: change.field, text: change.text, edit: seq });
				break;
			}
			case "content": {
				const index = doc.blocks.findIndex(block => block.id === change.block);
				doc.blocks[index] = { ...doc.blocks[index]!, content: change.content, progress: change.progress };
				touched = change.block;
				contentOrExistence = true;
				this.#append(key, origin, { type: "content_replaced", block: change.block, content: change.content });
				this.#append(key, origin, { type: "progress_changed", block: change.block, progress: change.progress });
				break;
			}
			case "config": {
				// The execution contract is not compiled text: it neither marks Launches dirty nor ends inspections.
				const index = doc.blocks.findIndex(block => block.id === change.block);
				const current = doc.blocks[index]!;
				if (current.content.kind !== "task") throw new Error(`block ${change.block} is not a task block`);
				const content = withConfig(current.content, change.config);
				doc.blocks[index] = { ...current, content };
				this.#append(key, origin, { type: "content_replaced", block: change.block, content });
				break;
			}
			case "progress": {
				// Progress is not compiled text either: a report or a status never reaches a Launch's prompt.
				const index = doc.blocks.findIndex(block => block.id === change.block);
				doc.blocks[index] = { ...doc.blocks[index]!, progress: change.progress };
				this.#append(key, origin, { type: "progress_changed", block: change.block, progress: change.progress });
				break;
			}
			case "insert": {
				const index = change.after === null ? doc.blocks.length : doc.blocks.findIndex(block => block.id === change.after) + 1;
				doc.blocks.splice(index, 0, change.block);
				doc.locks.set(change.block.id, { kind: "none" });
				touched = change.block.id;
				contentOrExistence = true;
				this.#append(key, origin, { type: "block_added", block: change.block.id, title: change.block.title, content: change.block.content });
				break;
			}
			case "delete": {
				const index = doc.blocks.findIndex(block => block.id === change.block);
				const [removed] = doc.blocks.splice(index, 1);
				doc.locks.delete(change.block);
				touched = change.block;
				contentOrExistence = true;
				if (removed) this.#append(key, origin, { type: "block_deleted", block: removed.id, title: removed.title, content: removed.content });
				break;
			}
			case "reorder": {
				const byId = new Map(doc.blocks.map(block => [block.id, block]));
				if (change.order.length !== byId.size || new Set(change.order).size !== byId.size || change.order.some(id => !byId.has(id))) {
					throw new Error("reorder needs a permutation of the document's blocks");
				}
				doc.blocks = change.order.map(id => byId.get(id)!);
				this.#append(key, origin, { type: "blocks_reordered", order: change.order });
				break;
			}
		}
		if (touched !== null && contentOrExistence) {
			const changed = touched;
			const afterContents = this.#contents(doc);
			this.#invalidateInspections(doc, blocks => this.#refs.closure(blocks, beforeContents).has(changed) || this.#refs.closure(blocks, afterContents).has(changed));
		}
		if (touched !== null && contentOrExistence && notifies) this.#markDirty(doc, touched, seq, beforeContents);
		this.#scheduleWrite(doc);
		this.#afterChange(doc);
		return seq;
	}

	/** checks.md §5: a pending inspection and a shown report end when their inputs change. */
	#invalidateInspections(doc: DocState, affects: (blocks: readonly BlockId[]) => boolean): void {
		for (const [setKey, inspection] of doc.inspections) {
			if (inspection.stale || !affects(inspection.blocks)) continue;
			doc.inspections.set(setKey, { ...inspection, stale: true, report: null });
		}
	}

	/** launch-events.md §3: human and disk edits of body or existence enter `dirty`. */
	#markDirty(doc: DocState, block: BlockId, seq: number, beforeContents: ReadonlyMap<BlockId, BlockContent>): void {
		const key = keyOf(doc.ref);
		const afterBodies = this.#contents(doc);
		for (const launch of this.#launches.values()) {
			if (keyOfRun(launch.record.run) !== key || launch.record.closed !== null) continue;
			const inBefore = this.#refs.closure(launch.record.blocks, beforeContents).has(block);
			const inAfter = this.#refs.closure(launch.record.blocks, afterBodies).has(block);
			if (!inBefore && !inAfter) continue;
			const dirty = new Map(launch.record.dirty);
			dirty.set(block, seq);
			this.#setLaunch(launch, { ...launch.record, dirty: [...dirty] });
			launch.deadline = this.#now() + JUDGE_DELAY_MS;
			this.#scheduleJudge(launch);
		}
	}

	#afterChange(doc: DocState): void {
		void this.#recomputeChecks(keyOf(doc.ref));
		this.#emit(doc.ref);
	}

	// ============================================================ write-back and disk edits (README §S2)

	#scheduleWrite(doc: DocState): void {
		if (doc.writeTimer) return;
		doc.writeTimer = setTimeout(() => {
			doc.writeTimer = undefined;
			this.#writeNow(doc);
		}, WRITE_DELAY_MS);
	}

	#writeNow(doc: DocState): void {
		// A disk edit made since the last poll (a subagent writing its report) is taken in before writing over it.
		this.#pollDoc(doc);
		if (doc.parseError !== null) return;
		const snapshot: PlaybookDoc = { title: doc.title, blocks: [...doc.blocks] };
		const text = this.#store.serialize(snapshot, doc.run);
		this.#store.write(doc.ref, text);
		doc.lastText = text;
		doc.lastDoc = snapshot;
		doc.lastMtime = this.#store.stat(doc.ref)?.mtimeMs ?? doc.lastMtime;
	}

	/** Run mapping changes are written immediately, before their timeline entry (runs.md §6). */
	#writeRunNow(doc: DocState): void {
		if (doc.writeTimer) {
			clearTimeout(doc.writeTimer);
			doc.writeTimer = undefined;
		}
		this.#writeNow(doc);
	}

	#pollDisk(): void {
		for (const doc of this.#docs.values()) this.#pollDoc(doc);
	}

	#pollDoc(doc: DocState): void {
		const stat = this.#store.stat(doc.ref);
		if (!stat || stat.mtimeMs === doc.lastMtime) return;
		doc.lastMtime = stat.mtimeMs;
		if (stat.text === doc.lastText) {
			if (doc.parseError !== null) {
				doc.parseError = null;
				this.#emit(doc.ref);
			}
			return;
		}
		const parsed = this.#store.parse(stat.text, doc.run !== null);
		if (!parsed.ok) {
			doc.parseError = parsed.error;
			this.#emit(doc.ref);
			return;
		}
		if (doc.parseError !== null) {
			doc.parseError = null;
			this.#emit(doc.ref);
		}
		doc.lastText = stat.text;
		this.#applyDisk(doc, parsed.doc);
		doc.lastDoc = parsed.doc;
	}

	#applyDisk(doc: DocState, next: PlaybookDoc): void {
		const before = new Map(doc.lastDoc.blocks.map(block => [block.id, block]));
		const after = new Map(next.blocks.map(block => [block.id, block]));
		if (next.title !== doc.lastDoc.title) {
			doc.title = next.title;
			this.#scheduleWrite(doc);
			this.#emit(doc.ref);
		}
		for (const id of before.keys()) {
			if (after.has(id) || !this.#block(doc, id)) continue;
			this.#applyEdit(doc, "disk", { kind: "delete", block: id });
		}
		next.blocks.forEach((block, index) => {
			const current = this.#block(doc, block.id);
			if (!current) {
				const afterId = index === 0 ? null : (next.blocks[index - 1]?.id ?? null);
				this.#maxBlock = Math.max(this.#maxBlock, idNumber(block.id));
				this.#applyEdit(doc, "disk", { kind: "insert", after: afterId && this.#block(doc, afterId) ? afterId : null, block });
				return;
			}
			// Compare with the last written content, not the current block (README §S2): unchanged
			// fields on disk must not overwrite edits made since the last write-back.
			const previous = before.get(block.id) ?? current;
			if (block.content.kind !== current.content.kind) {
				// A kind switch replaces the content and its progress whole.
				if (block.content.kind === previous.content.kind) return;
				if (block.title !== previous.title && block.title !== current.title) this.#applyEdit(doc, "disk", { kind: "field", block: block.id, field: "title", text: block.title });
				this.#applyEdit(doc, "disk", { kind: "content", block: block.id, content: block.content, progress: block.progress });
				return;
			}
			for (const field of ["title", "body", "requirement", "design"] as const) {
				const text = fieldText(block, field);
				if (text === null || text === fieldText(previous, field) || text === fieldText(current, field)) continue;
				this.#applyEdit(doc, "disk", { kind: "field", block: block.id, field, text });
			}
			if (block.content.kind === "task" && current.content.kind === "task") {
				const disk = taskConfig(block.content);
				const written = taskConfig(previous.content);
				const mine = taskConfig(current.content);
				const config = { agent: merged(disk.agent, written.agent, mine.agent), isolated: merged(disk.isolated, written.isolated, mine.isolated) };
				if (config.agent !== mine.agent || config.isolated !== mine.isolated) this.#applyEdit(doc, "disk", { kind: "config", block: block.id, config });
			}
			// The subagent that runs a block writes its status and report into the file itself.
			if (!sameProgress(block.progress, previous.progress) && !sameProgress(block.progress, current.progress)) this.#applyEdit(doc, "disk", { kind: "progress", block: block.id, progress: block.progress });
		});
		// Blocks added since the last write-back are not on disk: they keep their slots, and the disk's
		// blocks fill the remaining slots in the disk's order.
		const onDisk = new Set(next.blocks.map(block => block.id));
		const diskOrder = next.blocks.map(block => block.id);
		let slot = 0;
		const order = doc.blocks.map(block => onDisk.has(block.id) ? diskOrder[slot++]! : block.id);
		if (order.join() !== doc.blocks.map(block => block.id).join()) this.#applyEdit(doc, "disk", { kind: "reorder", order });
	}

	// ============================================================ Launch persistence and judgment (launch-events.md)

	#setLaunch(launch: LaunchState, record: Launch): void {
		launch.record = record;
		this.#store.appendLaunch(refOf(keyOfRun(record.run)), record);
	}

	/** Open, owned by the connected coordinator, and in a document that can still run (the template, or a running Run). */
	#isActive(launch: LaunchState): boolean {
		const doc = this.#docs.get(keyOfRun(launch.record.run));
		return doc !== undefined && !this.#isFinished(doc) && launch.record.closed === null && this.#conn?.session === launch.record.session;
	}

	#scheduleJudge(launch: LaunchState): void {
		clearTimeout(launch.timer);
		launch.timer = undefined;
		if (launch.deadline === null) return;
		const wait = Math.max(0, launch.deadline - this.#now());
		launch.timer = setTimeout(() => {
			launch.timer = undefined;
			void this.#judge(launch);
		}, wait);
	}

	/** launch-events.md §3 judgment. */
	async #judge(launch: LaunchState): Promise<void> {
		if (!this.#isActive(launch) || launch.pending !== null || launch.judging) return;
		if (launch.record.dirty.length === 0) return;
		if (launch.deadline !== null && launch.deadline > this.#now()) return;
		const doc = this.#docs.get(keyOfRun(launch.record.run))!;
		const maxSeq = Math.max(...launch.record.dirty.map(([, seq]) => seq));
		const changed = launch.record.dirty.map(([block]) => block);
		const generation = launch.generation;
		launch.judging = true;
		const fetches = await this.#launchFetches(launch);
		launch.judging = false;
		if (generation !== launch.generation || !this.#isActive(launch) || launch.pending !== null) return;
		// The same inputs `rebase` accepts: current contents and the document's current results.
		const result = this.#launchText(doc, launch.record.blocks, launch.record.kind, this.#refs.compile(launch.record.blocks, this.#input(doc, fetches)));
		const baseline = launch.record.baselines.at(-1)!;
		const dropUpTo = (): void => {
			this.#setLaunch(launch, { ...launch.record, dirty: launch.record.dirty.filter(([, seq]) => seq > maxSeq) });
		};
		if (result.kind === "Ok" && result.text === baseline) {
			launch.record = { ...launch.record, notified: null };
			dropUpTo();
		} else if (!sameResult(result, launch.record.notified)) {
			const id = `e${++this.#eventSeq}`;
			launch.pending = { event: id, maxSeq, result };
			this.#send({
				event: "block_changed",
				data: {
					id,
					launch: { id: launch.record.id, kind: launch.record.kind, ...(launch.record.run === null ? {} : { run: launch.record.run }) },
					agents: launch.record.agents,
					changed,
					diff: result.kind === "Ok" ? this.#refs.unifiedDiff(baseline, result.text) : "",
					current: result,
				},
			});
		} else {
			dropUpTo();
		}
		this.#emit(refOf(keyOfRun(launch.record.run)));
		if (launch.pending === null && launch.record.dirty.length > 0 && launch.deadline !== null && launch.deadline <= this.#now()) void this.#judge(launch);
	}

	/**
	 * The judgment fetch table of a Launch, extended with every target its current closure references
	 * (launch-events.md §3). Fetching yields to other requests that may edit the closure, so this repeats
	 * until the contents at return need no target the table lacks.
	 */
	async #launchFetches(launch: LaunchState): Promise<Map<TargetKey, FetchOutcome>> {
		const doc = this.#docs.get(keyOfRun(launch.record.run))!;
		for (;;) {
			const table = new Map(launch.record.fetches);
			const added: [TargetKey, FetchOutcome][] = [];
			for (const target of this.#refs.externalTargets(launch.record.blocks, this.#contents(doc))) {
				const key = this.#refs.targetKey(target);
				if (table.has(key)) continue;
				const outcome = this.#fetches.get(key) ?? (await this.#fetchTarget(target, false));
				table.set(key, outcome);
				added.push([key, outcome]);
			}
			if (added.length === 0) return table;
			// A concurrent judgment or rebase may have recorded the same targets meanwhile.
			const recorded = new Set(launch.record.fetches.map(([key]) => key));
			this.#setLaunch(launch, { ...launch.record, fetches: [...launch.record.fetches, ...added.filter(([key]) => !recorded.has(key))] });
		}
	}

	#closeLaunch(launch: LaunchState, by: LaunchCloser, origin: EntryOrigin): void {
		launch.generation++;
		launch.pending = null;
		launch.deadline = null;
		clearTimeout(launch.timer);
		launch.timer = undefined;
		this.#setLaunch(launch, { ...launch.record, closed: { at: this.#now(), by } });
		this.#append(keyOfRun(launch.record.run), origin, { type: "launch_closed", launch: launch.record.id });
	}

	/**
	 * What a Launch's subagent receives: the compiled prompt, and for a prompt Launch the implicit
	 * instructions to write the blocks' status and completion report into the document file itself.
	 */
	#launchText(doc: DocState, blocks: readonly BlockId[], kind: LaunchKind, result: CompileResult): CompileResult {
		if (result.kind === "Err" || kind === "orchestration") return result;
		const roots = blocks.flatMap(id => {
			const block = this.#block(doc, id);
			return block && block.progress.kind === "tracked" ? [{ id, title: block.title }] : [];
		});
		return roots.length === 0 ? result : { ...result, text: `${result.text}\n\n${launchFooter(this.#store.path(doc.ref), roots)}` };
	}

	// ============================================================ events

	/** Send an event to the current connection and record it in its document's log (launch-events.md §6). Returns false without a connection. */
	#send(payload: EventPayload): boolean {
		if (!this.#conn || this.#conn.session === null) return false;
		this.#conn.conn.send(payload);
		const run = payload.event === "block_changed" ? payload.data.launch.run : payload.data.run;
		this.#append(keyOfRun(run), "service", { type: "event_sent", event: payload.event, data: payload.data });
		return true;
	}

	// ============================================================ reminders (runs.md §6)

	#scheduleReminder(run: RunId, startup = false): void {
		const existing = this.#reminders.get(run);
		clearTimeout(existing);
		this.#reminders.delete(run);
		const doc = this.#docs.get(run);
		const meta = doc?.run;
		if (!doc || !meta || meta.status !== "running" || meta.updateDue === null) return;
		const due = meta.updateDue;
		const fired = (this.#logs.get(run)?.entries ?? []).some(entry => entry.data.type === "update_due" && entry.data.due === due);
		if (fired) return;
		const wait = Math.max(0, due - this.#now());
		if (startup && wait === 0) {
			this.#fireReminder(run, due);
			return;
		}
		this.#reminders.set(
			run,
			setTimeout(() => this.#fireReminder(run, due), wait),
		);
	}

	#fireReminder(run: RunId, due: number): void {
		this.#reminders.delete(run);
		const doc = this.#docs.get(run);
		if (!doc?.run || doc.run.status !== "running" || doc.run.updateDue !== due) return;
		this.#append(run, "service", { type: "update_due", due });
		this.#send({ event: "update_due", data: { run, due, last_update: this.#lastUpdateAt(run) } });
		this.#emit(doc.ref);
	}

	#lastUpdateAt(run: RunId): number | null {
		const entries = this.#logs.get(run)?.entries ?? [];
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i]!;
			if (entry.data.type === "post" && entry.data.kind === "update") return entry.at;
		}
		return null;
	}

	#setDue(doc: DocState, due: number | null): void {
		doc.run = { ...doc.run!, updateDue: due };
		this.#writeRunNow(doc);
		this.#scheduleReminder(doc.run.id);
	}

	// ============================================================ checks (checks.md)

	async #recomputeChecks(key: DocKey): Promise<void> {
		const doc = this.#docs.get(key);
		if (!doc) return;
		await this.#ensureFetched(
			doc,
			doc.blocks.map(block => block.id),
		);
		const input = this.#input(doc, this.#fetches);
		let changed = false;
		for (const block of doc.blocks) {
			const compiled = this.#refs.compile([block.id], input);
			const expansions = block.content.kind === "task" ? this.#refs.parseReferences(block.content.body).map(reference => this.#refs.expandOne(block.id, reference, input)) : [];
			const render = doc.render.get(block.id) ?? { blockError: false, documentError: false, pendingOverdue: false, view: { md: [], images: [] }, draftErrors: 0 };
			const next = this.#checks.findings({ compiled, expansions, content: block.content, render });
			const previous = doc.findings.get(block.id);
			if (JSON.stringify(previous) !== JSON.stringify(next)) changed = true;
			doc.findings.set(block.id, next);
		}
		for (const [setKey, inspection] of doc.inspections) {
			if (inspection.report === null) continue;
			if (this.#version(doc, inspection.blocks, input) !== inspection.version) {
				doc.inspections.set(setKey, { ...inspection, report: null });
				changed = true;
			}
		}
		if (changed) this.#emit(doc.ref);
	}

	#version(doc: DocState, blocks: readonly BlockId[], input: CompileInput): string {
		const contents = this.#contents(doc);
		const closure = new Map<BlockId, string | null>();
		// A task contributes its body (as before design blocks existed); a design its kind and both parts.
		for (const id of this.#refs.closure(blocks, contents)) {
			const content = contents.get(id);
			closure.set(id, content === undefined ? null : content.kind === "task" ? content.body : JSON.stringify(content));
		}
		const results = this.#refs.resultTargets(blocks, contents).flatMap(id => {
			const result = input.results.get(id);
			return result ? [result] : [];
		});
		return this.#checks.version({ closure, results, compiled: this.#refs.compile(blocks, input) });
	}

	#inspectState(doc: DocState, blocks: readonly BlockId[]): unknown {
		const input = this.#input(doc, this.#fetches);
		const version = this.#version(doc, blocks, input);
		const setKey = blocks.join(",");
		const previous = doc.inspections.get(setKey);
		doc.inspections.set(setKey, { blocks: [...blocks], version, stale: false, report: previous?.version === version && !previous.stale ? previous.report : null });
		return {
			blocks,
			source: Object.fromEntries(blocks.map(id => {
				const content = this.#block(doc, id)?.content;
				return [id, content === undefined ? null : content.kind === "task" ? content.body : { requirement: content.requirement, design: content.design }];
			})),
			compiled: this.#refs.compile(blocks, input),
			view: Object.fromEntries(blocks.map(id => [id, doc.render.get(id)?.view ?? { md: [], images: [] }])),
			findings: Object.fromEntries(blocks.map(id => [id, doc.findings.get(id) ?? null])),
			version,
		};
	}

	// ============================================================ K1 handler

	/** K1: a transport alone does not occupy the coordinator slot; the first valid hello does. */
	connected(_conn: Connection): void {}

	disconnected(conn: Connection): void {
		if (this.#conn?.conn !== conn) return;
		this.#conn = null;
		for (const doc of this.#docs.values()) {
			for (const [block, lock] of doc.locks) if (lock.kind === "coordinator") doc.locks.set(block, { kind: "none" });
		}
		for (const launch of this.#launches.values()) {
			launch.generation++;
			launch.pending = null;
			launch.judging = false;
		}
		this.#emit(null);
	}

	async handle(conn: Connection, requestId: string, request: Request): Promise<Outcome<unknown>> {
		// K1 reveal: a viewer asks the document's sole service to show its pane; it never
		// takes the coordinator slot, so it is answered before admission.
		if (request.op === "reveal") {
			const pane = this.#panes.ownPane();
			if (pane === null) return fail("RevealFailed", "文档服务不在 session daemon 托管的 pane 中");
			const shown = await this.#panes.focusPane(pane);
			return shown.ok ? ok(null) : fail("RevealFailed", shown.error);
		}
		if (this.#conn?.conn !== conn) {
			if (request.op !== "hello") return fail(this.#conn === null ? "NotHello" : "Busy", this.#conn === null ? "第一条请求必须是 hello" : "另一个协调者已连接");
			if (this.#conn !== null) return fail("Busy", "另一个协调者已连接");
			this.#conn = { conn, session: null, pane: null, agents: { kind: "unasked" } };
		}
		const session = this.#conn.session;
		switch (request.op) {
			case "hello": {
				if (this.#conn.session !== null) return fail("Busy", "本连接已 hello");
				this.#conn.session = request.args.session;
				this.#conn.pane = request.args.pane ?? null;
				for (const launch of this.#launches.values()) {
					if (launch.record.session === request.args.session && launch.record.dirty.length > 0 && this.#isActive(launch)) {
						launch.deadline = this.#now();
						void this.#judge(launch);
					}
				}
				this.#emit(null);
				const pane = this.#panes.ownPane();
				return ok({ blocks: this.#docs.get("template")!.blocks.map(block => block.id), runs: this.runs(), ...(pane ? { pane } : {}) });
			}
			case "lock": {
				const target = this.#target(request.args.run, request.args.block, true);
				if (!target.ok) return target;
				const { doc, block } = target.result;
				doc.locks.set(block.id, { kind: "coordinator", request: requestId });
				this.#emit(doc.ref);
				return ok({ block: wireBlock(block) });
			}
			case "unlock": {
				const doc = this.#docOf(request.args.run);
				if (!doc.ok) return doc;
				const lock = doc.result.locks.get(request.args.block);
				if (lock?.kind === "coordinator" && lock.request === request.args.request) {
					doc.result.locks.set(request.args.block, { kind: "none" });
					this.#emit(doc.result.ref);
				}
				return ok(null);
			}
			case "read": {
				const doc = this.#docOf(request.args.run);
				if (!doc.ok) return doc;
				if (request.args.block !== undefined) {
					const block = this.#block(doc.result, request.args.block);
					return block ? ok(wireBlock(block)) : fail("UnknownBlock", `块 ${request.args.block} 不存在`);
				}
				return ok({ title: doc.result.title, blocks: doc.result.blocks.map(wireBlock), ...(doc.result.run ? { run: doc.result.run } : {}) });
			}
			case "set": {
				const held = this.#held(request.args.run, request.args.block);
				if (!held.ok) return held;
				const { doc } = held.result;
				switch (request.args.field) {
					case "title":
						this.#applyEdit(doc, "coordinator", { kind: "field", block: request.args.block, field: "title", text: request.args.value });
						return ok(null);
					case "status": {
						const progress = this.#statusProgress(held.result.block, request.args.value);
						if (typeof progress === "string") return fail("BadValue", progress);
						this.#applyEdit(doc, "coordinator", { kind: "progress", block: request.args.block, progress });
						return ok(null);
					}
					case "task": {
						const block = held.result.block;
						if (block.content.kind !== "task") return fail("BadValue", "设计块不能声明为非任务块");
						if ((block.progress.kind === "tracked") === request.args.value) return ok(null);
						const progress: Progress = request.args.value ? { kind: "tracked", status: "todo", report: null } : { kind: "untracked" };
						this.#applyEdit(doc, "coordinator", { kind: "progress", block: request.args.block, progress });
						return ok(null);
					}
					case "agent":
					case "isolated": {
						const content = held.result.block.content;
						if (content.kind !== "task") return fail("BadValue", "设计块没有执行配置");
						const value = request.args.value ?? undefined;
						const config = { ...taskConfig(content), [request.args.field]: value };
						this.#applyEdit(doc, "coordinator", { kind: "config", block: request.args.block, config });
						return ok(null);
					}
				}
			}
			case "move": {
				const { block: id, after } = request.args;
				const held = this.#held(request.args.run, id);
				if (!held.ok) return held;
				const { doc } = held.result;
				if (after === id) return fail("BadValue", "不能把块移到自己后面");
				if (after !== null && !this.#block(doc, after)) return fail("UnknownBlock", `块 ${after} 不存在`);
				const current = doc.blocks.map(block => block.id);
				const rest = current.filter(other => other !== id);
				const index = after === null ? 0 : rest.indexOf(after) + 1;
				const order = [...rest.slice(0, index), id, ...rest.slice(index)];
				if (order.join() !== current.join()) this.#applyEdit(doc, "coordinator", { kind: "reorder", order });
				return ok(null);
			}
			case "edit": {
				const held = this.#held(request.args.run, request.args.block);
				if (!held.ok) return held;
				const { doc, block } = held.result;
				const field = coordinatorField(block.content);
				const current = fieldText(block, field)!;
				const first = current.indexOf(request.args.find);
				if (first < 0) return fail("NotFound", field === "body" ? "find 文本不在块正文中" : "find 文本不在设计稿中");
				if (current.indexOf(request.args.find, first + 1) >= 0) return fail("Ambiguous", "find 文本出现多次");
				const text = current.slice(0, first) + request.args.replace + current.slice(first + request.args.find.length);
				this.#applyEdit(doc, "coordinator", { kind: "field", block: block.id, field, text });
				return ok(null);
			}
			case "write": {
				const held = this.#held(request.args.run, request.args.block);
				if (!held.ok) return held;
				const { doc, block } = held.result;
				this.#applyEdit(doc, "coordinator", { kind: "field", block: block.id, field: coordinatorField(block.content), text: request.args.text });
				return ok(null);
			}
			case "panel": {
				const held = this.#held(request.args.run, request.args.block);
				if (!held.ok) return held;
				const { doc, block } = held.result;
				// Task bodies are drawn with the same panels as designs, so a panel of either is addressable.
				const field = coordinatorField(block.content);
				const replaced = this.#refs.replacePanel(fieldText(block, field)!, request.args.panel, request.args.text);
				if (!replaced.ok) return fail(replaced.code, replaced.reason);
				this.#applyEdit(doc, "coordinator", { kind: "field", block: block.id, field, text: replaced.text });
				return ok(null);
			}
			case "insert": {
				const doc = this.#docOf(request.args.run);
				if (!doc.ok) return doc;
				if (this.#isFinished(doc.result)) return fail("RunFinished", "Run 已结束");
				if (request.args.after !== undefined && !this.#block(doc.result, request.args.after)) return fail("UnknownBlock", `块 ${request.args.after} 不存在`);
				const id = this.#allocateBlock(doc.result);
				const given = request.args.content;
				// A design block's requirement is the person's; the coordinator only drafts the design.
				const content: BlockContent = given.kind === "task" ? given : { kind: "design", requirement: "", design: given.design };
				this.#applyEdit(doc.result, "coordinator", { kind: "insert", after: request.args.after ?? null, block: { id, title: request.args.title, progress: { kind: "tracked", status: "todo", report: null }, content } });
				return ok({ block: id });
			}
			case "revisions": {
				const doc = this.#docOf(request.args.run);
				if (!doc.ok) return doc;
				const after = request.args.after ?? 0;
				const block = request.args.block;
				return ok({ revisions: doc.result.revisions.filter(revision => revision.seq > after && (block === undefined || revision.block === block)) });
			}
			case "delete": {
				const held = this.#held(request.args.run, request.args.block);
				if (!held.ok) return held;
				this.#applyEdit(held.result.doc, "coordinator", { kind: "delete", block: request.args.block });
				return ok(null);
			}
			case "refetch": {
				const fetched: { target: string; ok: boolean }[] = [];
				const targets: ExternalTarget[] = [];
				for (const text of request.args.targets) {
					const target = this.#refs.parseTarget(text);
					if (!target || target.kind === "block" || target.kind === "result") return fail("UnknownTarget", `${text} 不是外部目标`);
					targets.push(target);
				}
				for (const target of targets) {
					const outcome = await this.#fetchTarget(target, true);
					fetched.push({ target: this.#refs.targetKey(target), ok: outcome.ok });
				}
				for (const key of this.#docs.keys()) void this.#recomputeChecks(key);
				return ok({ fetched });
			}
			case "compile": {
				const doc = this.#blocksOf(request.args.run, request.args.blocks);
				if (!doc.ok) return doc;
				return ok(await this.#compileNow(doc.result, request.args.blocks));
			}
			case "inspect": {
				const doc = this.#blocksOf(request.args.run, request.args.blocks);
				if (!doc.ok) return doc;
				await this.#ensureFetched(doc.result, request.args.blocks);
				return ok(this.#inspectState(doc.result, request.args.blocks));
			}
			case "report":
				return this.#report(request.args.run, request.args.blocks, request.args.version, request.args.result);
			case "launch":
				return this.#launch(session!, request.args.run, request.args.blocks);
			case "bind": {
				const launch = this.#owned(session!, request.args.launch);
				if (!launch.ok) return launch;
				if (launch.result.record.closed !== null) return fail("BadLaunch", "Launch 已关闭");
				this.#setLaunch(launch.result, { ...launch.result.record, agents: [...launch.result.record.agents, request.args.agent] });
				this.#append(keyOfRun(launch.result.record.run), "coordinator", { type: "agent_bound", launch: request.args.launch, agent: request.args.agent });
				this.#emit(refOf(keyOfRun(launch.result.record.run)));
				return ok(null);
			}
			case "rebase":
				return this.#rebase(session!, request.args.launch);
			case "close": {
				const launch = this.#owned(session!, request.args.launch);
				if (!launch.ok) return launch;
				if (launch.result.record.closed === null) this.#closeLaunch(launch.result, "coordinator", "coordinator");
				this.#emit(refOf(keyOfRun(launch.result.record.run)));
				return ok(null);
			}
			case "launch_info": {
				const launch = this.#launches.get(request.args.launch);
				return launch ? ok(launch.record) : fail("UnknownLaunch", `Launch ${request.args.launch} 不存在`);
			}
			case "start_run":
				return ok({ run: this.#startRun(request.args.name, request.args.update_every ?? null) });
			case "finish_run": {
				const result = this.#finishRun(request.args.run);
				return result === null ? ok(null) : result;
			}
			case "runs":
				return ok({ runs: this.runs() });
			case "timeline": {
				const doc = this.#docOf(request.args.run);
				if (!doc.ok) return doc;
				const after = request.args.after ?? 0;
				return ok({ entries: this.#logs.get(keyOf(doc.result.ref))!.entries.filter(entry => entry.seq > after) });
			}
			case "post": {
				const args = request.args;
				const result = this.#post(args.run, args.kind, args.text, args.block ?? null, args.launch ?? null, args.next ?? null, args.quote ?? null, args.origin === "human" ? "human" : "coordinator", session);
				return result;
			}
			case "snooze":
				return this.#snooze(request.args.run, request.args.after);
			case "ack": {
				for (const launch of this.#launches.values()) {
					if (launch.pending?.event !== request.args.event) continue;
					const pending = launch.pending;
					launch.pending = null;
					this.#setLaunch(launch, {
						...launch.record,
						notified: pending.result,
						dirty: launch.record.dirty.filter(([, seq]) => seq > pending.maxSeq),
					});
					if (launch.record.dirty.length > 0 && launch.deadline !== null && launch.deadline <= this.#now()) void this.#judge(launch);
					return ok(null);
				}
				return fail("UnknownEvent", `事件 ${request.args.event} 不是待确认的事件`);
			}
			case "agents": {
				if (this.#conn.agents.kind !== "pending") return fail("UnknownEvent", "没有待回答的 agents_requested");
				this.#conn.agents = request.args.result;
				this.#emit(null);
				return ok(null);
			}
		}
	}

	// ------------------------------------------------------------ K1 helpers

	#docOf(run: RunId | undefined): Outcome<DocState> {
		const doc = this.#docs.get(run ?? "template");
		return doc ? ok(doc) : fail("UnknownRun", `Run ${run} 不存在`);
	}

	#target(run: RunId | undefined, id: BlockId, modifying: boolean): Outcome<{ doc: DocState; block: Block }> {
		const doc = this.#docOf(run);
		if (!doc.ok) return doc;
		if (modifying && this.#isFinished(doc.result)) return fail("RunFinished", "Run 已结束");
		const block = this.#block(doc.result, id);
		return block ? ok({ doc: doc.result, block }) : fail("UnknownBlock", `块 ${id} 不存在`);
	}

	#held(run: RunId | undefined, id: BlockId): Outcome<{ doc: DocState; block: Block }> {
		const target = this.#target(run, id, true);
		if (!target.ok) return target;
		const lock = target.result.doc.locks.get(id);
		return lock?.kind === "coordinator" ? target : fail("NotLocked", `本连接不持有块 ${id} 的块锁`);
	}

	#blocksOf(run: RunId | undefined, blocks: readonly BlockId[]): Outcome<DocState> {
		const doc = this.#docOf(run);
		if (!doc.ok) return doc;
		for (const id of blocks) if (!this.#block(doc.result, id)) return fail("UnknownBlock", `块 ${id} 不存在`);
		return doc;
	}

	#owned(session: string, id: LaunchId): Outcome<LaunchState> {
		const launch = this.#launches.get(id);
		if (!launch) return fail("UnknownLaunch", `Launch ${id} 不存在`);
		if (launch.record.session !== session) return fail("NotOwner", `Launch ${id} 属于其他会话`);
		return ok(launch);
	}

	#allocateBlock(doc: DocState): BlockId {
		const docMax = Math.max(0, ...doc.blocks.map(block => idNumber(block.id)));
		const n = Math.max(this.#maxBlock, docMax) + 1;
		this.#maxBlock = n;
		const id = `b${n}` as BlockId;
		this.#store.appendServiceRecord({ kind: "block", id });
		return id;
	}

	async #launch(session: string, run: RunId | undefined, blocks: readonly BlockId[]): Promise<Outcome<unknown>> {
		const found = this.#docOf(run);
		if (!found.ok) return found;
		const docState = found.result;
		if (this.#isFinished(docState)) return fail("RunFinished", "Run 已结束");
		if (blocks.length === 0) return fail("BadLaunch", "blocks 为空");
		for (const id of blocks) if (!this.#block(docState, id)) return fail("UnknownBlock", `块 ${id} 不存在`);
		const before = this.#rootsError(docState, blocks);
		if (before) return fail("BadLaunch", before);
		await this.#ensureFetched(docState, blocks);
		if (this.#isFinished(docState)) return fail("RunFinished", "Run 已结束");
		for (const id of blocks) if (!this.#block(docState, id)) return fail("UnknownBlock", `块 ${id} 不存在`);
		// A disk edit may have switched a block's kind while fetching.
		const after = this.#rootsError(docState, blocks);
		if (after) return fail("BadLaunch", after);
		const kind = this.#launchKind(docState, blocks);
		const bodies = this.#contents(docState);
		const results = this.#results(keyOf(docState.ref));
		const result = this.#launchText(docState, blocks, kind, this.#refs.compile(blocks, this.#input(docState, this.#fetches, bodies, results)));
		if (result.kind === "Err") return fail("CompileError", "编译失败", result.error);
		const fetchKeys = this.#refs.externalTargets(blocks, bodies).map(target => this.#refs.targetKey(target));
		const fetches = fetchKeys.flatMap(key => {
			const outcome = this.#fetches.get(key);
			return outcome ? [[key, outcome] as const] : [];
		});
		const usedResults = this.#refs.resultTargets(blocks, bodies).flatMap(id => {
			const value = results.get(id);
			return value ? [[id, value] as const] : [];
		});
		this.#maxLaunch++;
		const id = `l${this.#maxLaunch}` as LaunchId;
		this.#store.appendServiceRecord({ kind: "launch", id });
		const record: Launch = {
			id,
			run: docState.run?.id ?? null,
			session,
			blocks: [...blocks],
			kind,
			snapshot: { result, fetches, results: usedResults },
			agents: [],
			baselines: [result.text],
			notified: null,
			dirty: [],
			fetches,
			closed: null,
		};
		const state: LaunchState = { record, pending: null, deadline: null, timer: undefined, generation: 0, judging: false };
		this.#launches.set(id, state);
		this.#store.appendLaunch(docState.ref, record);
		this.#append(keyOf(docState.ref), "coordinator", { type: "launch_created", launch: id, kind: record.kind, blocks: record.blocks });
		this.#emit(docState.ref);
		const config = kind === "prompt" ? sharedConfig(blocks.map(block => this.#block(docState, block)!.content)) : {};
		return ok({ launch: id, kind, text: result.text, ...config });
	}

	/** Why `blocks` cannot be Launch roots: a design or untracked block, or an orchestration block not started alone (README §定义). */
	#rootsError(doc: DocState, blocks: readonly BlockId[]): string | null {
		const designs = blocks.filter(id => this.#block(doc, id)!.content.kind === "design");
		if (designs.length > 0) return `设计块 ${designs.join(", ")} 不能直接启动：在执行块中引用它`;
		const untracked = blocks.filter(id => this.#block(doc, id)!.progress.kind === "untracked");
		if (untracked.length > 0) return `块 ${untracked.join(", ")} 声明为非任务块（task: false），不能启动：在执行块中引用它`;
		if (blocks.length > 1 && this.#launchKind(doc, blocks) === "orchestration") return "编排块只能单独启动";
		return null;
	}

	#launchKind(doc: DocState, blocks: readonly BlockId[]): LaunchKind {
		return blocks.some(id => isOrchestration(this.#block(doc, id)!.content)) ? "orchestration" : "prompt";
	}

	/**
	 * Accept the current compile as the Launch's new baseline (launch-events.md §3). Edits made while
	 * fetching stay dirty and are judged against the new baseline; roots must still form a Launch of
	 * the same kind. `snapshot` keeps the frozen first compile.
	 */
	async #rebase(session: string, id: LaunchId): Promise<Outcome<unknown>> {
		const owned = this.#owned(session, id);
		if (!owned.ok) return owned;
		const launch = owned.result;
		if (launch.record.closed !== null) return fail("BadLaunch", "Launch 已关闭");
		const key = keyOfRun(launch.record.run);
		const generation = launch.generation;
		const accepted = this.#editSeq;
		const fetches = await this.#launchFetches(launch);
		const doc = this.#docs.get(key)!;
		if (this.#isFinished(doc)) return fail("RunFinished", "Run 已结束");
		if (launch.record.closed !== null) return fail("BadLaunch", "Launch 已关闭");
		if (launch.generation !== generation) return fail("BadLaunch", "Launch 在 rebase 期间已变化，请重新 rebase");
		const missing = launch.record.blocks.filter(block => !this.#block(doc, block));
		if (missing.length > 0) return fail("BadLaunch", `根块 ${missing.join(", ")} 已删除`);
		const roots = this.#rootsError(doc, launch.record.blocks);
		if (roots) return fail("BadLaunch", roots);
		if (this.#launchKind(doc, launch.record.blocks) !== launch.record.kind) return fail("BadLaunch", `根块已不是${launch.record.kind === "prompt" ? "执行块" : "编排块"}：重新启动`);
		const result = this.#launchText(doc, launch.record.blocks, launch.record.kind, this.#refs.compile(launch.record.blocks, this.#input(doc, fetches)));
		if (result.kind === "Err") return fail("CompileError", "编译失败", result.error);
		launch.generation++;
		launch.pending = null;
		launch.judging = false;
		clearTimeout(launch.timer);
		launch.timer = undefined;
		const dirty = launch.record.dirty.filter(([, seq]) => seq > accepted);
		this.#setLaunch(launch, { ...launch.record, baselines: [...launch.record.baselines, result.text], notified: null, dirty });
		launch.deadline = dirty.length > 0 ? this.#now() + JUDGE_DELAY_MS : null;
		this.#scheduleJudge(launch);
		this.#emit(doc.ref);
		return ok({ baseline: result.text });
	}

	#report(run: RunId | undefined, blocks: readonly BlockId[], version: string, result: JudgeReport): Outcome<unknown> {
		const doc = this.#blocksOf(run, blocks);
		if (!doc.ok) return doc;
		if (!this.#checks.validateReport(result)) return fail("BadReport", "report 的 result 不完整或越界");
		const setKey = blocks.join(",");
		const inspection = doc.result.inspections.get(setKey);
		const current = this.#version(doc.result, blocks, this.#input(doc.result, this.#fetches));
		if (!inspection || inspection.stale || inspection.version !== version || current !== version) return ok(null);
		doc.result.inspections.set(setKey, { ...inspection, report: result });
		this.#append(keyOf(doc.result.ref), "coordinator", { type: "check_reported", blocks: [...blocks], version, result });
		this.#emit(doc.result.ref);
		return ok(null);
	}

	// ------------------------------------------------------------ Runs (runs.md)

	#startRun(name: string, updateEvery: number | null): RunId {
		const template = this.#docs.get("template")!;
		this.#maxRun++;
		const id = `r${this.#maxRun}` as RunId;
		this.#store.appendServiceRecord({ kind: "run", id });
		const started = this.#now();
		const meta: RunMeta = {
			id,
			name,
			status: "running",
			startedAt: started,
			finishedAt: null,
			updateEvery,
			updateDue: updateEvery === null ? null : started + updateEvery * 1000,
		};
		const doc: PlaybookDoc = { title: template.title, blocks: template.blocks.map(block => ({ ...block, progress: freshProgress(block.progress) })) };
		const text = this.#store.serialize(doc, meta);
		this.#store.write({ kind: "run", run: id }, text);
		const state = this.#newDocState({ kind: "run", run: id }, doc, meta);
		this.#docs.set(id, state);
		this.#logs.set(id, { entries: [] });
		this.#append(id, "coordinator", { type: "run_started", name });
		this.#scheduleReminder(id);
		void this.#recomputeChecks(id);
		this.#emit(null);
		return id;
	}

	#finishRun(run: RunId): Outcome<never> | null {
		const doc = this.#docs.get(run);
		if (!doc?.run) return fail("UnknownRun", `Run ${run} 不存在`);
		if (doc.run.status === "finished") return fail("RunFinished", "Run 已结束");
		for (const launch of this.#launches.values()) if (launch.record.run === run && launch.record.closed === null) this.#closeLaunch(launch, "run_finished", "service");
		for (const block of doc.locks.keys()) doc.locks.set(block, { kind: "none" });
		doc.run = { ...doc.run, status: "finished", finishedAt: this.#now(), updateDue: null };
		this.#writeRunNow(doc);
		this.#scheduleReminder(run);
		this.#append(run, "coordinator", { type: "run_finished" });
		this.#emit(null);
		return null;
	}

	#post(
		run: RunId | undefined,
		kind: RecordKind,
		text: string,
		block: BlockId | null,
		launch: LaunchId | null,
		next: number | null,
		quote: string | null,
		origin: "human" | "coordinator",
		session: string | null,
	): Outcome<unknown> {
		const found = this.#docOf(run);
		if (!found.ok) return found;
		const doc = found.result;
		const key = keyOf(doc.ref);
		if (kind === "retrospective" && doc.run?.status !== "finished") return fail("BadValue", "复盘只能写在已结束的 Run 中");
		if (next !== null && (kind !== "update" || doc.run === null)) return fail("BadValue", "next 只用于 Run 的 update");
		if (block !== null && !this.#block(doc, block)) return fail("UnknownBlock", `块 ${block} 不存在`);
		if (launch !== null) {
			const owner = this.#launches.get(launch);
			if (!owner) return fail("UnknownLaunch", `Launch ${launch} 不存在`);
			if (keyOfRun(owner.record.run) !== key) return fail("BadValue", "Launch 不属于这个文档");
		}
		if (kind === "update" && doc.run?.status === "running") {
			const seconds = next ?? doc.run.updateEvery;
			if (seconds !== null) this.#setDue(doc, this.#now() + seconds * 1000);
		}
		const entry = this.#append(key, origin, {
			type: "post",
			kind,
			text,
			...(block !== null ? { block } : {}),
			...(launch !== null ? { launch } : {}),
			...(quote !== null ? { quote } : {}),
			...(session !== null ? { session } : {}),
		});
		if (kind === "result" && block !== null) {
			this.#invalidateInspections(doc, blocks => this.#refs.resultTargets(blocks, this.#contents(doc)).includes(block));
			void this.#recomputeChecks(key);
		}
		this.#emit(doc.ref);
		return ok({ seq: entry.seq });
	}

	#snooze(run: RunId, after: number): Outcome<unknown> {
		const doc = this.#docs.get(run);
		if (!doc?.run) return fail("UnknownRun", `Run ${run} 不存在`);
		if (doc.run.updateDue === null) return fail("BadValue", "没有待到期的状态更新");
		const due = this.#now() + after * 1000;
		this.#setDue(doc, due);
		this.#append(run, "coordinator", { type: "update_snoozed", due });
		this.#emit(doc.ref);
		return ok({ due });
	}

	// ============================================================ CoreApi (human, K4)

	view(ref: DocRef): DocView {
		const doc = this.#doc(ref);
		if (!doc) return { ref, title: "", run: null, blocks: [], errors: [`文档不存在`] };
		const entries = this.#logs.get(keyOf(ref))?.entries ?? [];
		// A launch request stays pending until a Launch is created from that block.
		const pending = new Set<string>();
		for (const entry of entries) {
			const data = entry.data;
			if (data.type === "event_sent" && data.event === "launch_requested") for (const block of requestedBlocks(data.data)) pending.add(block);
			if (data.type === "launch_created") for (const block of data.blocks) pending.delete(block);
		}
		return {
			ref,
			title: doc.title,
			run: doc.run,
			blocks: doc.blocks.map(block => ({ block, launchPending: pending.has(block.id) })),
			errors: doc.parseError ? [`文件不能解析：${doc.parseError}`] : [],
		};
	}

	runs(): RunSummary[] {
		const now = this.#now();
		return [...this.#docs.values()].flatMap(doc => {
			if (!doc.run) return [];
			const entries = this.#logs.get(doc.run.id)?.entries ?? [];
			return [
				{
					id: doc.run.id,
					name: doc.run.name,
					status: doc.run.status,
					started_at: doc.run.startedAt,
					finished_at: doc.run.finishedAt,
					done: doc.blocks.filter(block => block.progress.kind === "tracked" && block.progress.status === "done").length,
					total: doc.blocks.filter(block => block.progress.kind === "tracked").length,
					update_due: doc.run.updateDue,
					update_overdue: doc.run.updateDue !== null && doc.run.updateDue <= now,
					retrospective: entries.some(entry => entry.data.type === "post" && entry.data.kind === "retrospective"),
				},
			];
		});
	}

	coordinator(): CoordinatorStatus {
		return { connected: this.#conn?.session != null, session: this.#conn?.session ?? null, pane: this.#conn?.pane ?? null };
	}

	agents(): AgentList {
		return this.#conn?.session != null ? this.#conn.agents : { kind: "offline" };
	}

	/** Ask the coordinator which subagents its session can launch; the answer arrives as an `agents` request. */
	requestAgents(): void {
		if (!this.#conn || this.#conn.session === null) return;
		this.#conn.agents = { kind: "pending" };
		// A query about the coordinator's session, not a document event: sent without a log entry.
		this.#conn.conn.send({ event: "agents_requested", data: {} });
		this.#emit(null);
	}

	async focusCoordinator(): Promise<string | null> {
		const pane = this.#conn?.pane ?? null;
		if (pane === null) return "协调者没有给出它的 pane";
		const result = await this.#panes.focusPane(pane);
		return result.ok ? null : this.#k5Error(result.error);
	}

	#k5Error(error: string): string {
		this.#errors.push(error);
		this.#emit(null);
		return error;
	}

	errors(): readonly string[] {
		return this.#errors;
	}

	onChange(listener: (ref: DocRef | null) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	setRenderStatus(ref: DocRef, block: BlockId, status: RenderStatus): void {
		const doc = this.#doc(ref);
		if (!doc) return;
		const previous = doc.render.get(block);
		doc.render.set(block, status);
		if (JSON.stringify(previous) !== JSON.stringify(status)) void this.#recomputeChecks(keyOf(ref));
	}

	#humanTarget(ref: DocRef, id: BlockId): { doc: DocState; block: Block } | string {
		const doc = this.#doc(ref);
		if (!doc) return "文档不存在";
		if (this.#isFinished(doc)) return "Run 已结束";
		const block = this.#block(doc, id);
		return block ? { doc, block } : `块 ${id} 不存在`;
	}

	/**
	 * A person's change takes back a block the coordinator holds: the lock ends, so the coordinator's
	 * in-flight `playbook_edit` fails with NotLocked instead of overwriting the person.
	 */
	#takeBack(doc: DocState, id: BlockId): void {
		const lock = doc.locks.get(id);
		if (lock?.kind !== "coordinator") return;
		doc.locks.set(id, { kind: "none" });
		this.#append(keyOf(doc.ref), "human", { type: "interrupted", block: id, request: lock.request });
		this.#conn?.conn.send({ event: "interrupted", data: { ...runField(doc), block: id, request: lock.request } });
	}

	/** The block's progress with `status`, or why a block of its kind cannot have it. */
	#statusProgress(block: Block, status: Status): Progress | string {
		if (block.progress.kind === "untracked") return `块 ${block.id} 声明为非任务块（task: false），没有状态`;
		if (block.content.kind === "design" && status === "running") return "设计块不会执行中";
		return { ...block.progress, status };
	}

	edit(ref: DocRef, id: BlockId, field: HumanField, expected: string, text: string): string | null {
		const target = this.#humanTarget(ref, id);
		if (typeof target === "string") return target;
		if (!humanFieldValid(target.block.content, field)) return target.block.content.kind === "task" ? "执行块没有这个字段" : "设计稿由协调者修改：请写修改要求";
		const current = fieldText(target.block, field)!;
		if (current !== expected) return "内容在你编辑时已被修改，请在最新内容上重新编辑";
		if (current === text) return null;
		this.#takeBack(target.doc, id);
		this.#applyEdit(target.doc, "human", { kind: "field", block: id, field, text });
		return null;
	}

	setTitle(ref: DocRef, expected: string, text: string): string | null {
		const doc = this.#doc(ref);
		if (!doc) return "文档不存在";
		if (this.#isFinished(doc)) return "Run 已结束";
		if (doc.title !== expected) return "标题在你编辑时已被修改，请在最新内容上重新编辑";
		if (doc.title === text) return null;
		doc.title = text;
		this.#scheduleWrite(doc);
		this.#emit(doc.ref);
		return null;
	}

	/** Submit a design change request: journal it, then notify the coordinator. Refused without a coordinator or text. */
	requestRevision(ref: DocRef, id: BlockId, prompt: string): string | null {
		const target = this.#humanTarget(ref, id);
		if (typeof target === "string") return target;
		if (target.block.content.kind !== "design") return "只有设计块接受修改要求";
		if (prompt.trim() === "") return "修改要求是空的";
		if (!this.#conn || this.#conn.session === null) return "协调者离线，修改要求没有发出";
		const doc = target.doc;
		const revision: Revision = { seq: (doc.revisions.at(-1)?.seq ?? 0) + 1, at: this.#now(), block: id, prompt };
		this.#store.appendRevision(doc.ref, revision);
		doc.revisions.push(revision);
		this.#send({ event: "revision_requested", data: { ...runField(doc), block: id, revision: revision.seq } });
		this.#emit(doc.ref);
		return null;
	}

	setStatus(ref: DocRef, id: BlockId, status: Status): string | null {
		const target = this.#humanTarget(ref, id);
		if (typeof target === "string") return target;
		const progress = this.#statusProgress(target.block, status);
		if (typeof progress === "string") return progress;
		this.#takeBack(target.doc, id);
		this.#applyEdit(target.doc, "human", { kind: "progress", block: id, progress });
		this.#send({ event: "status_changed", data: { ...runField(target.doc), block: id, status } });
		return null;
	}

	setAgent(ref: DocRef, id: BlockId, agent: string | null): string | null {
		const target = this.#humanTarget(ref, id);
		if (typeof target === "string") return target;
		if (target.block.content.kind !== "task") return "设计块没有执行配置";
		const name = agent?.trim() || undefined;
		if (name === target.block.content.agent) return null;
		this.#takeBack(target.doc, id);
		this.#applyEdit(target.doc, "human", { kind: "config", block: id, config: { ...taskConfig(target.block.content), agent: name } });
		return null;
	}

	setIsolated(ref: DocRef, id: BlockId, isolated: boolean): string | null {
		const target = this.#humanTarget(ref, id);
		if (typeof target === "string") return target;
		if (target.block.content.kind !== "task") return "设计块没有执行配置";
		this.#takeBack(target.doc, id);
		this.#applyEdit(target.doc, "human", { kind: "config", block: id, config: { ...taskConfig(target.block.content), isolated } });
		return null;
	}

	deleteBlock(ref: DocRef, id: BlockId): string | null {
		const target = this.#humanTarget(ref, id);
		if (typeof target === "string") return target;
		this.#takeBack(target.doc, id);
		this.#applyEdit(target.doc, "human", { kind: "delete", block: id });
		return null;
	}

	requestLaunch(ref: DocRef, blocks: readonly BlockId[]): string | null {
		const doc = this.#doc(ref);
		if (!doc) return "文档不存在";
		if (this.#isFinished(doc)) return "Run 已结束";
		if (blocks.length === 0) return "没有选中的块";
		const missing = blocks.filter(id => !this.#block(doc, id));
		if (missing.length > 0) return `块 ${missing.join(", ")} 不存在`;
		const roots = this.#rootsError(doc, blocks);
		if (roots) return roots;
		return this.#send({ event: "launch_requested", data: { ...runField(doc), blocks: [...blocks] } }) ? null : "协调者离线，请求没有发出";
	}

	requestStop(ref: DocRef, id: BlockId): string | null {
		const target = this.#humanTarget(ref, id);
		if (typeof target === "string") return target;
		const key = keyOf(target.doc.ref);
		const launches = [...this.#launches.values()]
			.filter(launch => keyOfRun(launch.record.run) === key && launch.record.closed === null && launch.record.blocks.includes(id))
			.map(launch => ({ id: launch.record.id, agents: launch.record.agents }));
		// Nothing is executing for this block: the running status is all there is to stop.
		if (launches.length === 0) return this.setStatus(ref, id, "todo");
		return this.#send({ event: "stop_requested", data: { ...runField(target.doc), block: id, launches } }) ? null : "协调者离线，请求没有发出";
	}
}

type EditChange =
	| { readonly kind: "field"; readonly block: BlockId; readonly field: BlockField; readonly text: string }
	/** A disk edit switched the block's kind: content and progress are replaced whole. */
	| { readonly kind: "content"; readonly block: BlockId; readonly content: BlockContent; readonly progress: Progress }
	| { readonly kind: "progress"; readonly block: BlockId; readonly progress: Progress }
	| { readonly kind: "insert"; readonly after: BlockId | null; readonly block: Block }
	| { readonly kind: "delete"; readonly block: BlockId }
	| { readonly kind: "reorder"; readonly order: readonly BlockId[] }
	/** A task block's execution contract replaced whole. */
	| { readonly kind: "config"; readonly block: BlockId; readonly config: TaskConfig };
