// Interface between the TSP IO layer (src/service/tsp.ts) and the form UI (src/service/ui.ts).
// TSP framing: APC `ESC _ tsp;<verb>;<json> ESC \` (see /tmp/pb-form/LockProbe/svc.ts).

export type TspNode = { readonly id: string; readonly k: string; readonly p?: Record<string, unknown>; readonly c?: readonly TspNode[] };

/** Frame operations sent with verb `f`. */
export type FrameOp =
	| readonly ["add", string, string, string | null, TspNode]
	| readonly ["del", string]
	| readonly ["set", string, Record<string, unknown>]
	| readonly ["focus", string | null]
	/** Scroll a node into view; Tern reads every position but `start` as `nearest`. */
	| readonly ["reveal", string, "start" | "nearest"];

export type TspEvent =
	| { readonly ev: "ack"; readonly s: number }
	| { readonly ev: "error"; readonly s?: number; readonly op?: number; readonly msg?: string }
	| { readonly ev: "theme"; readonly dark: boolean }
	| { readonly ev: "focus"; readonly id: string }
	| { readonly ev: "action"; readonly id: string; readonly act: string; readonly mods: readonly string[] }
	| { readonly ev: "change"; readonly id: string; readonly checked?: boolean; readonly value?: string; readonly text?: string }
	| { readonly ev: "edit"; readonly id: string; readonly from: number; readonly to: number; readonly text: string; readonly cursor: number; readonly len: number }
	| { readonly ev: "undo"; readonly id: string }
	| { readonly ev: "toggle"; readonly id: string; readonly collapsed: boolean; readonly key?: string }
	| { readonly ev: "other"; readonly body: unknown };

export type TspInput = { readonly kind: "hello"; readonly dark: boolean } | { readonly kind: "event"; readonly event: TspEvent } | { readonly kind: "keys"; readonly bytes: string };

/** Per-block render facts the TSP layer derives from frames, acks and errors (contracts.md K4 块检查的输入). */
export interface FrameStatus {
	readonly blockError: boolean;
	readonly documentError: boolean;
	readonly pendingOverdue: boolean;
}

export interface TspSession {
	/** Send the hello query (features edit, undo) and start reading stdin in raw mode. */
	start(app: string, onInput: (input: TspInput) => void): void;
	/** Open the screen surface and its stylesheet. */
	open(surface: string, title: string, css: string): void;
	/** Send a blob with verb `b` before any frame that references it. */
	blob(id: string, mime: string, bytes: Uint8Array): void;
	/**
	 * Send a frame; returns its sequence number `s`. `blocks` lists the block ids whose nodes
	 * the frame contains (node ids start with `<block id>.`), used for ack/error mapping.
	 */
	frame(ops: readonly FrameOp[], blocks: readonly string[]): number;
	/** Render facts for one block; `pendingOverdue` uses a 2 s threshold. */
	status(block: string): FrameStatus;
	/** Called after a full redraw: clears document-level errors once that redraw is acked. */
	fullRedraw(s: number): void;
	/** Subscribe to status changes (ack, error, 2 s timer) so checks can be recomputed. */
	onStatusChange(listener: (blocks: readonly string[]) => void): void;
}
