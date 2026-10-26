import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { prepareSvg } from "@oh-my-pi/pi-tui/chat/svg-source";
import { svgFigurePalette } from "@oh-my-pi/pi-tui/chat/svg-figure";
import { initThemeSync, setTheme } from "@oh-my-pi/pi-tui/theme/theme";
import { outlinedText, type Block, type BlockId, type DocRef, type HumanField } from "../domain/model";
import type { BlockView, CoreApi, DocView, RenderStatus } from "../domain/ports";
import { renderDraft, type DraftHost } from "./draft/components";
import { outlineProblems } from "./draft/outline";
import { imageMime } from "./draft/image";
import type { ChangeView, EditHost, FileRead, ListItem, Span } from "./draft/contract";
import { parseSlots, setSlotValue, type SlotDecl } from "./draft/slot";
import type { FrameOp, TspEvent, TspInput, TspNode, TspSession } from "./tsp-types";
import type { CoordinatorPicker, OmpPane } from "./coordinators";
import { tr } from "../i18n";

/** The block fields drawn as text: a person writes `body` and `requirement`; `design` is the coordinator's. */
type DraftField = "body" | "requirement" | "design";

/** The image on the system clipboard now, as the encoded bytes and their MIME type; null when it holds none. */
export type ClipboardImageReader = () => Promise<{ readonly data: Uint8Array; readonly mimeType: string } | null>;

/** The offline coordinator picker: closed, asking Tern, showing an answer, or carrying out a choice. */
type CoordPickerState =
	| { readonly kind: "closed" }
	| { readonly kind: "loading" }
	| { readonly kind: "listed"; readonly panes: readonly OmpPane[] }
	| { readonly kind: "failed"; readonly error: string }
	| { readonly kind: "working"; readonly text: string };

const SURFACE = "playbook";
const ESC = "\x1b";
/** The pane always shows the Playbook itself; Runs are copies the coordinator works in. */
const REF: DocRef = { kind: "template" };
/** A click on a title waits this long for a second click, which edits the title instead of folding the card. */
const CLICK_DELAY_MS = 250;
const VIEWS: readonly { readonly view: ChangeView; readonly label: string }[] = [{ view: "changes", label: tr("Changes", "变更") }, { view: "before", label: tr("Before", "之前") }, { view: "after", label: tr("After", "之后") }];

/** TSP sheets reach only descendants of the region root, so every rule targets nodes inside a region. */
const SURFACE_CSS = [
	".pb-app { display: flex; flex-direction: column; gap: 14px; padding: 18px 16px 24px; font-family: var(--mono); font-size: 13px; line-height: 1.6; color: var(--t1); }",
	".pb-doc-title { display: flex; align-items: baseline; gap: 8px; font-size: 15px; font-weight: 600; }",
	".pb-hash { color: var(--t3); font-weight: 400; }",
	".pb-errors { display: flex; flex-direction: column; gap: 2px; }",
	// A folded card has no body; Tern keeps the empty body's bottom padding unless it is hidden.
	".sf-card-body:empty { display: none; }",
	".pb-cards { display: flex; flex-direction: column; gap: 6px; }",
	".pb-empty { color: var(--t3); }",
	// Card head: number, title, status icon, then the more and fold buttons at the far end.
	".pb-head { display: flex; align-items: center; gap: 10px; min-width: 0; width: 100%; }",
	".pb-nn { flex: 0 0 auto; color: var(--t3); }",
	".pb-title { flex: 0 1 auto; min-width: 0; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: default; }",
	".pb-open .pb-title { font-weight: 600; }",
	".pb-spacer { flex: 1 1 auto; }",
	".pb-icon-btn { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 6px; color: var(--t2); cursor: pointer; }",
	".pb-icon-btn:hover { background: var(--l1); }",
	".pb-chev { transition: transform .12s; }",
	".pb-open .pb-chev { transform: rotate(90deg); }",
	".pb-st { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 6px; cursor: pointer; }",
	".pb-st:hover { background: var(--l1); }",
	".pb-st-todo { display: inline-block; width: 13px; height: 13px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--t3); }",
	".pb-st-done { display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--ok); color: var(--ok); }",
	// Card body: one column of sections; a section is a bold head line over its content.
	".pb-body { display: flex; flex-direction: column; gap: 18px; padding: 2px 4px 4px 0; }",
	".pb-draft { display: flex; flex-direction: column; gap: 14px; }",
	".pb-draft-title { margin: 0; font-size: 14px; font-weight: 600; }",
	".pb-draft-subtitle { margin: 0; color: var(--t2); }",
	".pb-section { display: flex; flex-direction: column; gap: 6px; }",
	".pb-ph { display: flex; align-items: baseline; gap: 8px; font-weight: 600; }",
	".pb-ph-id { color: var(--t3); font-weight: 400; }",
	".pb-ph-meta { color: var(--t3); font-weight: 400; font-size: 12px; }",
	".pb-lead { color: var(--t2); }",
	".pb-editable { min-width: 0; cursor: text; }",
	".pb-inline { white-space: pre-wrap; }",
	".pb-inline code { font-family: var(--mono); padding: 0 3px; border-radius: 4px; background: var(--l1); }",
	// Slot: the current value, underlined, opening its options.
	".pb-slot { display: inline; padding: 0 2px; border-bottom: 1.5px dashed var(--t3); font-weight: 600; cursor: pointer; }",
	".pb-slot-open { border-bottom-color: var(--accent); background: rgb(from var(--accent) r g b / 12%); }",
	".pb-opt { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; width: 100%; padding: 6px 10px; border-radius: 6px; text-align: left; cursor: pointer; }",
	".pb-opt:hover { background: var(--l1); }",
	".pb-opt-on { background: rgb(from var(--accent) r g b / 12%); }",
	".pb-opt-row { display: flex; align-items: center; gap: 8px; }",
	".pb-opt-label { font-family: var(--sans); font-weight: 500; }",
	".pb-opt-on .pb-opt-label { color: var(--accent); }",
	".pb-opt-note { font-size: 12px; color: var(--t2); }",
	".pb-opt-past { font-size: 11px; color: var(--t3); }",
	".pb-opt-notice { padding: 6px 10px; }",
	".pb-opt-stale { cursor: default; }",
	".pb-opt-stale .pb-opt-label { color: var(--t2); }",
	// SUBAGENT: a dropdown trigger, the value and a chevron in a field-like box.
	".pb-select { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-top: 4px; padding: 3px 8px; border-radius: 4px; box-shadow: inset 0 0 0 1px var(--l2); cursor: pointer; }",
	".pb-select:hover { background: var(--l1); }",
	".pb-select-open { box-shadow: inset 0 0 0 1px var(--accent); }",
	".pb-select-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
	// Lists: an ordered list's items carry a grip that picks the item up; a click on another item places it there.
	".pb-list { display: flex; flex-direction: column; margin: 0; padding: 0; }",
	".pb-li { display: flex; align-items: flex-start; gap: 8px; padding: 3px 6px 3px 2px; border-radius: 6px; }",
	".pb-li-target { cursor: copy; }",
	".pb-li-target:hover { box-shadow: inset 0 2px 0 var(--accent); }",
	".pb-grip { flex: 0 0 auto; color: var(--t3); cursor: grab; }",
	".pb-num { flex: 0 0 18px; color: var(--t2); }",
	".pb-bullet { flex: 0 0 10px; color: var(--t2); }",
	".pb-li-text { flex: 1 1 auto; min-width: 0; }",
	// kv: muted keys beside their values.
	".pb-kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); column-gap: 14px; row-gap: 2px; }",
	".pb-kv-k { color: var(--t2); }",
	".pb-kv-v { overflow-wrap: anywhere; }",
	".pb-kv-wide { grid-column: 1 / -1; font-weight: 600; }",
	// A flow drawn as a chain of cards.
	".pb-flow { display: flex; flex-direction: column; align-items: center; gap: 0; margin-top: 4px; }",
	".pb-node { min-width: 200px; max-width: 320px; padding: 6px 14px; border-radius: 8px; box-shadow: inset 0 0 0 1px var(--l3, var(--l2)); background: var(--card, transparent); text-align: center; cursor: pointer; }",
	".pb-node-round { border-radius: 17px; }",
	".pb-node-diamond { border-radius: 2px; transform: none; box-shadow: inset 0 0 0 1px var(--l3, var(--l2)), inset 0 0 0 3px var(--l1); }",
	".pb-node-cylinder { border-radius: 12px / 8px; }",
	".pb-node-sel { box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 3px rgb(from var(--accent) r g b / 18%); }",
	".pb-arrow { display: flex; flex-direction: column; align-items: center; color: var(--t3); line-height: 1.2; padding: 2px 0; }",
	".pb-arrow-dashed { opacity: .7; }",
	".pb-edge-label { font-size: 11px; color: var(--t2); }",
	".pb-node-tools { display: flex; gap: 4px; margin-top: 6px; font-family: var(--sans); }",
	".pb-tool { padding: 2px 8px; border-radius: 6px; box-shadow: inset 0 0 0 1px var(--l2); font-size: 12px; cursor: pointer; }",
	".pb-tool:hover { background: var(--l1); }",
	".pb-danger { color: var(--bad); }",
	// An in-place edit: the field, then the control that ends it (the same as Enter or Esc).
	".pb-editing { display: flex; flex-direction: column; align-items: stretch; gap: 4px; min-width: 0; flex: 1 1 auto; }",
	".pb-editing-line { flex-direction: row; align-items: center; gap: 6px; }",
	".pb-editing-line > .sf-input { flex: 1 1 auto; min-width: 0; }",
	".pb-exit { align-self: flex-end; flex: 0 0 auto; padding: 2px 8px; border-radius: 4px; font-family: var(--sans); font-size: 12px; color: var(--accent); box-shadow: inset 0 0 0 1px rgb(from var(--accent) r g b / 45%); cursor: pointer; white-space: nowrap; }",
	".pb-editing-line > .pb-exit { align-self: center; }",
	// Comments: `//` and muted small text, never a box.
	".pb-comment { display: flex; gap: 8px; align-items: flex-start; color: var(--t2); font-size: 12px; }",
	".pb-comment-slash { flex: 0 0 auto; color: var(--t3); }",
	".pb-comment-text { display: flex; flex-direction: column; gap: 2px; }",
	".pb-comment .sf-md { font-size: 12px; color: var(--t2); }",
	".pb-placeholder { color: var(--t3); }",
	// Card foot: hairline, the SUBAGENT / WORKTREE columns or the completion report, then the full-width button.
	".pb-foot { display: flex; flex-direction: column; padding-top: 2px; }",
	".pb-rule { height: 1px; background: var(--l3, var(--l2)); }",
	".pb-grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 12px; }",
	".pb-grid2 > div:first-child { padding-right: 12px; min-width: 0; box-shadow: inset -1px 0 0 var(--l3, var(--l2)); }",
	".pb-grid2 > div:last-child { padding-left: 14px; min-width: 0; }",
	".pb-label { font-size: 12px; font-weight: 600; letter-spacing: .5px; color: var(--t2); }",
	".pb-val { margin-top: 2px; font-size: 14px; overflow-wrap: anywhere; cursor: text; }",
	".pb-launch { display: block; width: 100%; height: 32px; margin-top: 16px; border-radius: 4px; font-family: var(--sans); font-size: 14px; font-weight: 600; line-height: 32px; text-align: center; background: rgb(from var(--accent) r g b / 16%); color: var(--accent); box-shadow: inset 0 0 0 1px rgb(from var(--accent) r g b / 45%); cursor: pointer; }",
	".pb-launch-stop { background: transparent; color: var(--bad); box-shadow: inset 0 0 0 1px rgb(from var(--bad) r g b / 50%); }",
	".pb-launch-off { opacity: .5; cursor: default; }",
	".pb-report-toggle { display: flex; align-items: center; gap: 6px; margin-top: 8px; height: 28px; font-size: 12px; font-weight: 600; letter-spacing: .5px; color: var(--ok); cursor: pointer; }",
	".pb-report-meta { color: var(--t3); font-weight: 400; letter-spacing: 0; }",
	".pb-report { margin: 2px 0 0 5px; padding: 2px 0 2px 24px; box-shadow: inset 1px 0 0 var(--l3, var(--l2)); }",
	// The menu and the slot picker are overlays; their buttons need a look of their own.
	".pb-menu-item { display: block; width: 100%; padding: 4px 10px; border-radius: 6px; font-family: var(--sans); text-align: left; cursor: pointer; }",
	".pb-menu-item:hover { background: var(--l1); }",
	".pb-bar { display: flex; gap: 8px; padding: 6px 16px; }",
	".pb-bar .pb-launch { margin-top: 0; flex: 1 1 auto; }",
	".pb-ghost { flex: 0 0 auto; padding: 0 12px; height: 32px; border-radius: 4px; color: var(--t2); box-shadow: inset 0 0 0 1px var(--l2); font-family: var(--sans); font-size: 14px; line-height: 32px; cursor: pointer; }",
	".pb-view-switch { display: flex; gap: 6px; font-size: 12px; }",
	".pb-view { padding: 0 6px; border-radius: 4px; color: var(--t2); cursor: pointer; }",
	".pb-view-on { color: var(--accent); background: rgb(from var(--accent) r g b / 12%); }",
].join("\n");

type Caret = { cursor: number; anchor: number | null };

/** The one piece of text being edited in place; it is applied when editing ends (Enter, Esc, or another action). */
interface Editing {
	/** The editable node; its field is `${id}.edit`. */
	readonly id: string;
	readonly multiline: boolean;
	readonly placeholder: string;
	readonly initial: string;
	/** Apply the edited text; an error message, or null. */
	readonly commit: (text: string) => string | null;
	text: string;
	caret: Caret;
	readonly undo: { text: string; caret: Caret }[];
}

/** An open slot picker: the slot, where it is drawn, and how a picked value is applied. */
interface Picker {
	readonly anchor: string;
	readonly slot: SlotDecl;
	readonly apply: (value: string) => string | null;
}

type Handler = { click?: (mods: readonly string[]) => void; dblclick?: () => void };

/** Largest file a text may embed (am's image limit; code blocks stop far earlier). */
const MAX_DRAFT_FILE_BYTES = 5 * 1024 * 1024;

/** Read a file a drawn text names: relative to the Playbook directory, only inside it, only a regular file of bounded size. */
function readDraftFile(baseDir: string, path: string): FileRead {
	try {
		const base = realpathSync(baseDir);
		const target = realpathSync(resolve(base, path));
		const inside = relative(base, target);
		if (inside.startsWith("..") || isAbsolute(inside)) return { ok: false, error: tr(`Only files inside the Playbook directory can be referenced: ${path}`, `只能引用 Playbook 目录内的文件：${path}`) };
		const stat = statSync(target);
		if (!stat.isFile()) return { ok: false, error: tr(`Not a regular file: ${path}`, `不是普通文件：${path}`) };
		if (stat.size > MAX_DRAFT_FILE_BYTES) return { ok: false, error: tr(`File exceeds 5 MB: ${path}`, `文件超过 5 MB：${path}`) };
		return { ok: true, bytes: new Uint8Array(readFileSync(target)), path: target };
	} catch (error) {
		return { ok: false, error: tr(`Unable to read ${path}: ${error instanceof Error ? error.message : String(error)}`, `无法读取 ${path}：${error instanceof Error ? error.message : String(error)}`) };
	}
}

/**
 * The image files a pasted text names, as Tern pastes a copied file: its absolute path with shell
 * escapes (`\ `), several separated by spaces; quoted paths, `~/` and `file://` URLs too. Null
 * unless the whole text is such paths.
 */
export function pastedImagePaths(text: string): readonly string[] | null {
	const words: string[] = [];
	let current = "", started = false, quote: string | null = null;
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
		if (quote !== null) { if (char === quote) quote = null; else current += char; continue; }
		if (char === "\\" && index + 1 < text.length) { current += text[++index]; started = true; continue; }
		if (char === "'" || char === "\"") { quote = char; started = true; continue; }
		if (/\s/.test(char)) { if (started) words.push(current); current = ""; started = false; continue; }
		current += char; started = true;
	}
	if (quote !== null) return null;
	if (started) words.push(current);
	const paths = words.map(word => word.startsWith("file://") ? decodeURIComponent(word.slice("file://".length)) : word.startsWith("~/") ? join(homedir(), word.slice(2)) : word);
	return paths.length > 0 && paths.every(path => isAbsolute(path) && imageMime(path) !== null) ? paths : null;
}

const el = (id: string, tag: string, className: string, c: readonly TspNode[] = [], extra: Record<string, unknown> = {}): TspNode => ({ id, k: "el", p: { tag, class: className, ...extra }, c });

/** An ordered list's items in a new order, renumbered from `start`, keeping the separators the list had. */
function reorderedList(source: string, span: Span, items: readonly ListItem[], order: readonly number[], start: number): string {
	const texts = items.map(item => source.slice(item.span.start, item.span.end));
	const gaps = items.slice(1).map((item, index) => source.slice(items[index]!.span.end, item.span.start));
	return order.map((from, position) => texts[from]!.replace(/^( {0,3})\d{1,9}([.)])/, (_, indent: string, delimiter: string) => `${indent}${start + position}${delimiter}`) + (position < gaps.length ? gaps[position]! : "")).join("") + source.slice(items.at(-1)!.span.end, span.end);
}

/** K4 front end. Core owns every document; this keeps only what the pane shows and what is being edited. */
export function startUi(core: CoreApi, tsp: TspSession, baseDir: string, coordinators: CoordinatorPicker, clipboardImage: ClipboardImageReader): void {
	initThemeSync();
	let opened = false;
	let mounted = false;
	/** Tern render or theme failure; stays until the next one. */
	let renderError: string | null = null;
	/** The one open card. */
	let open: BlockId | null = null;
	let openChosen = false;
	let menu: BlockId | null = null;
	/** The task block whose SUBAGENT dropdown is open. */
	let agentMenu: BlockId | null = null;
	let coordPicker: CoordPickerState = { kind: "closed" };
	let editing: Editing | null = null;
	let picker: Picker | null = null;
	/** An ordered list item picked up to be placed elsewhere. */
	let picked: { readonly list: string; readonly from: number } | null = null;
	/** The selected node of a chain flow, which shows its tools. */
	let node: { readonly chain: string; readonly index: number } | null = null;
	/** A notice shown once: it is added to the layer by itself and replaced by the next one. */
	let toast: { readonly text: string; readonly tone: "error" | "success"; readonly n: number } | null = null;
	let shownToast: number | null = null;
	let toastCount = 0;
	/** The slot picker as it was before the current action ended an edit, so a click on its slot closes it. */
	let pickerBefore: string | null = null;
	let titleTimer: Timer | undefined;
	const selected = new Set<BlockId>();
	const reports = new Set<BlockId>();
	const handlers = new Map<string, Handler>();
	const views = new Map<string, ChangeView>();
	const summaries = new Map<BlockId, Pick<RenderStatus, "view" | "draftErrors">>();
	const sentBlobs = new Set<string>();

	function notify(text: string, tone: "error" | "success" = "error"): void {
		toast = { text, tone, n: ++toastCount };
	}
	function outcome(error: string | null): void {
		if (error) notify(error);
	}
	function on(id: string, handler: Handler): void {
		handlers.set(id, { ...handlers.get(id), ...handler });
	}

	// ------------------------------------------------------------ in-place editing

	function startEdit(id: string, initial: string, multiline: boolean, commit: (text: string) => string | null, placeholder = ""): void {
		if (editing && editing.id !== id) finishEdit();
		editing = { id, multiline, placeholder, initial, commit, text: initial, caret: { cursor: initial.length, anchor: null }, undo: [] };
		menu = null;
	}
	function finishEdit(): void {
		const done = editing;
		if (!done) return;
		editing = null;
		// Enter or Esc in the picker's own field, or any action elsewhere, closes the picker.
		if (done.id === "picker.custom") picker = null;
		if (done.text !== done.initial) outcome(done.commit(done.text));
	}
	function editor(state: Editing): TspNode {
		const field: TspNode = { id: `${state.id}.edit`, k: state.multiline ? "editor" : "input", p: { text: state.text, cursor: state.caret.cursor, anchor: state.caret.anchor, placeholder: state.placeholder, aria: state.placeholder || tr("Edit", "编辑"), ...(state.multiline ? { maxLines: 18 } : {}) } };
		const exit = `${state.id}.exit`;
		on(exit, { click: finishEdit });
		return el(`${state.id}.editing`, "div", state.multiline ? "pb-editing" : "pb-editing pb-editing-line", [
			field,
			el(exit, "span", "pb-exit", [], { text: tr("Done", "退出编辑"), title: tr("Save and exit editing (same as Enter / Esc)", "保存并退出编辑（同 Enter / Esc）"), actions: { click: "invoke" } }),
		]);
	}
	/** A view that turns into its editor on double-click. */
	function editable(id: string, view: TspNode, initial: () => string, multiline: boolean, commit: (text: string) => string | null, placeholder = "", tag = "div"): TspNode {
		if (editing?.id === id) return editor(editing);
		on(id, { dblclick: () => startEdit(id, initial(), multiline, commit, placeholder) });
		return el(id, tag, "pb-editable", [view], { actions: { dblclick: "edit" } });
	}

	/**
	 * Keep pasted images beside the Playbook and put their lines at the caret of the multi-line text
	 * being edited, or else at the end of the open card's body (design card: requirement).
	 */
	function placeImages(images: readonly { readonly data: Uint8Array; readonly mimeType: string }[]): void {
		const lines: string[] = [];
		for (const image of images) {
			const saved = core.saveImage(image.data, image.mimeType);
			if (!saved.ok) { notify(saved.error); return; }
			lines.push(`![${tr("Image", "图片")}](${saved.path})`);
		}
		const text = lines.join("\n");
		if (editing) {
			if (!editing.multiline) { notify(tr("This field is single-line and cannot hold an image: finish editing before pasting; the image will be added to the end of the card", "这一栏只有一行，放不下图片：退出编辑再粘贴，图片会加到卡片末尾")); return; }
			const caret = editing.caret;
			const before = editing.text.slice(0, caret.anchor === null ? caret.cursor : Math.min(caret.cursor, caret.anchor));
			const after = editing.text.slice(caret.anchor === null ? caret.cursor : Math.max(caret.cursor, caret.anchor));
			// An image is drawn only on a line of its own.
			insert(`${before === "" || before.endsWith("\n") ? "" : "\n"}${text}${after === "" || after.startsWith("\n") ? "" : "\n"}`);
			return;
		}
		const block = open === null ? undefined : core.view(REF).blocks.find(item => item.block.id === open)?.block;
		if (!block) { notify(tr("Expand the card where the image should go first", "先展开要放图片的卡片")); return; }
		const field = block.content.kind === "task" ? "body" : "requirement";
		const source = block.content.kind === "task" ? block.content.body : block.content.requirement;
		const error = core.edit(REF, block.id, field, source, source.trim() ? `${source.trimEnd()}\n\n${text}\n` : `${text}\n`);
		if (error) notify(error);
		else notify(block.content.kind === "task" ? tr("Image added to end of body", "图片已加到正文末尾") : tr("Image added to end of requirement", "图片已加到需求末尾"), "success");
	}
	/** Ctrl+V, or a paste with no text: the image data on the system clipboard. */
	function pasteClipboardImage(): void {
		void clipboardImage().then(image => {
			if (image) placeImages([image]);
			else notify(tr("There is no image in the clipboard", "剪贴板里没有图片"));
		}, (error: unknown) => {
			notify(tr(`Unable to read an image from the clipboard: ${error instanceof Error ? error.message : String(error)}`, `读不到剪贴板里的图片：${error instanceof Error ? error.message : String(error)}`));
		}).then(redraw);
	}
	/**
	 * Cmd+V of copied image files: Tern pastes their paths, and the files themselves go in. One file
	 * this process may not open (another app's container) is still on the clipboard as image data.
	 */
	function pasteImageFiles(paths: readonly string[]): void {
		const images: { data: Uint8Array; mimeType: string }[] = [];
		for (const path of paths) {
			try {
				const stat = statSync(path);
				if (!stat.isFile()) { notify(tr(`Not a regular file: ${path}`, `不是普通文件：${path}`)); return; }
				if (stat.size > MAX_DRAFT_FILE_BYTES) { notify(tr(`Image exceeds 5 MiB and cannot be shown in the card: ${path}`, `图片超过 5 MiB，卡片显示不了：${path}`)); return; }
				images.push({ data: new Uint8Array(readFileSync(path)), mimeType: imageMime(path)! });
			} catch (error) {
				if (paths.length === 1) { pasteClipboardImage(); return; }
				notify(tr(`Unable to read ${path}: ${error instanceof Error ? error.message : String(error)}`, `读不到 ${path}：${error instanceof Error ? error.message : String(error)}`)); return;
			}
		}
		placeImages(images);
	}

	// ------------------------------------------------------------ drawing one block field

	function imageNode(id: string, bytes: Uint8Array, mime: string, alt: string, size?: { readonly w: number; readonly h: number }): TspNode {
		const blob = createHash("sha256").update(bytes).digest("hex");
		if (!sentBlobs.has(blob)) { tsp.blob(blob, mime, bytes); sentBlobs.add(blob); }
		return { id, k: "image", p: { blob, alt, ...(size ? { w: size.w, h: size.h } : {}) } };
	}

	/**
	 * How a person changes one field of a block: a task body and a design's requirement are written
	 * directly; a design is the coordinator's, so a person's change to it (a slot value) goes as a
	 * change request.
	 */
	function fieldHost(block: Block, field: DraftField, source: string): EditHost {
		const slots = parseSlots(source).slots;
		const target: HumanField | null = field === "design" ? null : field;
		const writable = target !== null;
		const write = (next: string): string | null => next === source || target === null ? null : core.edit(REF, block.id, target, source, next);
		const replace = (span: Span, text: string): string | null => write(source.slice(0, span.start) + text + source.slice(span.end));
		return {
			text(id, span, multiline, view) {
				return writable ? editable(id, view, () => source.slice(span.start, span.end), multiline, text => replace(span, text)) : view;
			},
			slot(id, name) {
				const slot = slots.get(name)!;
				const apply = (value: string): string | null => {
					if (value === slot.value) return null;
					if (!writable) return core.requestRevision(REF, block.id, tr(`Change slot “${name}” to “${value}”`, `把槽位「${name}」改为「${value}」`));
					const next = setSlotValue(source, name, value);
					return next === null ? tr(`Slot ${name} does not exist`, `槽位 ${name} 不存在`) : write(next);
				};
				on(id, { click: () => {
					if (pickerBefore === id) { picker = null; return; }
					picker = { anchor: id, slot, apply };
					startEdit("picker.custom", "", false, value => value.trim() ? apply(value.trim()) : null, tr("Custom…", "自定义…"));
				} });
				return el(id, "span", `pb-slot${picker?.anchor === id ? " pb-slot-open" : ""}`, [], { text: slot.value, actions: { click: "invoke" } });
			},
			list(id, span, ordered, start, items) {
				const sortable = ordered && writable && items.length > 1;
				const holding = picked?.list === id ? picked.from : null;
				return el(id, ordered ? "ol" : "ul", "pb-list", items.map((item, index): TspNode => {
					const itemId = `${id}.li${index}`;
					const marker: TspNode = ordered ? el(`${itemId}.num`, "span", "pb-num", [], { text: `${start + index}.` }) : el(`${itemId}.dot`, "span", "pb-bullet", [], { text: "•" });
					const content = el(`${itemId}.text`, "div", "pb-li-text", [item.node]);
					if (!sortable) return el(itemId, "li", "pb-li", [marker, content]);
					const grip = `${itemId}.grip`;
					on(grip, { click: () => { picked = holding === index ? null : { list: id, from: index }; } });
					const target = holding !== null && holding !== index;
					if (target) on(itemId, { click: () => {
						const order = items.map((_, position) => position);
						order.splice(index, 0, ...order.splice(holding, 1));
						picked = null;
						outcome(replace(span, reorderedList(source, span, items, order, start)));
					} });
					return el(itemId, "li", `pb-li${target ? " pb-li-target" : ""}`, [
						{ id: grip, k: "icon", p: { name: "grip", aria: holding === index ? tr("Put down", "放下") : tr("Pick up", "拾起"), actions: { click: "invoke" } } },
						marker, content,
					], { ...(holding === index ? { mark: "pick" } : {}), ...(target ? { actions: { click: "invoke" } } : {}) });
				}));
			},
			chain(id, body, chain) {
				const chosen = node?.chain === id ? node.index : null;
				const parts: TspNode[] = [];
				chain.nodes.forEach((item, index) => {
					if (index > 0) {
						const edge = chain.edges[index - 1]!;
						parts.push(el(`${id}.e${index}`, "div", `pb-arrow${edge.dashed ? " pb-arrow-dashed" : ""}`, [
							el(`${id}.e${index}.glyph`, "span", "", [], { text: edge.dashed ? "┊" : "↓" }),
							...(edge.label ? [el(`${id}.e${index}.label`, "span", "pb-edge-label", [], { text: edge.label })] : []),
						]));
					}
					const nodeId = `${id}.n${index}`;
					if (editing?.id === nodeId) { parts.push(editor(editing)); return; }
					const card = el(nodeId, "div", `pb-node pb-node-${item.shape}${chosen === index ? " pb-node-sel" : ""}`, [], { text: item.label, ...(writable ? { actions: { click: "invoke", dblclick: "edit" } } : {}) });
					parts.push(card);
					if (!writable) return;
					on(nodeId, {
						click: () => { node = chosen === index ? null : { chain: id, index }; },
						dblclick: () => {
							node = { chain: id, index };
							startEdit(nodeId, item.label, false, text => {
								if (item.slot !== null) {
									const next = setSlotValue(source, item.slot, text.trim());
									return next === null ? tr(`Slot ${item.slot} does not exist`, `槽位 ${item.slot} 不存在`) : write(next);
								}
								const next = chain.rename(index, text);
								return next === null ? tr("Node names cannot be empty or duplicated", "节点名称不能为空，也不能与其他节点重名") : replace(body, next);
							});
						},
					});
					if (chosen !== index) return;
					const tools: TspNode[] = [el(`${nodeId}.add`, "span", "pb-tool", [], { text: tr("+ Node below", "+ 下方节点"), actions: { click: "invoke" } })];
					on(`${nodeId}.add`, { click: () => { node = { chain: id, index: index + 1 }; outcome(replace(body, chain.insertAfter(index))); } });
					if (item.slot === null && chain.nodes.length > 2) {
						tools.push(el(`${nodeId}.del`, "span", "pb-tool pb-danger", [], { text: tr("Delete", "删除") }));
						on(`${nodeId}.del`, { click: () => { node = null; const next = chain.remove(index); outcome(next === null ? tr("A flow must keep at least two nodes", "流程至少保留两个节点") : replace(body, next)); } });
					}
					parts.push(el(`${nodeId}.tools`, "div", "pb-node-tools", tools));
				});
				return el(id, "div", "pb-flow", parts);
			},
		};
	}

	function draft(block: Block, field: DraftField, source: string): { readonly nodes: readonly TspNode[]; readonly errors: number } {
		const host: DraftHost = {
			id: `${block.id}.${field}`,
			context: {
				// Resolved per draw, so a theme change redraws figures in the new palette.
				svg: (id, svg, size, alt) => imageNode(id, new TextEncoder().encode(prepareSvg(svg, svgFigurePalette())), "image/svg+xml", alt, size),
				image: (id, bytes, mime, alt) => imageNode(id, bytes, mime, alt),
				readFile: path => readDraftFile(baseDir, path),
			},
			edit: fieldHost(block, field, source),
			view: key => views.get(`${block.id}.${key}`) ?? "changes",
			viewSwitch: (id, key, current) => el(id, "div", "pb-view-switch", VIEWS.map(option => {
				const optionId = `${id}.${option.view}`;
				on(optionId, { click: () => { views.set(`${block.id}.${key}`, option.view); } });
				return el(optionId, "span", `pb-view${current === option.view ? " pb-view-on" : ""}`, [], { text: option.label, actions: { click: "invoke" } });
			})),
		};
		const drawn = renderDraft(source, host);
		// A component that cannot be drawn points here: every problem is listed with its line.
		const problems: TspNode[] = drawn.diagnostics.length === 0 ? [] : [el(`${block.id}.${field}.problems`, "div", "pb-errors", drawn.diagnostics.map((found, index) => ({
			id: `${block.id}.${field}.problem${index}`, k: "text", p: { text: tr(`Line ${found.line} · ${found.component}: ${found.message}`, `第 ${found.line} 行 · ${found.component}：${found.message}`), tone: found.severity === "error" ? "error" : "warning" },
		})))];
		return { nodes: [...drawn.nodes, ...problems], errors: drawn.diagnostics.filter(found => found.severity === "error").length };
	}

	// ------------------------------------------------------------ cards

	function statusIcon(item: BlockView): TspNode | null {
		const block = item.block;
		if (block.progress.kind === "untracked") return null;
		const status = block.progress.status;
		const id = `${block.id}.status`;
		on(id, { click: () => outcome(core.setStatus(REF, block.id, status === "done" ? "todo" : "done")) });
		const label = status === "done" ? tr("Done", "已完成") : status === "running" ? tr("Running", "执行中") : tr("To do", "未完成");
		const glyph: TspNode = status === "done"
			? el(`${id}.ring`, "span", "pb-st-done", [{ id: `${id}.check`, k: "icon", p: { name: "check" } }])
			: status === "running" ? { id: `${id}.spin`, k: "spinner", p: { tone: "pending" } } : el(`${id}.ring`, "span", "pb-st-todo");
		return el(id, "span", "pb-st", [glyph], { title: label, aria: label, actions: { click: "invoke" } });
	}

	function head(item: BlockView, number: string, isOpen: boolean): TspNode {
		const block = item.block;
		const id = `${block.id}.head`;
		const titleId = `${block.id}.title`;
		const toggle = (): void => { open = isOpen ? null : block.id; openChosen = true; menu = null; node = null; picked = null; };
		const title = editing?.id === titleId
			? editor(editing)
			: el(titleId, "span", "pb-title", [], { text: block.title.trim() || tr("Unnamed block", "未命名块"), actions: { click: "invoke", dblclick: "edit" } });
		on(titleId, {
			click: mods => {
				// ⌘-click picks tasks to launch together; a plain click folds the card once no second click follows.
				if (mods.includes("meta")) {
					if (block.content.kind !== "task" || block.progress.kind === "untracked") { notify(tr("Only task blocks can be launched together", "只有任务块能一起启动")); return; }
					if (selected.has(block.id)) selected.delete(block.id); else selected.add(block.id);
					return;
				}
				clearTimeout(titleTimer);
				titleTimer = setTimeout(() => { toggle(); redraw(); }, CLICK_DELAY_MS);
			},
			dblclick: () => { clearTimeout(titleTimer); startEdit(titleId, block.title, false, text => core.edit(REF, block.id, "title", block.title, text)); },
		});
		const chevron = `${block.id}.fold`;
		on(chevron, { click: toggle });
		const status = statusIcon(item);
		const more = `${block.id}.more`;
		if (isOpen) on(more, { click: () => { menu = menu === block.id ? null : block.id; } });
		return el(id, "div", isOpen ? "pb-head pb-open" : "pb-head", [
			el(`${id}.nn`, "span", "pb-nn", [], { text: number }),
			title,
			...(status ? [status] : []),
			el(`${id}.spacer`, "span", "pb-spacer"),
			...(isOpen ? [el(more, "span", "pb-icon-btn", [{ id: `${more}.icon`, k: "icon", p: { name: "more" } }], { aria: tr("More", "更多"), actions: { click: "invoke" } })] : []),
			el(chevron, "span", "pb-icon-btn pb-chev", [{ id: `${chevron}.icon`, k: "icon", p: { name: "chev-r" } }], { aria: isOpen ? tr("Collapse", "收起") : tr("Expand", "展开"), actions: { click: "invoke" } }),
		]);
	}

	function foot(item: BlockView): TspNode | null {
		const block = item.block;
		if (block.content.kind !== "task" || block.progress.kind === "untracked") return null;
		const id = `${block.id}.foot`;
		const rule = el(`${id}.rule`, "div", "pb-rule");
		const progress = block.progress;
		if (progress.status === "done") {
			// The completion report the subagent wrote replaces the SUBAGENT row; it starts folded.
			const toggleId = `${id}.report.toggle`;
			const unfolded = reports.has(block.id);
			on(toggleId, { click: () => { if (unfolded) reports.delete(block.id); else reports.add(block.id); } });
			if (progress.report === null) return el(id, "div", "pb-foot", [rule, el(`${id}.report.none`, "div", "pb-comment", [el(`${id}.report.none.text`, "span", "", [], { text: `// ${tr("No completion report", "没有完成报告")}` })])]);
			return el(id, "div", "pb-foot", [
				rule,
				el(toggleId, "div", "pb-report-toggle", [{ id: `${toggleId}.icon`, k: "icon", p: { name: unfolded ? "chev" : "chev-r" } }, el(`${toggleId}.text`, "span", "", [], { text: tr("Completion report", "完成报告") })], { actions: { click: "invoke" } }),
				...(unfolded ? [el(`${id}.report`, "div", "pb-report", [{ id: `${id}.report.text`, k: "md", p: { text: progress.report } }])] : []),
			]);
		}
		const content = block.content;
		const agentId = `${id}.agent`;
		on(agentId, { click: () => {
			if (agentMenu === block.id) { agentMenu = null; return; }
			agentMenu = block.id;
			core.requestAgents();
		} });
		const agent = el(agentId, "div", `pb-val pb-select${agentMenu === block.id ? " pb-select-open" : ""}`, [
			el(`${agentId}.value`, "span", "pb-select-value", [], { text: content.agent ?? tr("Default", "默认") }),
			{ id: `${agentId}.chev`, k: "icon", p: { name: "chev" } },
		], { aria: tr("Choose subagent", "选择 subagent"), actions: { click: "invoke" } });
		const isolatedId = `${id}.isolated`;
		on(isolatedId, { dblclick: () => outcome(core.setIsolated(REF, block.id, !(content.isolated ?? false))) });
		const launchId = `${id}.launch`;
		const running = progress.status === "running";
		if (running) on(launchId, { click: () => outcome(core.requestStop(REF, block.id)) });
		else if (!item.launchPending) on(launchId, { click: () => outcome(core.requestLaunch(REF, [block.id])) });
		return el(id, "div", "pb-foot", [
			rule,
			el(`${id}.grid`, "div", "pb-grid2", [
				el(`${id}.agent.col`, "div", "", [el(`${id}.agent.label`, "div", "pb-label", [], { text: "SUBAGENT" }), agent]),
				el(`${id}.isolated.col`, "div", "", [el(`${id}.isolated.label`, "div", "pb-label", [], { text: tr("ISOLATED WORKTREE", "独立 WORKTREE") }), el(isolatedId, "div", "pb-val", [], { text: content.isolated ? tr("Yes", "是") : tr("No", "否"), actions: { dblclick: "edit" } })]),
			]),
			el(launchId, "div", `pb-launch${running ? " pb-launch-stop" : item.launchPending ? " pb-launch-off" : ""}`, [], { text: running ? tr("Stop", "打断执行") : item.launchPending ? tr("Launch requested", "已请求启动") : tr("Launch", "启动"), ...(item.launchPending && !running ? {} : { actions: { click: "invoke" } }) }),
		]);
	}

	/** A field a person writes (task body, design requirement): drawn like any text, edited part by part, double-click to start when empty. */
	function personText(block: Block, field: HumanField & DraftField, source: string, placeholder: string, label: string): { readonly nodes: readonly TspNode[]; readonly errors: number } {
		if (source.trim()) return draft(block, field, source);
		const id = `${block.id}.${field}.empty`;
		return { nodes: [editable(id, el(`${id}.view`, "div", "pb-placeholder", [], { text: placeholder }), () => "", true, text => core.edit(REF, block.id, field, source, text), label)], errors: 0 };
	}

	/** A design card: the person's requirement, the coordinator's design, and the line that sends a change request. */
	function designBody(block: Block, content: Extract<Block["content"], { kind: "design" }>): { nodes: TspNode[]; errors: number } {
		const requirement = personText(block, "requirement", content.requirement, tr("// Double-click to write the requirement", "// 双击写需求"), tr("Requirement", "需求"));
		const drawn = content.design.trim() ? draft(block, "design", content.design) : { nodes: [el(`${block.id}.design.empty`, "div", "pb-placeholder", [], { text: tr("// The coordinator has not written a design yet", "// 协调者还没有写设计") })], errors: 0 };
		const requestId = `${block.id}.request`;
		const request = editable(requestId, el(`${requestId}.view`, "div", "pb-comment", [el(`${requestId}.slash`, "span", "pb-comment-slash", [], { text: "//" }), el(`${requestId}.text`, "span", "", [], { text: tr("Double-click to write a change request; Enter sends it to the coordinator", "双击写修改要求，回车发给协调者") })]), () => "", true, text => {
			if (!text.trim()) return null;
			const error = core.requestRevision(REF, block.id, text);
			if (!error) notify(tr("Change request sent to coordinator", "修改要求已发给协调者"), "success");
			return error;
		}, tr("Write to the coordinator: what to change and what it should become", "写给协调者：哪里要改、改成什么"));
		return { nodes: [el(`${block.id}.requirement.lead`, "div", "pb-lead", [...requirement.nodes]), ...drawn.nodes, request], errors: requirement.errors + drawn.errors };
	}

	/** Every block is drawn for its render status; only the open card's body is mounted. */
	function card(item: BlockView, number: string): TspNode {
		const block = item.block;
		const isOpen = open === block.id;
		const drawn = block.content.kind === "task"
			? personText(block, "body", block.content.body, tr("// Double-click to write the body", "// 双击写正文"), tr("Body", "正文"))
			: designBody(block, block.content);
		const md: string[] = [], images: string[] = [];
		const collect = (child: TspNode): void => {
			if (child.k === "md" && typeof child.p?.text === "string") md.push(child.p.text);
			if (child.k === "image" && typeof child.p?.alt === "string") images.push(child.p.alt);
			child.c?.forEach(collect);
		};
		drawn.nodes.forEach(collect);
		summaries.set(block.id, { view: { md, images }, draftErrors: drawn.errors });
		const bottom = isOpen ? foot(item) : null;
		// The same rule as the `outline` check, said where the text is.
		const outlined = isOpen ? outlinedText(block.content) : null;
		const outline = outlined === null ? [] : outlineProblems(outlined);
		const outlineNode: TspNode[] = outline.length === 0 ? [] : [el(`${block.id}.outline`, "div", "pb-errors", outline.map((problem, index) => ({
			id: `${block.id}.outline${index}`, k: "text", p: { text: tr(`Where/What/How · ${problem}`, `Where/What/How · ${problem}`), tone: "warning" },
		})))];
		return {
			id: `${block.id}.card`, k: "card",
			p: { head: `${block.id}.head`, selected: isOpen, ...(selected.has(block.id) ? { mark: "pick" } : {}) },
			c: [head(item, number, isOpen), ...(isOpen ? [el(`${block.id}.body`, "div", "pb-body", [...drawn.nodes, ...outlineNode, ...(bottom ? [bottom] : [])])] : [])],
		};
	}

	// ------------------------------------------------------------ regions

	function main(view: DocView): TspNode {
		const titleId = "doc.title";
		const title = editing?.id === titleId
			? editor(editing)
			: el(titleId, "span", "", [], { text: view.title.trim() || tr("Unnamed Playbook", "未命名 Playbook"), actions: { dblclick: "edit" } });
		on(titleId, { dblclick: () => startEdit(titleId, view.title, false, text => core.setTitle(REF, view.title, text)) });
		const errors = [...core.errors(), ...view.errors, ...(renderError ? [renderError] : [])];
		let number = 0;
		const cards = view.blocks.map(item => card(item, item.block.progress.kind === "untracked" ? "--" : String(++number).padStart(2, "0")));
		return { id: "main.view", k: "col", c: [el("app", "div", "pb-app", [
			el("doc", "div", "pb-doc-title", [el("doc.hash", "span", "pb-hash", [], { text: "##" }), title]),
			...(errors.length ? [el("errors", "div", "pb-errors", errors.map((error, index) => ({ id: `errors.${index}`, k: "text", p: { text: error, tone: "error" } })))] : []),
			cards.length ? el("cards", "div", "pb-cards", cards) : el("empty", "div", "pb-empty", [], { text: tr("This Playbook has no blocks yet: ask the coordinator to add one with playbook_edit.", "这份 Playbook 还没有块：让协调者用 playbook_edit 加一个。") }),
		])] };
	}

	function dock(view: DocView): TspNode {
		const tracked = view.blocks.filter(item => item.block.progress.kind === "tracked");
		const done = tracked.filter(item => item.block.progress.kind === "tracked" && item.block.progress.status === "done").length;
		const online = core.coordinator().connected;
		on("status.coordinator", { click: () => {
			if (online) { void core.focusCoordinator().then(error => { outcome(error); redraw(); }); return; }
			if (coordPicker.kind !== "closed") { coordPicker = { kind: "closed" }; return; }
			openCoordPicker();
		} });
		const rows: TspNode[] = [];
		const chosen = view.blocks.filter(item => selected.has(item.block.id)).map(item => item.block.id);
		if (chosen.length) {
			on("bar.launch", { click: () => { const error = core.requestLaunch(REF, chosen); outcome(error); if (!error) selected.clear(); } });
			on("bar.clear", { click: () => selected.clear() });
			rows.push(el("bar", "div", "pb-bar", [
				el("bar.launch", "div", "pb-launch", [], { text: tr(`Launch ${chosen.length} block${chosen.length === 1 ? "" : "s"} together`, `一起启动 ${chosen.length} 块`), actions: { click: "invoke" } }),
				el("bar.clear", "div", "pb-ghost", [], { text: tr("Cancel", "取消"), actions: { click: "invoke" } }),
			]));
		}
		rows.push({ id: "status", k: "status", c: [
			{ id: "status.coordinator", k: "seg", p: { spans: [{ t: "● ", s: online ? "success" : "warning" }, { t: online ? tr("Coordinator online", "协调者在线") : tr("Coordinator offline · choose one", "协调者离线 · 选择协调者") }], actions: { click: "invoke" } } },
			{ id: "status.done", k: "seg", p: { side: "right", text: tr(`${done} / ${tracked.length} done`, `${done} / ${tracked.length} 已完成`) } },
		] });
		return { id: "dock.view", k: "col", c: rows };
	}

	/** Ask Tern and the omp sessions for the candidates now; the list is shown, never kept as truth. */
	function openCoordPicker(): void {
		const opened = { kind: "loading" } as const;
		coordPicker = opened;
		void coordinators.list().then(listed => {
			if (coordPicker !== opened) return;
			coordPicker = listed.ok ? { kind: "listed", panes: listed.panes } : { kind: "failed", error: listed.error };
			redraw();
		});
	}
	/** Run one picker action; the picker shows what it is doing until the owner answers. */
	function coordWork(text: string, work: () => Promise<{ readonly error: string | null; readonly done: string }>): void {
		if (coordPicker.kind === "working") return;
		coordPicker = { kind: "working", text };
		void work().then(result => {
			coordPicker = { kind: "closed" };
			if (result.error) notify(result.error); else notify(result.done, "success");
			redraw();
		});
	}
	function coordOptions(): TspNode[] {
		const notice = (text: string): TspNode => el("coord.notice", "div", "pb-opt-note pb-opt-notice", [], { text });
		const nodes: TspNode[] = [el("coord.head", "div", "pb-label pb-opt-notice", [], { text: tr("Choose a coordinator: panes running omp in this window", "选择协调者：本窗口里运行 omp 的面板") })];
		switch (coordPicker.kind) {
			case "closed": return [];
			case "loading": nodes.push(notice(tr("Reading panes from Tern…", "正在向 Tern 读取面板…"))); break;
			case "working": nodes.push(notice(coordPicker.text)); return nodes;
			case "failed": nodes.push(notice(coordPicker.error)); break;
			case "listed": {
				if (coordPicker.panes.length === 0) nodes.push(notice(tr("No pane running omp in this window", "这个窗口里没有运行 omp 的面板")));
				coordPicker.panes.forEach((pane, index) => {
					const id = `coord.o${index}`;
					const where = [pane.place === null ? null : `${pane.place.session} · ${tr("tab", "标签页")} ${pane.place.tab}`, pane.cwd || null].filter(part => part !== null).join(" · ");
					if (pane.loaded) on(id, { click: () => coordWork(tr(`Connecting “${pane.title || "omp"}”…`, `正在让「${pane.title || "omp"}」连接…`), async () => {
						const chosen = await coordinators.choose(pane.pane);
						switch (chosen.kind) {
							case "paired": return { error: null, done: tr("Connected as coordinator; the Playbook pane is now on its right", "已连接为协调者，Playbook 面板已移到它的右侧") };
							case "attachFailed": return { error: tr(`Unable to connect: ${chosen.error}`, `没有连上：${chosen.error}`), done: "" };
							case "moveFailed": return { error: tr(`Connected as coordinator, but moving the pane failed: ${chosen.error}`, `已连接为协调者，但移动面板失败：${chosen.error}`), done: "" };
						}
					}) });
					nodes.push(el(id, "div", `pb-opt${pane.loaded ? "" : " pb-opt-stale"}`, [
						el(`${id}.row`, "div", "pb-opt-row", [el(`${id}.label`, "span", "pb-opt-label", [], { text: pane.title || "omp" })]),
						el(`${id}.note`, "span", "pb-opt-note", [], { text: pane.loaded ? where : tr(`${where} · This omp session has not loaded omp-playbooks support for choosing a coordinator (restart the session after upgrading)`, `${where} · 这个 omp 会话没有加载支持选择协调者的 omp-playbooks（升级后需重启该会话）`) }),
					], pane.loaded ? { actions: { click: "invoke" } } : {}));
				});
				break;
			}
		}
		on("coord.new", { click: () => coordWork(tr("Creating a new session…", "正在新建会话…"), async () => {
			const started = await coordinators.newSession();
			return started.ok ? { error: null, done: tr("Created a new omp session on the left and sent the initialization prompt; it will show as online when it connects", "已在左侧新建 omp 会话并发送初始化提示；它连上后这里显示协调者在线") } : { error: tr(`Could not create a new session: ${started.error}`, `新建会话失败：${started.error}`), done: "" };
		}) });
		nodes.push(el("coord.new", "div", "pb-opt", [
			el("coord.new.row", "div", "pb-opt-row", [el("coord.new.label", "span", "pb-opt-label", [], { text: tr("New session", "新建会话") })]),
			el("coord.new.note", "span", "pb-opt-note", [], { text: tr("Open omp on the left and send the initialization prompt to open this Playbook", "在左侧新开 omp，发送初始化提示让它打开这份 Playbook") }),
		], { actions: { click: "invoke" } }));
		return nodes;
	}

	/** The SUBAGENT dropdown: 默认, then what the coordinator's session can launch, as it last answered. */
	function agentOptions(block: BlockId, current: string | null): TspNode[] {
		const choose = (id: string, label: string, value: string | null, note = ""): TspNode => {
			on(id, { click: () => { agentMenu = null; outcome(core.setAgent(REF, block, value)); } });
			return el(id, "div", `pb-opt${value === current ? " pb-opt-on" : ""}`, [
				el(`${id}.row`, "div", "pb-opt-row", [el(`${id}.label`, "span", "pb-opt-label", [], { text: label })]),
				...(note ? [el(`${id}.note`, "span", "pb-opt-note", [], { text: note })] : []),
			], { actions: { click: "invoke" } });
		};
		const notice = (text: string): TspNode => el("agents.notice", "div", "pb-opt-note pb-opt-notice", [], { text });
		const list = core.agents();
		const options: TspNode[] = [choose("agents.default", tr("Default", "默认"), null, tr("Not specified; the coordinator's omp uses its default subagent", "不指定，由协调者的 omp 用默认 subagent"))];
		switch (list.kind) {
			case "offline": options.push(notice(tr("The coordinator is offline, so available subagents cannot be listed", "协调者离线，无法列出可用的 subagent"))); break;
			case "unasked": case "pending": options.push(notice(tr("Reading available subagents from the coordinator…", "正在向协调者读取可用的 subagent…"))); break;
			case "unavailable": options.push(notice(list.reason)); break;
			case "listed": list.names.forEach((name, index) => options.push(choose(`agents.o${index}`, name, name))); break;
		}
		// A saved name the session no longer lists stays visible; it is never rewritten behind the person's back.
		if (current !== null && !(list.kind === "listed" && list.names.includes(current))) {
			options.push(el("agents.current", "div", "pb-opt pb-opt-on pb-opt-stale", [
				el("agents.current.row", "div", "pb-opt-row", [el("agents.current.label", "span", "pb-opt-label", [], { text: current })]),
				el("agents.current.note", "span", "pb-opt-note", [], { text: list.kind === "listed" ? tr("Current setting; the coordinator's omp cannot launch it now", "当前设置；协调者的 omp 现在不能启动它") : tr("Current setting", "当前设置") }),
			]));
		}
		return options;
	}

	function layer(view: DocView): TspNode {
		const children: TspNode[] = [];
		if (menu !== null && view.blocks.some(item => item.block.id === menu)) {
			const block = menu;
			on("menu.delete", { click: () => { menu = null; if (open === block) open = null; outcome(core.deleteBlock(REF, block)); } });
			children.push({ id: "menu", k: "overlay", p: { anchor: { node: `${block}.more` }, size: "sm" }, c: [el("menu.delete", "div", "pb-menu-item pb-danger", [], { text: tr("Delete block", "删除此块"), actions: { click: "invoke" } })] });
		}
		const agentItem = agentMenu === null ? undefined : view.blocks.find(item => item.block.id === agentMenu);
		if (agentItem && open === agentItem.block.id && agentItem.block.content.kind === "task" && agentItem.block.progress.kind === "tracked" && agentItem.block.progress.status !== "done") {
			children.push({ id: "agents", k: "overlay", p: { anchor: { node: `${agentItem.block.id}.foot.agent` }, size: "sm" }, c: agentOptions(agentItem.block.id, agentItem.block.content.agent ?? null) });
		}
		// Only while offline: a hello arriving meanwhile is the answer, and the picker goes away.
		if (coordPicker.kind !== "closed" && !core.coordinator().connected) {
			children.push({ id: "coord", k: "overlay", p: { anchor: { node: "status.coordinator" }, size: "sm" }, c: coordOptions() });
		}
		if (picker) {
			const current = picker;
			const options = current.slot.options.map((option, index): TspNode => {
				const id = `picker.o${index}`;
				on(id, { click: () => { editing = null; picker = null; outcome(current.apply(option.label)); } });
				return el(id, "div", `pb-opt${option.label === current.slot.value ? " pb-opt-on" : ""}`, [
					el(`${id}.row`, "div", "pb-opt-row", [
						el(`${id}.label`, "span", "pb-opt-label", [], { text: option.label }),
						...(option.kind === "recommended" ? [{ id: `${id}.suggest`, k: "badge", p: { text: tr("Recommended", "建议"), tone: "accent" } }] : []),
						...(option.kind === "past" ? [el(`${id}.past`, "span", "pb-opt-past", [], { text: tr("Previously proposed", "曾提出") })] : []),
					]),
					...(option.note ? [el(`${id}.note`, "span", "pb-opt-note", [], { text: option.note })] : []),
				], { actions: { click: "invoke" } });
			});
			children.push({ id: "picker", k: "overlay", p: { anchor: { node: current.anchor }, size: "sm" }, c: [...options, ...(editing?.id === "picker.custom" ? [editor(editing)] : [])] });
		}
		return { id: "layer.view", k: "col", c: children };
	}

	// ------------------------------------------------------------ frames

	/**
	 * Frame facts (`blockError`, `pendingOverdue`) come from `tsp.status`; only the open card is mounted,
	 * so a closed card keeps the facts of the last frame that mounted it.
	 */
	function reportStatus(blocks: readonly string[]): void {
		for (const item of core.view(REF).blocks) {
			const summary = summaries.get(item.block.id);
			if (summary && blocks.includes(item.block.id)) core.setRenderStatus(REF, item.block.id, { ...tsp.status(item.block.id), ...summary });
		}
	}
	/**
	 * Region roots are added once; each redraw replaces their one child. A toast is its own child of
	 * the layer, added once and removed by the next one, so redraws never show it again.
	 */
	function redraw(): void {
		if (!opened) return;
		const view = core.view(REF);
		handlers.clear();
		const present = new Set(view.blocks.map(item => item.block.id));
		for (const id of selected) if (!present.has(id)) selected.delete(id);
		if (open !== null && !present.has(open)) open = null;
		if (!openChosen && open === null) open = view.blocks[0]?.block.id ?? null;
		const regions = [main(view), dock(view), layer(view)];
		const field = editing ? `${editing.id}.edit` : null;
		const ops: FrameOp[] = [];
		if (!mounted) for (const region of ["main", "dock", "layer"]) ops.push(["add", region, SURFACE, null, { id: region, k: "col" }]);
		regions.forEach((node, index) => {
			if (mounted) ops.push(["del", node.id]);
			ops.push(["add", node.id, ["main", "dock", "layer"][index]!, null, node]);
		});
		if (toast && toast.n !== shownToast) {
			if (shownToast !== null) ops.push(["del", `toast.${shownToast}`]);
			ops.push(["add", `toast.${toast.n}`, "layer", null, { id: `toast.${toast.n}`, k: "toast", p: { text: toast.text, tone: toast.tone } }]);
			shownToast = toast.n;
		}
		ops.push(["focus", field]);
		const s = tsp.frame(ops, open !== null ? [open] : []);
		mounted = true;
		tsp.fullRedraw(s);
		reportStatus(view.blocks.map(item => item.block.id));
	}
	function updateField(): void {
		if (!editing) return;
		tsp.frame([["set", `${editing.id}.edit`, { text: editing.text, cursor: editing.caret.cursor, anchor: editing.caret.anchor }]], []);
	}
	function applyText(next: string, cursor: number, anchor: number | null = null, remember = true): void {
		if (!editing) return;
		if (next !== editing.text && remember) editing.undo.push({ text: editing.text, caret: editing.caret });
		editing.text = next;
		editing.caret = { cursor: Math.max(0, Math.min(next.length, cursor)), anchor };
		updateField();
	}
	function undoEdit(): void {
		const step = editing?.undo.pop();
		if (step) applyText(step.text, step.caret.cursor, step.caret.anchor, false);
	}
	function nativeEdit(event: Extract<TspEvent, { ev: "edit" }>): void {
		if (!editing || event.id !== `${editing.id}.edit` || event.len !== editing.text.length) return;
		applyText(editing.text.slice(0, event.from) + event.text + editing.text.slice(event.to), event.cursor);
	}

	// ------------------------------------------------------------ keys

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
	/** Enter, Ctrl+Enter and Esc end the edit and apply it; Shift+Enter is a new line in a multi-line field. */
	function key(bytes: string): void {
		const kitty = /^\x1b\[(\d+)(?:;(\d+)(?::(\d+))?)?u$/.exec(bytes);
		if (kitty) {
			if (kitty[3] === "3") return; // Key release is not a second edit.
			const code = Number(kitty[1]), modifiers = Number(kitty[2] ?? 1) - 1;
			if (code === 13 && modifiers === 1 && editing?.multiline) { insert("\n"); return; }
			if (code === 13 || code === 27) { end(); return; }
			if (code === 118 && modifiers === 4) { pasteClipboardImage(); return; } // Ctrl+V, as omp pastes an image.
			if (modifiers > 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return;
			bytes = String.fromCodePoint(code);
		}
		if (bytes === ESC || bytes === "\r" || bytes === "\n") { end(); return; }
		// Ctrl+V without the kitty protocol, and a paste carrying no text (the clipboard holds only an image).
		if (bytes === "\x16" || bytes === `${ESC}[200~${ESC}[201~`) { pasteClipboardImage(); return; }
		// Cmd+V of copied image files arrives as their paths, typed all at once.
		const pasted = bytes.startsWith(`${ESC}[200~`) && bytes.endsWith(`${ESC}[201~`) ? bytes.slice(6, -6) : bytes;
		const files = pasted.includes("/") ? pastedImagePaths(pasted.trim()) : null;
		if (files) { pasteImageFiles(files); redraw(); return; }
		if (!editing) return;
		const text = editing.text;
		const caret = editing.caret;
		let cursor = caret.cursor;
		let from = caret.anchor === null ? cursor : Math.min(cursor, caret.anchor);
		let to = caret.anchor === null ? cursor : Math.max(cursor, caret.anchor);
		if (bytes === "\x7f" || bytes === "\b") { if (from === to) from = previous(text, from); applyText(text.slice(0, from) + text.slice(to), from); return; }
		if (bytes === `${ESC}[3~`) { if (from === to) to = following(text, to); applyText(text.slice(0, from) + text.slice(to), from); return; }
		if (bytes === `${ESC}[D`) cursor = caret.anchor === null ? previous(text, cursor) : from;
		else if (bytes === `${ESC}[C`) cursor = caret.anchor === null ? following(text, cursor) : to;
		else if (bytes === `${ESC}[H` || bytes === "\x01") cursor = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
		else if (bytes === `${ESC}[F` || bytes === "\x05") { const stop = text.indexOf("\n", cursor); cursor = stop < 0 ? text.length : stop; }
		else if (bytes === "\x1a") { undoEdit(); return; }
		else if (bytes.startsWith(`${ESC}[200~`) && bytes.endsWith(`${ESC}[201~`)) { insert(bytes.slice(6, -6).replace(/\r\n?/g, "\n")); return; }
		else if (!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(bytes)) { insert(bytes); return; }
		else return;
		applyText(text, cursor);
	}
	function insert(value: string): void {
		if (!editing) return;
		const inserted = editing.multiline ? value : value.replace(/\n/g, " ");
		const caret = editing.caret;
		const from = caret.anchor === null ? caret.cursor : Math.min(caret.cursor, caret.anchor);
		const to = caret.anchor === null ? caret.cursor : Math.max(caret.cursor, caret.anchor);
		applyText(editing.text.slice(0, from) + inserted + editing.text.slice(to), from + inserted.length);
	}
	/** Enter or Esc: apply the edit; with nothing being edited, Esc closes the menu, the picker and a picked item. */
	function end(): void {
		if (editing) finishEdit();
		else { menu = null; agentMenu = null; picker = null; picked = null; node = null; if (coordPicker.kind !== "working") coordPicker = { kind: "closed" }; }
		redraw();
	}

	// ------------------------------------------------------------ events

	function event(input: TspEvent): void {
		switch (input.ev) {
			case "action": {
				const handler = handlers.get(input.id);
				const click = input.act === "invoke" ? handler?.click : undefined;
				const dblclick = input.act === "edit" ? handler?.dblclick : undefined;
				if (!click && !dblclick) break;
				pickerBefore = picker?.anchor ?? null;
				// Acting anywhere else ends the edit in progress and applies it; the picker's own options take over its field.
				if (editing && !(editing.id === "picker.custom" && input.id.startsWith("picker."))) finishEdit();
				if (click) click(input.mods);
				else dblclick?.();
				if (!input.id.startsWith("picker.") && !input.id.endsWith(".more") && !input.id.startsWith("menu.")) menu = null;
				if (!input.id.startsWith("agents.") && !input.id.endsWith(".foot.agent")) agentMenu = null;
				if (coordPicker.kind !== "working" && !input.id.startsWith("coord.") && input.id !== "status.coordinator") coordPicker = { kind: "closed" };
				redraw();
				break;
			}
			case "edit": nativeEdit(input); break;
			case "undo": undoEdit(); break;
			case "focus": break;
			case "theme": void setTheme(input.dark ? "dark" : "light").then(result => { if (!result.success) renderError = result.error ?? tr("Theme switch failed", "主题切换失败"); redraw(); }); break;
			case "error": if (input.s === undefined) { renderError = input.msg ?? tr("Tern rendering error", "Tern 渲染错误"); redraw(); } break;
			case "ack": case "toggle": case "change": case "other": break;
		}
	}
	function input(value: TspInput): void {
		switch (value.kind) {
			case "hello": void setTheme(value.dark ? "dark" : "light").then(result => {
				if (!result.success) renderError = result.error ?? tr("Theme initialization failed", "主题初始化失败");
				if (!opened) { tsp.open(SURFACE, "Playbooks", SURFACE_CSS); opened = true; }
				redraw();
			}); break;
			case "event": event(value.event); break;
			case "keys": keys(value.bytes); break;
		}
	}
	core.onChange(() => queueMicrotask(redraw));
	tsp.onStatusChange(reportStatus);
	tsp.start("omp-playbooks", input);
}

function previous(text: string, offset: number): number { if (offset <= 0) return 0; const last = text.charCodeAt(offset - 1); return offset > 1 && last >= 0xdc00 && last <= 0xdfff ? offset - 2 : offset - 1; }
function following(text: string, offset: number): number { if (offset >= text.length) return text.length; const first = text.charCodeAt(offset); return first >= 0xd800 && first <= 0xdbff ? offset + 2 : offset + 1; }
