import { tr } from "../../i18n";
import { diagnostic, type DraftDiagnostic, type FenceInput, type Parsed, type RenderContext, type Rendered } from "./contract";
import { escapeXml, inlineSpans, plainText, textWidth, wrapText } from "./text";
import type { TspNode } from "../tsp-types";

interface TimelineItem {
	readonly time: string;
	readonly title: string;
	readonly note: string;
	readonly highlight: boolean;
}

/** `timeline [h|v]`: ordered `time | title | note` events; `*time` highlights an event. */
export interface TimelineSpec {
	readonly direction: "horizontal" | "vertical";
	readonly items: readonly TimelineItem[];
}

export function parseTimeline(input: FenceInput): Parsed<TimelineSpec> {
	const items: TimelineItem[] = [];
	const diagnostics: DraftDiagnostic[] = [];
	for (const [index, raw] of input.lines.entries()) {
		const text = raw.trim();
		if (!text || text.startsWith("//")) continue;
		const parts = text.split("|").map(part => part.trim());
		if (parts.length < 2 || !parts[1]) {
			diagnostics.push(diagnostic("timeline", input.line + index, tr("A timeline item needs a title, in the format: time | title | note (optional)", "时间线条目需包含标题，格式：时间 | 标题 | 备注（可选）")));
			continue;
		}
		const time = parts[0]!;
		const highlight = time.startsWith("*");
		items.push({ time: highlight ? time.slice(1).trim() : time, title: parts[1], note: parts[2] ?? "", highlight });
	}
	if (diagnostics.length) return { ok: false, diagnostics };
	if (!items.length) {
		return { ok: false, diagnostics: [diagnostic("timeline", input.line, tr("A timeline needs at least one item, e.g. now | Ship | Live", "时间线至少需要一项，例如：现在 | 发布 | 已上线"))] };
	}
	const vertical = /\bv(ertical)?\b/.test(input.args) || (!/\bh(orizontal)?\b/.test(input.args) && items.length > 6);
	return { ok: true, value: { direction: vertical ? "vertical" : "horizontal", items }, diagnostics };
}

// The shared word wrapper preserves long unspaced words. Split only those overflowing
// lines locally so URLs/identifiers, like CJK labels, stay inside their timeline cell.
function labelLines(text: string, width: number, fontSize: number): string[] {
	return wrapText(text, width, fontSize).flatMap(line => {
		if (textWidth(line, fontSize) <= width) return [line];
		const lines: string[] = [];
		let chunk = "";
		for (const char of line) {
			if (chunk && textWidth(chunk + char, fontSize) > width) {
				lines.push(chunk.trimEnd());
				chunk = char.trimStart();
			} else chunk += char;
		}
		if (chunk) lines.push(chunk.trimEnd());
		return lines;
	});
}

// One <text> per line: Tern's SVG renderer draws no <tspan> text.
function svgLabel(lines: readonly string[], x: number, y: number, fontSize: number, color: string, strong = false): string {
	return lines.map((line, index) => `<text x="${x}" y="${y + index * (fontSize + 5)}" fill="${color}" font-size="${fontSize}"${strong ? ' font-weight="600"' : ""}>${escapeXml(line)}</text>`).join("");
}

export function renderTimeline(spec: TimelineSpec, ctx: RenderContext): Rendered {
	if (spec.direction === "vertical") {
		const rows: TspNode[] = spec.items.map((item, index) => {
			const id = `${ctx.id}.item.${index}`;
			const content: TspNode[] = [{ id: `${id}.title`, k: "text", p: { spans: inlineSpans(item.title, item.highlight ? "strong accent" : "strong") } }];
			if (item.note) content.push({ id: `${id}.note`, k: "text", p: { spans: inlineSpans(item.note, "muted") } });
			return {
				id, k: "row", p: { gap: 12 }, c: [
					{ id: `${id}.time`, k: "badge", p: { text: item.time, tone: item.highlight ? "accent" : "muted" } },
					{ id: `${id}.content`, k: "col", p: { gap: 4 }, c: content },
				],
			};
		});
		return { nodes: [{ id: `${ctx.id}.timeline`, k: "col", p: { gap: 16 }, c: rows }], diagnostics: [] };
	}

	const width = Math.min(960, Math.max(240, spec.items.length * 200 + 32));
	const cellWidth = (width - 32) / spec.items.length;
	const labelWidth = cellWidth - 20;
	const labels = spec.items.map(item => ({
		time: labelLines(item.time, labelWidth, 12),
		title: labelLines(plainText(item.title), labelWidth, 14),
		note: item.note ? labelLines(plainText(item.note), labelWidth, 12) : [],
	}));
	const timeHeight = Math.max(...labels.map(label => label.time.length)) * 17;
	const axisY = timeHeight + 24;
	const titleY = axisY + 32;
	const height = titleY + Math.max(...labels.map(label => label.title.length * 19 + (label.note.length ? 6 + label.note.length * 17 : 0))) + 16;
	const center = (index: number): number => 16 + (index + 0.5) * cellWidth;
	const drawing = [`<line x1="${center(0)}" y1="${axisY}" x2="${center(spec.items.length - 1)}" y2="${axisY}" stroke="var(--border)" stroke-width="2"/>`];
	for (const [index, item] of spec.items.entries()) {
		const x = center(index);
		const label = labels[index]!;
		const color = item.highlight ? "var(--accent)" : "var(--fg)";
		drawing.push(svgLabel(label.time, x, axisY - 18 - (label.time.length - 1) * 17, 12, item.highlight ? color : "var(--muted)", item.highlight));
		if (item.highlight) drawing.push(`<circle cx="${x}" cy="${axisY}" r="10" fill="var(--surface)" stroke="var(--accent)" stroke-width="2"/>`);
		drawing.push(`<circle cx="${x}" cy="${axisY}" r="5" fill="${item.highlight ? color : "var(--muted)"}"/>`);
		drawing.push(svgLabel(label.title, x, titleY, 14, color, true));
		if (label.note.length) drawing.push(svgLabel(label.note, x, titleY + label.title.length * 19 + 6, 12, "var(--muted)"));
	}
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif" text-anchor="middle">${drawing.join("")}</svg>`;
	const alt = spec.items.map(item => `${item.highlight ? "★ " : ""}${item.time}: ${plainText(item.title)}${item.note ? ` — ${plainText(item.note)}` : ""}`).join("; ");
	return { nodes: [ctx.svg(`${ctx.id}.timeline`, svg, { w: width, h: height }, alt)], diagnostics: [] };
}
