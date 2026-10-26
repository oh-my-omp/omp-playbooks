import { tr } from "../../i18n";
import type { TspNode } from "../tsp-types";
import { diagnostic, takeMarker, type Change, type ChangeView, type DraftDiagnostic, type FenceInput, type Parsed, type RenderContext, type Rendered } from "./contract";
import { escapeXml, inlineSpans, plainText, textWidth, wrapText, type Span } from "./text";

interface TreeItem {
	readonly line: number;
	readonly label: string;
	readonly note: string;
	readonly highlight: boolean;
	readonly change: Change;
	readonly children: readonly TreeItem[];
}

export interface TreeSpec {
	readonly roots: readonly TreeItem[];
	readonly layout: "org" | "list" | "columns";
	readonly marked: boolean;
}

interface BuildingItem {
	readonly line: number;
	readonly indent: number;
	readonly label: string;
	readonly note: string;
	readonly highlight: boolean;
	readonly change: Change;
	readonly children: BuildingItem[];
}

export function parseTree(input: FenceInput): Parsed<TreeSpec> {
	const roots: BuildingItem[] = [];
	const stack: BuildingItem[] = [];
	const diagnostics: DraftDiagnostic[] = [];
	let marked = false;
	for (const [index, raw] of input.lines.entries()) {
		if (!raw.trim()) continue;
		const indent = /^ */.exec(raw.replace(/\t/g, "  "))![0].length;
		const source = raw.trim();
		const marker = /^\\[+\-~] /.test(source) ? { change: "same" as const, text: source.slice(1) } : takeMarker(source);
		if (marker.change !== "same") marked = true;
		const highlight = marker.text.startsWith("*");
		const [label = "", note = ""] = (highlight ? marker.text.slice(1) : marker.text).split("|").map(field => field.trim());
		while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
		const parent = stack[stack.length - 1];
		const inherited = parent?.change === "added" || parent?.change === "removed" ? parent.change : "same";
		if (inherited !== "same" && marker.change !== "same" && marker.change !== inherited) {
			const symbol = inherited === "added" ? "+" : "-";
			diagnostics.push(diagnostic("tree", input.line + index, tr(`A child node's ${symbol} marker conflicts with its parent; remove the child marker, e.g. ${label}, or move it outside that parent.`, `子节点与父节点的 ${symbol} 标记冲突；删除子节点标记，例如：${label}，或移到该父节点之外。`)));
		}
		const node: BuildingItem = {
			line: input.line + index,
			indent,
			label,
			note,
			highlight,
			change: inherited === "same" ? marker.change : inherited,
			children: [],
		};
		(parent ? parent.children : roots).push(node);
		stack.push(node);
	}
	if (!roots.length) diagnostics.push(diagnostic("tree", input.line, tr("A tree needs at least one node, e.g. Root.", "树至少需要一个节点，例如：Root。")));
	if (diagnostics.length) return { ok: false, diagnostics };
	const close = (node: BuildingItem): TreeItem => ({ line: node.line, label: node.label, note: node.note, highlight: node.highlight, change: node.change, children: node.children.map(close) });
	const list = /\blist\b/.test(input.args);
	const layout = list ? "list" : roots.length > 1 ? "columns" : roots[0]!.children.length >= 2 && roots[0]!.children.length <= 4 ? "org" : "list";
	return { ok: true, value: { roots: roots.map(close), layout, marked }, diagnostics: [] };
}

function visible(node: TreeItem, view: ChangeView): boolean {
	return !(view === "before" && node.change === "added") && !(view === "after" && node.change === "removed");
}

function changeSymbol(change: Change): string {
	switch (change) {
		case "same": return "";
		case "added": return "+";
		case "removed": return "−";
		case "changed": return "~";
	}
}

function changeStyle(change: Change): string {
	switch (change) {
		case "same": return "";
		case "added": return "ins";
		case "removed": return "del muted";
		case "changed": return "warning";
	}
}

interface SurfaceTreeItem {
	readonly id: string;
	readonly label: readonly Span[];
	readonly open: true;
	readonly children: readonly SurfaceTreeItem[];
}

function surfaceItem(node: TreeItem, ctx: RenderContext): SurfaceTreeItem {
	const change = ctx.view === "changes" ? node.change : "same";
	const style = [node.highlight ? "accent strong" : "", changeStyle(change)].filter(Boolean).join(" ");
	const label: Span[] = [];
	if (change !== "same") label.push({ t: `${changeSymbol(change)} `, s: changeStyle(change) });
	label.push(...inlineSpans(node.label, style));
	if (node.note) label.push({ t: " · ", s: "muted" }, ...inlineSpans(node.note, "muted"));
	return { id: `${ctx.id}.item.${node.line}`, label, open: true, children: node.children.filter(child => visible(child, ctx.view)).map(child => surfaceItem(child, ctx)) };
}

function countRow(spec: TreeSpec, ctx: RenderContext): TspNode {
	const counts = { added: 0, removed: 0, changed: 0 };
	const visit = (node: TreeItem): void => {
		if (node.change !== "same") counts[node.change]++;
		node.children.forEach(visit);
	};
	spec.roots.forEach(visit);
	return {
		id: `${ctx.id}.counts`, k: "row", p: { gap: 12 }, c: [
			{ id: `${ctx.id}.count.added`, k: "badge", p: { text: tr(`+ ${counts.added} added`, `+ ${counts.added} 新增`), tone: "success" } },
			{ id: `${ctx.id}.count.removed`, k: "badge", p: { text: tr(`− ${counts.removed} removed`, `− ${counts.removed} 删除`), tone: "muted" } },
			{ id: `${ctx.id}.count.changed`, k: "badge", p: { text: tr(`~ ${counts.changed} changed`, `~ ${counts.changed} 修改`), tone: "warning" } },
		],
	};
}

export function renderTree(spec: TreeSpec, ctx: RenderContext): Rendered {
	const roots = spec.roots.filter(root => visible(root, ctx.view));
	const nodes: TspNode[] = [];
	if (roots.length) {
		if (spec.layout === "org") nodes.push(orgChart(roots[0]!, ctx));
		else if (spec.layout === "columns") nodes.push({
			id: `${ctx.id}.columns`, k: "row", p: { gap: 20 }, c: roots.map(root => ({
				id: `${ctx.id}.tree.${root.line}`, k: "tree", p: { nodes: [surfaceItem(root, ctx)] },
			})),
		});
		else nodes.push({ id: `${ctx.id}.tree`, k: "tree", p: { nodes: roots.map(root => surfaceItem(root, ctx)) } });
	}
	if (spec.marked && ctx.view === "changes") nodes.push(countRow(spec, ctx));
	return { nodes, diagnostics: [] };
}

interface Box {
	readonly node: TreeItem;
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
	readonly labels: readonly (readonly Span[])[];
	readonly notes: readonly (readonly Span[])[];
}

// The shared wrapper keeps ordinary words together. Hard-wrap any remaining long
// token (a path, URL or identifier) before mapping its text back to Markdown spans.
function wrappedSpans(text: string, maxWidth: number, fontSize: number): Span[][] {
	const spans = inlineSpans(text);
	const plain = spans.map(span => span.t).join("");
	const lines: string[] = [];
	for (const wrapped of wrapText(plain, maxWidth, fontSize)) {
		let line = "";
		for (const glyph of wrapped) {
			if (line && textWidth(line + glyph, fontSize) > maxWidth) {
				lines.push(line);
				line = "";
			}
			line += glyph;
		}
		lines.push(line);
	}
	let cursor = 0;
	return lines.map(line => {
		const start = plain.indexOf(line, cursor);
		const end = start + line.length;
		cursor = end;
		let offset = 0;
		const result: Span[] = [];
		for (const span of spans) {
			const from = Math.max(start, offset);
			const to = Math.min(end, offset + span.t.length);
			if (from < to) result.push({ t: span.t.slice(from - offset, to - offset), s: span.s });
			offset += span.t.length;
		}
		return result;
	});
}

function makeBox(node: TreeItem, x: number, y: number, w: number, view: ChangeView): Box {
	const labels = wrappedSpans(node.label, w - 24, 14);
	const notes = node.note ? wrappedSpans(node.note, w - 24, 12) : [];
	const badgeHeight = view === "changes" && node.change !== "same" ? 22 : 0;
	return { node, x, y, w, h: 24 + labels.length * 19 + notes.length * 17 + badgeHeight, labels, notes };
}

// Each styled run is its own <text>, placed by measured width: Tern's SVG renderer draws no <tspan> text.
function spansSvg(spans: readonly Span[], x: number, y: number, fontSize: number, attrs: string): string {
	let offset = x;
	return spans.map(span => {
		const tokens = span.s?.split(" ") ?? [];
		// A box-level attribute (highlight weight, removed strike-through) wins over the run's own.
		const style = [
			tokens.includes("strong") ? 'font-weight="700"' : "",
			tokens.includes("em") ? 'font-style="italic"' : "",
			tokens.includes("code") ? 'font-family="monospace"' : "",
			tokens.includes("del") ? 'text-decoration="line-through"' : "",
		].filter(attribute => attribute && !attrs.includes(`${attribute.slice(0, attribute.indexOf("="))}=`)).join(" ");
		const text = `<text x="${offset}" y="${y}" font-size="${fontSize}" ${attrs} ${style}>${escapeXml(span.t)}</text>`;
		offset += textWidth(span.t, fontSize);
		return text;
	}).join("");
}

function boxSvg(box: Box, view: ChangeView): string {
	const { node, x, y, w, h } = box;
	const change = view === "changes" ? node.change : "same";
	const marked = change !== "same";
	const color = change === "added" ? "var(--success)" : change === "changed" ? "var(--warning)" : node.highlight ? "var(--accent)" : "var(--border)";
	const labelColor = change === "added" ? "var(--success)" : node.highlight ? "var(--accent)" : "var(--fg)";
	const badge = marked ? `<rect x="${x + 12}" y="${y + 9}" width="22" height="18" rx="5" fill="var(--surface)" stroke="${color}"/><text x="${x + 23}" y="${y + 22}" text-anchor="middle" font-size="12" fill="${change === "removed" ? "var(--muted)" : color}">${changeSymbol(change)}</text>` : "";
	let textY = y + 26 + (marked ? 22 : 0);
	const labels = box.labels.map(line => {
		const result = spansSvg(line, x + 12, textY, 14, `fill="${labelColor}"${node.highlight ? ' font-weight="700"' : ""}${change === "removed" ? ' text-decoration="line-through"' : ""}`);
		textY += 19;
		return result;
	}).join("");
	const notes = box.notes.map(line => {
		const result = spansSvg(line, x + 12, textY, 12, 'fill="var(--muted)"');
		textY += 17;
		return result;
	}).join("");
	return `<g${change === "removed" ? ' opacity="0.48"' : ""}><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="var(--surface)" stroke="${color}" stroke-width="${marked || node.highlight ? 2 : 1}"/>${badge}${labels}${notes}</g>`;
}

function orgChart(root: TreeItem, ctx: RenderContext): TspNode {
	const children = root.children.filter(child => visible(child, ctx.view));
	const columnWidth = 220;
	const gap = 16;
	const width = Math.max(300, children.length * columnWidth + Math.max(0, children.length - 1) * gap + 32);
	const rootWidth = Math.min(420, width - 32);
	const rootBox = makeBox(root, (width - rootWidth) / 2, 16, rootWidth, ctx.view);
	const boxes: Box[] = [rootBox];
	const paths: string[] = [];
	const rootBottom = rootBox.y + rootBox.h;
	const childY = rootBottom + 48;
	let height = rootBottom + 16;
	for (const [index, child] of children.entries()) {
		const columnX = 16 + index * (columnWidth + gap);
		const childBox = makeBox(child, columnX, childY, columnWidth, ctx.view);
		boxes.push(childBox);
		paths.push(`M ${width / 2} ${rootBottom} V ${rootBottom + 24} H ${columnX + columnWidth / 2} V ${childY}`);
		let bottom = childY + childBox.h;
		const descendants = (parent: Box, items: readonly TreeItem[], depth: number): void => {
			for (const item of items) {
				if (!visible(item, ctx.view)) continue;
				const indent = Math.min(depth * 16, 64);
				const box = makeBox(item, columnX + indent, bottom + 16, columnWidth - indent, ctx.view);
				boxes.push(box);
				paths.push(`M ${parent.x + 6} ${parent.y + parent.h} V ${parent.y + parent.h + 8} H ${parent.x - 8} V ${box.y + 18} H ${box.x}`);
				bottom = box.y + box.h;
				descendants(box, item.children, depth + 1);
			}
		};
		descendants(childBox, child.children, 1);
		height = Math.max(height, bottom + 16);
	}
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif"><g fill="none" stroke="var(--border)" stroke-width="1.5">${paths.map(path => `<path d="${path}"/>`).join("")}</g>${boxes.map(box => boxSvg(box, ctx.view)).join("")}</svg>`;
	return ctx.svg(`${ctx.id}.org`, svg, { w: width, h: height }, boxes.map(box => `${plainText(box.node.label)}${box.node.note ? `: ${plainText(box.node.note)}` : ""}`).join("; "));
}
