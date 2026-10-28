// Contract between the design-draft document parser (src/service/draft/document.ts), the
// component modules (src/service/draft/<component>.ts) and the TSP renderer.
// Draft syntax follows answer-me-with-html's draft format (`am help <component>`).
import type { Target } from "../../domain/model";
import type { TspNode } from "../tsp-types";
import type { SlotDecl } from "./slot";

/** One finding about a design draft; `line` is 1-based in the design text. */
export interface DraftDiagnostic {
	readonly line: number;
	readonly severity: "error" | "warning";
	/** Component name (`flow`, `kv`, …) or `draft` for document-level syntax. */
	readonly component: string;
	readonly message: string;
}

/** A UTF-16 range of the drawn text (a task body, a design draft). */
export interface Span {
	readonly start: number;
	readonly end: number;
}

/** One line of the drawn text and where it starts. */
export interface SourceLine {
	readonly text: string;
	/** UTF-16 offset of the line start. */
	readonly offset: number;
}

/** A fenced component's source: the fence arguments and the lines between the fences. */
export interface FenceInput {
	/** Text after the fence language, trimmed (`LR`, `cols=2`, `warn Caution`, `ts src=a.ts lines=1-4`). */
	readonly args: string;
	readonly lines: readonly string[];
	/** 1-based line of `lines[0]` in the design text (the line after the opening fence). */
	readonly line: number;
	/** UTF-16 offset of each of `lines` in the drawn text. */
	readonly starts: readonly number[];
	/** The range of `lines` (empty at the body's place when there are none). */
	readonly body: Span;
}

/** Result of parsing one component. `ok: false` means nothing can be drawn; its diagnostics say why. */
export type Parsed<T> =
	| { readonly ok: true; readonly value: T; readonly diagnostics: readonly DraftDiagnostic[] }
	| { readonly ok: false; readonly diagnostics: readonly DraftDiagnostic[] };

/** Change marker at the start of a line (`+ ` added, `- ` removed, `~ ` changed). */
export type Change = "same" | "added" | "removed" | "changed";

/** Which view of a component with change markers to draw: all changes marked, or the plain diagram as it was / will be. */
export type ChangeView = "changes" | "before" | "after";

export type FileRead =
	| { readonly ok: true; readonly bytes: Uint8Array; /** Absolute path that was read. */ readonly path: string }
	| { readonly ok: false; readonly error: string };

/** A renderer's output: nodes to draw, plus findings only known while rendering (a missing file, an oversized image). */
export interface Rendered {
	readonly nodes: readonly TspNode[];
	readonly diagnostics: readonly DraftDiagnostic[];
}

/** One item of a Markdown list: the item's whole source and its drawn content. */
export interface ListItem {
	readonly span: Span;
	readonly node: TspNode;
}

/** One node of a flow drawn as a chain of cards. */
export interface ChainNode {
	/** The node's name as written, `{{slot}}` included. */
	readonly name: string;
	/** What the card shows: the name, or a slot's current value. */
	readonly label: string;
	readonly shape: "rect" | "round" | "diamond" | "cylinder";
	/** The slot a `{{name}}` node shows; renaming it picks that slot's value. */
	readonly slot: string | null;
}

/**
 * A flow that is one path of nodes (no branches, groups or change markers), drawn as cards a person
 * edits. Each operation returns the fence's new body text, or null when it cannot apply.
 */
export interface FlowChain {
	readonly nodes: readonly ChainNode[];
	/** `edges[i]` joins `nodes[i]` and `nodes[i + 1]`. */
	readonly edges: readonly { readonly dashed: boolean; readonly label: string }[];
	rename(index: number, name: string): string | null;
	insertAfter(index: number): string;
	remove(index: number): string | null;
}

/**
 * What a drawing may do with the text it came from; the UI implements it for one block field.
 * Renderers draw what is written and leave every interaction to the host.
 */
export interface EditHost {
	/** `view` drawn for the text in `span`, edited in place on double-click. */
	text(id: string, span: Span, multiline: boolean, view: TspNode): TspNode;
	/** The current value of slot `name`, as the control that switches it. */
	slot(id: string, name: string): TspNode;
	/** A Markdown list; the items of an ordered one can be picked up and placed elsewhere. */
	list(id: string, span: Span, ordered: boolean, start: number, items: readonly ListItem[]): TspNode;
	/** A flow drawn as a chain of cards; `body` is the fence body its operations replace. */
	chain(id: string, body: Span, chain: FlowChain): TspNode;
	/** A `((target))` reference written in prose (`text` is its source), drawn as a link to `target` named by `alias`, else by the target. */
	reference(id: string, text: string, target: Target, alias: string | null): TspNode;
}

/**
 * What a renderer may use. Renderers are pure apart from these calls: no Core, socket or UI state.
 * Every node id a renderer creates must be unique and start with `${ctx.id}.`.
 */
export interface RenderContext {
	readonly id: string;
	readonly view: ChangeView;
	/**
	 * An `image` node drawing SVG source. Colors written as `var(--name)` resolve to the reader's
	 * theme: fg, muted, border, accent, success, warning, error, surface, c1…c6. `size` is the SVG's
	 * width and height in user units (1 unit ≈ 1px; font-size 14 ≈ body text).
	 */
	svg(id: string, svg: string, size: { readonly w: number; readonly h: number }, alt: string): TspNode;
	/** An `image` node for file bytes (`image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`, `image/svg+xml`). */
	image(id: string, bytes: Uint8Array, mime: string, alt: string): TspNode;
	/** Read a file by a path relative to the Playbook's directory (or absolute); refuses paths outside that directory. */
	readFile(path: string): FileRead;
	/** The slots the drawn text declares, by name. */
	readonly slots: ReadonlyMap<string, SlotDecl>;
	readonly edit: EditHost;
}

/** Split a leading change marker (`+ `, `- `, `~ `) off `text`. */
export function takeMarker(text: string): { readonly change: Change; readonly text: string } {
	const match = /^([+\-~]) (.*)$/s.exec(text);
	if (!match) return { change: "same", text };
	return { change: match[1] === "+" ? "added" : match[1] === "-" ? "removed" : "changed", text: match[2]! };
}

export function diagnostic(component: string, line: number, message: string, severity: DraftDiagnostic["severity"] = "error"): DraftDiagnostic {
	return { line, severity, component, message };
}
