import { diagnostic, type DraftDiagnostic, type FenceInput, type Parsed, type RenderContext, type Rendered, type Span } from "./contract";
import { inlineText } from "./markdown";
import type { TspNode } from "../tsp-types";

export interface KvSpec {
	readonly cols: number;
	readonly items: readonly {
		readonly kind: "item" | "wide";
		readonly key: string;
		readonly value: string;
		/** Where the key and the value are written. */
		readonly keySpan: Span;
		readonly valueSpan: Span;
	}[];
}

export function parseKv(input: FenceInput): Parsed<KvSpec> {
	const diagnostics: DraftDiagnostic[] = [];
	let cols = 2;
	// Match am's attribute tokens, including quoted values and last-value wins.
	let columnValue: string | undefined;
	for (const match of input.args.matchAll(/([\w-]+)(?:=("[^"]*"|'[^']*'|\S+))?/g)) {
		if (match[1] !== "cols") continue;
		const raw = match[2];
		columnValue = raw === undefined ? "1" : /^["']/.test(raw) ? raw.slice(1, -1) : raw;
	}
	if (columnValue !== undefined) {
		const count = Number(columnValue);
		if (!Number.isFinite(count) || !Number.isInteger(count)) {
			diagnostics.push(diagnostic("kv", Math.max(1, input.line - 1), "列数须为整数；请写 cols=2。"));
		} else cols = Math.max(1, Math.min(count || 2, 6));
	}

	const items: KvSpec["items"][number][] = [];
	for (let index = 0; index < input.lines.length; index++) {
		const raw = input.lines[index]!;
		const text = raw.trim();
		if (!text || text.startsWith("//")) continue;
		const kind = text.startsWith("*") ? "wide" : "item";
		const body = kind === "wide" ? text.slice(1).trim() : text;
		const match = /^([^:：]+)[:：]\s*(.*)$/.exec(body);
		if (!match) {
			diagnostics.push(diagnostic("kv", input.line + index, "缺少键名或冒号；请写 key: value。"));
			continue;
		}
		const key = match[1]!.trim();
		const value = match[2]!.trim();
		const lineStart = input.starts[index]!;
		const keyAt = raw.indexOf(key);
		const valueAt = value ? raw.lastIndexOf(value) : raw.length;
		items.push({
			kind, key, value,
			keySpan: { start: lineStart + keyAt, end: lineStart + keyAt + key.length },
			valueSpan: { start: lineStart + valueAt, end: lineStart + valueAt + value.length },
		});
	}
	if (items.length === 0) {
		if (diagnostics.length === 0) diagnostics.push(diagnostic("kv", input.line, "至少需要一项；请写 key: value。"));
		return { ok: false, diagnostics };
	}
	return { ok: true, value: { cols, items }, diagnostics };
}

export function renderKv(spec: KvSpec, ctx: RenderContext): Rendered {
	// A two-column grid: muted keys, values beside them; a `*` item spans the row with a stronger value.
	const cells = spec.items.flatMap((item, index): TspNode[] => {
		const id = `${ctx.id}.item.${index}`;
		return [
			ctx.edit.text(`${id}.key`, item.keySpan, false, { id: `${id}.key.view`, k: "el", p: { tag: "span", class: "pb-kv-key", text: item.key } }),
			ctx.edit.text(`${id}.value`, item.valueSpan, false, inlineText(ctx, `${id}.value.view`, item.value, "span")),
		].map((node, position) => ({ id: `${id}.${position ? "v" : "k"}`, k: "el", p: { tag: "div", class: position ? `pb-kv-v${item.kind === "wide" ? " pb-kv-wide" : ""}` : "pb-kv-k" }, c: [node] }));
	});
	return { nodes: [{ id: `${ctx.id}.grid`, k: "el", p: { tag: "div", class: "pb-kv" }, c: cells }], diagnostics: [] };
}
