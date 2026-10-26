import type { TspNode } from "../tsp-types";
import { diagnostic, takeMarker, type Change, type ChangeView, type ChainNode, type DraftDiagnostic, type FenceInput, type FlowChain, type Parsed, type RenderContext, type Rendered, type Span } from "./contract";
import { escapeXml, textWidth, wrapText } from "./text";

type Direction = "TB" | "LR" | "BT" | "RL";
type Shape = "rect" | "round" | "diamond" | "cylinder";
interface FlowNode {
	readonly id: string;
	readonly shape: Shape;
	readonly highlighted: boolean;
	readonly change: Change;
	readonly line: number;
}
interface FlowEdge {
	readonly from: string;
	readonly to: string;
	readonly dashed: boolean;
	readonly label: string;
	readonly change: "same" | "added" | "removed";
	readonly line: number;
}
interface FlowGroup {
	readonly name: string;
	readonly members: readonly string[];
	readonly change: "same" | "added" | "removed";
	readonly line: number;
}
export interface FlowSpec {
	readonly direction: Direction;
	readonly nodes: readonly FlowNode[];
	readonly edges: readonly FlowEdge[];
	readonly groups: readonly FlowGroup[];
	readonly marked: boolean;
	/** The fence body, and its `//` comment lines kept when a chain is rewritten. */
	readonly body: Span;
	readonly comments: readonly string[];
}
interface NodeToken { readonly id: string; readonly shape: Shape; readonly explicit: boolean; readonly highlighted: boolean }
interface Step { readonly nodes: readonly NodeToken[]; readonly dashed: boolean }
interface SeenNode { token: NodeToken; before: boolean; after: boolean; changed: boolean; line: number }
type Scan<T> = { readonly ok: true; readonly value: T; readonly end: number } | { readonly ok: false; readonly message: string };
const brackets: readonly { readonly open: string; readonly close: string; readonly shape: Shape }[] = [
	{ open: "[(", close: ")]", shape: "cylinder" }, { open: "[", close: "]", shape: "rect" },
	{ open: "(", close: ")", shape: "round" }, { open: "{", close: "}", shape: "diamond" },
];
function scanNode(text: string, start: number): Scan<NodeToken> {
	let pos = start;
	while (/\s/.test(text[pos] ?? "") && pos < text.length) pos++;
	const highlighted = text[pos] === "*";
	if (highlighted) pos++;
	const bracket = brackets.find(b => text.startsWith(b.open, pos));
	let id: string;
	let end: number;
	if (bracket) {
		const close = text.indexOf(bracket.close, pos + bracket.open.length);
		if (close === -1) return { ok: false, message: `形状括号未闭合，请补上 ${bracket.close}` };
		id = text.slice(pos + bracket.open.length, close).trim();
		end = close + bracket.close.length;
	} else {
		const match = /^(.*?)(?=\s*(?:-->|->|&|[:：]|$))/.exec(text.slice(pos));
		id = (match?.[1] ?? "").trim();
		end = pos + (match?.[0].length ?? 0);
	}
	if (!id) return { ok: false, message: "节点名称为空，请写成 A -> B" };
	return { ok: true, value: { id, shape: bracket?.shape ?? "rect", explicit: !!bracket, highlighted }, end };
}
function scanChain(text: string): Scan<{ readonly steps: readonly Step[]; readonly label: string }> {
	const steps: Step[] = [];
	let pos = 0;
	let dashed = false;
	for (;;) {
		const nodes: NodeToken[] = [];
		for (;;) {
			const result = scanNode(text, pos);
			if (!result.ok) return result;
			nodes.push(result.value);
			pos = result.end;
			const amp = /^\s*&\s*/.exec(text.slice(pos));
			if (!amp) break;
			pos += amp[0].length;
		}
		steps.push({ nodes, dashed });
		const arrow = /^\s*(-->|->)\s*/.exec(text.slice(pos));
		if (!arrow) break;
		dashed = arrow[1] === "-->";
		pos += arrow[0].length;
	}
	const rest = text.slice(pos).trim();
	if (rest && !/^[:：]/.test(rest)) return { ok: false, message: "无法解析节点后的内容，请写成 A -> B: 标签" };
	return { ok: true, value: { steps, label: rest.replace(/^[:：]\s*/, "") }, end: text.length };
}
export function parseFlow(input: FenceInput): Parsed<FlowSpec> {
	const diagnostics: DraftDiagnostic[] = [];
	const arg = input.args.trim().toUpperCase();
	if (arg !== "" && arg !== "TB" && arg !== "LR" && arg !== "BT" && arg !== "RL") return { ok: false, diagnostics: [diagnostic("flow", input.line - 1, "方向无效，请使用 flow TB、LR、BT 或 RL")] };
	const direction: Direction = arg === "" ? "TB" : arg;
	const seen = new Map<string, SeenNode>();
	const edges: FlowEdge[] = [];
	const groups: FlowGroup[] = [];
	let marked = false;
	input.lines.forEach((raw, i) => {
		const source = raw.trim();
		if (!source || source.startsWith("//")) return;
		const line = input.line + i;
		const { change, text: body } = takeMarker(source);
		const text = body.trimStart();
		marked ||= change !== "same";
		const group = /^group\s+(.+?)\s*[:：]\s*(.+)$/i.exec(text);
		if (group) {
			if (change === "changed") { diagnostics.push(diagnostic("flow", line, "~ 只能标记节点；分组请使用 + group 名称: A 或 - group 名称: A")); return; }
			const members = group[2]!.split(/[,，]/).map(m => m.trim()).filter(Boolean);
			if (!members.length) { diagnostics.push(diagnostic("flow", line, "分组不能为空，请写成 group 名称: A, B")); return; }
			groups.push({ name: group[1]!.trim(), members, change, line });
			return;
		}
		if (/^group\s/i.test(text)) { diagnostics.push(diagnostic("flow", line, "分组格式无效，请写成 group 名称: A, B")); return; }
		const chain = scanChain(text);
		if (!chain.ok) { diagnostics.push(diagnostic("flow", line, chain.message)); return; }
		if (change === "changed" && chain.value.steps.length > 1) { diagnostics.push(diagnostic("flow", line, "~ 不能标记连线；请用 - A -> B 删除旧连线，再用 + A -> C 添加新连线")); return; }
		for (const step of chain.value.steps) for (const token of step.nodes) {
			const prev = seen.get(token.id);
			if (prev) {
				prev.before ||= change !== "added";
				prev.after ||= change !== "removed";
				prev.changed ||= change === "changed";
				prev.token = { ...prev.token, shape: token.explicit ? token.shape : prev.token.shape, highlighted: prev.token.highlighted || token.highlighted };
			} else seen.set(token.id, { token, before: change !== "added", after: change !== "removed", changed: change === "changed", line });
		}
		if (change === "changed") return;
		for (let k = 1; k < chain.value.steps.length; k++) for (const from of chain.value.steps[k - 1]!.nodes) for (const to of chain.value.steps[k]!.nodes) {
			edges.push({ from: from.id, to: to.id, dashed: chain.value.steps[k]!.dashed, label: k === chain.value.steps.length - 1 ? chain.value.label : "", change, line });
		}
	});
	if (!seen.size && !diagnostics.length) diagnostics.push(diagnostic("flow", input.line, "流程图为空，请添加节点，例如 A -> B"));
	for (const group of groups) {
		const missing = group.members.filter(m => !seen.has(m));
		if (missing.length) diagnostics.push(diagnostic("flow", group.line, `分组 ${group.name} 引用了不存在的节点 ${missing.join("、")}；请先声明这些节点`));
	}
	for (const edge of edges) if (edge.change !== "same") {
		const plain = edges.find(e => e.change === "same" && e.from === edge.from && e.to === edge.to);
		if (plain) diagnostics.push(diagnostic("flow", edge.line, `连线 ${edge.from} -> ${edge.to} 在第 ${plain.line} 行未标记；请统一所有同名连线的变更标记`));
	}
	const nodes: FlowNode[] = [...seen].map(([id, n]) => ({ id, shape: n.token.shape, highlighted: n.token.highlighted, change: !n.after ? "removed" : !n.before ? "added" : n.changed ? "changed" : "same", line: n.line }));
	for (const group of groups) if (group.change !== "removed" && group.members.length && group.members.every(m => nodes.find(n => n.id === m)?.change === "removed")) diagnostics.push(diagnostic("flow", group.line, `分组 ${group.name} 只含删除节点；请写成 - group ${group.name}: ${group.members.join(", ")}`, "warning"));
	if (diagnostics.some(d => d.severity === "error")) return { ok: false, diagnostics };
	return { ok: true, value: { direction, nodes, edges, groups, marked, body: input.body, comments: input.lines.filter(line => line.trim().startsWith("//")) }, diagnostics };
}

interface Box { x: number; y: number; w: number; h: number }
interface Positioned extends Box { readonly node: FlowNode; readonly lines: readonly string[]; readonly rank: number }
interface Point { readonly x: number; readonly y: number }
interface LabelBox extends Box { readonly lines: readonly string[] }
interface Route { readonly edge: FlowEdge; readonly points: readonly Point[]; readonly label: LabelBox | null }
const FS = 14;
const LH = 19;
function linesFor(text: string, width: number, fs = FS): string[] {
	return wrapText(text, width, fs).flatMap(line => {
		if (textWidth(line, fs) <= width) return [line];
		const parts: string[] = [];
		let part = "";
		for (const char of line) { if (part && textWidth(part + char, fs) > width) { parts.push(part); part = ""; } part += char; }
		if (part) parts.push(part);
		return parts;
	});
}
function visible(change: Change, view: ChangeView): boolean { return view === "changes" || (view === "before" ? change !== "added" : change !== "removed"); }
function color(change: Change, highlighted = false): string {
	switch (change) { case "added": return "var(--success)"; case "changed": return "var(--warning)"; case "removed": return "var(--muted)"; case "same": return highlighted ? "var(--accent)" : "var(--border)"; }
}
function sign(change: Change): string { switch (change) { case "same": return ""; case "added": return "+"; case "removed": return "−"; case "changed": return "~"; } }
// One <text> per line: Tern's SVG renderer draws no <tspan> text.
function labelSvg(lines: readonly string[], x: number, y: number, change: Change, fs = FS): string {
	return lines.map((line, i) => `<text x="${x}" y="${y + i * LH}" text-anchor="middle" fill="var(--fg)" font-size="${fs}"${change === "removed" ? ' text-decoration="line-through"' : ""}>${escapeXml(line)}</text>`).join("");
}
function badgeSvg(change: Change, x: number, y: number): string {
	if (change === "same") return "";
	return `<circle cx="${x}" cy="${y}" r="10" fill="var(--surface)" stroke="${color(change)}"/><text x="${x}" y="${y + 4}" text-anchor="middle" font-size="14" fill="${color(change)}">${sign(change)}</text>`;
}
function nodeSvg(p: Positioned, view: ChangeView): string {
	const change = view === "changes" ? p.node.change : "same";
	const stroke = color(change, p.node.highlighted);
	const { x, y, w, h } = p;
	let shape: string;
	switch (p.node.shape) {
		case "rect": shape = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4"/>`; break;
		case "round": shape = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/>`; break;
		case "diamond": shape = `<path d="M ${x + w / 2} ${y} L ${x + w} ${y + h / 2} L ${x + w / 2} ${y + h} L ${x} ${y + h / 2} Z"/>`; break;
		case "cylinder": shape = `<path d="M ${x} ${y + 10} C ${x} ${y - 3} ${x + w} ${y - 3} ${x + w} ${y + 10} V ${y + h - 10} C ${x + w} ${y + h + 3} ${x} ${y + h + 3} ${x} ${y + h - 10} Z M ${x} ${y + 10} C ${x} ${y + 23} ${x + w} ${y + 23} ${x + w} ${y + 10}"/>`; break;
	}
	return `<g${change === "removed" ? ' opacity="0.45"' : ""}><g fill="var(--surface)" stroke="${stroke}" stroke-width="${change === "changed" || p.node.highlighted ? 2.5 : 1.5}">${shape}</g>${labelSvg(p.lines, x + w / 2, y + h / 2 - (p.lines.length - 1) * LH / 2 + 5, change)}${badgeSvg(change, x + w - 2, y + 2)}</g>`;
}

/** Longest-path ranks after DFS back-edge reversal; cycles and self-links remain visible. */
function ranksFor(nodes: readonly FlowNode[], edges: readonly FlowEdge[]): Map<string, number> {
	const outgoing = new Map(nodes.map(n => [n.id, [] as string[]]));
	for (const edge of edges) outgoing.get(edge.from)!.push(edge.to);
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const order: string[] = [];
	// Iterative post-order DFS: a long chain must not exhaust the call stack.
	for (const node of nodes) {
		if (visited.has(node.id)) continue;
		const stack: { id: string; next: number }[] = [{ id: node.id, next: 0 }];
		visiting.add(node.id);
		while (stack.length) {
			const top = stack.at(-1)!;
			const targets = outgoing.get(top.id)!;
			if (top.next < targets.length) {
				const to = targets[top.next++]!;
				if (visited.has(to) || visiting.has(to)) continue;
				visiting.add(to);
				stack.push({ id: to, next: 0 });
				continue;
			}
			stack.pop();
			visiting.delete(top.id);
			visited.add(top.id);
			order.push(top.id);
		}
	}
	order.reverse();
	const index = new Map(order.map((id, i) => [id, i]));
	// Each edge points forward in `order` (back edges reversed); ranks relax along that order.
	const forward = new Map<string, string[]>(nodes.map(n => [n.id, []]));
	for (const edge of edges) {
		if (edge.from === edge.to) continue;
		const reversed = index.get(edge.from)! > index.get(edge.to)!;
		forward.get(reversed ? edge.to : edge.from)!.push(reversed ? edge.from : edge.to);
	}
	const rank = new Map(nodes.map(n => [n.id, 0]));
	for (const id of order) for (const to of forward.get(id)!) rank.set(to, Math.max(rank.get(to)!, rank.get(id)! + 1));
	return rank;
}
function overlap(a: Box, b: Box): boolean { return a.x < b.x + b.w + 4 && a.x + a.w + 4 > b.x && a.y < b.y + b.h + 4 && a.y + a.h + 4 > b.y; }

const OPEN: Readonly<Record<Shape, string>> = { rect: "[", round: "(", diamond: "{", cylinder: "[(" };
const CLOSE: Readonly<Record<Shape, string>> = { rect: "]", round: ")", diamond: "}", cylinder: ")]" };

/** A node as written: a bare name when that parses back to the same node, else its shape's brackets. */
function nodeToken(node: { readonly id: string; readonly shape: Shape; readonly highlighted: boolean }): string {
	const bare = node.shape === "rect" && !/->|&|[:：[\](){}*]/.test(node.id);
	return `${node.highlighted ? "*" : ""}${bare ? node.id : `${OPEN[node.shape]}${node.id}${CLOSE[node.shape]}`}`;
}

/**
 * A flow that is one path (each node at most one edge in and out, no groups or change markers), with
 * the operations that rewrite its fence body. Null for any other flow.
 */
function chainOf(spec: FlowSpec, slots: RenderContext["slots"]): FlowChain | null {
	if (spec.marked || spec.groups.length || !spec.nodes.length || spec.edges.length !== spec.nodes.length - 1) return null;
	const incoming = new Map<string, FlowEdge>();
	const outgoing = new Map<string, FlowEdge>();
	for (const edge of spec.edges) {
		if (incoming.has(edge.to) || outgoing.has(edge.from) || edge.from === edge.to) return null;
		incoming.set(edge.to, edge);
		outgoing.set(edge.from, edge);
	}
	const starts = spec.nodes.filter(node => !incoming.has(node.id));
	if (starts.length !== 1) return null;
	const path: FlowNode[] = [starts[0]!];
	const steps: FlowEdge[] = [];
	for (let edge = outgoing.get(starts[0]!.id); edge; edge = outgoing.get(edge.to)) {
		steps.push(edge);
		path.push(spec.nodes.find(node => node.id === edge!.to)!);
	}
	if (path.length !== spec.nodes.length) return null;
	type Link = { readonly dashed: boolean; readonly label: string };
	const write = (nodes: readonly { id: string; shape: Shape; highlighted: boolean }[], links: readonly Link[]): string => {
		const lines: string[] = [...spec.comments];
		let line = nodeToken(nodes[0]!);
		links.forEach((link, index) => {
			line += ` ${link.dashed ? "-->" : "->"} ${nodeToken(nodes[index + 1]!)}`;
			// An edge label is written after the line's last step, so a labeled edge ends its line.
			if (link.label) { lines.push(`${line}: ${link.label}`); line = index + 1 < links.length ? nodeToken(nodes[index + 1]!) : ""; }
		});
		if (line) lines.push(line);
		return lines.join("\n");
	};
	const nodes = path.map(node => ({ id: node.id, shape: node.shape, highlighted: node.highlighted }));
	const links: Link[] = steps.map(edge => ({ dashed: edge.dashed, label: edge.label }));
	return {
		nodes: path.map((node): ChainNode => {
			const slot = /^\{\{(.+)\}\}$/.exec(node.id)?.[1]?.trim() ?? null;
			const declared = slot === null ? undefined : slots.get(slot);
			return { name: node.id, label: declared?.value ?? node.id, shape: node.shape, slot: declared ? slot : null };
		}),
		edges: links,
		rename(index, name) {
			const value = name.trim();
			if (!value || value.includes("\n") || nodes.some((node, other) => other !== index && node.id === value)) return null;
			return write(nodes.map((node, other) => other === index ? { ...node, id: value } : node), links);
		},
		insertAfter(index) {
			let name = "新节点";
			for (let n = 2; nodes.some(node => node.id === name); n++) name = `新节点 ${n}`;
			const next = [...nodes];
			next.splice(index + 1, 0, { id: name, shape: "rect", highlighted: false });
			const nextLinks = [...links];
			// The new node takes the plain edge from its predecessor; the old edge now leaves the new node.
			nextLinks.splice(index, 0, { dashed: false, label: "" });
			return write(next, nextLinks);
		},
		remove(index) {
			if (nodes.length <= 2) return null;
			const nextLinks = [...links];
			// The edge into the removed node is kept and now reaches its successor.
			nextLinks.splice(index === 0 ? 0 : index === nodes.length - 1 ? index - 1 : index, 1);
			return write(nodes.filter((_, other) => other !== index), nextLinks);
		},
	};
}

export function renderFlow(spec: FlowSpec, ctx: RenderContext): Rendered {
	const chain = chainOf(spec, ctx.slots);
	if (chain) return { nodes: [ctx.edit.chain(`${ctx.id}.chain`, spec.body, chain)], diagnostics: [] };
	return { nodes: [ctx.edit.text(`${ctx.id}.source`, spec.body, true, { id: `${ctx.id}.drawing`, k: "col", c: renderFlowSvg(spec, ctx) })], diagnostics: [] };
}

function renderFlowSvg(spec: FlowSpec, ctx: RenderContext): TspNode[] {
	const nodes = spec.nodes.filter(n => visible(n.change, ctx.view));
	const ids = new Set(nodes.map(n => n.id));
	const edges = spec.edges.filter(e => visible(e.change, ctx.view) && ids.has(e.from) && ids.has(e.to));
	const groups = spec.groups.filter(g => visible(g.change, ctx.view));
	const vertical = spec.direction === "TB" || spec.direction === "BT";
	const reverse = spec.direction === "BT" || spec.direction === "RL";
	const ranks = ranksFor(nodes, edges);
	const rows: string[][] = [];
	for (const node of nodes) { const rank = ranks.get(node.id)!; (rows[rank] ??= []).push(node.id); }
	// Alternating barycenters put related nodes near each other and reduce crossings.
	for (let pass = 0; pass < 6; pass++) {
		const positions = new Map<string, number>();
		for (const row of rows) row.forEach((id, i) => positions.set(id, i));
		const sequence = pass % 2 ? [...rows].reverse() : rows;
		for (const row of sequence) {
			const score = (id: string): number => {
				const adjacent = edges.flatMap(e => pass % 2 ? e.from === id ? [e.to] : [] : e.to === id ? [e.from] : []);
				return adjacent.length ? adjacent.reduce((sum, other) => sum + positions.get(other)!, 0) / adjacent.length : positions.get(id)!;
			};
			row.sort((a, b) => score(a) - score(b));
			// Keep a group's same-rank members contiguous after ordering.
			for (const group of groups) { const members = row.filter(id => group.members.includes(id)); if (members.length < 2) continue; const first = row.findIndex(id => group.members.includes(id)); const rest = row.filter(id => !group.members.includes(id)); rest.splice(first, 0, ...members); row.splice(0, row.length, ...rest); }
		}
	}
	const positioned = new Map<string, Positioned>();
	for (const node of nodes) {
		const lines = linesFor(node.id, 160);
		const tw = Math.max(...lines.map(line => textWidth(line, FS)));
		const th = lines.length * LH;
		const diamond = node.shape === "diamond";
		positioned.set(node.id, { node, lines, rank: ranks.get(node.id)!, x: 0, y: 0, w: diamond ? Math.max(100, tw * 2 + 40) : Math.max(96, tw + 36), h: diamond ? th * 2 + 28 : th + (node.shape === "cylinder" ? 38 : 28) });
	}
	const labelSizes = new Map<FlowEdge, { readonly lines: readonly string[]; readonly w: number; readonly h: number }>();
	for (const edge of edges) if (edge.label) { const lines = linesFor(edge.label, 150, 12); labelSizes.set(edge, { lines, w: Math.max(...lines.map(line => textWidth(line, 12))) + 16, h: lines.length * LH + 10 }); }
	const rankSize = rows.map(row => Math.max(0, ...row.map(id => { const p = positioned.get(id)!; return vertical ? p.h : p.w; })));
	const breadth = rows.map(row => row.reduce((sum, id) => { const p = positioned.get(id)!; return sum + (vertical ? p.w : p.h); }, 0) + Math.max(0, row.length - 1) * 64);
	const maxBreadth = Math.max(120, ...breadth);
	const gaps = rows.map((_, rank) => {
		const labels = edges.filter(e => ranks.get(e.from) === rank && ranks.get(e.to) === rank + 1).map(e => labelSizes.get(e)).filter((s): s is NonNullable<typeof s> => !!s);
		return Math.max(96, labels.reduce((sum, s) => sum + (vertical ? s.h : s.w) + 14, 24));
	});
	let depth = 56;
	rows.forEach((row, rank) => {
		let cross = 48 + (maxBreadth - breadth[rank]!) / 2;
		for (const id of row) { const p = positioned.get(id)!; if (vertical) { p.x = cross; p.y = depth + (rankSize[rank]! - p.h) / 2; cross += p.w + 64; } else { p.x = depth + (rankSize[rank]! - p.w) / 2; p.y = cross; cross += p.h + 64; } }
		depth += rankSize[rank]! + (rank < rows.length - 1 ? gaps[rank]! : 0);
	});
	const baseDepth = depth;
	if (reverse) for (const p of positioned.values()) { if (vertical) p.y = baseDepth + 56 - p.y - p.h; else p.x = baseDepth + 56 - p.x - p.w; }
	const rankBounds = rows.map(row => {
		const boxes = row.map(id => positioned.get(id)!);
		return { min: Math.min(...boxes.map(p => vertical ? p.y : p.x)), max: Math.max(...boxes.map(p => vertical ? p.y + p.h : p.x + p.w)) };
	});
	const routes: Route[] = [];
	const occupied: Box[] = [...positioned.values()];
	let outer = maxBreadth + 132;
	const lanes = new Map<number, number>();
	for (const edge of edges) {
		const a = positioned.get(edge.from)!;
		const b = positioned.get(edge.to)!;
		const forward = b.rank === a.rank + 1;
		const direction = reverse ? -1 : 1;
		let points: Point[];
		let label: LabelBox | null = null;
		const size = labelSizes.get(edge);
		if (forward) {
			const start = vertical ? { x: a.x + a.w / 2, y: a.y + (reverse ? 0 : a.h) } : { x: a.x + (reverse ? 0 : a.w), y: a.y + a.h / 2 };
			const end = vertical ? { x: b.x + b.w / 2, y: b.y + (reverse ? b.h : 0) } : { x: b.x + (reverse ? b.w : 0), y: b.y + b.h / 2 };
			const used = lanes.get(a.rank) ?? 0;
			const extent = size ? (vertical ? size.h : size.w) : 0;
			const sourceBoundary = reverse ? rankBounds[a.rank]!.min : rankBounds[a.rank]!.max;
			const targetBoundary = reverse ? rankBounds[b.rank]!.max : rankBounds[b.rank]!.min;
			const middle = size ? sourceBoundary + direction * (20 + used + extent / 2) : (sourceBoundary + targetBoundary) / 2;
			if (size) { lanes.set(a.rank, used + extent + 14); label = { ...size, x: vertical ? (start.x + end.x) / 2 - size.w / 2 : middle - size.w / 2, y: vertical ? middle - size.h / 2 : (start.y + end.y) / 2 - size.h / 2 }; }
			points = vertical ? [start, { x: start.x, y: middle }, { x: end.x, y: middle }, end] : [start, { x: middle, y: start.y }, { x: middle, y: end.y }, end];
			// A label may be wider than its gap. Route that edge outside instead.
			if (label && occupied.some(box => overlap(label!, box))) points = [];
		} else points = [];
		if (!points.length) {
			const lane = outer + (size ? (vertical ? size.w : size.h) / 2 : 0);
			const start = vertical ? { x: a.x + a.w / 2, y: a.y + (reverse ? 0 : a.h) } : { x: a.x + (reverse ? 0 : a.w), y: a.y + a.h / 2 };
			const end = vertical ? { x: b.x + b.w / 2, y: b.y + (reverse ? b.h : 0) } : { x: b.x + (reverse ? b.w : 0), y: b.y + b.h / 2 };
			// Leave/enter through clear inter-rank channels, never through another
			// node in the source/target rank (including disconnected nodes).
			const sourceChannel = (reverse ? rankBounds[a.rank]!.min : rankBounds[a.rank]!.max) + direction * 20;
			const targetChannel = (reverse ? rankBounds[b.rank]!.max : rankBounds[b.rank]!.min) - direction * 20;
			points = vertical
				? [start, { x: start.x, y: sourceChannel }, { x: lane, y: sourceChannel }, { x: lane, y: targetChannel }, { x: end.x, y: targetChannel }, end]
				: [start, { x: sourceChannel, y: start.y }, { x: sourceChannel, y: lane }, { x: targetChannel, y: lane }, { x: targetChannel, y: end.y }, end];
			if (size) label = { ...size, x: vertical ? lane - size.w / 2 : (sourceChannel + targetChannel) / 2 - size.w / 2, y: vertical ? (sourceChannel + targetChannel) / 2 - size.h / 2 : lane - size.h / 2 };
			outer = lane + (size ? (vertical ? size.w : size.h) / 2 : 0) + 36;
		}
		if (label) { while (occupied.some(box => overlap(label!, box))) { if (vertical) label.x += label.w + 16; else label.y += label.h + 16; } occupied.push(label); }
		routes.push({ edge, points, label });
	}
	const groupSvgs: string[] = [];
	const groupBoxes: Box[] = [];
	for (const group of groups) {
		const members = group.members.map(id => positioned.get(id)).filter((p): p is Positioned => !!p);
		if (!members.length) continue;
		const lines = linesFor(group.name, 180, 12);
		const x = Math.min(...members.map(p => p.x)) - 20;
		const y = Math.min(...members.map(p => p.y)) - 24 - lines.length * LH;
		const w = Math.max(Math.max(...members.map(p => p.x + p.w)) - x + 20, Math.max(...lines.map(l => textWidth(l, 12))) + 36);
		const h = Math.max(...members.map(p => p.y + p.h)) - y + 20;
		const change = ctx.view === "changes" ? group.change : "same";
		groupBoxes.push({ x, y, w, h });
		groupSvgs.push(`<g${change === "removed" ? ' opacity="0.45"' : ""}><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="none" stroke="${color(change)}" stroke-dasharray="5 4"/>${labelSvg(lines, x + w / 2, y + 18, change, 12)}${badgeSvg(change, x + w - 12, y + 12)}</g>`);
	}
	const boxes = [...positioned.values(), ...groupBoxes, ...routes.flatMap(r => r.label ? [r.label] : [])];
	const allPoints = routes.flatMap(r => r.points);
	const minX = Math.min(0, ...boxes.map(b => b.x - 12), ...allPoints.map(p => p.x - 12));
	const minY = Math.min(0, ...boxes.map(b => b.y - 12), ...allPoints.map(p => p.y - 12));
	const width = Math.max(160, ...boxes.map(b => b.x + b.w + 28), ...allPoints.map(p => p.x + 28)) - minX;
	const height = Math.max(100, ...boxes.map(b => b.y + b.h + 28), ...allPoints.map(p => p.y + 28)) - minY;
	const displayWidth = Math.min(1000, width);
	const displayHeight = height * displayWidth / width;
	const edgeSvgs = routes.map((route, i) => {
		const change = ctx.view === "changes" ? route.edge.change : "same";
		const stroke = change === "same" ? "var(--muted)" : color(change);
		const marker = `${ctx.id}.arrow.${i}`;
		return `<g${change === "removed" ? ' opacity="0.45"' : ""}><defs><marker id="${escapeXml(marker)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 Z" fill="${stroke}"/></marker></defs><path d="${route.points.map((p, k) => `${k ? "L" : "M"} ${p.x} ${p.y}`).join(" ")}" fill="none" stroke="${stroke}" stroke-width="1.7"${route.edge.dashed ? ' stroke-dasharray="6 4"' : ""} marker-end="url(#${escapeXml(marker)})"/>${route.label ? `<rect x="${route.label.x}" y="${route.label.y}" width="${route.label.w}" height="${route.label.h}" rx="4" fill="var(--surface)" stroke="${color(change)}"/>${labelSvg(route.label.lines, route.label.x + route.label.w / 2, route.label.y + 18, change, 12)}` : ""}</g>`;
	});
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${displayWidth}" height="${displayHeight}" viewBox="${minX} ${minY} ${width} ${height}" font-family="sans-serif"><title>${escapeXml(`流程图 ${spec.direction}`)}</title>${groupSvgs.join("")}${edgeSvgs.join("")}${[...positioned.values()].map(p => nodeSvg(p, ctx.view)).join("")}${!nodes.length ? labelSvg(["此视图没有节点"], 80, 50, "same") : ""}</svg>`;
	const output: TspNode[] = [ctx.svg(`${ctx.id}.diagram`, svg, { w: displayWidth, h: displayHeight }, nodes.map(n => n.id).join("、"))];
	if (spec.marked && ctx.view === "changes") {
		const changes = [...spec.nodes, ...spec.edges, ...spec.groups].map(item => item.change);
		output.push({ id: `${ctx.id}.counts`, k: "text", p: { spans: [
			{ t: `+ ${changes.filter(c => c === "added").length} 新增`, s: "success" },
			{ t: `  − ${changes.filter(c => c === "removed").length} 删除`, s: "muted del" },
			{ t: `  ~ ${changes.filter(c => c === "changed").length} 修改`, s: "warning" },
		] } });
	}
	return output;
}
