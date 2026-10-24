import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { prepareSvg } from "@oh-my-pi/pi-tui/chat/svg-source";
import { svgFigurePalette } from "@oh-my-pi/pi-tui/chat/svg-figure";
import { lookupTableChart, setTableCharts, splitTableCharts } from "@oh-my-pi/pi-tui/chat/table-chart";
import { initThemeSync, setTheme } from "@oh-my-pi/pi-tui/theme/theme";
import type { BlockContent, BlockId, CompileError, CompileResult, DocRef, EntryData, EventName, FindingName, HumanField, Launch, LaunchId, RecordKind, Revision, RunId, RunStatus, Source, TimelineEntry } from "../domain/model";
import { fieldText, parseRunId } from "../domain/model";
import type { BlockView, CoreApi, DocView, RenderStatus } from "../domain/ports";
import type { RunSummary } from "../domain/protocol";
import { separateTableReferences } from "./checks";
import { isOrchestration } from "./core";
import { renderDraft, type DraftHost } from "./draft/components";
import type { AskSpec } from "./draft/ask";
import type { ChangeView, FileRead } from "./draft/contract";
import type { FrameOp, TspEvent, TspInput, TspNode, TspSession } from "./tsp-types";

const SURFACE = "playbook";
const ESC = "\x1b";
const TYPES: readonly EntryData["type"][] = ["run_started", "run_finished", "block_edited", "block_added", "block_deleted", "content_replaced", "blocks_reordered", "done_changed", "launch_created", "agent_bound", "launch_closed", "event_sent", "interrupted", "check_reported", "post", "update_due", "update_snoozed"];
const LABELS: Readonly<Record<HumanField, string>> = { title: "标题", body: "正文", requirement: "需求", prompt: "修改要求" };
const FIELD_LABELS: Readonly<Record<"title" | "body" | "requirement" | "design", string>> = { title: "标题", body: "正文", requirement: "需求", design: "设计稿" };
const RECORD_LABELS: Readonly<Record<RecordKind, string>> = { update: "状态更新", result: "执行结果", failure: "执行失败", retrospective: "复盘" };
const SNOOZE_LABELS: Readonly<Record<string, string>> = { "300": "5 分钟", "900": "15 分钟", "3600": "1 小时", "86400": "1 天" };
const FINDING_LABELS: Readonly<Record<FindingName, string>> = {
	compile: "编译",
	empty_expansion: "引用非空",
	render_error: "渲染错误",
	render_pending: "渲染响应",
	chart: "表格图表",
	draft: "设计稿语法",
};
const EVENT_LABELS: Readonly<Record<EventName, string>> = {
	block_changed: "块内容变更",
	launch_requested: "请求启动",
	check_requested: "请求检查",
	run_started: "Run 开始",
	run_finished: "Run 结束",
	done_changed: "完成状态变更",
	update_due: "状态更新到期",
	interrupted: "打断编辑",
	revision_requested: "提交修改要求",
};
const TYPE_LABELS: Readonly<Record<EntryData["type"] | "all", string>> = {
	all: "全部",
	run_started: "Run 开始",
	run_finished: "Run 结束",
	block_edited: "块编辑",
	block_added: "新建块",
	block_deleted: "删除块",
	content_replaced: "内容/配置替换",
	blocks_reordered: "块顺序调整",
	done_changed: "完成标记",
	launch_created: "创建 Launch",
	agent_bound: "绑定 Agent",
	launch_closed: "关闭 Launch",
	event_sent: "发送通知",
	interrupted: "人工打断",
	check_reported: "检查报告",
	post: "记录与复盘",
	update_due: "更新到期",
	update_snoozed: "推迟提醒",
};
const ORIGIN_LABELS: Readonly<Record<TimelineEntry["origin"], string>> = { human: "人", coordinator: "协调者", disk: "磁盘", service: "服务" };
const VIEWS: readonly { readonly view: ChangeView; readonly label: string }[] = [{ view: "changes", label: "变更" }, { view: "before", label: "之前" }, { view: "after", label: "之后" }];

/** TSP sheets reach only descendants of the region root, so every rule targets the `app` wrapper or nodes inside it. */
const SURFACE_CSS = [
	// The shell: one sans font, one spacing scale (4/8/12/16/24). The app fills the main region (which would
	// otherwise scroll as one page), so the navigator and the detail each scroll on their own.
	".pb-app { position: absolute; inset: 0; display: flex; flex-direction: column; min-height: 0; box-sizing: border-box; font-family: var(--sans); font-size: 13px; line-height: 1.5; color: var(--t1); }",
	".pb-app .sf-text, .pb-app .sf-md, .pb-app .sf-badge, .pb-app .sf-input { font-family: var(--sans); }",
	// Tern's Markdown sheet sets inline code to inherit the text face; code stays monospace here.
	".pb-app code, .pb-app pre, .pb-app .sf-code { font-family: var(--mono) !important; }",
	".pb-top { display: flex; flex-direction: column; gap: 8px; padding: 12px 24px; border-bottom: 1px solid var(--l2); background: var(--panel, transparent); }",
	".pb-top-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }",
	".pb-title { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.4; color: var(--t1); }",
	".pb-spacer { flex: 1 1 auto; }",
	".pb-body { display: grid; grid-template-columns: 264px minmax(0, 1fr); flex: 1 1 auto; min-height: 0; }",
	".pb-nav { display: flex; flex-direction: column; gap: 4px; padding: 12px 8px; overflow-y: auto; overscroll-behavior: contain; min-height: 0; border-right: 1px solid var(--l2); }",
	".pb-detail { display: flex; flex-direction: column; gap: 16px; padding: 0 24px 24px; overflow-y: auto; overscroll-behavior: contain; min-height: 0; }",
	".pb-detail > .pb-block-title, .pb-detail > .pb-empty { margin-top: 16px; }",
	".pb-detail-block { display: flex; flex-direction: column; gap: 16px; }",
	".pb-nav-row { display: flex; align-items: flex-start; gap: 4px; }",
	".pb-nav-row > .pb-choice { border-color: transparent; background: transparent; padding: 8px 4px; }",
	".pb-nav-item { display: flex; flex-direction: column; gap: 4px; padding: 8px; border-radius: 6px; flex: 1 1 auto; min-width: 0; cursor: pointer; }",
	".pb-nav-item:hover { background: var(--l1); }",
	".pb-nav-active { background: rgb(from var(--accent) r g b / 12%); box-shadow: inset 2px 0 0 var(--accent); }",
	".pb-nav-label { font-size: 11px; line-height: 1.3; color: var(--t3); }",
	".pb-nav-title { font-weight: 600; line-height: 1.4; color: var(--t1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
	".pb-nav-sep { height: 1px; background: var(--l2); margin: 8px 4px; }",
	".pb-select-bar { display: flex; flex-direction: column; gap: 8px; padding: 8px; margin-top: 8px; border-radius: 6px; background: rgb(from var(--accent) r g b / 8%); border: 1px solid rgb(from var(--accent) r g b / 30%); }",
	".pb-cite { padding: 4px 0; color: var(--t1); cursor: pointer; }",
	".pb-cite:hover { color: var(--accent); }",
	".pb-pinned { max-height: 420px; overflow: auto; padding: 4px; border-left: 3px solid rgb(from var(--accent) r g b / 50%); }",
	".pb-chips { display: flex; flex-wrap: wrap; gap: 4px; }",
	// The block head stays at the top of the detail while the block scrolls under it.
	".pb-head { position: sticky; top: 0; z-index: 1; display: flex; flex-direction: column; gap: 8px; padding: 16px 0 12px; background: var(--page, var(--panel)); border-bottom: 1px solid var(--l2); }",
	".pb-block-title { margin: 0; font-size: 18px; font-weight: 600; line-height: 1.4; color: var(--t1); cursor: text; }",
	".pb-head .pb-choice { border-color: transparent; background: transparent; padding: 4px; }",
	".pb-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }",
	".pb-panel { display: flex; flex-direction: column; gap: 8px; padding: 12px 16px; border-radius: 8px; border: 1px solid var(--l2); background: var(--card, transparent); }",
	".pb-panel-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }",
	".pb-panel-title { font-size: 12px; font-weight: 600; color: var(--t2); }",
	".pb-request { display: flex; flex-direction: column; gap: 4px; padding: 8px 12px; border-radius: 6px; background: var(--l1); }",
	".pb-request-text { white-space: pre-wrap; color: var(--t1); line-height: 1.5; }",
	".pb-form-row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; }",
	".pb-field { display: flex; flex-direction: column; gap: 4px; width: 260px; max-width: 100%; }",
	".pb-field-wide { display: flex; flex-direction: column; gap: 4px; width: 100%; }",
	".pb-button { display: inline-flex; align-items: center; justify-content: center; align-self: flex-start; width: auto; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--l3, var(--l2)); background: var(--raise, var(--l1)); color: var(--t1); font-weight: 500; line-height: 1.5; cursor: pointer; }",
	".pb-button-primary { background: rgb(from var(--accent) r g b / 16%); border-color: rgb(from var(--accent) r g b / 45%); color: var(--accent-ink, var(--accent)); font-weight: 600; }",
	".pb-button-danger { background: rgb(from var(--bad) r g b / 12%); border-color: rgb(from var(--bad) r g b / 45%); color: var(--bad); }",
	".pb-button-ghost { background: transparent; border-color: transparent; color: var(--t2); padding: 4px 8px; }",
	".pb-disabled { opacity: .42; cursor: default; }",
	".pb-choice { display: inline-flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--l2); background: var(--card, transparent); cursor: pointer; align-self: flex-start; }",
	".pb-choice-checked { border-color: rgb(from var(--accent) r g b / 45%); background: rgb(from var(--accent) r g b / 10%); color: var(--accent-ink, var(--t1)); }",
	".pb-choice-disabled { opacity: .45; cursor: default; }",
	".pb-timeline-entry { display: flex; flex-direction: column; gap: 4px; padding: 8px 12px; border-left: 2px solid var(--l3, var(--l2)); }",
	".pb-empty { padding: 32px 0; color: var(--t3); }",
	".pb-doc { display: flex; flex-direction: column; gap: 8px; }",
	// Checks and deletion close the block: one quiet footer instead of loose lines.
	".pb-foot { display: flex; flex-direction: column; gap: 4px; padding-top: 12px; border-top: 1px solid var(--l2); color: var(--t3); }",
	".am-draft { display: flex; flex-direction: column; gap: 14px; font-family: var(--sans); font-size: 14px; line-height: 1.55; color: var(--t1); }",
	".am-draft .sf-md, .am-draft .sf-text { font-family: var(--sans); font-size: 14px; line-height: 1.55; }",
	".am-title { margin: 0; font-size: 20px; font-weight: 600; line-height: 1.3; }",
	".am-subtitle { margin: 0; color: var(--t2); }",
	".am-sheet, .am-doc { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }",
	".am-panel { flex: 1 1 100%; min-width: 300px; display: flex; flex-direction: column; border: 1px solid var(--l3, var(--l2)); border-radius: 8px; background: var(--card, transparent); overflow: hidden; }",
	// `cols` caps the panels per row; a panel never narrows below 300px (560px with a drawing), so a narrow pane wraps.
	...[2, 3, 4, 5, 6].flatMap(cols => Array.from({ length: cols - 1 }, (_, index) => `.am-cols-${cols} > .am-span-${index + 1} { flex-basis: ${Math.floor(((index + 1) / cols) * 100 - 10)}%; }`)),
	".am-panel-wide { min-width: 560px; }",
	".am-doc > .am-panel { flex-basis: 100%; }",
	".am-panel-bare { border-color: transparent; background: transparent; }",
	".am-panel-head { display: flex; align-items: stretch; gap: 10px; min-height: 34px; border-bottom: 1px solid var(--l2); }",
	".am-panel-id { display: flex; align-items: center; justify-content: center; min-width: 32px; background: var(--t1); color: var(--card, #fff); font-weight: 700; font-size: 14px; }",
	".am-panel-heading { margin: 0; align-self: center; font-size: 15px; font-weight: 600; }",
	".am-panel-meta { margin-left: auto; align-self: center; padding-right: 12px; font-size: 12px; color: var(--t3); }",
	".am-panel-body { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px 16px; }",
	".am-callout { display: flex; flex-direction: column; gap: 4px; padding: 10px 14px; border-left: 3px solid var(--accent); background: rgb(from var(--accent) r g b / 8%); }",
	".am-callout-ok { border-left-color: var(--ok); background: rgb(from var(--ok) r g b / 10%); }",
	".am-callout-warn { border-left-color: var(--warn); background: rgb(from var(--warn) r g b / 12%); }",
	".am-callout-err { border-left-color: var(--bad); background: rgb(from var(--bad) r g b / 10%); }",
	".am-callout-title { font-size: 14px; font-weight: 600; }",
	".am-kv { display: grid; gap: 1px; background: var(--l3, var(--l2)); border: 1px solid var(--l3, var(--l2)); }",
	...[1, 2, 3, 4, 5, 6].map(cols => `.am-kv-${cols} { grid-template-columns: repeat(${cols}, minmax(0, 1fr)); }`),
	".am-kv-cell { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; background: var(--card, var(--panel)); }",
	".am-kv-wide { grid-column: 1 / -1; }",
	".am-kv-wide .sf-text { font-size: 17px; font-weight: 600; }",
	".am-kv-key { font-size: 11px; color: var(--t3); }",
	".am-ask { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 6px; background: var(--l1); border: 1px solid var(--l2); }",
	".am-option { display: flex; align-items: flex-start; gap: 10px; padding: 6px 8px; border-radius: 6px; cursor: pointer; }",
	".am-option-checked { background: rgb(from var(--accent) r g b / 12%); }",
	".am-option-text { display: flex; flex-direction: column; gap: 2px; }",
	".am-option-name { display: flex; align-items: center; gap: 6px; font-weight: 500; }",
	".am-option-note { font-size: 12px; color: var(--t3); }",
].join("\n");

type ButtonKind = "default" | "primary" | "danger" | "ghost";
type Caret = { cursor: number; anchor: number | null };
type UndoStep = Caret & { text: string };
type Field = { readonly multiline: boolean; text(): string; write(text: string): string | null };
type Summary = Pick<RenderStatus, "chartNodes" | "view" | "draftErrors">;
/** A refused human action, shown at the control that caused it until the next action. */
type ActionError = { readonly message: string; readonly anchor: string | null; readonly needsCoordinator: boolean };
/** What the detail column shows: one block, the Run's activity, or the compiled selection. */
type Current = { readonly kind: "block"; readonly block: BlockId } | { readonly kind: "activity" } | { readonly kind: "selection" };
type Chip = { readonly text: string; readonly tone: string };

const text = (id: string, value: string, tone?: string): TspNode => ({ id, k: "text", p: { text: value, ...(tone ? { tone } : {}) } });
const badge = (id: string, value: string, tone?: string): TspNode => ({ id, k: "badge", p: { text: value, ...(tone ? { tone } : {}) } });
const col = (id: string, c: readonly TspNode[]): TspNode => ({ id, k: "col", p: { gap: "sm" }, c });
const row = (id: string, c: readonly TspNode[]): TspNode => ({ id, k: "row", p: { gap: "sm", wrap: true, align: "center" }, c });
const box = (id: string, className: string, c: readonly TspNode[], extra: Record<string, unknown> = {}): TspNode => ({ id, k: "el", p: { tag: "div", class: className, ...extra }, c });
const time = (at: number | null): string => at === null ? "无" : `${new Date(at).toISOString().slice(0, 19).replace("T", " ")} UTC`;
const clock = (at: number): string => new Date(at).toISOString().slice(11, 16);

function blockKindLabel(content: BlockContent): "设计块" | "编排块" | "执行块" {
	if (content.kind === "design") return "设计块";
	return isOrchestration(content) ? "编排块" : "执行块";
}

function compileErrorText(error: CompileError): string {
	const site = `（位于 ${error.at.block} 的引用 ${error.at.reference}）`;
	switch (error.kind) {
		case "UnknownBlock": return `引用的块 ${error.block} 不存在${site}`;
		case "UnknownTarget": return `无法识别的引用目标${site}`;
		case "BadExpression": return `引用选择器无效：${error.reason}${site}`;
		case "Cycle": return `循环引用：${error.path.join(" → ")}${site}`;
		case "TooDeep": return `块引用超过 8 层${site}`;
		case "NoResult": return `块 ${error.block} 还没有关联的 result 记录${site}`;
		case "FetchFailed": return `外部引用 ${error.target} 取回失败：${error.error}${site}`;
	}
}

const compileText = (result: CompileResult): string => result.kind === "Ok" ? result.text : compileErrorText(result.error);

function sourcesText(sources: readonly Source[]): string {
	if (sources.length === 0) return "引用来源：无";
	return "引用来源：" + sources.map(source => {
		const expression = source.expression ? ` | ${source.expression}` : "";
		switch (source.kind) {
			case "block": return `块 ${source.target}${expression}`;
			case "result": return `结果 ${source.target}${expression} (#${source.seq})`;
			case "external": return `外部 ${source.target}${expression}（${time(source.fetchedAt)}）`;
		}
	}).join("；");
}

function excerpt(value: string, max = 96): string {
	const single = value.replace(/\s+/g, " ").trim();
	if (!single) return "（空）";
	return single.length <= max ? single : `${single.slice(0, max)}…`;
}

function describeEntry(data: Exclude<EntryData, { type: "post" }>): string {
	switch (data.type) {
		case "run_started": return `开始 Run「${data.name}」`;
		case "run_finished": return "结束 Run";
		case "block_edited": return `修改块 ${data.block} 的${FIELD_LABELS[data.field]}：${excerpt(data.text)}`;
		case "block_added": return `新建${blockKindLabel(data.content)} ${data.block}${data.title.trim() ? `「${data.title.trim()}」` : ""}`;
		case "block_deleted": return `删除${blockKindLabel(data.content)} ${data.block}${data.title.trim() ? `「${data.title.trim()}」` : ""}`;
		case "content_replaced": return `替换块 ${data.block} 的内容或执行配置`;
		case "blocks_reordered": return `调整块顺序：${data.order.join(" → ")}`;
		case "done_changed": return `块 ${data.block} 标为${data.done ? "已完成" : "未完成"}`;
		case "launch_created": return `创建 Launch ${data.launch}（${data.kind === "orchestration" ? "编排" : "执行"} · 块 ${data.blocks.join("、")}）`;
		case "agent_bound": return `Launch ${data.launch} 绑定 Agent ${data.agent}`;
		case "launch_closed": return `关闭 Launch ${data.launch}`;
		case "event_sent": return `通知协调者：${EVENT_LABELS[data.event]}`;
		case "interrupted": return `打断协调者在块 ${data.block} 上的编辑`;
		case "check_reported": return `记录块 ${data.blocks.join("、")} 的检查报告`;
		case "update_due": return `状态更新到期（${time(data.due)}）`;
		case "update_snoozed": return `状态更新提醒推迟到 ${time(data.due)}`;
	}
}

/** Blocks an event payload names; `event_sent` carries the K1 payload as `unknown`. */
function eventBlocks(data: unknown): readonly string[] {
	if (typeof data !== "object" || data === null) return [];
	if ("blocks" in data && Array.isArray(data.blocks)) return data.blocks.filter((value): value is string => typeof value === "string");
	if ("block" in data && typeof data.block === "string") return [data.block];
	return [];
}

/** Largest file a draft may embed (am's image limit; code blocks stop far earlier). */
const MAX_DRAFT_FILE_BYTES = 5 * 1024 * 1024;

/** Read a file a design draft names: relative to the Playbook directory, only inside it, only a regular file of bounded size. */
function readDraftFile(baseDir: string, path: string): FileRead {
	try {
		const base = realpathSync(baseDir);
		const target = realpathSync(resolve(base, path));
		const inside = relative(base, target);
		if (inside.startsWith("..") || isAbsolute(inside)) return { ok: false, error: `只能引用 Playbook 目录内的文件：${path}` };
		const stat = statSync(target);
		if (!stat.isFile()) return { ok: false, error: `不是普通文件：${path}` };
		if (stat.size > MAX_DRAFT_FILE_BYTES) return { ok: false, error: `文件超过 5 MB：${path}` };
		return { ok: true, bytes: new Uint8Array(readFileSync(target)), path: target };
	} catch (error) {
		return { ok: false, error: `无法读取 ${path}：${error instanceof Error ? error.message : String(error)}` };
	}
}

/** K4 front end. Core owns every document, lock and draft; local state is only interaction state. */
export function startUi(core: CoreApi, tsp: TspSession, baseDir: string): void {
	initThemeSync();
	setTableCharts("always");
	let ref: DocRef = { kind: "template" };
	let opened = false;
	let mounted = false;
	let focus: string | null = null;
	/** The field committed last, until the human focuses a field again: input arriving for it is late (K4 错误). */
	let committed: string | null = null;
	/** Tern render or theme failure; stays until dismissed. */
	let renderError: string | null = null;
	let actionError: ActionError | null = null;
	let current: Current | null = null;
	let confirmDelete: BlockId | null = null;
	/** A block shown read-only above whichever block is open, for reading two blocks together. */
	let pinned: BlockId | null = null;
	let runName = "";
	let runEvery = "";
	let postText = "";
	let postNext = "";
	let postKind: RecordKind = "update";
	let postBlock: BlockId | null = null;
	let postKindChosen = false;
	let filter: EntryData["type"] | "all" = "all";
	let snoozeAfter = 900;
	/** Last status seen per Run, to reset the record form once when a Run finishes. */
	const runStatus = new Map<RunId, RunStatus>();
	/**
	 * The design text when this pane submitted a template change request, by block: the template has no
	 * timeline, so "the design changed after the request" can only be seen by comparing with this.
	 */
	const designAtRequest = new Map<BlockId, { readonly seq: number; readonly design: string }>();
	const selected = new Set<BlockId>();
	const carets = new Map<string, Caret>();
	const undo = new Map<string, UndoStep[]>();
	const notices = new Map<string, string>();
	const previews = new Map<string, CompileResult>();
	const summaries = new Map<BlockId, Summary>();
	const actions = new Map<string, () => void>();
	const changes = new Map<string, (event: Extract<TspEvent, { ev: "change" }>) => void>();
	const fields = new Map<string, Field>();
	/** Opened Launch records: copies of `core.launchInfo(id)`, refreshed on every Core change. */
	const info = new Map<LaunchId, Launch>();
	/** View of each marked draft component, by `<block>.<component key>`; UI state only. */
	const views = new Map<string, ChangeView>();
	const sentBlobs = new Set<string>();

	function imageNode(id: string, bytes: Uint8Array, mime: string, alt: string, size?: { readonly w: number; readonly h: number }): TspNode {
		const blob = createHash("sha256").update(bytes).digest("hex");
		if (!sentBlobs.has(blob)) { tsp.blob(blob, mime, bytes); sentBlobs.add(blob); }
		// The cap is the SVG's own width in px (1 user unit = 1px): a `ch` cap shrank drawings by the font's ch/8px ratio.
		return { id, k: "image", p: { blob, alt, ...(size ? { w: size.w, h: size.h, max: { w: `${Math.round(size.w)}px` } } : {}) } };
	}
	function draftHost(block: BlockId): DraftHost {
		return {
			id: `${block}.design.view`,
			context: {
				// Resolved per draw, so a theme change redraws figures in the new palette.
				svg: (id, svg, size, alt) => imageNode(id, new TextEncoder().encode(prepareSvg(svg, svgFigurePalette())), "image/svg+xml", alt, size),
				image: (id, bytes, mime, alt) => imageNode(id, bytes, mime, alt),
				readFile: path => readDraftFile(baseDir, path),
			},
			view: key => views.get(`${block}.${key}`) ?? "changes",
			viewSwitch: (id, key, currentView) => row(id, VIEWS.map(option => check(`${id}.${option.view}`, option.label, currentView === option.view, false, checked => { if (checked) { views.set(`${block}.${key}`, option.view); redraw(); } }, id, option.view))),
		};
	}
	function startDraft(block: BlockId, name: HumanField): void {
		const error = core.pencil(ref, block, name);
		if (error) return showError(error, `${block}.${name}`);
		current = { kind: "block", block };
		focus = `${block}.${name}`; committed = null;
		carets.delete(focus); undo.delete(focus); notices.delete(focus);
		redraw();
	}
	function discardDraft(block: BlockId, fieldId: string): void {
		const error = core.discard(ref, block);
		if (error) return showError(error, fieldId);
		if (focus === fieldId) focus = null;
		carets.delete(fieldId); undo.delete(fieldId); notices.delete(fieldId);
		redraw();
	}
	function draftField(block: BlockId, name: HumanField): TspNode {
		return field(`${block}.${name}`, { multiline: name !== "title", text: () => {
			const item = core.view(ref).blocks.find(candidate => candidate.block.id === block);
			const lock = item?.lock;
			if (lock?.kind === "human" && lock.field === name) return lock.draft;
			return name === "prompt" || !item ? "" : fieldText(item.block, name) ?? "";
		}, write: draft => core.setDraft(ref, block, draft) }, name === "prompt" ? "写给协调者：哪里要改、改成什么" : `${block} ${LABELS[name]}`);
	}
	/**
	 * Option inputs of an ask in `block`'s visible draft. A pick is a line of the block's change-request
	 * draft (Core holds it), so the shown selection is read back from that draft, never kept here.
	 */
	function askControl(block: BlockId, editable: boolean): NonNullable<DraftHost["askControl"]> {
		return (id, _key, spec) => {
			const item = core.view(ref).blocks.find(candidate => candidate.block.id === block);
			const draft = item?.lock.kind === "human" && item.lock.field === "prompt" ? item.lock.draft : "";
			const prefix = `针对问题「${spec.question}」，选择：`;
			const line = draft.split("\n").find(entry => entry.startsWith(prefix));
			const chosen = line ? line.slice(prefix.length).split("、").filter(Boolean) : [];
			const options = spec.options.map((option, index): TspNode => {
				const optionId = `${id}.${index}`;
				const checked = chosen.includes(option.label);
				if (editable) changes.set(optionId, event => {
					if (typeof event.checked !== "boolean") return;
					const next = spec.mode === "single"
						? (event.checked ? [option.label] : chosen)
						: spec.options.map(other => other.label).filter(label => label === option.label ? event.checked === true : chosen.includes(label));
					writeAnswer(block, prefix, next);
				});
				return { id: `${optionId}.label`, k: "el", p: { tag: "label", class: `am-option${checked ? " am-option-checked" : ""}${editable ? "" : " pb-choice-disabled"}` }, c: [
					{ id: optionId, k: "el", p: { tag: "input", type: spec.mode === "single" ? "radio" : "checkbox", name: spec.mode === "single" ? id : optionId, value: option.label, checked, disabled: !editable } },
					{ id: `${optionId}.text`, k: "el", p: { tag: "div", class: "am-option-text" }, c: [
						{ id: `${optionId}.name`, k: "el", p: { tag: "span", class: "am-option-name" }, c: [text(`${optionId}.label.text`, option.label), ...(option.suggested ? [badge(`${optionId}.suggested`, "建议", "accent")] : [])] },
						...(option.note ? [{ id: `${optionId}.note`, k: "el", p: { tag: "span", class: "am-option-note", text: option.note } }] : []),
					] },
				] };
			});
			return [col(`${id}.options`, options), text(`${id}.chosen`, chosen.length ? `已写入下方修改要求：${chosen.join("、")}。可继续补充，一次提交。` : "选择会写入下方修改要求草稿，不会立即发出", "muted")];
		};
	}
	/** Put an ask's answer into the block's change-request draft as one line, opening the draft when needed. */
	function writeAnswer(block: BlockId, prefix: string, labels: readonly string[]): void {
		const item = core.view(ref).blocks.find(candidate => candidate.block.id === block);
		if (!(item?.lock.kind === "human" && item.lock.field === "prompt")) {
			const started = core.pencil(ref, block, "prompt");
			if (started) return showError(started, `${block}.prompt`);
			carets.delete(`${block}.prompt`); undo.delete(`${block}.prompt`);
		}
		const lock = core.view(ref).blocks.find(candidate => candidate.block.id === block)?.lock;
		const draft = lock?.kind === "human" ? lock.draft : "";
		// The person's own lines, blank ones included, stay as written; only this ask's line changes.
		const lines = draft === "" ? [] : draft.split("\n");
		const at = lines.findIndex(entry => entry.startsWith(prefix));
		const answer = labels.length ? [`${prefix}${labels.join("、")}`] : [];
		if (at >= 0) lines.splice(at, 1, ...answer);
		else if (answer.length) {
			if (lines.at(-1) === "") lines.pop();
			lines.push(...answer);
		}
		const drafted = core.setDraft(ref, block, lines.join("\n"));
		if (drafted) return showError(drafted, `${block}.prompt`);
		carets.delete(`${block}.prompt`);
		focus = `${block}.prompt`; committed = null;
	}
	function submitPrompt(block: BlockId): void {
		const before = core.view(ref).blocks.find(item => item.block.id === block)?.block.content;
		const error = core.commit(ref, block);
		if (error) return showError(error, `${block}.prompt`);
		const last = core.revisions(ref, block).at(-1);
		if (last && before?.kind === "design") designAtRequest.set(block, { seq: last.seq, design: before.design });
		// Input that arrives for the submitted editor is late and is shown, as for committed fields.
		committed = `${block}.prompt`;
		focus = null;
		redraw();
	}
	/** Insert a block after the shown one, show it and open its title editor: the new id is read back from Core, never guessed. */
	function insertAndEdit(after: BlockId | null, kind: BlockContent["kind"], anchor: string): void {
		const before = new Set(core.view(ref).blocks.map(item => item.block.id));
		const error = core.insertBlock(ref, after, kind);
		if (error) return showError(error, anchor);
		const created = core.view(ref).blocks.find(item => !before.has(item.block.id));
		if (!created) return redraw();
		current = { kind: "block", block: created.block.id };
		if (anyDraft()) redraw(); else startDraft(created.block.id, "title");
	}
	function anyDraft(): boolean {
		return [core.view({ kind: "template" }), ...core.runs().map(run => core.view({ kind: "run", run: run.id }))].some(doc => doc.blocks.some(item => item.lock.kind === "human"));
	}
	function resetRecordForm(): void {
		postKind = "retrospective"; postBlock = null; postKindChosen = false; postNext = "";
	}

	function showError(error: string | null, anchor: string | null = null): void {
		if (!error) return;
		actionError = { message: error, anchor, needsCoordinator: error.includes("没有协调者连接") };
		redraw();
	}
	function inlineError(anchor: string): TspNode[] {
		return actionError?.anchor === anchor ? [text(`${anchor}.error`, actionError.message, "error")] : [];
	}
	function button(id: string, label: string, action: () => void, disabled = false, kind: ButtonKind = "default"): TspNode {
		if (!disabled) actions.set(id, action);
		return { id, k: "el", p: { tag: "button", text: label, class: `pb-button${kind === "default" ? "" : ` pb-button-${kind}`}${disabled ? " pb-disabled" : ""}`, attrs: { "aria-disabled": disabled }, ...(disabled ? {} : { actions: { click: "invoke" } }) } };
	}
	function check(id: string, label: string, checked: boolean, disabled: boolean, change: (checked: boolean) => void, name?: string, value?: string): TspNode {
		if (!disabled) changes.set(id, event => { if (typeof event.checked === "boolean") change(event.checked); });
		return { id: `${id}.label`, k: "el", p: { tag: "label", class: `pb-choice${checked ? " pb-choice-checked" : ""}${disabled ? " pb-choice-disabled" : ""}` }, c: [{ id, k: "el", p: { tag: "input", type: name ? "radio" : "checkbox", name: name ?? id, value: value ?? id, checked, disabled } }, text(`${id}.text`, label)] };
	}
	function choices<T extends string>(id: string, values: readonly T[], value: T, change: (value: T) => void, disabled = false, labelOf: (value: T) => string = item => item): TspNode {
		return row(id, values.map(item => check(`${id}.${item}`, labelOf(item), value === item, disabled, checked => { if (checked) { change(item); redraw(); } }, id, item)));
	}
	function field(id: string, value: Field, placeholder: string): TspNode {
		fields.set(id, value);
		const caret = carets.get(id) ?? { cursor: value.text().length, anchor: null };
		carets.set(id, caret);
		return { id, k: value.multiline ? "editor" : "input", p: { text: value.text(), cursor: caret.cursor, anchor: caret.anchor, placeholder, aria: placeholder, ...(value.multiline ? { maxLines: 18 } : {}) } };
	}
	function formField(id: string, get: () => string, put: (value: string) => void, placeholder: string, multiline = false): TspNode {
		return field(id, { multiline, text: get, write: value => { put(value); return null; } }, placeholder);
	}
	function labeled(id: string, label: string, control: TspNode, wide = false): TspNode {
		return box(`${id}.group`, wide ? "pb-field-wide" : "pb-field", [text(`${id}.caption`, label, "muted"), control]);
	}
	function section(id: string, head: string | TspNode, c: readonly TspNode[], key = id, startCollapsed = false): TspNode {
		return { id, k: "section", p: { head: typeof head === "string" ? head : head.id, key, collapsible: true, collapsed: startCollapsed }, c: typeof head === "string" ? c : [head, ...c] };
	}
	function panel(id: string, title: string, head: readonly TspNode[], c: readonly TspNode[]): TspNode {
		return box(id, "pb-panel", [box(`${id}.head`, "pb-panel-head", [{ id: `${id}.title`, k: "el", p: { tag: "span", class: "pb-panel-title", text: title } }, ...head]), ...c]);
	}
	function rendered(id: string, body: string): TspNode[] {
		return splitTableCharts(separateTableReferences(body), false).flatMap((segment, index): TspNode[] => {
			const nodeId = `${id}.${index}`;
			if (segment.kind === "markdown") return [{ id: nodeId, k: "md", p: { text: segment.text } }];
			const chart = lookupTableChart(segment.table);
			if (!chart || chart instanceof Promise) throw new Error("always-mode chart lookup did not return a chart");
			return [imageNode(nodeId, new TextEncoder().encode(prepareSvg(chart, svgFigurePalette())), "image/svg+xml", "表格图表")];
		});
	}
	function record(id: string, entry: TimelineEntry): TspNode {
		const data = entry.data;
		const meta = text(`${id}.meta`, `#${entry.seq} · ${time(entry.at)} · ${TYPE_LABELS[data.type]} · ${ORIGIN_LABELS[entry.origin]}`, "muted");
		if (data.type !== "post") return col(id, [meta, text(`${id}.content`, describeEntry(data))]);
		const head = [`**${RECORD_LABELS[data.kind]}**`, ...(data.block ? [`关联块 ${data.block}`] : []), ...(data.launch ? [`Launch ${data.launch}`] : [])].join(" · ");
		return col(id, [meta, { id: `${id}.content`, k: "md", p: { text: `${head}\n\n${data.text}` } }, ...(data.quote ? [text(`${id}.quote`, `取自会话 ${data.session ?? "未提供"} 的消息 ${data.quote}`, "muted")] : [])]);
	}

	// ------------------------------------------------------------ derived block state

	/** Entries of the Run timeline that concern `block`, oldest first. */
	function blockHistory(view: DocView, block: BlockId): TimelineEntry[] {
		const launches = new Set<string>();
		return view.timeline.filter(entry => {
			const data = entry.data;
			switch (data.type) {
				case "launch_created": if (data.blocks.includes(block)) { launches.add(data.launch); return true; } return false;
				case "agent_bound": case "launch_closed": return launches.has(data.launch);
				case "post": return data.block === block;
				case "done_changed": case "block_edited": case "content_replaced": case "interrupted": case "block_added": return data.block === block;
				case "event_sent": return (data.event === "launch_requested" || data.event === "check_requested") && eventBlocks(data.data).includes(block);
				case "check_reported": return data.blocks.includes(block);
				case "run_started": case "run_finished": case "block_deleted": case "blocks_reordered": case "update_due": case "update_snoozed": return false;
			}
		});
	}
	/** Open Launches started for `item` itself; `item.launches` also lists Launches that only reference it. */
	function rootLaunches(view: DocView, item: BlockView): BlockView["launches"] {
		const roots = new Set(view.timeline.flatMap(entry => entry.data.type === "launch_created" && entry.data.blocks.includes(item.block.id) ? [entry.data.launch] : []));
		return item.launches.filter(launch => roots.has(launch.id));
	}
	/** The pinned block, read-only: a design's drawing or a task's body, with a way to open or unpin it. */
	function pinnedPanel(item: BlockView): TspNode {
		const id = `pin.${item.block.id}`;
		const body = item.block.content.kind === "design"
			? renderDraft(item.block.content.design, { ...draftHost(item.block.id), id: `${id}.design`, view: () => "changes" }).nodes
			: rendered(`${id}.body`, item.block.content.body);
		return panel(id, `参考 · ${item.block.id} ${item.block.title.trim()}`, [
			button(`${id}.open`, "打开", () => { current = { kind: "block", block: item.block.id }; redraw(); }, false, "ghost"),
			button(`${id}.unpin`, "取消参考", () => { pinned = null; redraw(); }, false, "ghost"),
		], [box(`${id}.doc`, "pb-pinned", body)]);
	}
	/** A launch request for `block` that no Launch has answered yet, read from the Run timeline. */
	function launchPending(view: DocView, block: BlockId): TimelineEntry | null {
		let pending: TimelineEntry | null = null;
		for (const entry of view.timeline) {
			const data = entry.data;
			if (data.type === "event_sent" && data.event === "launch_requested" && eventBlocks(data.data).includes(block)) pending = entry;
			if (data.type === "launch_created" && data.blocks.includes(block)) pending = null;
		}
		return pending;
	}
	/** Where the latest change request of a design block stands, from what this pane can observe. */
	function requestState(view: DocView, item: BlockView, history: readonly Revision[]): Chip | null {
		const last = history.at(-1);
		if (!last || item.block.content.kind !== "design") return null;
		// No data ties a coordinator lock or a design edit to a revision: state order and facts, never "handled".
		if (item.lock.kind === "coordinator") return null;
		const changed = view.run
			? view.timeline.some(entry => entry.data.type === "block_edited" && entry.data.block === item.block.id && entry.data.field === "design" && entry.at >= last.at)
			: (() => { const seen = designAtRequest.get(item.block.id); return seen?.seq === last.seq ? seen.design !== item.block.content.design : null; })();
		if (changed === true) return { text: `提交 #${last.seq} 之后设计有改动`, tone: "success" };
		if (changed === false) return { text: `已提交 #${last.seq}，设计尚未改动`, tone: "accent" };
		return { text: `最近提交 #${last.seq} · ${clock(last.at)} UTC`, tone: "muted" };
	}
	function blockChips(view: DocView, item: BlockView): Chip[] {
		const chips: Chip[] = [];
		const block = item.block;
		if (block.done) chips.push({ text: "已完成", tone: "success" });
		if (item.lock.kind === "coordinator") chips.push({ text: "协调者编辑中", tone: "warning" });
		if (item.lock.kind === "human") chips.push({ text: "你在编辑", tone: "accent" });
		if (view.run) {
			for (const launch of rootLaunches(view, item)) chips.push({ text: !launch.active ? `${launch.id} 不活跃` : launch.agents.length ? `${launch.id} 已绑定 ${launch.agents.join("、")}` : `${launch.id} 等待绑定`, tone: launch.active ? "accent" : "neutral" });
			const affecting = item.launches.length - rootLaunches(view, item).length;
			if (affecting > 0) chips.push({ text: `被 ${affecting} 个未关闭 Launch 引用`, tone: "neutral" });
			const pending = launchPending(view, block.id);
			if (!rootLaunches(view, item).length && pending) chips.push({ text: `${clock(pending.at)} 已请求启动`, tone: "accent" });
			const latest = item.latestRecord?.data;
			if (latest?.type === "post" && (latest.kind === "result" || latest.kind === "failure")) chips.push({ text: latest.kind === "result" ? (block.done ? "有结果" : "有结果 · 待确认完成") : "失败", tone: latest.kind === "result" ? "success" : "error" });
		}
		const request = requestState(view, item, core.revisions(ref, block.id));
		if (request && request.tone !== "muted") chips.push(request);
		const failed = (item.findings ? Object.values(item.findings).filter(Boolean).length : 0) + (item.report?.result.kind === "answers" ? Object.values(item.report.result.answers).filter(probability => probability >= 0.5).length : 0);
		const report = item.report?.result;
		// Only a check state that tells blocks apart is a chip: the usual "auto checks passed, model not asked" is the detail's footer.
		if (item.findings && failed) chips.push({ text: `检查 ${failed} 项不通过`, tone: "error" });
		else if (item.findings && report?.kind === "answers") chips.push({ text: "检查通过", tone: "success" });
		else if (item.findings && report?.kind === "judge_unavailable") chips.push({ text: "检查：模型不可用", tone: "warning" });
		return chips;
	}
	function chipRow(id: string, chips: readonly Chip[]): TspNode {
		return box(id, "pb-chips", chips.map((chip, index) => badge(`${id}.${index}`, chip.text, chip.tone)));
	}

	// ------------------------------------------------------------ block detail

	/**
	 * Every block is drawn on every redraw so its render status and checks stay exact; only the shown
	 * block is mounted. The check view (checks.md §1) is collected from the block's content nodes only.
	 */
	function blockDetail(view: DocView, item: BlockView, hasDraft: boolean): TspNode {
		const block = item.block;
		const prefix = block.id;
		const finished = view.run?.status === "finished";
		const unlocked = item.lock.kind === "none";
		const canEdit = unlocked && !hasDraft && !finished;
		const contract = block.content.kind === "task" ? block.content : null;
		const editingTitle = item.lock.kind === "human" && item.lock.field === "title";
		const content: TspNode[] = [];

		const titleNode: TspNode = editingTitle
			? draftField(block.id, "title")
			: { id: `${prefix}.title.view`, k: "md", p: { text: block.title } };
		content.push(...(editingTitle ? [] : [titleNode]));
		const head = box(`${prefix}.state`, "pb-head", [
			row(`${prefix}.toolbar`, [
				badge(`${prefix}.kind.badge`, `${block.id} · ${blockKindLabel(block.content)}`, "neutral"),
				...(contract?.agent !== undefined ? [badge(`${prefix}.agent`, `agent: ${contract.agent}`, "accent")] : []),
				...(contract?.isolated !== undefined ? [badge(`${prefix}.isolated`, `isolated: ${contract.isolated ? "true" : "false"}`, "accent")] : []),
				check(`${prefix}.done`, "已完成", block.done, !unlocked || finished, done => { showError(core.setDone(ref, block.id, done), `${prefix}.state`); }),
				...(item.lock.kind === "coordinator" ? [text(`${prefix}.lock`, "协调者正在编辑这个块", "warning"), button(`${prefix}.interrupt`, "收回编辑权", () => showError(core.interrupt(ref, block.id), `${prefix}.state`), finished, "danger")] : []),
				box(`${prefix}.toolbar.spacer`, "pb-spacer", []),
				...(view.run && block.content.kind === "task" ? [button(`${prefix}.launch`, isOrchestration(block.content) ? "启动编排" : "启动", () => { if (view.run) showError(core.requestLaunch(view.run.id, [block.id]), `${prefix}.actions`); }, finished, "primary")] : []),
				...(block.content.kind === "task" ? [button(`${prefix}.preview`, "预览", () => { void core.preview(ref, [block.id]).then(result => { previews.set(prefix, result); redraw(); }); })] : []),
				button(`${prefix}.check`, "检查", () => showError(core.requestCheck(ref, [block.id]), `${prefix}.actions`)),
				button(`${prefix}.pin`, pinned === block.id ? "取消参考" : "设为参考", () => { pinned = pinned === block.id ? null : block.id; redraw(); }),
				...(editingTitle ? [] : [button(`${prefix}.title.pencil`, "改标题", () => startDraft(block.id, "title"), !canEdit)]),
				// An empty requirement is not drawn as a panel; writing one starts from here.
				...(block.content.kind === "design" && !block.content.requirement.trim() && !(item.lock.kind === "human" && item.lock.field === "requirement")
					? [button(`${prefix}.requirement.pencil`, "写需求", () => startDraft(block.id, "requirement"), !canEdit)]
					: []),
			]),
			editingTitle
				? col(`${prefix}.title.edit`, [titleNode, row(`${prefix}.title.controls`, [button(`${prefix}.title.commit`, "保存标题", () => commit(block.id), false, "primary"), button(`${prefix}.title.discard`, "放弃", () => discardDraft(block.id, `${prefix}.title`), false, "ghost"), text(`${prefix}.title.hint`, "Enter 不换行；Esc 也会保存", "muted")])])
				: { id: `${prefix}.title.heading`, k: "el", p: { tag: "h2", class: "pb-block-title", text: block.title.trim() || "未命名块（点击填写标题）", ...(canEdit ? { actions: { click: "invoke" } } : {}) } },
			...(notices.get(`${prefix}.title`) ? [text(`${prefix}.title.notice`, notices.get(`${prefix}.title`)!, "warning")] : []),
			...inlineError(`${prefix}.title`),
			...inlineError(`${prefix}.state`),
		]);
		if (canEdit && !editingTitle) actions.set(`${prefix}.title.heading`, () => startDraft(block.id, "title"));

		const sections: TspNode[] = [head, ...inlineError(`${prefix}.actions`)];
		const reference = pinned !== null && pinned !== block.id ? view.blocks.find(other => other.block.id === pinned) : undefined;
		if (reference) sections.push(pinnedPanel(reference));
		const citing = view.blocks.flatMap(other => other.block.id === block.id ? [] : other.references.filter(found => found.reference.targetText === block.id).map(found => ({ other, text: found.reference.text })));
		if (citing.length) {
			const ids = [...new Set(citing.map(found => found.other.block.id))];
			// Folded by default: the head names the citing blocks, the rows open them.
			sections.push(section(`${prefix}.cited`, `被 ${ids.length} 个块引用：${ids.join("、")}`, citing.map((found, index) => {
				const id = `${prefix}.cited.${index}`;
				actions.set(id, () => { current = { kind: "block", block: found.other.block.id }; redraw(); });
				return { id, k: "el", p: { tag: "div", class: "pb-cite", text: `${found.other.block.id} · ${found.other.block.title.trim() || "未命名块"}　${found.text}`, actions: { click: "invoke" } } } satisfies TspNode;
			}), `${prefix}.cited`, true));
		}
		const pending = view.run ? launchPending(view, block.id) : null;
		if (pending) sections.push(text(`${prefix}.pending`, `已在 ${clock(pending.at)} UTC 发出启动请求；之后还没有为此块创建的 Launch`, "accent"));
		const latestPost = item.latestRecord?.data;
		if (view.run && !finished && !block.done && latestPost?.type === "post" && latestPost.kind === "result") sections.push(row(`${prefix}.confirm`, [text(`${prefix}.confirm.text`, `协调者已记录结果（#${item.latestRecord!.seq}）。核对后标记完成：`, "success"), button(`${prefix}.confirm.done`, "标记已完成", () => showError(core.setDone(ref, block.id, true), `${prefix}.state`), !unlocked, "primary")]));
		const ownLaunches = view.run ? rootLaunches(view, item) : [];
		if (view.run && ownLaunches.length) sections.push(panel(`${prefix}.launches`, `从此块启动、未关闭的 Launch ${ownLaunches.length}`, [], ownLaunches.map(launch => row(`${prefix}.launch.${launch.id}`, [
			badge(`${prefix}.launch.${launch.id}.badge`, launch.id, "accent"),
			text(`${prefix}.launch.${launch.id}.detail`, `${launch.active ? "活跃" : `不活跃 · 会话 ${launch.session}`} · agents: ${launch.agents.join(", ") || "等待绑定"}`),
			button(`${prefix}.launch.${launch.id}.close`, "关闭 Launch", () => showError(core.closeLaunch(launch.id), `${prefix}.actions`), false, "danger"),
		]))));
		const impact = view.run ? item.launches.filter(launch => !ownLaunches.includes(launch)) : [];
		if (impact.length) sections.push(text(`${prefix}.impact`, `被未关闭的 Launch 引用：${impact.map(launch => `${launch.id}（从 ${view.timeline.flatMap(entry => entry.data.type === "launch_created" && entry.data.launch === launch.id ? entry.data.blocks : []).join("、")} 启动）`).join("，")}`, "neutral"));
		if (view.run && item.latestRecord) sections.push(panel(`${prefix}.latest`, "最近记录", [], [record(`${prefix}.latest.view`, item.latestRecord)]));
		const preview = previews.get(prefix);
		if (preview) sections.push(panel(`${prefix}.compiled`, "发给 agent 的内容", [text(`${prefix}.compiled.length`, preview.kind === "Ok" ? `${preview.text.length} 字符` : "编译失败", preview.kind === "Ok" ? "muted" : "error"), box(`${prefix}.compiled.spacer`, "pb-spacer", []), button(`${prefix}.compiled.close`, "收起", () => { previews.delete(prefix); redraw(); }, false, "ghost")], [
			{ id: `${prefix}.compiled.text`, k: "code", p: { text: compileText(preview), lang: "text", wrap: true, max: { h: "24lines" } } },
			...(preview.kind === "Ok" ? [text(`${prefix}.compiled.sources`, sourcesText(preview.sources), "muted")] : []),
		]));

		const textField = (name: "body" | "requirement", title: string, view: TspNode[]): TspNode => {
			const editing = item.lock.kind === "human" && item.lock.field === name;
			const notice = notices.get(`${prefix}.${name}`);
			return panel(`${prefix}.${name}.panel`, title, editing
				? [button(`${prefix}.${name}.commit`, "保存", () => commit(block.id), false, "primary"), button(`${prefix}.${name}.discard`, "放弃", () => discardDraft(block.id, `${prefix}.${name}`), false, "ghost"), text(`${prefix}.${name}.hint`, "Esc 也会保存", "muted")]
				: [button(`${prefix}.${name}.pencil`, `编辑${LABELS[name]}`, () => startDraft(block.id, name), !canEdit, "ghost")], [
				...(editing ? [draftField(block.id, name)] : view),
				...(notice ? [text(`${prefix}.${name}.notice`, notice, "warning")] : []),
				...inlineError(`${prefix}.${name}`),
			]);
		};

		let draftErrors = 0;
		/** Checks read the design in the changes view, whatever view the person picked (issue #3 decision 8). */
		let checkedDesign: readonly TspNode[] = [];
		if (block.content.kind === "task") {
			const bodyView = block.content.body.trim() ? rendered(`${prefix}.body.view`, block.content.body) : rendered(`${prefix}.body.view`, block.content.body).concat(text(`${prefix}.body.empty`, "（还没有写正文）", "muted"));
			content.push(...bodyView);
			sections.push(textField("body", isOrchestration(block.content) ? "编排代码" : "正文（发给 agent 的 prompt）", bodyView));
		} else {
			const requirementView = block.content.requirement.trim() ? [{ id: `${prefix}.requirement.view`, k: "md", p: { text: block.content.requirement } } satisfies TspNode] : [];
			content.push(...requirementView);
			if (requirementView.length || (item.lock.kind === "human" && item.lock.field === "requirement")) sections.push(textField("requirement", "需求（你写）", requirementView));
			const host = draftHost(block.id);
			const answering = item.lock.kind === "human" && item.lock.field === "prompt" && !finished;
			const drawn = renderDraft(block.content.design, { ...host, askControl: askControl(block.id, canEdit || answering) });
			draftErrors = drawn.diagnostics.filter(found => found.severity === "error").length;
			// The hidden pass draws asks statically: no controls, no events, no selection state.
			checkedDesign = renderDraft(block.content.design, { ...host, context: { ...host.context, svg: (id, _svg, _size, alt) => ({ id, k: "image", p: { alt } }), image: (id, _bytes, _mime, alt) => ({ id, k: "image", p: { alt } }) }, view: () => "changes" }).nodes;
			const history = core.revisions(ref, block.id);
			const state = requestState(view, item, history);
			const writing = item.lock.kind === "human" && item.lock.field === "prompt";
			const promptNotice = notices.get(`${prefix}.prompt`);
			sections.push(box(`${prefix}.design`, "pb-doc", block.content.design.trim() ? drawn.nodes : [text(`${prefix}.design.empty`, "协调者还没有写设计", "muted")]));
			if (drawn.diagnostics.length) sections.push(panel(`${prefix}.diagnostics`, `稿件问题 ${drawn.diagnostics.length}`, [], drawn.diagnostics.map((found, index) => text(`${prefix}.diagnostic.${index}`, `第 ${found.line} 行 · ${found.component} · ${found.message}`, found.severity === "error" ? "error" : "warning"))));
			sections.push(panel(`${prefix}.requests`, "修改要求", [...(state ? [badge(`${prefix}.request.state`, state.text, state.tone)] : []), box(`${prefix}.requests.spacer`, "pb-spacer", []), ...(writing ? [] : [button(`${prefix}.prompt.pencil`, "写修改要求", () => startDraft(block.id, "prompt"), !canEdit, "primary")])], [
				...(writing ? [draftField(block.id, "prompt"), row(`${prefix}.prompt.controls`, [button(`${prefix}.prompt.submit`, "提交给协调者", () => submitPrompt(block.id), false, "primary"), button(`${prefix}.prompt.discard`, "放弃", () => discardDraft(block.id, `${prefix}.prompt`), false, "ghost"), text(`${prefix}.prompt.hint`, "Esc 不会提交", "muted")])] : []),
				...(promptNotice ? [text(`${prefix}.prompt.notice`, promptNotice, "warning")] : []),
				...inlineError(`${prefix}.prompt`),
				...(history.length
					? [...history].reverse().map(revision => box(`${prefix}.revision.${revision.seq}`, "pb-request", [text(`${prefix}.revision.${revision.seq}.meta`, `#${revision.seq} · ${time(revision.at)}`, "muted"), { id: `${prefix}.revision.${revision.seq}.text`, k: "el", p: { tag: "div", class: "pb-request-text", text: revision.prompt } }]))
					: [text(`${prefix}.revisions.empty`, writing ? "" : "还没有提交过修改要求。看完设计后，把要改的地方写给协调者。", "muted")]),
			]));
		}
		item.references.forEach((reference, index) => {
			const id = `${prefix}.reference.${index}`;
			const state = reference.status === "fetching" ? "取回中" : reference.fetchFailed ? "取回失败" : reference.expansion?.kind === "Err" ? "展开失败" : reference.external ? `已取回 ${time(reference.fetchedAt)}` : "已展开";
			const failed = reference.fetchFailed || reference.expansion?.kind === "Err";
			const local = view.blocks.find(other => other.block.id === reference.reference.targetText)?.block.id;
			// Buttons sit in the panel head, outside the collapsible section: a click on a section head toggles it.
			const buttons = [
				...(local ? [button(`${id}.pin`, "设为参考，对照阅读", () => { pinned = local; redraw(); }, false, "ghost")] : []),
				...(reference.external ? [button(`${id}.refetch`, "重新取回", () => { void core.refetch(ref, reference.reference.targetText).then(error => showError(error, id)); }, false, "ghost")] : []),
			];
			const expansion: TspNode = reference.expansion ? { id: `${id}.expansion`, k: "md", p: { text: compileText(reference.expansion) } } : text(`${id}.pending`, "取回中");
			content.push(expansion);
			// A ready expansion repeats content shown elsewhere; failures stay open so they are seen.
			sections.push(panel(id, `引用 ${reference.reference.text} · ${state}`, buttons, [...(failed ? [text(`${id}.failed`, state, "error")] : []), section(`${id}.body`, "展开后的内容", [expansion], `${index}:${reference.reference.text}`, reference.status === "ready" && !failed), ...inlineError(id)]));
		});
		if (view.run) {
			const history = blockHistory(view, block.id);
			sections.push(panel(`${prefix}.history`, `这个块在本次 Run 中的经过 ${history.length}`, [], history.length ? history.map(entry => box(`${prefix}.history.${entry.seq}`, "pb-timeline-entry", [record(`${prefix}.history.${entry.seq}.record`, entry)])) : [text(`${prefix}.history.empty`, "还没有记录", "muted")]));
		}
		if (item.latestRecord) content.push(record(`${prefix}.latest.entry`, item.latestRecord));
		const findings = item.findings ? (Object.entries(item.findings) as [FindingName, boolean][]) : [];
		const report = item.report?.result;
		const failed = findings.filter(([, fails]) => fails).length + (report?.kind === "answers" ? Object.values(report.answers).filter(probability => probability >= 0.5).length : 0);
		const checksHead = !item.findings ? "检查 · 计算中" : failed ? `检查 · ${failed} 项不通过` : report?.kind === "answers" ? "检查 · 全部通过" : "检查 · 自动检查通过，模型未判定";
		const checks = section(`${prefix}.checks`, checksHead, [
			...(item.findings ? findings.map(([name, fails]) => text(`${prefix}.finding.${name}`, `${FINDING_LABELS[name]}：${fails ? "不通过" : "通过"}`, fails ? "error" : "success")) : [text(`${prefix}.finding.pending`, "未判定", "muted")]),
			...(report?.kind === "answers" ? Object.entries(report.answers).map(([name, probability]) => text(`${prefix}.report.${name}`, `模型判定 ${name}：${probability >= 0.5 ? "不通过" : "通过"} · P(yes)=${probability}`, probability >= 0.5 ? "error" : "success")) : [text(`${prefix}.report`, report?.kind === "judge_unavailable" ? "模型判定：模型不可用" : "模型判定：未判定（点“检查”让协调者判定）", "muted")]),
		], `${prefix}.checks`, failed === 0);
		sections.push(...item.notices.map((notice, index) => text(`${prefix}.notice.${index}`, notice, "warning")));
		const deletion = confirmDelete === block.id
			? row(`${prefix}.delete.confirm`, [text(`${prefix}.delete.question`, `删除 ${block.id}？删除后不能在面板里恢复。`, "warning"), button(`${prefix}.delete.yes`, "确认删除", () => { confirmDelete = null; const error = core.deleteBlock(ref, block.id); if (error) return showError(error, `${prefix}.delete`); redraw(); }, false, "danger"), button(`${prefix}.delete.no`, "取消", () => { confirmDelete = null; redraw(); }, false, "ghost")])
			: row(`${prefix}.more`, [button(`${prefix}.delete`, "删除此块…", () => { confirmDelete = block.id; redraw(); }, !unlocked || finished, "ghost")]);
		sections.push(box(`${prefix}.foot`, "pb-foot", [checks, deletion, ...inlineError(`${prefix}.delete`)]));

		const md: string[] = [], images: string[] = [];
		let chartNodes = 0;
		function collect(node: TspNode): void { if (node.k === "md" && typeof node.p?.text === "string") md.push(node.p.text); if (node.k === "image") { chartNodes++; if (typeof node.p?.alt === "string") images.push(node.p.alt); } node.c?.forEach(collect); }
		content.forEach(collect);
		checkedDesign.forEach(collect);
		// Only task bodies hold chartable tables; a design's images are its own drawings.
		if (block.content.kind === "design") chartNodes = 0;
		if (item.lock.kind === "human" && item.lock.field === "body") chartNodes = summaries.get(block.id)?.chartNodes ?? 0;
		summaries.set(block.id, { chartNodes, view: { md, images }, draftErrors });
		return box(`${prefix}.card`, "pb-detail-block", sections);
	}

	// ------------------------------------------------------------ navigation column

	function navItem(view: DocView, item: BlockView, active: boolean): TspNode {
		const block = item.block;
		const id = `nav.${block.id}`;
		actions.set(id, () => { current = { kind: "block", block: block.id }; confirmDelete = null; redraw(); });
		return box(`${id}.row`, "pb-nav-row", [
			check(`${block.id}.selected`, "", selected.has(block.id), false, checked => { if (checked) selected.add(block.id); else selected.delete(block.id); redraw(); }),
			box(id, `pb-nav-item${active ? " pb-nav-active" : ""}`, [
				{ id: `${id}.label`, k: "el", p: { tag: "span", class: "pb-nav-label", text: `${block.id} · ${blockKindLabel(block.content)}` } },
				{ id: `${id}.title`, k: "el", p: { tag: "span", class: "pb-nav-title", text: (item.lock.kind === "human" && item.lock.field === "title" ? item.lock.draft : block.title).trim() || "未命名块" } },
				chipRow(`${id}.chips`, blockChips(view, item)),
			], { actions: { click: "invoke" } }),
		]);
	}
	function selectionBar(view: DocView): TspNode[] {
		const picked = view.blocks.filter(item => selected.has(item.block.id));
		if (!picked.length) return [];
		const ids = picked.map(item => item.block.id);
		const finished = view.run?.status === "finished";
		const design = picked.some(item => item.block.content.kind === "design");
		const mixed = picked.length > 1 && picked.some(item => isOrchestration(item.block.content));
		const reason = design ? "设计块不能启动：在执行块中引用它" : mixed ? "编排块只能单独启动" : null;
		return [box("selection", "pb-select-bar", [
			text("selection.label", `已选 ${ids.join("、")}：下面的按钮作用于这 ${ids.length} 块`, "accent"),
			row("selection.actions", [
				...(view.run ? [button("selection.launch", `一起启动 (${ids.length})`, () => { if (view.run) showError(core.requestLaunch(view.run.id, ids), "selection"); }, finished || reason !== null, "primary")] : []),
				button("selection.preview", "合并预览", () => { void core.preview(ref, ids).then(result => { previews.set("selection", result); current = { kind: "selection" }; redraw(); }); }),
				button("selection.check", `一起检查 (${ids.length})`, () => showError(core.requestCheck(ref, ids), "selection")),
				button("selection.clear", "取消选择", () => { selected.clear(); redraw(); }, false, "ghost"),
			]),
			...(view.run && reason ? [text("selection.reason", reason, "warning")] : []),
			...inlineError("selection"),
		])];
	}
	function nav(view: DocView, hasDraft: boolean): TspNode {
		const finished = view.run?.status === "finished";
		const after = current?.kind === "block" ? current.block : view.blocks.at(-1)?.block.id ?? null;
		const items: TspNode[] = [];
		if (view.run) {
			const run = view.run;
			const due = run.updateDue !== null && run.updateDue <= Date.now();
			actions.set("nav.activity", () => { current = { kind: "activity" }; redraw(); });
			items.push(box("nav.activity", `pb-nav-item${current?.kind === "activity" ? " pb-nav-active" : ""}`, [
				{ id: "nav.activity.title", k: "el", p: { tag: "span", class: "pb-nav-title", text: "Run 记录与时间线" } },
				chipRow("nav.activity.chips", [{ text: `${view.timeline.length} 条`, tone: "neutral" }, ...(due ? [{ text: "状态更新到期", tone: "warning" }] : []), ...(run.status === "finished" && !view.retrospective ? [{ text: "待写复盘", tone: "warning" }] : [])]),
			], { actions: { click: "invoke" } }));
			items.push(box("nav.sep", "pb-nav-sep", []));
		}
		items.push(...view.blocks.map(item => navItem(view, item, current?.kind === "block" && current.block === item.block.id)));
		items.push(box("nav.sep2", "pb-nav-sep", []));
		items.push(row("nav.insert", [
			button("block.insert.task", "+ 执行块", () => insertAndEdit(after, "task", "nav.insert"), finished || hasDraft, "ghost"),
			button("block.insert.design", "+ 设计块", () => insertAndEdit(after, "design", "nav.insert"), finished || hasDraft, "ghost"),
		]));
		items.push(...inlineError("nav.insert"));
		// Below the list, so picking a block never moves the rows above it.
		items.push(...selectionBar(view));
		return box("nav", "pb-nav", items);
	}

	// ------------------------------------------------------------ Run activity and top bar

	function activity(view: DocView): TspNode[] {
		const run = view.run!;
		if (!postKindChosen) postKind = run.status === "finished" && !view.retrospective ? "retrospective" : "update";
		const kinds: readonly RecordKind[] = run.status === "finished" ? ["update", "result", "failure", "retrospective"] : ["update", "result", "failure"];
		const titles = new Map<string, string>(view.blocks.map(item => [item.block.id, item.block.title.trim()]));
		const retrospective = postKind === "retrospective";
		const counts = new Map<EntryData["type"], number>();
		for (const entry of view.timeline) counts.set(entry.data.type, (counts.get(entry.data.type) ?? 0) + 1);
		const shown = view.timeline.filter(entry => filter === "all" || entry.data.type === filter);
		return [
			{ id: "activity.title", k: "el", p: { tag: "h2", class: "pb-block-title", text: "Run 记录与时间线" } },
			panel("post", retrospective ? "写复盘" : "写记录", [], [
				labeled("post.kind", "类别", choices("post.kind", kinds, postKind, kind => { postKind = kind; postKindChosen = true; }, false, kind => RECORD_LABELS[kind]), true),
				labeled("post.block", "关联块", choices("post.block", ["none", ...view.blocks.map(item => item.block.id)], postBlock ?? "none", value => { postBlock = view.blocks.find(item => item.block.id === value)?.block.id ?? null; }, false, value => value === "none" ? "不关联块" : `${value}${titles.get(value) ? ` · ${titles.get(value)}` : ""}`), true),
				labeled("post.text", retrospective ? "复盘内容" : "正文", formField("post.text", () => postText, value => { postText = value; }, retrospective ? "结果、问题与改进" : "记录正文", true), true),
				...(postKind === "update" ? [labeled("post.next", "下次更新间隔（秒，可选）", formField("post.next", () => postNext, value => { postNext = value; }, "留空沿用 Run 的间隔"))] : []),
				button("post.submit", retrospective ? "写复盘" : "写记录", () => {
					const next = postKind === "update" ? seconds(postNext) : null;
					if (next === undefined) return showError("下次更新时间必须是正整数秒", "post.submit");
					const error = core.post(run.id, postKind, postText, postBlock, next);
					if (error) return showError(error, "post.submit");
					postText = ""; postNext = "";
					for (const id of ["post.text", "post.next"]) { undo.delete(id); carets.delete(id); }
					redraw();
				}, false, "primary"),
				...inlineError("post.submit"),
			]),
			panel("timeline", `时间线 ${shown.length}/${view.timeline.length}`, [], [
				choices("timeline.filter", ["all", ...TYPES.filter(type => counts.has(type) || type === filter)], filter, value => { filter = value; }, false, value => `${TYPE_LABELS[value]} ${value === "all" ? view.timeline.length : counts.get(value) ?? 0}`),
				...Array.from(info, ([id, launch]) => section(`launch-info.${id}`, `${id} 完整记录`, [
					row(`launch-info.${id}.bar`, [
						badge(`launch-info.${id}.state`, launch.closed ? `已关闭 · ${launch.closed.by}` : "未关闭", launch.closed ? "neutral" : "accent"),
						text(`launch-info.${id}.meta`, `块 ${launch.blocks.join("、")} · ${launch.kind === "orchestration" ? "编排" : "执行"} · agents ${launch.agents.join(", ") || "无"} · 基线 ${launch.baselines.length} 个`, "muted"),
						button(`launch-info.${id}.hide`, "收起", () => { info.delete(id); redraw(); }, false, "ghost"),
					]),
					{ id: `launch-info.${id}.text`, k: "code", p: { text: JSON.stringify(launch, null, 2), lang: "json", wrap: true } },
				])),
				...(shown.length ? [...shown].reverse().map(entry => {
					const data = entry.data;
					return box(`timeline.${entry.seq}`, "pb-timeline-entry", [record(`timeline.${entry.seq}.record`, entry), ...(data.type === "launch_created" ? [button(`timeline.${entry.seq}.launch`, info.has(data.launch) ? `收起 ${data.launch} 完整记录` : `打开 ${data.launch} 完整记录`, () => {
						if (info.has(data.launch)) info.delete(data.launch);
						else { const launch = core.launchInfo(data.launch); if (launch) info.set(data.launch, launch); }
						redraw();
					}, false, "ghost")] : [])]);
				}) : [text("timeline.empty", view.timeline.length ? `没有「${TYPE_LABELS[filter]}」类记录` : "时间线还是空的", "muted")]),
			]),
		];
	}
	function topBar(view: DocView, runs: readonly RunSummary[]): TspNode {
		const coordinator = core.coordinator();
		const errors = [...core.errors(), ...view.errors, ...(renderError ? [renderError] : []), ...(actionError ? [actionError.message] : [])];
		const rows: TspNode[] = [
			{ id: "tabs", k: "tabs", p: { min: { h: "2lines" }, shrink: 0, items: [{ id: "template", label: "模板" }, ...runs.map(run => ({ id: run.id, label: `${run.name}${run.status === "finished" ? " · 已结束" : ""}` }))], active: ref.kind === "template" ? "template" : ref.run } },
			box("top.main", "pb-top-row", [
				{ id: "heading", k: "el", p: { tag: "h1", class: "pb-title", text: view.run?.name ?? view.title } },
				badge("coordinator.badge", coordinator.connected ? "协调者在线" : "协调者离线", coordinator.connected ? "success" : "warning"),
				...(coordinator.connected && coordinator.pane ? [button("coordinator.focus", "转到协调者", () => { void core.focusCoordinator().then(error => showError(error)); }, false, "ghost")] : []),
				...(!coordinator.connected ? [text("coordinator.status", "没有协调者连接：修改要求、启动和检查请求会被拒绝", "muted")] : []),
			]),
		];
		if (!view.run) {
			rows.push(box("start-run.form", "pb-top-row", [
				formField("run.name", () => runName, value => { runName = value; }, "新 Run 名称"),
				formField("run.every", () => runEvery, value => { runEvery = value; }, "状态更新间隔（秒，可选）"),
				button("run.start", "开始 Run", startRun, false, "primary"),
				...inlineError("run.start"),
			]));
		} else {
			const run = view.run;
			const done = view.blocks.filter(item => item.block.done).length;
			const running = view.blocks.filter(item => rootLaunches(view, item).length).length;
			const overdue = run.updateDue !== null && run.updateDue <= Date.now();
			rows.push(box("run.bar", "pb-top-row", [
				badge("run.badge", run.status === "running" ? "进行中" : "已结束", run.status === "running" ? "accent" : "neutral"),
				badge("run.progress", `完成 ${done}/${view.blocks.length}`, view.blocks.length > 0 && done === view.blocks.length ? "success" : "neutral"),
				...(running ? [badge("run.running", `未关闭 Launch 的块 ${running}`, "accent")] : []),
				text("run.status", `开始 ${time(run.startedAt)}${run.finishedAt === null ? "" : ` · 结束 ${time(run.finishedAt)}`}`, "muted"),
				box("run.spacer", "pb-spacer", []),
				button("run.finish", "结束 Run", () => {
					const error = core.finishRun(run.id);
					if (error) return showError(error, "run.finish");
					if (!view.retrospective) resetRecordForm();
					current = { kind: "activity" };
				}, run.status === "finished", "danger"),
				...inlineError("run.finish"),
			]));
			if (run.updateDue !== null) rows.push(box("run.due", "pb-top-row", [
				text("run.due.time", `${overdue ? "状态更新已到期" : "下次状态更新"}：${time(run.updateDue)}`, overdue ? "warning" : "muted"),
				...(overdue ? [button("run.due.write", "写状态更新", () => { current = { kind: "activity" }; postKind = "update"; postKindChosen = true; redraw(); }, false, "primary")] : []),
				choices("run.snooze.duration", ["300", "900", "3600", "86400"], String(snoozeAfter), value => { snoozeAfter = Number(value); }, run.status === "finished", value => SNOOZE_LABELS[value] ?? value),
				button("run.snooze", "推迟提醒", () => showError(core.snooze(run.id, snoozeAfter), "run.snooze"), run.status === "finished"),
				...inlineError("run.snooze"),
			]));
		}
		if (errors.length) rows.push(row("errors", [...errors.map((error, index) => text(`error.${index}`, error, "error")), ...(renderError || actionError ? [button("error.dismiss", "关闭提示", () => { renderError = null; actionError = null; redraw(); }, false, "ghost")] : [])]));
		return box("top", "pb-top", rows);
	}
	function commit(block: BlockId): void {
		const lock = core.view(ref).blocks.find(item => item.block.id === block)?.lock;
		const fieldId = lock?.kind === "human" ? `${block}.${lock.field}` : null;
		const error = core.commit(ref, block);
		if (error) return showError(error, fieldId);
		committed = fieldId;
		focus = null;
		redraw();
	}
	function switchView(next: DocRef): void {
		ref = next; selected.clear(); previews.clear(); info.clear(); summaries.clear(); focus = null; actionError = null; current = null; confirmDelete = null; pinned = null;
		postText = ""; postNext = ""; postBlock = null; postKindChosen = false; filter = "all";
		redraw();
	}
	function startRun(): void {
		const every = seconds(runEvery);
		if (every === undefined) return showError("更新间隔必须是正整数秒", "run.start");
		const before = new Set(core.runs().map(run => run.id));
		const error = core.startRun(runName, every);
		if (error) return showError(error, "run.start");
		runName = ""; runEvery = "";
		for (const id of ["run.name", "run.every"]) { carets.delete(id); undo.delete(id); }
		const created = core.runs().find(run => !before.has(run.id));
		if (created) switchView({ kind: "run", run: created.id });
		else redraw();
	}
	function root(view: DocView): TspNode {
		actions.clear(); changes.clear(); fields.clear();
		const runs = core.runs();
		if (core.coordinator().connected && actionError?.needsCoordinator) actionError = null;
		const present = new Set(view.blocks.map(item => item.block.id));
		for (const id of selected) if (!present.has(id)) selected.delete(id);
		if (pinned !== null && !present.has(pinned)) pinned = null;
		// Keep the shown block, or the first one; a draft does not hold the view, its editor stays with its block.
		if (current?.kind === "block" && !present.has(current.block)) current = null;
		if (current?.kind === "activity" && !view.run) current = null;
		if (current?.kind === "selection" && !previews.has("selection")) current = null;
		current ??= view.blocks[0] ? { kind: "block", block: view.blocks[0].block.id } : view.run ? { kind: "activity" } : null;
		const hasDraft = anyDraft();
		// The record form follows a Run that finishes while shown: once, and before the form is drawn.
		if (view.run) {
			if (runStatus.get(view.run.id) === "running" && view.run.status === "finished" && !view.retrospective) resetRecordForm();
			runStatus.set(view.run.id, view.run.status);
		}
		// Every block is drawn for its render status; only the shown one is mounted.
		const details = new Map(view.blocks.map(item => [item.block.id, blockDetail(view, item, hasDraft)] as const));
		for (const id of fields.keys()) if (!(current?.kind === "block" && id.startsWith(`${current.block}.`)) && !id.startsWith("run.") && !id.startsWith("post.")) fields.delete(id);
		let detail: TspNode[];
		if (current?.kind === "block") detail = [details.get(current.block)!];
		else if (current?.kind === "activity") detail = activity(view);
		else if (current?.kind === "selection") {
			const preview = previews.get("selection")!;
			detail = [{ id: "selection.title", k: "el", p: { tag: "h2", class: "pb-block-title", text: "已选块合并后发给 agent 的内容" } }, row("selection.preview.bar", [text("selection.preview.length", preview.kind === "Ok" ? `${preview.text.length} 字符` : "编译失败", preview.kind === "Ok" ? "muted" : "error"), button("selection.preview.close", "收起", () => { previews.delete("selection"); current = null; redraw(); }, false, "ghost")]), { id: "selection.preview.text", k: "code", p: { text: compileText(preview), lang: "text", wrap: true } }];
		} else detail = [box("empty", "pb-empty", [text("empty.text", "这份 Playbook 还没有块。在左侧新建执行块或设计块。", "muted")])];
		return col("main", [box("app", "pb-app", [topBar(view, runs), box("body", "pb-body", [nav(view, hasDraft), box("detail", "pb-detail", detail)])])]);
	}
	/**
	 * Summaries are drawn for every block on every redraw, so they are exact for all of them. Frame facts
	 * (`blockError`, `pendingOverdue`) come from `tsp.status`, which only frames that mounted a block update:
	 * a block that is not shown keeps the facts of the last frame that mounted it.
	 */
	function reportStatus(blocks: readonly string[]): void {
		const view = core.view(ref);
		for (const item of view.blocks) if (blocks.includes(item.block.id)) {
			const summary = summaries.get(item.block.id);
			if (summary) core.setRenderStatus(ref, item.block.id, { ...tsp.status(item.block.id), ...summary });
		}
	}
	function redraw(): void {
		if (!opened) return;
		const view = core.view(ref);
		const node = root(view);
		if (focus && !fields.has(focus)) focus = null;
		const ops: FrameOp[] = [...(mounted ? [["del", "main"] as const] : []), ["add", "main", SURFACE, null, node], ["focus", focus]];
		const s = tsp.frame(ops, current?.kind === "block" ? [current.block] : []);
		mounted = true;
		tsp.fullRedraw(s);
		reportStatus(view.blocks.map(item => item.block.id));
	}
	function updateField(id: string): void {
		const value = fields.get(id);
		if (!value) return;
		const caret = carets.get(id)!;
		const block = core.view(ref).blocks.find(item => id === `${item.block.id}.title` || id === `${item.block.id}.body`)?.block.id;
		tsp.frame([["set", id, { text: value.text(), cursor: caret.cursor, anchor: caret.anchor }]], block ? [block] : []);
		if (block) reportStatus([block]);
	}
	function applyText(id: string, next: string, cursor: number, anchor: number | null = null, remember = true): void {
		const value = fields.get(id);
		if (!value) return;
		const before = value.text();
		if (next !== before) {
			const error = value.write(next);
			if (error) return showError(error, id);
			if (remember) { const history = undo.get(id) ?? []; history.push({ text: before, ...(carets.get(id) ?? { cursor: before.length, anchor: null }) }); undo.set(id, history); }
		}
		carets.set(id, { cursor: Math.max(0, Math.min(next.length, cursor)), anchor });
		// Changing the text answers the refusal shown for this field.
		if (next !== before && actionError?.anchor === id) { actionError = null; redraw(); return; }
		updateField(id);
	}
	/** contracts.md K4 错误: input for a field that was committed before the input arrived is shown, never silently dropped. */
	function late(id: string): void {
		notices.set(id, "一次输入因文本已变化未应用");
		redraw();
	}
	function edit(event: Extract<TspEvent, { ev: "edit" }>): void {
		const value = fields.get(event.id);
		if (!value) {
			if (event.id === committed) late(event.id);
			return;
		}
		const currentText = value.text();
		if (event.len !== currentText.length) { notices.set(event.id, "一次输入因文本已变化未应用"); redraw(); return; }
		applyText(event.id, currentText.slice(0, event.from) + event.text + currentText.slice(event.to), event.cursor);
	}
	let keyBuffer = "";
	// A pty read can contain several keys (including text followed immediately by Esc).
	// Only incomplete CSI/paste sequences survive into the next read.
	function keys(bytes: string): void {
		keyBuffer += bytes;
		while (keyBuffer.length) {
			if (keyBuffer.startsWith(`${ESC}[200~`)) {
				const end = keyBuffer.indexOf(`${ESC}[201~`, 6);
				if (end < 0) return;
				key(keyBuffer.slice(0, end + 6)); keyBuffer = keyBuffer.slice(end + 6); continue;
			}
			if (keyBuffer.startsWith(`${ESC}[`)) {
				const sequence = /^\x1b\[[0-9:;?]*[A-Za-z~]/.exec(keyBuffer)?.[0];
				if (!sequence) return;
				key(sequence); keyBuffer = keyBuffer.slice(sequence.length); continue;
			}
			if (keyBuffer[0] === ESC || keyBuffer.charCodeAt(0) < 32 || keyBuffer.charCodeAt(0) === 127) {
				key(keyBuffer[0]!); keyBuffer = keyBuffer.slice(1); continue;
			}
			const plain = /^[^\x00-\x1f\x7f]+/.exec(keyBuffer)![0];
			key(plain); keyBuffer = keyBuffer.slice(plain.length);
		}
	}
	function key(bytes: string): void {
		const kitty = /^\x1b\[(\d+)(?:;(\d+)(?::(\d+))?)?u$/.exec(bytes);
		if (kitty) {
			if (kitty[3] === "3") return; // Key release is not a second edit.
			const code = Number(kitty[1]), modifiers = Number(kitty[2] ?? 1) - 1;
			if (modifiers > 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return;
			bytes = code === 13 ? "\r" : String.fromCodePoint(code);
		}
		if (bytes === ESC || bytes === "\x1b[27u") {
			// Esc finishes a field edit; a change request is only sent by its button.
			const editing = core.view(ref).blocks.find(item => item.lock.kind === "human");
			if (editing && !(editing.lock.kind === "human" && editing.lock.field === "prompt")) commit(editing.block.id);
			return;
		}
		const value = focus === null ? undefined : fields.get(focus);
		if (focus === null || !value) {
			const changesText = bytes === "\x7f" || bytes === "\b" || bytes === `${ESC}[3~` || bytes.startsWith(`${ESC}[200~`) || !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(bytes);
			if (committed !== null && changesText) late(committed);
			return;
		}
		const currentText = value.text();
		const caret = carets.get(focus) ?? { cursor: currentText.length, anchor: null };
		let cursor = caret.cursor;
		let from = caret.anchor === null ? cursor : Math.min(cursor, caret.anchor);
		let to = caret.anchor === null ? cursor : Math.max(cursor, caret.anchor);
		let insertion: string | null = null;
		if (bytes === "\x7f" || bytes === "\b") { if (from === to) from = previous(currentText, from); insertion = ""; }
		else if (bytes === `${ESC}[3~`) { if (from === to) to = following(currentText, to); insertion = ""; }
		else if (bytes === `${ESC}[D`) cursor = caret.anchor === null ? previous(currentText, cursor) : from;
		else if (bytes === `${ESC}[C`) cursor = caret.anchor === null ? following(currentText, cursor) : to;
		else if (bytes === `${ESC}[H` || bytes === "\x01") cursor = currentText.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
		else if (bytes === `${ESC}[F` || bytes === "\x05") { const end = currentText.indexOf("\n", cursor); cursor = end < 0 ? currentText.length : end; }
		else if (bytes === "\x1a") { undoField(focus); return; }
		else if (bytes.startsWith(`${ESC}[200~`) && bytes.endsWith(`${ESC}[201~`)) insertion = bytes.slice(6, -6).replace(/\r\n?/g, "\n");
		else if (!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(bytes)) insertion = bytes.replace(/\r\n?/g, "\n");
		else return;
		if (insertion !== null) {
			if (!value.multiline && insertion.includes("\n")) return;
			applyText(focus, currentText.slice(0, from) + insertion + currentText.slice(to), from + insertion.length);
		} else applyText(focus, currentText, cursor);
	}
	function undoField(id: string): void { const step = undo.get(id)?.pop(); if (step) applyText(id, step.text, step.cursor, step.anchor, false); }
	function event(input: TspEvent): void {
		switch (input.ev) {
			case "action": {
				const handler = input.act === "invoke" ? actions.get(input.id) : undefined;
				// A new action replaces the previous action's refusal.
				if (handler) { actionError = null; handler(); redraw(); }
				break;
			}
			case "change": {
				const handler = changes.get(input.id);
				if (handler) { actionError = null; handler(input); redraw(); }
				break;
			}
			case "edit": edit(input); break;
			case "undo": undoField(input.id); break;
			case "focus": if (fields.has(input.id)) { focus = input.id; committed = null; tsp.frame([["focus", focus]], []); } break;
			case "theme": void setTheme(input.dark ? "dark" : "light").then(result => { if (!result.success) renderError = result.error ?? "主题切换失败"; redraw(); }); break;
			case "error": if (input.s === undefined) { renderError = input.msg ?? "Tern 渲染错误"; redraw(); } break;
			case "ack": case "toggle": break;
			case "other": {
				const body = input.body;
				if (typeof body !== "object" || body === null || !("ev" in body) || body.ev !== "select" || !("id" in body) || body.id !== "tabs" || !("item" in body) || typeof body.item !== "string") break;
				if (body.item === "template") switchView({ kind: "template" });
				else { const run = parseRunId(body.item); if (run && core.runs().some(candidate => candidate.id === run)) switchView({ kind: "run", run }); }
				break;
			}
		}
	}
	function input(value: TspInput): void {
		switch (value.kind) {
			case "hello": void setTheme(value.dark ? "dark" : "light").then(result => {
				if (!result.success) renderError = result.error ?? "主题初始化失败";
				if (!opened) { tsp.open(SURFACE, "Playbooks", SURFACE_CSS); opened = true; }
				redraw();
			}); break;
			case "event": event(value.event); break;
			case "keys": keys(value.bytes); break;
		}
	}
	core.onChange(() => {
		// Core is the source of Launch records; an opened record is re-read on every change.
		for (const id of [...info.keys()]) {
			const fresh = core.launchInfo(id);
			if (fresh) info.set(id, fresh); else info.delete(id);
		}
		queueMicrotask(redraw);
	});
	tsp.onStatusChange(reportStatus);
	tsp.start("omp-playbooks", input);
}

function seconds(value: string): number | null | undefined {
	if (value.trim() === "") return null;
	if (!/^[1-9][0-9]*$/.test(value.trim())) return undefined;
	const number = Number(value);
	return Number.isSafeInteger(number) ? number : undefined;
}
function previous(text: string, offset: number): number { if (offset <= 0) return 0; const last = text.charCodeAt(offset - 1); return offset > 1 && last >= 0xdc00 && last <= 0xdfff ? offset - 2 : offset - 1; }
function following(text: string, offset: number): number { if (offset >= text.length) return text.length; const first = text.charCodeAt(offset); return first >= 0xd800 && first <= 0xdbff ? offset + 2 : offset + 1; }
