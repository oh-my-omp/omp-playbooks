// Component dispatch and whole-draft rendering. Every fence name maps to exactly one module; any
// other fence language is a code block (am: "Any other fence language is a code block").
import type { TspNode } from "../tsp-types";
import { parseAnnot, renderAnnot } from "./annot";
import { parseAsk, renderAsk, type AskSpec } from "./ask";
import { parseCallout, renderCallout } from "./callout";
import { parseCode, renderCode } from "./code";
import { diagnostic, type ChangeView, type DraftDiagnostic, type FenceInput, type Parsed, type RenderContext, type Rendered } from "./contract";
import { parseDiff, renderDiff } from "./diff";
import { parseDocument, type Panel, type Segment } from "./document";
import { parseEr, renderEr } from "./er";
import { parseFlow, renderFlow } from "./flow";
import { parseHtml, renderHtml } from "./html";
import { parseImage, renderImage } from "./image";
import { parseKv, renderKv } from "./kv";
import { parseLimits, renderLimits } from "./limits";
import { parseSequence, renderSequence } from "./sequence";
import { parseSvg, renderSvg } from "./svg";
import { parseTable, renderTable } from "./table";
import { parseTimeline, renderTimeline } from "./timeline";
import { parseTree, renderTree } from "./tree";

/** Largest component body drawn; longer ones are a diagnostic instead of a stalled pane. */
const MAX_FENCE_LINES = 1000;

/** One parsed segment, ready to draw. `marked` components offer the before/changes/after views. */
interface Built {
	readonly diagnostics: readonly DraftDiagnostic[];
	readonly marked: boolean;
	render(ctx: RenderContext): Rendered;
}

function built<T>(component: string, line: number, parsed: Parsed<T>, render: (spec: T, ctx: RenderContext) => Rendered, marked: (spec: T) => boolean = () => false): Built {
	if (!parsed.ok) {
		return {
			diagnostics: parsed.diagnostics,
			marked: false,
			render: ctx => ({ nodes: [{ id: `${ctx.id}.failed`, k: "text", p: { text: `${component} 无法绘制（第 ${line} 行起）：见下方稿件问题`, tone: "error" } }], diagnostics: [] }),
		};
	}
	const spec = parsed.value;
	return { diagnostics: parsed.diagnostics, marked: marked(spec), render: ctx => render(spec, ctx) };
}

function fence(name: string, input: FenceInput, line: number): Built {
	switch (name) {
		case "flow": return built(name, line, parseFlow(input), renderFlow, spec => spec.marked);
		case "er": return built(name, line, parseEr(input), renderEr, spec => spec.marked);
		case "tree": return built(name, line, parseTree(input), renderTree, spec => spec.marked);
		case "sequence": return built(name, line, parseSequence(input), renderSequence);
		case "timeline": return built(name, line, parseTimeline(input), renderTimeline);
		case "limits": return built(name, line, parseLimits(input), renderLimits);
		case "annot": return built(name, line, parseAnnot(input), renderAnnot);
		case "kv": return built(name, line, parseKv(input), renderKv);
		case "callout": return built(name, line, parseCallout(input), renderCallout);
		case "ask": return built(name, line, parseAsk(input), renderAsk);
		case "diff": return built(name, line, parseDiff(input), renderDiff);
		case "html": return built(name, line, parseHtml(input), renderHtml);
		case "svg": return built(name, line, parseSvg(input), renderSvg);
		default: return built("code", line, parseCode({ ...input, args: [name, input.args].filter(Boolean).join(" ") }), renderCode);
	}
}

function build(segment: Segment): Built {
	switch (segment.kind) {
		case "markdown": return { diagnostics: [], marked: false, render: ctx => ({ nodes: [{ id: `${ctx.id}.md`, k: "md", p: { text: segment.text } }], diagnostics: [] }) };
		case "fence":
			// A drawing beyond this size is unreadable and its layout would stall the pane.
			if (segment.input.lines.length > MAX_FENCE_LINES) return { diagnostics: [diagnostic(segment.name || "code", segment.line, `组件超过 ${MAX_FENCE_LINES} 行：拆成几个较小的组件`)], marked: false, render: ctx => ({ nodes: [{ id: `${ctx.id}.failed`, k: "text", p: { text: `第 ${segment.line} 行的组件过大，未绘制`, tone: "error" } }], diagnostics: [] }) };
			return fence(segment.name, segment.input, segment.line);
		case "table": return built("table", segment.input.line, parseTable(segment.input), renderTable);
		case "image": return built("image", segment.input.line, parseImage(segment.input), renderImage);
	}
}

function lineOf(segment: Segment): number {
	return segment.kind === "markdown" || segment.kind === "fence" ? segment.line : segment.input.line;
}

/** Every parse-time finding of a draft (document syntax and each component), by line. */
export function draftDiagnostics(design: string): DraftDiagnostic[] {
	const document = parseDocument(design);
	const found = [...document.diagnostics];
	for (const segment of [...document.lead, ...document.panels.flatMap(panel => panel.segments)]) found.push(...build(segment).diagnostics);
	return found.sort((a, b) => a.line - b.line);
}

/** What the UI supplies for drawing a draft. */
export interface DraftHost {
	/** Prefix for every node id. */
	readonly id: string;
	readonly context: Omit<RenderContext, "id" | "view" | "askControl">;
	view(key: string): ChangeView;
	/** A control switching the view of `key` (the UI owns the state and the event). */
	viewSwitch(id: string, key: string, current: ChangeView): TspNode;
	/** Selection controls for the `ask` whose stable key is `key`; omitted to draw asks without interaction. */
	askControl?(id: string, key: string, spec: AskSpec): readonly TspNode[];
}

export interface DraftRender {
	readonly nodes: readonly TspNode[];
	/** Parse-time and render-time findings, by line. */
	readonly diagnostics: readonly DraftDiagnostic[];
}

/** Draw a whole design draft: header, lead and panels (a wrapping grid for `sheet`, one column for `doc`). */
export function renderDraft(design: string, host: DraftHost): DraftRender {
	const document = parseDocument(design);
	const diagnostics: DraftDiagnostic[] = [...document.diagnostics];
	const segmentNodes = (prefix: string, segments: readonly Segment[]): TspNode[] => segments.flatMap((segment, index) => {
		const item = build(segment);
		diagnostics.push(...item.diagnostics);
		const id = `${prefix}.${index}`;
		// The view key follows the segment's line so it survives edits elsewhere in the draft.
		const key = `${lineOf(segment)}`;
		const view = item.marked ? host.view(key) : "changes";
		let rendered: Rendered;
		try {
			const askControl = host.askControl;
			rendered = item.render({ ...host.context, id, view, ...(askControl ? { askControl: (controlId: string, spec: AskSpec) => askControl(controlId, key, spec) } : {}) });
		} catch (error) {
			// A renderer bug stays inside its component: the rest of the draft still draws.
			const message = error instanceof Error ? error.message : String(error);
			rendered = { nodes: [{ id: `${id}.failed`, k: "text", p: { text: `第 ${lineOf(segment)} 行的组件绘制失败：${message}`, tone: "error" } }], diagnostics: [diagnostic("draft", lineOf(segment), `组件绘制失败：${message}`)] };
		}
		diagnostics.push(...rendered.diagnostics);
		return item.marked ? [host.viewSwitch(`${id}.view`, key, view), ...rendered.nodes] : [...rendered.nodes];
	});
	const meta = document.meta;
	const header: TspNode[] = [];
	if (meta.title !== null) header.push({ id: `${host.id}.title`, k: "text", p: { spans: [{ t: meta.title, s: "strong" }] } });
	if (meta.subtitle !== null) header.push({ id: `${host.id}.subtitle`, k: "text", p: { text: meta.subtitle, tone: "muted" } });
	if (meta.extra.length > 0) header.push({ id: `${host.id}.meta`, k: "kv", p: { layout: "inline", items: meta.extra.map(item => ({ k: item.key, v: item.value })) } });
	const lead = segmentNodes(`${host.id}.lead`, document.lead);
	// Node ids follow panel position, not panel ID: a draft may repeat an ID (a diagnostic) and Tern drops frames with duplicate ids.
	const panel = (item: Panel, index: number): TspNode => {
		const head = item.bare ? undefined : [item.id, item.title].filter(Boolean).join(" ") + (item.meta ? ` · ${item.meta}` : "");
		const body = segmentNodes(`${host.id}.p${index}`, item.segments);
		const sheet = meta.template === "sheet";
		return {
			id: `${host.id}.p${index}.card`, k: "card",
			p: { ...(head === undefined ? { variant: "bare" } : { head }), ...(sheet ? { grow: Math.min(item.span ?? 1, meta.cols), basis: 0 } : {}) },
			c: [{ id: `${host.id}.p${index}.body`, k: "col", p: { gap: "sm" }, c: body }],
		};
	};
	// A sheet fills rows of `cols` columns; a panel's span takes that many columns (am's grid).
	const rows: Panel[][] = [];
	let used = meta.cols;
	for (const item of document.panels) {
		const span = Math.min(item.span ?? 1, meta.cols);
		if (used + span > meta.cols) { rows.push([]); used = 0; }
		rows.at(-1)!.push(item);
		used += span;
	}
	const panels = document.panels.map(panel);
	const byPanel = new Map(document.panels.map((item, index) => [item, panels[index]!]));
	const grid: TspNode = meta.template === "sheet"
		? { id: `${host.id}.panels`, k: "col", p: { gap: "sm" }, c: rows.map((items, index) => {
			const spans = items.reduce((total, item) => total + Math.min(item.span ?? 1, meta.cols), 0);
			// A short last row keeps the column width by padding with an empty growing spacer.
			const pad: TspNode[] = spans < meta.cols ? [{ id: `${host.id}.row${index}.pad`, k: "spacer", p: { grow: meta.cols - spans, basis: 0 } }] : [];
			return { id: `${host.id}.row${index}`, k: "row", p: { gap: "sm", align: "start" }, c: [...items.map(item => byPanel.get(item)!), ...pad] };
		}) }
		: { id: `${host.id}.panels`, k: "col", p: { gap: "sm" }, c: panels };
	return { nodes: [...header, ...lead, ...(panels.length ? [grid] : [])], diagnostics: diagnostics.sort((a, b) => a.line - b.line) };
}
