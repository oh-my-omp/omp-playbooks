import { tr } from "../../i18n";
import type { TspNode } from "../tsp-types";
import { diagnostic, type DraftDiagnostic, type FenceInput, type Parsed, type RenderContext, type Rendered } from "./contract";
import { inlineSpans } from "./text";

type LimitsRow = {
	readonly label: string;
	readonly limit: number;
	readonly unit: string;
	readonly note: string;
} & (
	| { readonly kind: "measured"; readonly value: number }
	| { readonly kind: "limit" }
);

export interface LimitsSpec {
	readonly rows: readonly LimitsRow[];
}

function numberField(text: string): number | undefined {
	const match = /^(?:max\s+)?(-?\d+(?:\.\d+)?)$/i.exec(text);
	if (!match) return undefined;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : undefined;
}

export function parseLimits(input: FenceInput): Parsed<LimitsSpec> {
	const rows: LimitsRow[] = [];
	const diagnostics: DraftDiagnostic[] = [];
	let content = false;
	for (const [index, raw] of input.lines.entries()) {
		const text = raw.trim();
		if (!text || text.startsWith("//")) continue;
		content = true;
		const line = input.line + index;
		const fields = text.split("|").map(field => field.trim());
		const [label = "", measure = "", unit = "", note = ""] = fields;
		if (fields.length > 4) {
			diagnostics.push(diagnostic("limits", line, tr("Extra fields are not displayed; use: Label | value / limit | unit | note", "多余字段未显示，请改为：标签 | 数值 / 上限 | 单位 | 备注"), "warning"));
		}
		if (!label || !measure) {
			diagnostics.push(diagnostic("limits", line, tr("A label or value is missing; complete: Label | 13 / 20 | unit", "缺少标签或数值，请补全：标签 | 13 / 20 | 单位")));
			continue;
		}
		const parts = measure.split("/").map(part => part.trim());
		if (parts.length > 2 || parts.some(part => !part)) {
			diagnostics.push(diagnostic("limits", line, tr("The value format is incomplete; use: Label | 13 / 20 | unit, or Label | max 20 | unit", "数值格式不完整，请改为：标签 | 13 / 20 | 单位，或 标签 | max 20 | 单位")));
			continue;
		}
		const first = numberField(parts[0]!);
		const second = parts.length === 2 ? numberField(parts[1]!) : first;
		if (first === undefined || second === undefined) {
			diagnostics.push(diagnostic("limits", line, tr("The value and limit must be finite numbers; use: Label | 13 / 20 | unit, or Label | max 20 | unit", "数值和上限必须是有限数字，请改为：标签 | 13 / 20 | 单位，或 标签 | max 20 | 单位")));
			continue;
		}
		rows.push(parts.length === 2
			? { kind: "measured", label, value: first, limit: second, unit, note }
			: { kind: "limit", label, limit: first, unit, note });
	}
	if (!content) diagnostics.push(diagnostic("limits", input.line, tr("At least one line is required; add: Label | 13 / 20 | unit", "至少需要一行，请添加：标签 | 13 / 20 | 单位")));
	return rows.length ? { ok: true, value: { rows }, diagnostics } : { ok: false, diagnostics };
}

export function renderLimits(spec: LimitsSpec, ctx: RenderContext): Rendered {
	const nodes: TspNode[] = spec.rows.map((row, index) => {
		const id = `${ctx.id}.row.${index}`;
		const over = row.kind === "measured" && row.value > row.limit;
		const ratio = row.kind === "limit" ? 1
			: row.value < 0 || row.limit < 0 ? 0
			: row.limit === 0 ? 1
			: Math.min(1, Math.max(0, row.value / row.limit));
		const amount = row.kind === "measured" ? `${row.value} / ${row.limit}` : `max ${row.limit}`;
		const children: TspNode[] = [
			{ id: `${id}.label`, k: "text", p: { spans: inlineSpans(row.label, over ? "error" : "") } },
			{ id: `${id}.meter`, k: "meter", p: { value: ratio, label: amount + (row.unit ? ` ${row.unit}` : ""), tone: over ? "error" : "accent" } },
		];
		if (row.note) children.push({ id: `${id}.note`, k: "text", p: { spans: inlineSpans(row.note, "muted") } });
		return { id, k: "col", p: { gap: 1 }, c: children };
	});
	return { nodes, diagnostics: [] };
}
