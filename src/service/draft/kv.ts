import { diagnostic, type DraftDiagnostic, type FenceInput, type Parsed, type RenderContext, type Rendered } from "./contract";
import { inlineSpans } from "./text";
import type { TspNode } from "../tsp-types";

export interface KvSpec {
	readonly cols: number;
	readonly items: readonly {
		readonly kind: "item" | "wide";
		readonly key: string;
		readonly value: string;
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
		const text = input.lines[index]!.trim();
		if (!text || text.startsWith("//")) continue;
		const kind = text.startsWith("*") ? "wide" : "item";
		const body = kind === "wide" ? text.slice(1).trim() : text;
		const match = /^([^:：]+)[:：]\s*(.*)$/.exec(body);
		if (!match) {
			diagnostics.push(diagnostic("kv", input.line + index, "缺少键名或冒号；请写 key: value。"));
			continue;
		}
		items.push({ kind, key: match[1]!.trim(), value: match[2]!.trim() });
	}
	if (items.length === 0) {
		if (diagnostics.length === 0) diagnostics.push(diagnostic("kv", input.line, "至少需要一项；请写 key: value。"));
		return { ok: false, diagnostics };
	}
	return { ok: true, value: { cols, items }, diagnostics };
}

export function renderKv(spec: KvSpec, ctx: RenderContext): Rendered {
	// am's grammar: a bordered cell grid, muted label above its value; a `*` item spans the row with a stronger value.
	const cells = spec.items.map((item, index): TspNode => ({
		id: `${ctx.id}.item.${index}`, k: "el",
		p: { tag: "div", class: item.kind === "wide" ? "am-kv-cell am-kv-wide" : "am-kv-cell" },
		c: [
			{ id: `${ctx.id}.item.${index}.key`, k: "el", p: { tag: "span", class: "am-kv-key", text: item.key } },
			{ id: `${ctx.id}.item.${index}.value`, k: "text", p: { spans: inlineSpans(item.value, item.kind === "wide" ? "strong" : "") } },
		],
	}));
	return { nodes: [{ id: `${ctx.id}.grid`, k: "el", p: { tag: "div", class: `am-kv am-kv-${spec.cols}` }, c: cells }], diagnostics: [] };
}
