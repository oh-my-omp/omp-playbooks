// Contract between the design-draft document parser (src/service/draft/document.ts), the
// component modules (src/service/draft/<component>.ts) and the TSP renderer.
// Draft syntax follows answer-me-with-html's draft format (`am help <component>`).
import type { TspNode } from "../tsp-types";
import type { AskSpec } from "./ask";

/** One finding about a design draft; `line` is 1-based in the design text. */
export interface DraftDiagnostic {
	readonly line: number;
	readonly severity: "error" | "warning";
	/** Component name (`flow`, `kv`, …) or `draft` for document-level syntax. */
	readonly component: string;
	readonly message: string;
}

/** A fenced component's source: the fence arguments and the lines between the fences. */
export interface FenceInput {
	/** Text after the fence language, trimmed (`LR`, `cols=2`, `warn Caution`, `ts src=a.ts lines=1-4`). */
	readonly args: string;
	readonly lines: readonly string[];
	/** 1-based line of `lines[0]` in the design text (the line after the opening fence). */
	readonly line: number;
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
	/**
	 * Selection controls for an `ask`: its options as inputs and a submit button, owned by the UI.
	 * Absent when the draft is drawn without interaction (the checks' hidden pass); the ask is then shown statically.
	 */
	askControl?(id: string, spec: AskSpec): readonly TspNode[];
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
