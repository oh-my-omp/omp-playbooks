import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { prepareSvg } from "@oh-my-pi/pi-tui/chat/svg-source";
import { svgFigurePalette } from "@oh-my-pi/pi-tui/chat/svg-figure";
import { lookupTableChart, setTableCharts, splitTableCharts } from "@oh-my-pi/pi-tui/chat/table-chart";
import { initThemeSync, setTheme } from "@oh-my-pi/pi-tui/theme/theme";
import type { BlockContent, BlockId, CompileError, CompileResult, DocRef, EntryData, EventName, FindingName, HumanField, Launch, LaunchId, RecordKind, RunId, RunStatus, Source, TimelineEntry } from "../domain/model";
import { fieldText, parseRunId } from "../domain/model";
import type { BlockView, CoreApi, DocView, RenderStatus } from "../domain/ports";
import { separateTableReferences } from "./checks";
import { isOrchestration } from "./core";
import { renderDraft, type DraftHost } from "./draft/components";
import type { AskSpec } from "./draft/ask";
import type { ChangeView, FileRead } from "./draft/contract";
import type { FrameOp, TspEvent, TspInput, TspNode, TspSession } from "./tsp-types";

const SURFACE = "playbook";
const ESC = "\x1b";
const TYPES: readonly EntryData["type"][] = ["run_started", "run_finished", "block_edited", "block_added", "block_deleted", "content_replaced", "blocks_reordered", "done_changed", "launch_created", "agent_bound", "launch_closed", "event_sent", "interrupted", "check_reported", "post", "update_due", "update_snoozed"];
const LABELS: Readonly<Record<HumanField, string>> = { title: "标题", body: "正文", requirement: "需求", prompt: "修改 prompt" };
const FIELD_LABELS: Readonly<Record<"title" | "body" | "requirement" | "design", string>> = { title: "标题", body: "正文", requirement: "需求", design: "设计稿" };
const RECORD_LABELS: Readonly<Record<RecordKind, string>> = { update: "状态更新", result: "执行结果", failure: "执行失败", retrospective: "复盘" };
const SNOOZE_LABELS: Readonly<Record<string, string>> = { "300": "5 分钟", "900": "15 分钟", "3600": "1 小时", "86400": "1 天" };
const FINDING_LABELS: Readonly<Record<FindingName, string>> = {
	compile: "编译 (compile)",
	empty_expansion: "引用非空 (empty_expansion)",
	render_error: "渲染错误 (render_error)",
	render_pending: "渲染响应 (render_pending)",
	chart: "表格图表 (chart)",
	draft: "设计稿语法 (draft)",
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
	revision_requested: "提交修改请求",
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
/** SVG user units per terminal column (16 per row on 1:2 cells), as pi-tui sizes its native chart images. */
const UNITS_PER_COLUMN = 8;

/** TSP sheets reach only descendants of the region root, so every rule targets the `shell` wrapper or nodes inside it. */
const SURFACE_CSS = [
	".pb-shell { display: flex; flex-direction: column; gap: 14px; padding: 14px 18px 28px; max-width: 1360px; width: 100%; box-sizing: border-box; }",
	".pb-header { display: flex; flex-direction: column; gap: 8px; padding: 12px 16px; border-radius: 8px; background: var(--panel, var(--l1)); border: 1px solid var(--l2); }",
	".pb-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 6px; background: var(--well, var(--l1)); border: 1px solid var(--l2); }",
	".pb-form-row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px; }",
	".pb-field { display: flex; flex-direction: column; gap: 4px; width: 300px; max-width: 100%; }",
	".pb-form-row > .pb-field { flex: 1 1 240px; min-width: 200px; max-width: 360px; }",
	".pb-field-wide { display: flex; flex-direction: column; gap: 4px; width: 100%; max-width: 920px; }",
	".pb-button { display: inline-flex; align-items: center; justify-content: center; align-self: flex-start; width: auto; padding: 4px 11px; border-radius: 6px; border: 1px solid var(--l3, var(--l2)); background: var(--raise, var(--l1)); color: var(--t1); font-weight: 500; cursor: pointer; }",
	".pb-button-primary { background: rgb(from var(--accent) r g b / 16%); border-color: rgb(from var(--accent) r g b / 45%); color: var(--accent-ink, var(--accent)); font-weight: 600; }",
	".pb-button-danger { background: color-mix(in srgb, var(--bad) 14%, transparent); border-color: color-mix(in srgb, var(--bad) 45%, var(--l2)); color: var(--bad); }",
	".pb-button-ghost { background: transparent; border-color: var(--l2); color: var(--t2); padding: 3px 9px; }",
	".pb-disabled { opacity: .42; cursor: default; }",
	".pb-choice { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: 6px; border: 1px solid var(--l2); background: var(--card, transparent); cursor: pointer; align-self: flex-start; }",
	".pb-choice-checked { border-color: rgb(from var(--accent) r g b / 45%); background: rgb(from var(--accent) r g b / 10%); color: var(--accent-ink, var(--t1)); }",
	".pb-choice-disabled { opacity: .45; cursor: default; }",
	".pb-run-item { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 12px; border-radius: 6px; border: 1px solid var(--l2); background: var(--card, var(--l1)); }",
	".pb-timeline-entry { display: flex; flex-direction: column; gap: 4px; padding: 8px 12px; border-radius: 6px; border: 1px solid var(--l2); background: var(--card, transparent); }",
	".sf-row.al-start > .sf-card { align-self: flex-start; }",
].join("\n");

type ButtonKind = "default" | "primary" | "danger" | "ghost";
type Caret = { cursor: number; anchor: number | null };
type UndoStep = Caret & { text: string };
type Field = { readonly multiline: boolean; text(): string; write(text: string): string | null };
type Summary = Pick<RenderStatus, "chartNodes" | "view" | "draftErrors">;
/** A refused human action, shown at the control that caused it until the next action. */
type ActionError = { readonly message: string; readonly anchor: string | null; readonly needsCoordinator: boolean };

const text = (id: string, value: string, tone?: string): TspNode => ({ id, k: "text", p: { text: value, ...(tone ? { tone } : {}) } });
const badge = (id: string, value: string, tone?: string): TspNode => ({ id, k: "badge", p: { text: value, ...(tone ? { tone } : {}) } });
const col = (id: string, c: readonly TspNode[]): TspNode => ({ id, k: "col", p: { gap: "sm" }, c });
const row = (id: string, c: readonly TspNode[]): TspNode => ({ id, k: "row", p: { gap: "sm", wrap: true, align: "center" }, c });
const box = (id: string, className: string, c: readonly TspNode[]): TspNode => ({ id, k: "el", p: { tag: "div", class: className }, c });
const time = (at: number | null): string => at === null ? "无" : `${new Date(at).toISOString().slice(0, 19).replace("T", " ")} UTC`;

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
		case "event_sent": return `通知协调者：${EVENT_LABELS[data.event]} (${data.event})`;
		case "interrupted": return `打断协调者在块 ${data.block} 上的编辑`;
		case "check_reported": return `记录块 ${data.blocks.join("、")} 的检查报告`;
		case "update_due": return `状态更新到期（${time(data.due)}）`;
		case "update_snoozed": return `状态更新提醒推迟到 ${time(data.due)}`;
	}
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
	/**
	 * The person's pick for each drawn `ask`, by block and fence line; UI state only. It starts at the
	 * suggested options and starts over when the ask's question, mode or option labels change.
	 */
	const asks = new Map<BlockId, Map<string, { signature: string; selected: string[] }>>();
	/** Cards showing only their state row, title and notices; UI state only. */
	const collapsed = new Set<BlockId>();
	const sentBlobs = new Set<string>();

	function imageNode(id: string, bytes: Uint8Array, mime: string, alt: string, size?: { readonly w: number; readonly h: number }): TspNode {
		const blob = createHash("sha256").update(bytes).digest("hex");
		if (!sentBlobs.has(blob)) { tsp.blob(blob, mime, bytes); sentBlobs.add(blob); }
		return { id, k: "image", p: { blob, alt, ...(size ? { w: size.w, h: size.h, max: { w: `${Math.max(1, Math.round(size.w / UNITS_PER_COLUMN))}ch` } } : {}) } };
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
			viewSwitch: (id, key, current) => row(id, VIEWS.map(option => check(`${id}.${option.view}`, option.label, current === option.view, false, checked => { if (checked) { views.set(`${block}.${key}`, option.view); redraw(); } }, id, option.view))),
		};
	}
	function startDraft(block: BlockId, name: HumanField): void {
		const error = core.pencil(ref, block, name);
		if (error) return showError(error, `${block}.${name}`);
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
		}, write: draft => core.setDraft(ref, block, draft) }, name === "prompt" ? "写给协调者的修改要求：哪里、改成什么" : `${block} ${LABELS[name]}`);
	}
	/** Option inputs and the submit button of an ask in `block`'s visible draft. */
	function askControl(block: BlockId, canEdit: boolean): NonNullable<DraftHost["askControl"]> {
		return (id, key, spec) => {
			const signature = JSON.stringify([spec.question, spec.mode, spec.options.map(option => option.label)]);
			const byKey = asks.get(block) ?? new Map<string, { signature: string; selected: string[] }>();
			asks.set(block, byKey);
			let choice = byKey.get(key);
			if (choice?.signature !== signature) {
				choice = { signature, selected: spec.options.filter(option => option.suggested).map(option => option.label) };
				byKey.set(key, choice);
			}
			const state = choice;
			const options = spec.options.map((option, index) => check(
				`${id}.${index}`,
				`${option.label}${option.suggested ? " · 建议" : ""}${option.note ? ` — ${option.note}` : ""}`,
				state.selected.includes(option.label),
				!canEdit,
				checked => {
					if (spec.mode === "single") { if (checked) state.selected = [option.label]; }
					else state.selected = spec.options.map(other => other.label).filter(label => label === option.label ? checked : state.selected.includes(label));
					redraw();
				},
				spec.mode === "single" ? id : undefined,
				option.label,
			));
			return [col(`${id}.options`, options), button(`${id}.submit`, "提交选择", () => submitAsk(block, spec, state.selected), !canEdit || state.selected.length === 0, "primary")];
		};
	}
	/** An ask's choice goes to the coordinator as a change request; refused, the text stays in the block's prompt draft. */
	function submitAsk(block: BlockId, spec: AskSpec, selected: readonly string[]): void {
		const started = core.pencil(ref, block, "prompt");
		if (started) return showError(started, `${block}.prompt`);
		focus = `${block}.prompt`; committed = null;
		carets.delete(focus); undo.delete(focus); notices.delete(focus);
		const drafted = core.setDraft(ref, block, `针对问题「${spec.question}」，选择：${selected.join("、")}`);
		if (drafted) return showError(drafted, `${block}.prompt`);
		submitPrompt(block);
	}
	function submitPrompt(block: BlockId): void {
		const error = core.commit(ref, block);
		if (error) return showError(error, `${block}.prompt`);
		// Input that arrives for the submitted editor is late and is shown, as for committed fields.
		committed = `${block}.prompt`;
		focus = null;
		redraw();
	}
	/** Insert a block, then open its title editor: the new id is read back from Core, never guessed. */
	function insertAndEdit(after: BlockId | null, kind: BlockContent["kind"], anchor: string): void {
		const before = new Set(core.view(ref).blocks.map(item => item.block.id));
		const error = core.insertBlock(ref, after, kind);
		if (error) return showError(error, anchor);
		const created = core.view(ref).blocks.find(item => !before.has(item.block.id));
		if (created && !anyDraft()) startDraft(created.block.id, "title");
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
	function choices<T extends string>(id: string, values: readonly T[], current: T, change: (value: T) => void, disabled = false, labelOf: (value: T) => string = value => value): TspNode {
		return row(id, values.map(value => check(`${id}.${value}`, labelOf(value), current === value, disabled, checked => { if (checked) { change(value); redraw(); } }, id, value)));
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
	function rendered(id: string, body: string): TspNode[] {
		return splitTableCharts(separateTableReferences(body), false).flatMap((segment, index): TspNode[] => {
			const nodeId = `${id}.${index}`;
			if (segment.kind === "markdown") return [{ id: nodeId, k: "md", p: { text: segment.text } }];
			const chart = lookupTableChart(segment.table);
			if (!chart || chart instanceof Promise) throw new Error("always-mode chart lookup did not return a chart");
			return [imageNode(nodeId, new TextEncoder().encode(prepareSvg(chart, svgFigurePalette())), "image/svg+xml", "表格图表")];
		});
	}
	function selectedBlocks(view: DocView, fallback: BlockId): BlockId[] {
		const ids = view.blocks.filter(item => selected.has(item.block.id)).map(item => item.block.id);
		return ids.length ? ids : [fallback];
	}
	function record(id: string, entry: TimelineEntry): TspNode {
		const data = entry.data;
		const meta = text(`${id}.meta`, `#${entry.seq} · ${time(entry.at)} · ${TYPE_LABELS[data.type]} · 来源：${ORIGIN_LABELS[entry.origin]}`, "muted");
		if (data.type !== "post") return col(id, [meta, text(`${id}.content`, describeEntry(data))]);
		const head = [`**${RECORD_LABELS[data.kind]}**`, ...(data.block ? [`关联块 ${data.block}`] : []), ...(data.launch ? [`Launch ${data.launch}`] : [])].join(" · ");
		return col(id, [meta, { id: `${id}.content`, k: "md", p: { text: `${head}\n\n${data.text}` } }, ...(data.quote ? [text(`${id}.quote`, `取自会话 ${data.session ?? "未提供"} 的消息 ${data.quote}`, "muted")] : [])]);
	}
	function blockCard(view: DocView, item: BlockView, hasDraft: boolean): TspNode {
		const block = item.block;
		const prefix = block.id;
		const finished = view.run?.status === "finished";
		const unlocked = item.lock.kind === "none";
		const canEdit = unlocked && !hasDraft && !finished;
		const targets = selectedBlocks(view, block.id);
		const mixed = targets.length > 1 && view.blocks.some(other => targets.includes(other.block.id) && isOrchestration(other.block.content));
		const designSelected = view.blocks.some(other => targets.includes(other.block.id) && other.block.content.kind === "design");
		const folded = collapsed.has(block.id);
		const contract = block.content.kind === "task" ? block.content : null;
		const c: TspNode[] = [row(`${prefix}.state`, [
			check(`${prefix}.selected`, "选择", selected.has(block.id), false, checked => { if (checked) selected.add(block.id); else selected.delete(block.id); redraw(); }),
			check(`${prefix}.done`, "已完成", block.done, !unlocked || finished, done => { showError(core.setDone(ref, block.id, done), `${prefix}.state`); }),
			text(`${prefix}.lock`, item.lock.kind === "coordinator" ? "协调者正在编辑" : item.lock.kind === "human" ? "人正在编辑" : "块锁：无", item.lock.kind === "coordinator" ? "warning" : item.lock.kind === "human" ? "accent" : "muted"),
			...(contract?.agent !== undefined ? [badge(`${prefix}.agent`, `agent: ${contract.agent}`, "accent")] : []),
			...(contract?.isolated !== undefined ? [badge(`${prefix}.isolated`, `isolated: ${contract.isolated ? "true" : "false"}`, "accent")] : []),
			...(item.lock.kind === "coordinator" ? [button(`${prefix}.interrupt`, "打断", () => showError(core.interrupt(ref, block.id), `${prefix}.state`), finished, "danger")] : []),
			button(`${prefix}.fold`, folded ? "展开" : "折叠", () => { if (collapsed.has(block.id)) collapsed.delete(block.id); else collapsed.add(block.id); redraw(); }, false, "ghost"),
		]), ...inlineError(`${prefix}.state`)];
		const editable: readonly ("title" | "body" | "requirement")[] = block.content.kind === "task" ? ["title", "body"] : ["title", "requirement"];
		for (const name of editable) {
			const editing = item.lock.kind === "human" && item.lock.field === name;
			c.push(row(`${prefix}.${name}.controls`, editing
				? [text(`${prefix}.${name}.label`, `${LABELS[name]}：点完成或按 Esc 保存`, "accent"), button(`${prefix}.${name}.commit`, "完成", () => commit(block.id), false, "primary"), button(`${prefix}.${name}.discard`, "放弃", () => discardDraft(block.id, `${prefix}.${name}`), false, "ghost")]
				: [text(`${prefix}.${name}.label`, LABELS[name], "muted"), button(`${prefix}.${name}.pencil`, `编辑${LABELS[name]}`, () => startDraft(block.id, name), !canEdit, "ghost")]));
			if (editing) c.push(draftField(block.id, name));
			// The md nodes stay exactly the block text: they are the check view (checks.md §1). Placeholders are plain text.
			else if (name === "title") c.push({ id: `${prefix}.title.view`, k: "md", p: { text: block.title } }, ...(block.title.trim() ? [] : [text(`${prefix}.title.empty`, "（未命名块）", "muted")]));
			else if (name === "body" && block.content.kind === "task") c.push(...rendered(`${prefix}.body.view`, block.content.body), ...(block.content.body.trim() ? [] : [text(`${prefix}.body.empty`, "（还没有写执行正文）", "muted")]));
			else if (name === "requirement" && block.content.kind === "design") c.push(block.content.requirement.trim() ? { id: `${prefix}.requirement.view`, k: "md", p: { text: block.content.requirement } } : text(`${prefix}.requirement.empty`, "（还没有写需求）", "muted"));
			const notice = notices.get(`${prefix}.${name}`);
			if (notice) c.push(text(`${prefix}.${name}.notice`, notice, "warning"));
			c.push(...inlineError(`${prefix}.${name}`));
		}
		let draftErrors = 0;
		/** Checks read the design in the changes view, whatever view the person picked (issue #3 decision 8). */
		let checkedDesign: readonly TspNode[] = [];
		if (block.content.kind === "design") {
			const host = draftHost(block.id);
			const drawn = renderDraft(block.content.design, { ...host, askControl: askControl(block.id, canEdit) });
			draftErrors = drawn.diagnostics.filter(found => found.severity === "error").length;
			// The hidden pass draws asks statically: no controls, no events, no selection state.
			checkedDesign = renderDraft(block.content.design, { ...host, context: { ...host.context, svg: (id, _svg, _size, alt) => ({ id, k: "image", p: { alt } }), image: (id, _bytes, _mime, alt) => ({ id, k: "image", p: { alt } }) }, view: () => "changes" }).nodes;
			c.push(section(`${prefix}.design`, "设计（由协调者按修改 prompt 修订）", block.content.design.trim() ? [...drawn.nodes] : [text(`${prefix}.design.empty`, "（协调者还没有写设计）", "muted")]));
			if (drawn.diagnostics.length) c.push(section(`${prefix}.diagnostics`, `稿件问题 ${drawn.diagnostics.length}`, drawn.diagnostics.map((found, index) => text(`${prefix}.diagnostic.${index}`, `第 ${found.line} 行 · ${found.component} · ${found.message}`, found.severity === "error" ? "error" : "warning"))));
			const writing = item.lock.kind === "human" && item.lock.field === "prompt";
			c.push(row(`${prefix}.prompt.controls`, writing
				? [text(`${prefix}.prompt.label`, "修改 prompt（Esc 不提交）", "accent"), button(`${prefix}.prompt.submit`, "提交修改", () => submitPrompt(block.id), false, "primary"), button(`${prefix}.prompt.discard`, "放弃", () => discardDraft(block.id, `${prefix}.prompt`), false, "ghost")]
				: [button(`${prefix}.prompt.pencil`, "写修改 prompt", () => startDraft(block.id, "prompt"), !canEdit)]));
			if (writing) c.push(draftField(block.id, "prompt"));
			const notice = notices.get(`${prefix}.prompt`);
			if (notice) c.push(text(`${prefix}.prompt.notice`, notice, "warning"));
			c.push(...inlineError(`${prefix}.prompt`));
			const history = core.revisions(ref, block.id);
			const head = `修改记录 ${history.length}${history.length ? ` · 最新 #${history.at(-1)!.seq} ${time(history.at(-1)!.at)}` : ""}`;
			c.push(section(`${prefix}.revisions`, head, history.length ? history.map(revision => col(`${prefix}.revision.${revision.seq}`, [text(`${prefix}.revision.${revision.seq}.meta`, `#${revision.seq} · ${time(revision.at)}`, "muted"), { id: `${prefix}.revision.${revision.seq}.text`, k: "md", p: { text: revision.prompt } }])) : [text(`${prefix}.revisions.empty`, "没有修改记录", "muted")], `${prefix}.revisions`, true));
		}
		item.references.forEach((reference, index) => {
			const id = `${prefix}.reference.${index}`;
			const state = reference.status === "fetching" ? "取回中" : reference.fetchFailed ? "取回失败" : reference.expansion?.kind === "Err" ? "展开失败" : reference.external ? `已取回 ${time(reference.fetchedAt)}` : "已展开";
			const head = row(`${id}.head`, [text(`${id}.label`, `引用 ${reference.reference.text} · ${state}`, reference.fetchFailed || reference.expansion?.kind === "Err" ? "error" : undefined), ...(reference.external ? [button(`${id}.refetch`, "重新取回", () => { void core.refetch(ref, reference.reference.targetText).then(error => showError(error, id)); }, false, "ghost")] : [])]);
			// A ready expansion is a copy of content shown elsewhere; failures stay open so they are seen.
			const quiet = reference.status === "ready" && !reference.fetchFailed && reference.expansion?.kind === "Ok";
			c.push(section(id, head, reference.expansion ? [{ id: `${id}.expansion`, k: "md", p: { text: compileText(reference.expansion) } }] : [text(`${id}.pending`, "取回中")], `${index}:${reference.reference.text}`, quiet));
			c.push(...inlineError(id));
		});
		const scope = targets.length > 1 ? `（${targets.length} 块）` : "";
		c.push(row(`${prefix}.actions`, [
			...(view.run ? [button(`${prefix}.launch`, `启动${scope}`, () => { if (view.run) showError(core.requestLaunch(view.run.id, targets), `${prefix}.actions`); }, finished || mixed || designSelected, "primary")] : []),
			button(`${prefix}.check`, `检查${scope}`, () => showError(core.requestCheck(ref, targets), `${prefix}.actions`)),
			button(`${prefix}.preview`, `预览${scope}`, () => { void core.preview(ref, targets).then(result => { previews.set(prefix, result); redraw(); }); }),
			button(`${prefix}.insert`, "在下方新建执行块", () => insertAndEdit(block.id, "task", `${prefix}.actions`), !unlocked || finished, "ghost"),
			button(`${prefix}.insert-design`, "在下方新建设计块", () => insertAndEdit(block.id, "design", `${prefix}.actions`), !unlocked || finished, "ghost"),
			button(`${prefix}.delete`, "删除", () => showError(core.deleteBlock(ref, block.id), `${prefix}.actions`), !unlocked || finished, "danger"),
		]));
		c.push(...inlineError(`${prefix}.actions`));
		if (view.run && mixed) c.push(text(`${prefix}.mixed`, "编排块只能单独启动", "warning"));
		if (view.run && designSelected) c.push(text(`${prefix}.design-launch`, "设计块不能直接启动：在执行块中引用它", "warning"));
		if (view.run && item.launches.length) c.push(section(`${prefix}.launches`, `Launch ${item.launches.length}`, item.launches.map(launch => row(`${prefix}.launch.${launch.id}`, [
			text(`${prefix}.launch.${launch.id}.detail`, `${launch.id} · ${launch.active ? "活跃" : `不活跃 · 会话 ${launch.session}`} · agents: ${launch.agents.join(", ") || "无"}`),
			button(`${prefix}.launch.${launch.id}.close`, "关闭", () => showError(core.closeLaunch(launch.id), `${prefix}.actions`), false, "danger"),
		]))));
		if (item.latestRecord) c.push(section(`${prefix}.latest`, "最近记录", [record(`${prefix}.latest.entry`, item.latestRecord)]));
		const findings = item.findings ? (Object.entries(item.findings) as [FindingName, boolean][]) : [];
		const report = item.report?.result;
		const failed = findings.filter(([, fails]) => fails).length + (report?.kind === "answers" ? Object.values(report.answers).filter(probability => probability >= 0.5).length : 0);
		const checksHead = !item.findings ? "检查 · 计算中" : failed ? `检查 · ${failed} 项不通过` : report?.kind === "answers" ? "检查 · 全部通过" : "检查 · 确定性检查通过，模型未判定";
		c.push(section(`${prefix}.checks`, checksHead, [
			...(item.findings ? findings.map(([name, fails]) => text(`${prefix}.finding.${name}`, `${FINDING_LABELS[name]}：${fails ? "不通过" : "通过"}`, fails ? "error" : "success")) : [text(`${prefix}.finding.pending`, "未判定", "muted")]),
			...(report?.kind === "answers" ? Object.entries(report.answers).map(([name, probability]) => text(`${prefix}.report.${name}`, `模型判定 ${name}：${probability >= 0.5 ? "不通过" : "通过"} · P(yes)=${probability}`, probability >= 0.5 ? "error" : "success")) : [text(`${prefix}.report`, report?.kind === "judge_unavailable" ? "模型判定 (jev)：模型不可用" : "模型判定 (jev)：未判定", "muted")]),
		], `${prefix}.checks`, failed === 0));
		const preview = previews.get(prefix);
		if (preview) c.push(section(`${prefix}.compiled`, "编译预览", [
			row(`${prefix}.compiled.bar`, [text(`${prefix}.compiled.length`, preview.kind === "Ok" ? `${preview.text.length} 字符` : "编译失败", preview.kind === "Ok" ? "muted" : "error"), button(`${prefix}.compiled.close`, "收起预览", () => { previews.delete(prefix); redraw(); }, false, "ghost")]),
			{ id: `${prefix}.compiled.text`, k: "code", p: { text: compileText(preview), lang: "text", wrap: true } },
			...(preview.kind === "Ok" ? [text(`${prefix}.compiled.sources`, sourcesText(preview.sources), "muted")] : []),
		]));
		c.push(...item.notices.map((notice, index) => text(`${prefix}.notice.${index}`, notice, "warning")));
		const md: string[] = [], images: string[] = [];
		let chartNodes = 0;
		function collect(node: TspNode): void { if (node.id === `${prefix}.design`) return; if (node.k === "md" && typeof node.p?.text === "string") md.push(node.p.text); if (node.k === "image") { chartNodes++; if (typeof node.p?.alt === "string") images.push(node.p.alt); } node.c?.forEach(collect); }
		c.forEach(collect);
		checkedDesign.forEach(collect);
		// Only task bodies hold chartable tables; a design's images are its own drawings.
		if (block.content.kind === "design") chartNodes = 0;
		if (item.lock.kind === "human" && item.lock.field === "body") chartNodes = summaries.get(block.id)?.chartNodes ?? 0;
		summaries.set(block.id, { chartNodes, view: { md, images }, draftErrors });
		const title = item.lock.kind === "human" && item.lock.field === "title" ? item.lock.draft : block.title;
		// A folded card still drew everything above, so its checks and render status match an open card;
		// only its state row (with the lock), title and notices are mounted. A title being edited shows its draft.
		const shown = folded
			? [
				...c.filter(node => node.id === `${prefix}.state`),
				c.find(node => node.id === `${prefix}.title.view`) ?? { id: `${prefix}.title.view`, k: "md", p: { text: title.trim() || "*（未命名块）*" } },
				...c.filter(node => node.id.startsWith(`${prefix}.notice.`)),
			]
			: c;
		if (folded) for (const id of fields.keys()) if (id.startsWith(`${prefix}.`)) fields.delete(id);
		return { id: `${prefix}.card`, k: "card", p: { head: `${block.id} · ${blockKindLabel(block.content)} · ${title.trim() || "未命名块"}${block.done ? " · 已完成" : ""}` }, c: shown };
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
		ref = next; selected.clear(); previews.clear(); info.clear(); summaries.clear(); asks.clear(); collapsed.clear(); focus = null; actionError = null;
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
		const coordinator = core.coordinator();
		if (coordinator.connected && actionError?.needsCoordinator) actionError = null;
		const errors = [...core.errors(), ...view.errors, ...(renderError ? [renderError] : []), ...(actionError ? [actionError.message] : [])];
		const c: TspNode[] = [box("header", "pb-header", [
			{ id: "tabs", k: "tabs", p: { min: { h: "2lines" }, shrink: 0, items: [{ id: "template", label: "模板" }, ...runs.map(run => ({ id: run.id, label: `${run.name}${run.status === "finished" ? " · 已结束" : ""}` }))], active: ref.kind === "template" ? "template" : ref.run } },
			{ id: "heading", k: "md", p: { text: `# ${view.run?.name ?? view.title}` } },
			row("coordinator", [
				badge("coordinator.badge", coordinator.connected ? "协调者在线" : "协调者离线", coordinator.connected ? "success" : "warning"),
				text("coordinator.status", coordinator.connected ? `协调者会话 ${coordinator.session}` : "没有协调者连接", "muted"),
				...(coordinator.connected && coordinator.pane ? [button("coordinator.focus", "转到协调者", () => { void core.focusCoordinator().then(error => showError(error)); }, false, "ghost")] : []),
			]),
			...(errors.length ? [row("errors", [...errors.map((error, index) => text(`error.${index}`, error, "error")), ...(renderError || actionError ? [button("error.dismiss", "关闭提示", () => { renderError = null; actionError = null; redraw(); }, false, "ghost")] : [])])] : []),
		])];
		if (!view.run) {
			c.push(section("start-run", "开始 Run", [
				box("start-run.form", "pb-form-row", [
					labeled("run.name", "Run 名称", formField("run.name", () => runName, value => { runName = value; }, "例如：检查缓存方案")),
					labeled("run.every", "状态更新间隔（秒，可选）", formField("run.every", () => runEvery, value => { runEvery = value; }, "留空表示不提醒")),
					button("run.start", "开始 Run", startRun, false, "primary"),
				]),
				...inlineError("run.start"),
			]));
			if (runs.length) c.push(section("runs", `Run 列表 ${runs.length}`, runs.map(run => box(`run.${run.id}`, "pb-run-item", [
				row(`run.${run.id}.info`, [
					badge(`run.${run.id}.badge`, run.status === "running" ? "进行中" : "已结束", run.status === "running" ? "accent" : "neutral"),
					text(`run.${run.id}.summary`, `完成 ${run.done}/${run.total} · 开始 ${time(run.started_at)}${run.finished_at === null ? "" : ` · 结束 ${time(run.finished_at)}`}${run.update_due === null ? "" : ` · 下次更新 ${time(run.update_due)}`}${run.update_overdue ? " · 状态更新已到期" : ""}${run.status === "finished" && !run.retrospective ? " · 未复盘" : ""}`),
				]),
				button(`run.${run.id}.open`, `打开「${run.name}」`, () => switchView({ kind: "run", run: run.id })),
			]))));
		} else {
			const run = view.run;
			// The record form follows a Run that finishes while shown: once, not on every redraw.
			if (runStatus.get(run.id) === "running" && run.status === "finished" && !view.retrospective) resetRecordForm();
			runStatus.set(run.id, run.status);
			const done = view.blocks.filter(item => item.block.done).length;
			c.push(box("run.bar", "pb-toolbar", [
				badge("run.badge", run.status === "running" ? "进行中" : "已结束", run.status === "running" ? "accent" : "neutral"),
				badge("run.progress", `完成 ${done}/${view.blocks.length}`, view.blocks.length > 0 && done === view.blocks.length ? "success" : "neutral"),
				text("run.status", `开始 ${time(run.startedAt)}${run.finishedAt === null ? "" : ` · 结束 ${time(run.finishedAt)}`} · 最近更新 ${time(view.lastUpdateAt)}`, "muted"),
				button("run.finish", "结束 Run", () => {
					const error = core.finishRun(run.id);
					if (error) return showError(error, "run.finish");
					if (!view.retrospective) resetRecordForm();
				}, run.status === "finished", "danger"),
				...inlineError("run.finish"),
			]));
			if (run.updateDue !== null) {
				const overdue = run.updateDue <= Date.now();
				c.push(box("run.due", "pb-toolbar", [
					text("run.due.time", `下次状态更新：${time(run.updateDue)}${overdue ? " · 状态更新已到期" : ""}`, overdue ? "warning" : "muted"),
					choices("run.snooze.duration", ["300", "900", "3600", "86400"], String(snoozeAfter), value => { snoozeAfter = Number(value); }, run.status === "finished", value => SNOOZE_LABELS[value] ?? value),
					button("run.snooze", "推迟提醒", () => showError(core.snooze(run.id, snoozeAfter), "run.snooze"), run.status === "finished"),
					...inlineError("run.snooze"),
				]));
			}
		}
		const hasDraft = anyDraft();
		const present = new Set(view.blocks.map(item => item.block.id));
		for (const id of asks.keys()) if (!present.has(id)) asks.delete(id);
		for (const id of collapsed) if (!present.has(id)) collapsed.delete(id);
		for (const id of selected) if (!present.has(id)) selected.delete(id);
		const finished = view.run?.status === "finished";
		const picked = view.blocks.filter(item => selected.has(item.block.id)).map(item => item.block.id);
		c.push(box("cards", "pb-toolbar", [
			...(view.blocks.length ? [button("cards.collapse", "全部折叠", () => { for (const item of view.blocks) collapsed.add(item.block.id); redraw(); }, false, "ghost"), button("cards.expand", "全部展开", () => { collapsed.clear(); redraw(); }, false, "ghost")] : []),
			button("block.insert.task", "新建执行块", () => insertAndEdit(view.blocks.at(-1)?.block.id ?? null, "task", "cards"), finished),
			button("block.insert.design", "新建设计块", () => insertAndEdit(view.blocks.at(-1)?.block.id ?? null, "design", "cards"), finished),
			...(picked.length ? [badge("cards.selected", `已选 ${picked.join("、")}：卡片上的启动/检查/预览作用于全部已选块`, "accent"), button("cards.unselect", "取消选择", () => { selected.clear(); redraw(); }, false, "ghost")] : []),
			...inlineError("cards"),
		]));
		c.push(...view.blocks.map(item => blockCard(view, item, hasDraft)));
		if (view.run) {
			const run = view.run;
			if (!postKindChosen) postKind = run.status === "finished" && !view.retrospective ? "retrospective" : "update";
			const kinds: readonly RecordKind[] = run.status === "finished" ? ["update", "result", "failure", "retrospective"] : ["update", "result", "failure"];
			const titles = new Map<string, string>(view.blocks.map(item => [item.block.id, item.block.title.trim()]));
			const retrospective = postKind === "retrospective";
			c.push(section("post", retrospective ? "写复盘" : "写记录", [
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
			]));
			const counts = new Map<EntryData["type"], number>();
			for (const entry of view.timeline) counts.set(entry.data.type, (counts.get(entry.data.type) ?? 0) + 1);
			const shown = view.timeline.filter(entry => filter === "all" || entry.data.type === filter);
			c.push(section("timeline", `时间线 ${shown.length}/${view.timeline.length}`, [
				choices("timeline.filter", ["all", ...TYPES.filter(type => counts.has(type) || type === filter)], filter, value => { filter = value; }, false, value => `${TYPE_LABELS[value]} ${value === "all" ? view.timeline.length : counts.get(value) ?? 0}`),
				...Array.from(info, ([id, launch]) => section(`launch-info.${id}`, `${id} 完整记录`, [
					row(`launch-info.${id}.bar`, [
						badge(`launch-info.${id}.state`, launch.closed ? `已关闭 · ${launch.closed.by}` : "未关闭", launch.closed ? "neutral" : "accent"),
						text(`launch-info.${id}.meta`, `块 ${launch.blocks.join("、")} · ${launch.kind === "orchestration" ? "编排" : "执行"} · agents ${launch.agents.join(", ") || "无"} · 基线 ${launch.baselines.length} 个`, "muted"),
						button(`launch-info.${id}.hide`, "收起", () => { info.delete(id); redraw(); }, false, "ghost"),
					]),
					{ id: `launch-info.${id}.text`, k: "code", p: { text: JSON.stringify(launch, null, 2), lang: "json", wrap: true } },
				])),
				...(shown.length ? shown.map(entry => {
					const data = entry.data;
					return box(`timeline.${entry.seq}`, "pb-timeline-entry", [record(`timeline.${entry.seq}.record`, entry), ...(data.type === "launch_created" ? [button(`timeline.${entry.seq}.launch`, info.has(data.launch) ? `收起 ${data.launch} 完整记录` : `打开 ${data.launch} 完整记录`, () => {
						if (info.has(data.launch)) info.delete(data.launch);
						else { const launch = core.launchInfo(data.launch); if (launch) info.set(data.launch, launch); }
						redraw();
					}, false, "ghost")] : [])]);
				}) : [text("timeline.empty", view.timeline.length ? `没有「${TYPE_LABELS[filter]}」类记录` : "时间线还是空的", "muted")]),
			]));
		}
		return col("main", [box("shell", "pb-shell", c)]);
	}
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
		const blocks = view.blocks.map(item => item.block.id);
		const s = tsp.frame(ops, blocks);
		mounted = true;
		tsp.fullRedraw(s);
		reportStatus(blocks);
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
		const current = value.text();
		if (event.len !== current.length) { notices.set(event.id, "一次输入因文本已变化未应用"); redraw(); return; }
		applyText(event.id, current.slice(0, event.from) + event.text + current.slice(event.to), event.cursor);
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
		const current = value.text();
		const caret = carets.get(focus) ?? { cursor: current.length, anchor: null };
		let cursor = caret.cursor;
		let from = caret.anchor === null ? cursor : Math.min(cursor, caret.anchor);
		let to = caret.anchor === null ? cursor : Math.max(cursor, caret.anchor);
		let insertion: string | null = null;
		if (bytes === "\x7f" || bytes === "\b") { if (from === to) from = previous(current, from); insertion = ""; }
		else if (bytes === `${ESC}[3~`) { if (from === to) to = following(current, to); insertion = ""; }
		else if (bytes === `${ESC}[D`) cursor = caret.anchor === null ? previous(current, cursor) : from;
		else if (bytes === `${ESC}[C`) cursor = caret.anchor === null ? following(current, cursor) : to;
		else if (bytes === `${ESC}[H` || bytes === "\x01") cursor = current.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
		else if (bytes === `${ESC}[F` || bytes === "\x05") { const end = current.indexOf("\n", cursor); cursor = end < 0 ? current.length : end; }
		else if (bytes === "\x1a") { undoField(focus); return; }
		else if (bytes.startsWith(`${ESC}[200~`) && bytes.endsWith(`${ESC}[201~`)) insertion = bytes.slice(6, -6).replace(/\r\n?/g, "\n");
		else if (!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(bytes)) insertion = bytes.replace(/\r\n?/g, "\n");
		else return;
		if (insertion !== null) {
			if (!value.multiline && insertion.includes("\n")) return;
			applyText(focus, current.slice(0, from) + insertion + current.slice(to), from + insertion.length);
		} else applyText(focus, current, cursor);
	}
	function undoField(id: string): void { const step = undo.get(id)?.pop(); if (step) applyText(id, step.text, step.cursor, step.anchor, false); }
	function event(input: TspEvent): void {
		switch (input.ev) {
			case "action": {
				const handler = input.act === "invoke" ? actions.get(input.id) : undefined;
				// A new action replaces the previous action's refusal.
				if (handler) { actionError = null; handler(); }
				break;
			}
			case "change": {
				const handler = changes.get(input.id);
				if (handler) { actionError = null; handler(input); }
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
