import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
	parseBlockId, parseLaunchId, parseRunId,
	type Block, type BlockContent, type BlockId, type BlockResult, type CompileError, type CompileResult, type Revision,
	type DocRef, type EntryData, type EntryOrigin, type FetchOutcome,
	type JudgeReport, type Launch, type LaunchId, type PlaybookDoc, type Progress, type RunId,
	type RunMeta, type Source, type Status, type TimelineEntry,
} from "../domain/model";
import { tr } from "../i18n";
import type { ParsedFile, ServiceRecord, Store } from "../domain/ports";

// Only boundary decoders inspect untrusted maps. Domain objects are constructed below.
type Fields = Readonly<Record<string, unknown>>;
function fields(value: unknown): Fields {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a mapping");
	return value as Fields;
}
function keys(value: Fields, required: readonly string[], optional: readonly string[] = []): void {
	for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`Missing field: ${key}`);
	for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) throw new Error(`Unknown field: ${key}`);
}
function string(value: unknown): string {
	if (typeof value !== "string") throw new Error("Expected a string");
	return value;
}
function number(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Expected a finite number");
	return value;
}
function positive(value: unknown): number {
	const result = number(value);
	if (!Number.isSafeInteger(result) || result <= 0) throw new Error("Expected a positive integer");
	return result;
}
function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") throw new Error("Expected a boolean");
	return value;
}
function list<T>(value: unknown, decode: (value: unknown) => T): T[] {
	if (!Array.isArray(value)) throw new Error("Expected a sequence");
	return value.map(decode);
}
function nullable<T>(value: unknown, decode: (value: unknown) => T): T | null {
	return value === null ? null : decode(value);
}
function choice<const T extends string>(value: unknown, values: readonly T[]): T {
	for (const candidate of values) if (candidate === value) return candidate;
	throw new Error(`Unexpected value: ${String(value)}`);
}
function blockId(value: unknown): BlockId {
	const id = parseBlockId(string(value));
	if (id === null) throw new Error("Invalid block id");
	return id;
}
function runId(value: unknown): RunId {
	const id = parseRunId(string(value));
	if (id === null) throw new Error("Invalid Run id");
	return id;
}
function launchId(value: unknown): LaunchId {
	const id = parseLaunchId(string(value));
	if (id === null) throw new Error("Invalid Launch id");
	return id;
}
function origin(value: unknown): EntryOrigin {
	return choice(value, ["human", "coordinator", "disk", "service"]);
}
function status(value: unknown): Status {
	return choice(value, ["todo", "running", "done"]);
}
function timestamp(value: unknown): number {
	const text = string(value);
	if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(text)) throw new Error("Expected an ISO 8601 timestamp");
	const at = Date.parse(text);
	if (!Number.isFinite(at)) throw new Error("Invalid timestamp");
	// Date.parse accepts impossible dates such as February 30; check the date independently.
	const date = text.slice(0, 10);
	if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error("Invalid calendar date");
	return at;
}
/**
 * Block content by field shape: `body` is a task block, `requirement` + `design` a design block.
 * A task block may also carry its execution contract: `agent` (non-blank after trimming) and `isolated`.
 * `others` are the other keys allowed beside the content keys; mixed or missing shapes are errors.
 */
function decodeContent(v: Fields, required: readonly string[], optional: readonly string[] = []): BlockContent {
	if (Object.hasOwn(v, "body")) {
		keys(v, [...required, "body"], [...optional, "agent", "isolated"]);
		return {
			kind: "task",
			body: string(v.body),
			...(Object.hasOwn(v, "agent") ? { agent: agentName(v.agent) } : {}),
			...(Object.hasOwn(v, "isolated") ? { isolated: boolean(v.isolated) } : {}),
		};
	}
	if (Object.hasOwn(v, "requirement") || Object.hasOwn(v, "design")) {
		keys(v, [...required, "requirement", "design"], optional);
		return { kind: "design", requirement: string(v.requirement), design: string(v.design) };
	}
	throw new Error("A block needs body (task block) or requirement and design (design block)");
}
function agentName(value: unknown): string {
	const name = string(value).trim();
	if (name === "") throw new Error("agent must not be blank");
	return name;
}
/** Content fields as stored in Run log entries; execution contract keys only when set. */
function contentFields(content: BlockContent): Record<string, string | boolean> {
	switch (content.kind) {
		case "task": return {
			body: content.body,
			...(content.agent === undefined ? {} : { agent: content.agent }),
			...(content.isolated === undefined ? {} : { isolated: content.isolated }),
		};
		case "design": return { requirement: content.requirement, design: content.design };
	}
}
/**
 * A block's progress by its keys: `task: false` declares an untracked task block, which has no status or
 * report; every other block has `status` and, for a task block, an optional `report`. A design block is
 * never running and has no report: it is not launched.
 */
function decodeProgress(v: Fields, content: BlockContent): Progress {
	if (Object.hasOwn(v, "task")) {
		if (content.kind !== "task") throw new Error("task: false is only valid on a task block");
		if (v.task !== false) throw new Error("task may only be false");
		if (Object.hasOwn(v, "status") || Object.hasOwn(v, "report")) throw new Error("A block with task: false has no status or report");
		return { kind: "untracked" };
	}
	if (!Object.hasOwn(v, "status")) throw new Error("Missing field: status");
	const value = status(v.status);
	if (content.kind === "design" && value === "running") throw new Error("A design block cannot be running");
	if (content.kind === "design" && Object.hasOwn(v, "report")) throw new Error("A design block has no report");
	return { kind: "tracked", status: value, report: Object.hasOwn(v, "report") ? string(v.report) : null };
}
function decodeBlock(value: unknown): Block {
	const v = fields(value);
	const content = decodeContent(v, ["id", "title"], ["status", "report", "task"]);
	return { id: blockId(v.id), title: string(v.title), progress: decodeProgress(v, content), content };
}
function decodeRevision(value: unknown): Revision {
	const v = fields(value);
	keys(v, ["seq", "at", "block", "prompt"]);
	return { seq: positive(v.seq), at: number(v.at), block: blockId(v.block), prompt: string(v.prompt) };
}
function decodeRun(value: unknown): RunMeta {
	const v = fields(value);
	keys(v, ["id", "name", "status", "started_at", "finished_at", "update_every", "update_due"]);
	const status = choice(v.status, ["running", "finished"]);
	const finishedAt = nullable(v.finished_at, timestamp);
	const updateDue = nullable(v.update_due, timestamp);
	if (status === "running" && finishedAt !== null) throw new Error("Running Run cannot have a finish time");
	if (status === "finished" && (finishedAt === null || updateDue !== null)) throw new Error("Finished Run requires a finish time and no update due");
	const updateEvery = nullable(v.update_every, number);
	if (updateEvery !== null && updateEvery <= 0) throw new Error("Update interval must be positive");
	return { id: runId(v.id), name: string(v.name), status, startedAt: timestamp(v.started_at), finishedAt, updateEvery, updateDue };
}
function parse(text: string, expectRun: boolean): ParsedFile {
	try {
		const v = fields(Bun.YAML.parse(text));
		keys(v, expectRun ? ["title", "blocks", "run"] : ["title", "blocks"]);
		const blocks = list(v.blocks, decodeBlock);
		const seen = new Set<BlockId>();
		for (const block of blocks) {
			if (seen.has(block.id)) throw new Error(`Duplicate block id: ${block.id}`);
			seen.add(block.id);
		}
		return { ok: true, doc: { title: string(v.title), blocks }, run: expectRun ? decodeRun(v.run) : null };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function parseFailure(error: string): string {
	if (error === "Expected a mapping") return tr(error, "应为映射");
	if (error.startsWith("Missing field: ")) return tr(error, `缺少字段：${error.slice("Missing field: ".length)}`);
	if (error.startsWith("Unknown field: ")) return tr(error, `未知字段：${error.slice("Unknown field: ".length)}`);
	if (error === "Expected a string") return tr(error, "应为字符串");
	if (error === "Expected a finite number") return tr(error, "应为有限数字");
	if (error === "Expected a positive integer") return tr(error, "应为正整数");
	if (error === "Expected a boolean") return tr(error, "应为布尔值");
	if (error === "Expected a sequence") return tr(error, "应为序列");
	if (error.startsWith("Unexpected value: ")) return tr(error, `意外的值：${error.slice("Unexpected value: ".length)}`);
	if (error === "Invalid block id") return tr(error, "无效的块 ID");
	if (error === "Invalid Run id") return tr(error, "无效的 Run ID");
	if (error === "Invalid Launch id") return tr(error, "无效的 Launch ID");
	if (error === "Expected an ISO 8601 timestamp") return tr(error, "应为 ISO 8601 时间戳");
	if (error === "Invalid timestamp") return tr(error, "无效的时间戳");
	if (error === "Invalid calendar date") return tr(error, "无效的日历日期");
	if (error === "A block needs body (task block) or requirement and design (design block)") return tr(error, "块需要 body（任务块）或 requirement 和 design（设计块）");
	if (error === "agent must not be blank") return tr(error, "agent 不能为空");
	if (error === "task: false is only valid on a task block") return tr(error, "task: false 只对任务块有效");
	if (error === "task may only be false") return tr(error, "task 只能是 false");
	if (error === "A block with task: false has no status or report") return tr(error, "task: false 的块没有 status 或 report");
	if (error === "A design block cannot be running") return tr(error, "设计块不能是 running");
	if (error === "A design block has no report") return tr(error, "设计块没有 report");
	if (error === "Running Run cannot have a finish time") return tr(error, "运行中的 Run 不能有结束时间");
	if (error === "Finished Run requires a finish time and no update due") return tr(error, "已结束的 Run 必须有结束时间且没有待更新");
	if (error === "Update interval must be positive") return tr(error, "更新间隔必须为正数");
	if (error.startsWith("Duplicate block id: ")) return tr(error, `块 ID 重复：${error.slice("Duplicate block id: ".length)}`);
	if (error === "Expected a pair") return tr(error, "应为一对值");
	if (error === "Launch snapshot must be a successful compile") return tr(error, "Launch 快照必须是成功的编译结果");
	if (error === "Launch requires blocks") return tr(error, "Launch 必须包含 blocks");
	if (error === "First baseline must equal snapshot text") return tr(error, "第一个基线必须等于快照文本");
	if (error === "Timeline sequence must increase") return tr(error, "时间线序号必须递增");
	if (error === "Launch belongs to another document") return tr(error, "Launch 属于另一个文档");
	if (error === "YAML text must be well-formed Unicode") return tr(error, "YAML 文本必须是格式正确的 Unicode");
	if (error === "Block body must be well-formed Unicode") return tr(error, "块正文必须是格式正确的 Unicode");
	return tr(error, `Playbook 数据无效：${error}`);
}

function quoted(text: string): string {
	if (!text.isWellFormed()) throw new RangeError("YAML text must be well-formed Unicode");
	// JSON string escapes are also YAML double-quoted escapes. Escape YAML's
	// additional line-break characters so parsing cannot normalize their text.
	return JSON.stringify(text).replace(/[\u0085\u2028\u2029\uFFFE\uFFFF]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function bodyScalar(body: string): string {
	if (!body.isWellFormed()) throw new RangeError("Block body must be well-formed Unicode");
	// YAML normalizes CR and several Unicode separators; non-printable characters
	// cannot be represented literally. Escape those strings while ordinary
	// Markdown remains line-diffable.
	if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\uFFFE\uFFFF]/.test(body)) return `${quoted(body)}\n`;
	const trailing = body.match(/\n*$/)?.[0].length ?? 0;
	const indicator = trailing === 0 ? "-" : trailing > 1 || /^\n+$/.test(body) ? "+" : "";
	const content = body.endsWith("\n") ? body.slice(0, -1) : body;
	return `|2${indicator}\n${content.split("\n").map(line => `      ${line}\n`).join("")}`;
}
/** Content fields as YAML lines of a block mapping; a task block without a contract is written as before. */
function contentYaml(content: BlockContent): string {
	switch (content.kind) {
		case "task":
			return `    body: ${bodyScalar(content.body)}`
				+ (content.agent === undefined ? "" : `    agent: ${quoted(content.agent)}\n`)
				+ (content.isolated === undefined ? "" : `    isolated: ${content.isolated}\n`);
		case "design": return `    requirement: ${bodyScalar(content.requirement)}    design: ${bodyScalar(content.design)}`;
	}
}
/** Progress as YAML lines of a block mapping. */
function progressYaml(progress: Progress): string {
	if (progress.kind === "untracked") return "    task: false\n";
	return `    status: ${progress.status}\n` + (progress.report === null ? "" : `    report: ${bodyScalar(progress.report)}`);
}
function serialize(doc: PlaybookDoc, run: RunMeta | null): string {
	let text = `title: ${quoted(doc.title)}\nblocks:${doc.blocks.length === 0 ? " []" : ""}\n`;
	for (const block of doc.blocks) {
		text += `  - id: ${block.id}\n    title: ${quoted(block.title)}\n`;
		text += contentYaml(block.content);
		text += progressYaml(block.progress);
	}
	if (run !== null) {
		const iso = (value: number | null): string => value === null ? "null" : quoted(new Date(value).toISOString());
		text += `run:\n  id: ${run.id}\n  name: ${quoted(run.name)}\n  status: ${run.status}\n  started_at: ${iso(run.startedAt)}\n  finished_at: ${iso(run.finishedAt)}\n  update_every: ${run.updateEvery}\n  update_due: ${iso(run.updateDue)}\n`;
	}
	return text;
}

function decodeReport(value: unknown): JudgeReport {
	const v = fields(value);
	const kind = choice(v.kind, ["answers", "judge_unavailable"]);
	if (kind === "judge_unavailable") { keys(v, ["kind"]); return { kind }; }
	keys(v, ["kind", "answers"]);
	const answers: Record<string, number> = {};
	for (const [key, answer] of Object.entries(fields(v.answers))) Object.defineProperty(answers, key, { value: number(answer), enumerable: true, writable: true, configurable: true });
	return { kind, answers };
}
function decodeEntryProgress(value: unknown): Progress {
	const v = fields(value);
	const kind = choice(v.kind, ["untracked", "tracked"]);
	if (kind === "untracked") { keys(v, ["kind"]); return { kind }; }
	keys(v, ["kind", "status", "report"]);
	return { kind, status: status(v.status), report: nullable(v.report, string) };
}
function decodeEntryData(type: unknown, value: unknown): EntryData {
	const v = fields(value);
	const tag = choice(type, ["run_started", "run_finished", "block_edited", "block_added", "block_deleted", "content_replaced", "blocks_reordered", "progress_changed", "launch_created", "agent_bound", "launch_closed", "event_sent", "interrupted", "check_reported", "post", "update_due", "update_snoozed"]);
	switch (tag) {
		case "run_started": keys(v, ["name"]); return { type: tag, name: string(v.name) };
		case "run_finished": keys(v, []); return { type: tag };
		case "block_edited": keys(v, ["block", "field", "text", "edit"]); return { type: tag, block: blockId(v.block), field: choice(v.field, ["title", "body", "requirement", "design"]), text: string(v.text), edit: positive(v.edit) };
		case "block_added": case "block_deleted": return { type: tag, content: decodeContent(v, ["block", "title"]), block: blockId(v.block), title: string(v.title) };
		case "content_replaced": return { type: tag, content: decodeContent(v, ["block"]), block: blockId(v.block) };
		case "blocks_reordered": keys(v, ["order"]); return { type: tag, order: list(v.order, blockId) };
		case "progress_changed": keys(v, ["block", "progress"]); return { type: tag, block: blockId(v.block), progress: decodeEntryProgress(v.progress) };
		case "launch_created": keys(v, ["launch", "kind", "blocks"]); return { type: tag, launch: launchId(v.launch), kind: choice(v.kind, ["prompt", "orchestration"]), blocks: list(v.blocks, blockId) };
		case "agent_bound": keys(v, ["launch", "agent"]); return { type: tag, launch: launchId(v.launch), agent: string(v.agent) };
		case "launch_closed": keys(v, ["launch"]); return { type: tag, launch: launchId(v.launch) };
		case "event_sent": keys(v, ["event", "data"]); return { type: tag, event: string(v.event), data: v.data };
		case "interrupted": keys(v, ["block", "request"]); return { type: tag, block: blockId(v.block), request: string(v.request) };
		case "check_reported": keys(v, ["blocks", "version", "result"]); return { type: tag, blocks: list(v.blocks, blockId), version: string(v.version), result: decodeReport(v.result) };
		case "post": {
			keys(v, ["kind", "text"], ["block", "launch", "quote", "session"]);
			return { type: tag, kind: choice(v.kind, ["update", "result", "failure", "retrospective"]), text: string(v.text), ...(v.block === undefined ? {} : { block: blockId(v.block) }), ...(v.launch === undefined ? {} : { launch: launchId(v.launch) }), ...(v.quote === undefined ? {} : { quote: string(v.quote) }), ...(v.session === undefined ? {} : { session: string(v.session) }) };
		}
		case "update_due": case "update_snoozed": keys(v, ["due"]); return { type: tag, due: number(v.due) };
	}
}
function decodeEntry(value: unknown): TimelineEntry {
	const v = fields(value);
	keys(v, ["seq", "at", "type", "origin", "data"]);
	return { seq: positive(v.seq), at: number(v.at), origin: origin(v.origin), data: decodeEntryData(v.type, v.data) };
}
function decodeSource(value: unknown): Source {
	const v = fields(value);
	const kind = choice(v.kind, ["block", "result", "external"]);
	const base = { target: string(v.target), expression: nullable(v.expression, string) };
	switch (kind) {
		case "block": keys(v, ["kind", "target", "expression"]); return { kind, ...base };
		case "result": keys(v, ["kind", "target", "expression", "seq", "origin", "launch"]); return { kind, ...base, seq: positive(v.seq), origin: origin(v.origin), launch: nullable(v.launch, launchId) };
		case "external": keys(v, ["kind", "target", "expression", "fetchedAt"]); return { kind, ...base, fetchedAt: number(v.fetchedAt) };
	}
}
function decodeCompileError(value: unknown): CompileError {
	const v = fields(value);
	const site = fields(v.at);
	keys(site, ["block", "reference"]);
	const at = { block: blockId(site.block), reference: string(site.reference) };
	const kind = choice(v.kind, ["UnknownBlock", "UnknownTarget", "BadExpression", "Cycle", "TooDeep", "NoResult", "FetchFailed", "UnknownSlot"]);
	switch (kind) {
		case "UnknownBlock": case "NoResult": keys(v, ["kind", "block", "at"]); return { kind, block: blockId(v.block), at };
		case "UnknownTarget": case "TooDeep": keys(v, ["kind", "at"]); return { kind, at };
		case "BadExpression": keys(v, ["kind", "reason", "at"]); return { kind, reason: string(v.reason), at };
		case "Cycle": keys(v, ["kind", "path", "at"]); return { kind, path: list(v.path, blockId), at };
		case "FetchFailed": keys(v, ["kind", "target", "error", "at"]); return { kind, target: string(v.target), error: string(v.error), at };
		case "UnknownSlot": keys(v, ["kind", "block", "slot", "at"]); return { kind, block: blockId(v.block), slot: string(v.slot), at };
	}
}
function decodeCompile(value: unknown): CompileResult {
	const v = fields(value);
	const kind = choice(v.kind, ["Ok", "Err"]);
	if (kind === "Err") { keys(v, ["kind", "error"]); return { kind, error: decodeCompileError(v.error) }; }
	keys(v, ["kind", "text", "sources"]);
	return { kind, text: string(v.text), sources: list(v.sources, decodeSource) };
}
function decodeFetch(value: unknown): FetchOutcome {
	const v = fields(value);
	const ok = boolean(v.ok);
	const at = number(v.at);
	if (!ok) { keys(v, ["ok", "at", "error"]); return { ok, at, error: string(v.error) }; }
	keys(v, ["ok", "at", "value"]);
	const payload = fields(v.value);
	const kind = choice(payload.kind, ["file", "issue"]);
	if (kind === "file") { keys(payload, ["kind", "text"]); return { ok, at, value: { kind, text: string(payload.text) } }; }
	keys(payload, ["kind", "issue"]);
	const issue = fields(payload.issue);
	keys(issue, ["title", "body", "comments"]);
	return { ok, at, value: { kind, issue: { title: string(issue.title), body: string(issue.body), comments: list(issue.comments, item => { const c = fields(item); keys(c, ["author", "createdAt", "body"]); return { author: string(c.author), createdAt: string(c.createdAt), body: string(c.body) }; }) } } };
}
function tuple<A, B>(value: unknown, first: (value: unknown) => A, second: (value: unknown) => B): readonly [A, B] {
	if (!Array.isArray(value) || value.length !== 2) throw new Error("Expected a pair");
	return [first(value[0]), second(value[1])];
}
function decodeBlockResult(value: unknown): BlockResult {
	const v = fields(value);
	keys(v, ["text", "at", "seq", "origin", "launch"]);
	return { text: string(v.text), at: number(v.at), seq: positive(v.seq), origin: origin(v.origin), launch: nullable(v.launch, launchId) };
}
function decodeLaunch(value: unknown): Launch {
	const v = fields(value);
	keys(v, ["id", "run", "session", "blocks", "kind", "snapshot", "agents", "baselines", "notified", "dirty", "fetches", "closed"]);
	const snapshot = fields(v.snapshot);
	keys(snapshot, ["result", "fetches", "results"]);
	const result = decodeCompile(snapshot.result);
	if (result.kind !== "Ok") throw new Error("Launch snapshot must be a successful compile");
	const blocks = list(v.blocks, blockId);
	if (blocks.length === 0) throw new Error("Launch requires blocks");
	const fetches = (value: unknown) => list(value, pair => tuple(pair, string, decodeFetch));
	const baselines = list(v.baselines, string);
	if (baselines[0] !== result.text) throw new Error("First baseline must equal snapshot text");
	return {
		id: launchId(v.id), run: nullable(v.run, runId), session: string(v.session), blocks, kind: choice(v.kind, ["prompt", "orchestration"]),
		snapshot: { result, fetches: fetches(snapshot.fetches), results: list(snapshot.results, pair => tuple(pair, blockId, decodeBlockResult)) },
		agents: list(v.agents, string), baselines, notified: nullable(v.notified, decodeCompile), dirty: list(v.dirty, pair => tuple(pair, blockId, positive)), fetches: fetches(v.fetches),
		closed: nullable(v.closed, value => { const c = fields(value); keys(c, ["at", "by"]); return { at: number(c.at), by: choice(c.by, ["coordinator", "human", "run_finished"]) }; }),
	};
}
function decodeServiceRecord(value: unknown): ServiceRecord {
	const v = fields(value);
	keys(v, ["kind", "id"]);
	const kind = choice(v.kind, ["block", "run", "launch"]);
	switch (kind) {
		case "block": return { kind, id: blockId(v.id) };
		case "run": return { kind, id: runId(v.id) };
		case "launch": return { kind, id: launchId(v.id) };
	}
}
function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function readOptional(path: string): string | null {
	try { return readFileSync(path, "utf8"); } catch (error) { if (missing(error)) return null; throw error; }
}
function readLines<T>(path: string, decode: (value: unknown) => T): T[] {
	const text = readOptional(path);
	if (text === null || text === "") return [];
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines.map((line, index) => {
		try { return decode(JSON.parse(line)); }
		catch (error) { throw new Error(`${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
	});
}
function append(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}
/** Entry payload as stored: block content flattened into its fields (`body`, or `requirement` + `design`). */
function encodeEntryData(data: EntryData): Record<string, unknown> {
	const { type: _type, ...rest } = data;
	if (!("content" in rest)) return rest;
	const { content, ...others } = rest;
	return { ...others, ...contentFields(content) };
}

export function createStore(templatePath: string): Store {
	const path = resolve(templatePath);
	const baseDir = dirname(path);
	const runsDir = join(baseDir, `${basename(path).replace(/\.yaml$/, "")}.runs`);
	const filePath = (ref: DocRef): string => ref.kind === "template" ? path : join(runsDir, `${runId(ref.run)}.yaml`);
	const logPath = (ref: DocRef): string => ref.kind === "template" ? `${path}.log.jsonl` : join(runsDir, `${runId(ref.run)}.jsonl`);
	const revisionsPath = (ref: DocRef): string => ref.kind === "template" ? `${path}.revisions.jsonl` : join(runsDir, `${runId(ref.run)}.revisions.jsonl`);
	return {
		templatePath: path, baseDir, serialize, parse, path: filePath,
		readTemplate() {
			try {
				const parsed = parse(readFileSync(path, "utf8"), false);
				return parsed.ok ? parsed : { ...parsed, error: parseFailure(parsed.error) };
			}
			catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
		},
		readRuns() {
			const runs = new Map<RunId, ParsedFile>();
			let names: string[];
			try { names = readdirSync(runsDir); } catch (error) { if (missing(error)) return runs; throw error; }
			for (const name of names.sort()) {
				if (!name.endsWith(".yaml")) continue;
				const id = runId(name.slice(0, -5));
				let parsed: ParsedFile;
				try {
					const value = parse(readFileSync(join(runsDir, name), "utf8"), true);
					parsed = value.ok ? value : { ...value, error: parseFailure(value.error) };
				}
				catch (error) { parsed = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
				if (parsed.ok && parsed.run?.id !== id) parsed = { ok: false, error: tr(`Run id does not match filename: ${name}`, `Run ID 与文件名不匹配：${name}`) };
				runs.set(id, parsed);
			}
			return runs;
		},
		write(ref, text) {
			const destination = filePath(ref);
			mkdirSync(dirname(destination), { recursive: true });
			const temporary = join(dirname(destination), `.${basename(destination)}.${crypto.randomUUID()}.tmp`);
			let fd: number | null = null;
			try {
				fd = openSync(temporary, "wx", 0o600);
				writeFileSync(fd, text, "utf8");
				closeSync(fd); fd = null;
				renameSync(temporary, destination);
			} finally {
				if (fd !== null) closeSync(fd);
				try { unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; }
			}
		},
		stat(ref) {
			const destination = filePath(ref);
			try { return { text: readFileSync(destination, "utf8"), mtimeMs: statSync(destination).mtimeMs }; }
			catch (error) { if (missing(error)) return null; throw error; }
		},
		readServiceRecords: () => readLines(`${path}.pb.jsonl`, decodeServiceRecord),
		appendServiceRecord: record => append(`${path}.pb.jsonl`, record),
		readLog(ref) {
			const entries: TimelineEntry[] = [];
			const launches = new Map<LaunchId, Launch>();
			const run = ref.kind === "template" ? null : ref.run;
			readLines(logPath(ref), value => {
				const v = fields(value);
				if (Object.hasOwn(v, "entry")) {
					keys(v, ["entry"]);
					const entry = decodeEntry(v.entry);
					if (entry.seq <= (entries.at(-1)?.seq ?? 0)) throw new Error("Timeline sequence must increase");
					entries.push(entry);
				} else {
					keys(v, ["launch"]);
					const launch = decodeLaunch(v.launch);
					if (launch.run !== run) throw new Error("Launch belongs to another document");
					launches.set(launch.id, launch);
				}
			});
			return { entries, launches };
		},
		appendEntry(ref, entry) {
			append(logPath(ref), { entry: { seq: entry.seq, at: entry.at, type: entry.data.type, origin: entry.origin, data: encodeEntryData(entry.data) } });
		},
		appendLaunch: (ref, launch) => append(logPath(ref), { launch }),
		readRevisions(ref) {
			const revisions = readLines(revisionsPath(ref), decodeRevision);
			revisions.forEach((revision, index) => { if (index > 0 && revision.seq <= revisions[index - 1]!.seq) throw new Error(`${revisionsPath(ref)}: revision sequence must increase`); });
			return revisions;
		},
		appendRevision: (ref, revision) => append(revisionsPath(ref), revision),
		saveAsset(bytes, extension) {
			const name = `${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}.${extension}`;
			const folder = `${basename(path)}.assets`;
			const target = join(baseDir, folder, name);
			// Same name, same bytes: an existing file is already this image.
			if (!statSync(target, { throwIfNoEntry: false })) {
				mkdirSync(join(baseDir, folder), { recursive: true });
				const temporary = `${target}.${process.pid}.tmp`;
				writeFileSync(temporary, bytes);
				renameSync(temporary, target);
			}
			return `${folder}/${name}`;
		},
	};
}
