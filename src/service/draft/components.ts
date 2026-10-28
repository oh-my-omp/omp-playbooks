import { tr } from "../../i18n";
// Component dispatch and whole-text rendering. Every fence name maps to exactly one module; any
// other fence language is a code block (am: "Any other fence language is a code block"). Task
// bodies and design drafts are drawn the same way; the host decides what a person may change.
import type { TspNode } from "../tsp-types";
import { parseAnnot, renderAnnot } from "./annot";
import { parseCallout, renderCallout } from "./callout";
import { parseCode, renderCode } from "./code";
import { diagnostic, type ChangeView, type DraftDiagnostic, type EditHost, type FenceInput, type Parsed, type RenderContext, type Rendered } from "./contract";
import { parseDiff, renderDiff } from "./diff";
import { parseDocument, type Panel, type Segment } from "./document";
import { parseEr, renderEr } from "./er";
import { parseFlow, renderFlow } from "./flow";
import { parseHtml, renderHtml } from "./html";
import { parseImage, renderImage } from "./image";
import { parseKv, renderKv } from "./kv";
import { parseLimits, renderLimits } from "./limits";
import { linkedHeading, renderMarkdown } from "./markdown";
import { parseSequence, renderSequence } from "./sequence";
import { parseSlot, parseSlots } from "./slot";
import { parseSvg, renderSvg } from "./svg";
import { parseTable, renderTable } from "./table";
import { parseTimeline, renderTimeline } from "./timeline";
import { parseTree, renderTree } from "./tree";

/** Largest component body drawn; longer ones are a diagnostic instead of a stalled pane. */
const MAX_FENCE_LINES = 1000;
/** Components that make their own parts editable; every other segment is edited as its whole source. */
const SELF_EDITING: Readonly<Record<string, true>> = { flow: true, kv: true, callout: true, slot: true };

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
			render: ctx => ({ nodes: [{ id: `${ctx.id}.failed`, k: "text", p: { text: tr(`${component} cannot be drawn (starting at line ${line}); see draft problems below`, `${component} 无法绘制（第 ${line} 行起）：见下方稿件问题`), tone: "error" } }], diagnostics: [] }),
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
		// A slot declaration draws nothing: its `{{name}}` uses show and switch its value.
		case "slot": return built(name, line, parseSlot(input), () => ({ nodes: [], diagnostics: [] }));
		case "diff": return built(name, line, parseDiff(input), renderDiff);
		case "html": return built(name, line, parseHtml(input), renderHtml);
		case "svg": return built(name, line, parseSvg(input), renderSvg);
		default: return built("code", line, parseCode({ ...input, args: [name, input.args].filter(Boolean).join(" ") }), renderCode);
	}
}

function build(segment: Segment): Built {
	switch (segment.kind) {
		case "markdown": return { diagnostics: [], marked: false, render: ctx => ({ nodes: renderMarkdown(ctx, segment.lines), diagnostics: [] }) };
		case "fence":
			// A drawing beyond this size is unreadable and its layout would stall the pane.
			if (segment.input.lines.length > MAX_FENCE_LINES) return { diagnostics: [diagnostic(segment.name || "code", segment.line, tr(`Component exceeds ${MAX_FENCE_LINES} lines; split it into several smaller components`, `组件超过 ${MAX_FENCE_LINES} 行：拆成几个较小的组件`))], marked: false, render: ctx => ({ nodes: [{ id: `${ctx.id}.failed`, k: "text", p: { text: tr(`The component at line ${segment.line} is too large and was not drawn`, `第 ${segment.line} 行的组件过大，未绘制`), tone: "error" } }], diagnostics: [] }) };
			return fence(segment.name, segment.input, segment.line);
		case "table": return built("table", segment.input.line, parseTable(segment.input), renderTable);
		case "image": return built("image", segment.input.line, parseImage(segment.input), renderImage);
	}
}

function lineOf(segment: Segment): number {
	return segment.kind === "markdown" || segment.kind === "fence" ? segment.line : segment.input.line;
}

/** Every parse-time finding of a text (document syntax, each component, slot uses), by line. */
export function draftDiagnostics(text: string): DraftDiagnostic[] {
	const document = parseDocument(text);
	const found = [...document.diagnostics, ...parseSlots(text).diagnostics];
	for (const segment of [...document.lead, ...document.panels.flatMap(panel => panel.segments)]) found.push(...build(segment).diagnostics);
	return found.sort((a, b) => a.line - b.line);
}

/** What the UI supplies for drawing a text. */
export interface DraftHost {
	/** Prefix for every node id. */
	readonly id: string;
	readonly context: Pick<RenderContext, "svg" | "image" | "readFile">;
	readonly edit: EditHost;
	view(key: string): ChangeView;
	/** A control switching the view of `key` (the UI owns the state and the event). */
	viewSwitch(id: string, key: string, current: ChangeView): TspNode;
}

export interface DraftRender {
	readonly nodes: readonly TspNode[];
	/** Parse-time and render-time findings, by line. */
	readonly diagnostics: readonly DraftDiagnostic[];
}

/** Draw a whole text: header, lead and panels, one column of headed sections. */
export function renderDraft(text: string, host: DraftHost): DraftRender {
	const document = parseDocument(text);
	const { slots, diagnostics: slotDiagnostics } = parseSlots(text);
	const diagnostics: DraftDiagnostic[] = [...document.diagnostics, ...slotDiagnostics];
	const segmentNodes = (prefix: string, segments: readonly Segment[]): TspNode[] => segments.flatMap((segment, index) => {
		const item = build(segment);
		diagnostics.push(...item.diagnostics);
		const id = `${prefix}.${index}`;
		// The view key follows the segment's line so it survives edits elsewhere in the text.
		const key = `${lineOf(segment)}`;
		const view = item.marked ? host.view(key) : "changes";
		let rendered: Rendered;
		try {
			rendered = item.render({ ...host.context, id, view, slots, edit: host.edit });
		} catch (error) {
			// A renderer bug stays inside its component: the rest of the text still draws.
			const message = error instanceof Error ? error.message : String(error);
			rendered = { nodes: [{ id: `${id}.failed`, k: "text", p: { text: tr(`Component drawing failed at line ${lineOf(segment)}: ${message}`, `第 ${lineOf(segment)} 行的组件绘制失败：${message}`), tone: "error" } }], diagnostics: [diagnostic("draft", lineOf(segment), tr(`Component drawing failed: ${message}`, `组件绘制失败：${message}`))] };
		}
		diagnostics.push(...rendered.diagnostics);
		const nodes = segment.kind === "markdown" || (segment.kind === "fence" && SELF_EDITING[segment.name] === true) || rendered.nodes.length === 0
			? [...rendered.nodes]
			: [host.edit.text(`${id}.source`, segment.kind === "fence" ? segment.input.body : segment.span, true, { id: `${id}.drawing`, k: "col", c: rendered.nodes })];
		return item.marked ? [host.viewSwitch(`${id}.view`, key, view), ...nodes] : nodes;
	});
	const meta = document.meta;
	const header: TspNode[] = [];
	if (meta.title !== null) header.push({ id: `${host.id}.title`, k: "el", p: { tag: "h3", class: "pb-draft-title", text: meta.title } });
	if (meta.subtitle !== null) header.push({ id: `${host.id}.subtitle`, k: "el", p: { tag: "p", class: "pb-draft-subtitle", text: meta.subtitle } });
	if (meta.extra.length > 0) header.push({ id: `${host.id}.meta`, k: "kv", p: { layout: "inline", items: meta.extra.map(item => ({ k: item.key, v: item.value })) } });
	const lead = segmentNodes(`${host.id}.lead`, document.lead);
	// Node ids follow panel position, not panel ID: a text may repeat an ID (a diagnostic) and Tern drops frames with duplicate ids.
	const panel = (item: Panel, index: number): TspNode => {
		const id = `${host.id}.p${index}`;
		const head: TspNode[] = item.bare ? [] : [{ id: `${id}.head`, k: "el", p: { tag: "div", class: "pb-ph" }, c: [
			...(item.explicit ? [{ id: `${id}.letter`, k: "el", p: { tag: "span", class: "pb-ph-id", text: item.id } }] : []),
			host.edit.text(`${id}.heading`, item.titleSpan, false, linkedHeading(host, `${id}.heading.view`, item.title, "span", "pb-ph-title") ?? { id: `${id}.heading.view`, k: "el", p: { tag: "span", class: "pb-ph-title", text: item.title } }),
			...(item.meta ? [{ id: `${id}.meta`, k: "el", p: { tag: "span", class: "pb-ph-meta", text: item.meta } }] : []),
		] }];
		return { id, k: "el", p: { tag: "section", class: "pb-section" }, c: [...head, ...segmentNodes(`${id}.s`, item.segments)] };
	};
	return { nodes: [{ id: `${host.id}.doc`, k: "el", p: { tag: "article", class: "pb-draft" }, c: [...header, ...lead, ...document.panels.map(panel)] }], diagnostics: diagnostics.sort((a, b) => a.line - b.line) };
}
