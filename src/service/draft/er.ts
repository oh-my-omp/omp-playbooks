import { tr } from "../../i18n";
import { diagnostic, takeMarker, type Change, type ChangeView, type DraftDiagnostic, type FenceInput, type Parsed, type RenderContext, type Rendered } from "./contract";
import { escapeXml, textWidth, wrapText } from "./text";

type Direction = "TB" | "LR" | "BT" | "RL";
type Cardinality = "1" | "0..1" | "*" | "1..*";
type Key = "PK" | "FK" | "UK";
interface ErField {
	readonly name: string;
	readonly type: string;
	readonly key: Key | null;
	readonly ref: string | null;
	readonly change: Change;
	readonly line: number;
}
interface ErEntity {
	readonly name: string;
	readonly highlighted: boolean;
	readonly fields: readonly ErField[];
	readonly change: Change;
	readonly line: number;
}
interface ErRelationship {
	readonly from: string;
	readonly to: string;
	readonly fromCard: Cardinality;
	readonly toCard: Cardinality;
	readonly label: string;
	readonly change: Change;
	readonly line: number;
	readonly source: { readonly kind: "field"; readonly name: string } | { readonly kind: "written"; readonly change: Change };
}
export interface ErSpec {
	readonly direction: Direction;
	readonly entities: readonly ErEntity[];
	readonly relationships: readonly ErRelationship[];
	readonly marked: boolean;
}
const RELATIONSHIP = /^(\S+)\s+(1\.\.\*|0\.\.1|\*|1)\s*--\s*(1\.\.\*|0\.\.1|\*|1)\s+(\S+?)\s*(?::\s*(.*))?$/;
const MERMAID = /^(\S+)\s+([|o{}]{2})(?:--|\.\.)([|o{}]{2})\s+(\S+?)\s*(?::\s*(.*))?$/;
function card(text: string): Cardinality | null {
	switch (text) {
		case "1": case "0..1": case "*": case "1..*": return text;
		case "||": return "1";
		case "o|": case "|o": return "0..1";
		case "|{": case "}|": return "1..*";
		case "o{": case "}o": return "*";
		default: return null;
	}
}
function key(text: string | undefined): Key | null {
	return text === "PK" || text === "FK" || text === "UK" ? text : null;
}
function pair(a: string, b: string): string { return JSON.stringify([a, b].sort()); }
function endChange(a: ErEntity, b: ErEntity): Change {
	if (a.change === "removed" || b.change === "removed") return "removed";
	if (a.change === "added" || b.change === "added") return "added";
	return "same";
}

export function parseEr(input: FenceInput): Parsed<ErSpec> {
	const fail = (line: number, message: string): Parsed<ErSpec> => ({ ok: false, diagnostics: [diagnostic("er", line, message)] });
	const arg = input.args.trim().toUpperCase();
	let direction: Direction;
	switch (arg) {
		case "": direction = "TB"; break;
		case "TB": case "LR": case "BT": case "RL": direction = arg; break;
		default: return fail(input.line, tr("Direction must be TB, LR, BT, or RL, e.g. er LR", "方向应为 TB、LR、BT 或 RL，例如 er LR"));
	}
	const entities: (Omit<ErEntity, "fields"> & { fields: ErField[] })[] = [];
	const named = new Map<string, ErEntity>();
	const written: ErRelationship[] = [];
	let current: typeof entities[number] | null = null;
	let marked = false;
	for (let index = 0; index < input.lines.length; index++) {
		const raw = input.lines[index]!;
		if (!raw.trim()) continue;
		const line = input.line + index;
		const { change, text } = takeMarker(raw.trimStart());
		const body = text.trim();
		marked ||= change !== "same";
		if (/^\s/.test(raw)) {
			if (!current) return fail(line, tr("Write the entity name in column 0 before fields, e.g. User, then indent id PK", "字段前需在第 0 列写实体名，例如 User，然后缩进写 id PK"));
			const inherited = current.change === "added" || current.change === "removed" ? current.change : "same";
			if (inherited !== "same" && change !== "same" && change !== inherited) return fail(line, tr(`The field marker conflicts with entity ${current.name}; remove the field marker to inherit the entity marker.`, `字段标记与实体 ${current.name} 冲突；删除字段标记以继承实体标记`));
			const tokens = body.split(/\s+/);
			const name = tokens.shift()!;
			if (!name) return fail(line, tr("A field needs a name, e.g. id PK", "字段需要名称，例如 id PK"));
			const arrow = tokens.indexOf("->");
			const head = arrow < 0 ? tokens : tokens.slice(0, arrow);
			const ref = arrow < 0 ? null : tokens[arrow + 1];
			if (arrow >= 0 && (!ref || arrow + 2 !== tokens.length)) return fail(line, tr(`A foreign-key target must be last, e.g. ${name} FK -> User`, `外键目标应写在末尾，例如 ${name} FK -> User`));
			if (ref !== null && key(head.at(-1)) !== "FK") return fail(line, tr(`Only an FK field can reference an entity, e.g. ${name} FK -> ${ref}`, `只有 FK 字段能引用实体，例如 ${name} FK -> ${ref}`));
			const keyAt = head.findIndex(token => key(token) !== null);
			if (keyAt >= 0 && keyAt !== head.length - 1) return fail(line, tr(`The key marker must follow the type, e.g. ${name} string ${head[keyAt]}${ref ? ` -> ${ref}` : ""}`, `键标记应在类型之后，例如 ${name} string ${head[keyAt]}${ref ? ` -> ${ref}` : ""}`));
			current.fields.push({ name, type: head.slice(0, keyAt < 0 ? head.length : keyAt).join(" "), key: keyAt < 0 ? null : key(head[keyAt]), ref: ref ?? null, change: inherited === "same" ? change : inherited, line });
			continue;
		}
		const rel = RELATIONSHIP.exec(body);
		if (rel) {
			if (change === "changed") return fail(line, tr("A relationship cannot use ~; write two lines: - A 1--* B and + A 1--1 B", "关系不能用 ~；改为两行：- A 1--* B 与 + A 1--1 B"));
			written.push({ from: rel[1]!, fromCard: card(rel[2]!)!, to: rel[4]!, toCard: card(rel[3]!)!, label: rel[5]?.trim() ?? "", change, line, source: { kind: "written", change } });
			current = null;
			continue;
		}
		const mermaid = MERMAID.exec(body);
		if (mermaid && card(mermaid[2]!) && card(mermaid[3]!)) {
			const sign = change === "added" ? "+ " : change === "removed" ? "- " : "";
			return fail(line, tr(`This is Mermaid syntax; change it to ${sign}${mermaid[1]} ${card(mermaid[2]!)}--${card(mermaid[3]!)} ${mermaid[4]}${mermaid[5]?.trim() ? `: ${mermaid[5].trim()}` : ""}`, `这是 Mermaid 语法；改为 ${sign}${mermaid[1]} ${card(mermaid[2]!)}--${card(mermaid[3]!)} ${mermaid[4]}${mermaid[5]?.trim() ? `: ${mermaid[5].trim()}` : ""}`));
		}
		if (body.includes("--") || /[{}]/.test(body)) return fail(line, tr("A relationship must be written as A 1--* B; write entity names alone in column 0.", "关系应写为 A 1--* B；实体名称单独写在第 0 列"));
		const highlighted = body.startsWith("*");
		const name = (highlighted ? body.slice(1) : body).trim();
		if (!name) return fail(line, tr("An entity needs a name, e.g. *User", "实体需要名称，例如 *User"));
		if (named.has(name)) return fail(line, tr(`Entity ${name} is repeated; declare it only once in column 0.`, `实体 ${name} 重复；只在第 0 列声明一次`));
		current = { name, highlighted, fields: [], change, line };
		entities.push(current);
		named.set(name, current);
	}
	if (!entities.length) return fail(input.line, tr("An ER diagram needs at least one entity; write User in column 0.", "ER 图需要至少一个实体；在第 0 列写 User"));
	const implied: ErRelationship[] = [];
	for (const entity of entities) for (const field of entity.fields) {
		if (field.ref === null) continue;
		if (!named.has(field.ref)) return fail(field.line, tr(`Entity ${field.ref} was not found; write ${field.ref} in column 0.`, `找不到实体 ${field.ref}；请在第 0 列写 ${field.ref}`));
		implied.push({ from: entity.name, to: field.ref, fromCard: "*", toCard: "1", label: "", change: field.change === "changed" ? "same" : field.change, line: field.line, source: { kind: "field", name: field.name } });
	}
	for (const rel of written) for (const name of [rel.from, rel.to]) if (!named.has(name)) return fail(rel.line, tr(`Entity ${name} was not found; write ${name} in column 0.`, `找不到实体 ${name}；请在第 0 列写 ${name}`));
	const replaced = new Set(written.map(rel => pair(rel.from, rel.to)));
	const retained = implied.filter(rel => !replaced.has(pair(rel.from, rel.to)));
	for (const rel of [...retained, ...written]) {
		const a = named.get(rel.from)!;
		const b = named.get(rel.to)!;
		const hasAdded = a.change === "added" || b.change === "added";
		const hasRemoved = a.change === "removed" || b.change === "removed";
		if (rel.change === "added" && hasRemoved) return fail(rel.line, tr("An added relationship cannot connect a removed entity; remove the + marker or keep the entity.", "新增关系不能连接已删除实体；删除 + 标记或保留该实体"));
		if (rel.change === "removed" && hasAdded) return fail(rel.line, tr("A removed relationship cannot connect an added entity; remove the - marker or keep the original entity.", "删除关系不能连接新增实体；删除 - 标记或保留原实体"));
		if (rel.change === "same" && hasAdded && hasRemoved) return fail(rel.line, tr("The relationship's ends are respectively added and removed, so neither view contains it; remove the relationship or change the entity markers.", "关系两端分别新增和删除，前后视图均不存在；删除关系或修改实体标记"));
	}
	const relationships = [...retained, ...written].map(rel => {
		let change = rel.change;
		if (change === "same") change = endChange(named.get(rel.from)!, named.get(rel.to)!);
		if (change === "same" && rel.source.kind === "written") change = implied.find(other => pair(other.from, other.to) === pair(rel.from, rel.to) && other.change !== "same")?.change ?? "same";
		return { ...rel, change };
	});
	return { ok: true, value: { direction, entities, relationships, marked }, diagnostics: [] };
}

function visible(change: Change, view: ChangeView): boolean {
	return view === "changes" || (view === "before" ? change !== "added" : change !== "removed");
}
function color(change: Change): string {
	switch (change) {
		case "same": return "var(--border)";
		case "added": return "var(--success)";
		case "removed": return "var(--muted)";
		case "changed": return "var(--warning)";
	}
}
function sign(change: Change): string {
	switch (change) {
		case "same": return "";
		case "added": return "+";
		case "removed": return "−";
		case "changed": return "~";
	}
}
function lines(text: string, width: number, fs: number): string[] {
	return wrapText(text, width, fs).flatMap(line => {
		if (textWidth(line, fs) <= width) return [line];
		const chunks: string[] = [];
		let chunk = "";
		for (const char of line) {
			if (chunk && textWidth(chunk + char, fs) > width) { chunks.push(chunk); chunk = ""; }
			chunk += char;
		}
		if (chunk) chunks.push(chunk);
		return chunks;
	});
}
interface Row { readonly field: ErField; readonly text: readonly string[]; readonly height: number }
interface Box { readonly entity: ErEntity; readonly rows: readonly Row[]; readonly title: readonly string[]; readonly w: number; readonly h: number; readonly head: number; x: number; y: number; rank: number }
interface Point { readonly x: number; readonly y: number }
function textSvg(text: string, x: number, y: number, size: number, extra = ""): string {
	return `<text x="${x}" y="${y}" font-size="${size}" fill="var(--fg)" ${extra}>${escapeXml(text)}</text>`;
}
function crow(point: Point, toward: Point, value: Cardinality, stroke: string): string {
	const distance = Math.hypot(toward.x - point.x, toward.y - point.y) || 1;
	const dx = (toward.x - point.x) / distance;
	const dy = (toward.y - point.y) / distance;
	const p = (along: number, across: number): string => `${point.x + dx * along - dy * across},${point.y + dy * along + dx * across}`;
	let shape = "";
	if (value === "*" || value === "1..*") shape += `<path d="M${p(0, -7)} L${p(12, 0)} L${p(0, 7)} M${p(0, 0)} L${p(12, 0)}"/>`;
	else shape += `<path d="M${p(8, -7)} L${p(8, 7)}"/>`;
	if (value === "1" || value === "1..*") shape += `<path d="M${p(18, -7)} L${p(18, 7)}"/>`;
	else shape += `<circle cx="${point.x + dx * 21}" cy="${point.y + dy * 21}" r="4" fill="var(--surface)"/>`;
	return `<g stroke="${stroke}" stroke-width="1.7" fill="none">${shape}</g>`;
}

export function renderEr(spec: ErSpec, ctx: RenderContext): Rendered {
	const changes = ctx.view === "changes";
	const entities = spec.entities.filter(entity => visible(entity.change, ctx.view));
	const names = new Set(entities.map(entity => entity.name));
	const relationships = spec.relationships.filter(rel => names.has(rel.from) && names.has(rel.to) && visible(rel.change, ctx.view));
	const boxes: Box[] = entities.map(entity => {
		const fields = entity.fields.filter(field => visible(field.change, ctx.view));
		const signWidth = changes && fields.some(field => field.change !== "same") ? 18 : 0;
		const w = Math.min(320, Math.max(180, textWidth(entity.name, 15) + 64, ...fields.map(field => textWidth([field.name, field.type].filter(Boolean).join(" "), 13) + (field.key ? 50 : 0) + signWidth + 30)));
		const title = lines(entity.name, w - 64, 15);
		const head = title.length * 20 + 20;
		const rows = fields.map(field => {
			const text = lines([field.name, field.type].filter(Boolean).join(" "), w - 30 - signWidth - (field.key ? 48 : 0), 13);
			return { field, text, height: text.length * 18 + 12 };
		});
		return { entity, rows, title, w, head, h: head + rows.reduce((sum, row) => sum + row.height, 0) + (rows.length ? 0 : 16), x: 0, y: 0, rank: 0 };
	});
	const byName = new Map(boxes.map(box => [box.entity.name, box]));
	// Rank parents before dependants. Kahn's pass leaves cyclic components together;
	// edges within a rank use outside lanes rather than crossing the entity boxes.
	const arcs = relationships.filter(rel => rel.from !== rel.to).map(rel => rel.source.kind === "field" ? { from: rel.to, to: rel.from } : { from: rel.from, to: rel.to });
	const indegree = new Map(boxes.map(box => [box.entity.name, 0]));
	for (const arc of arcs) indegree.set(arc.to, indegree.get(arc.to)! + 1);
	const queue = boxes.filter(box => indegree.get(box.entity.name) === 0);
	for (let index = 0; index < queue.length; index++) {
		const box = queue[index]!;
		for (const arc of arcs) if (arc.from === box.entity.name) {
			const to = byName.get(arc.to)!;
			to.rank = Math.max(to.rank, box.rank + 1);
			const remaining = indegree.get(arc.to)! - 1;
			indegree.set(arc.to, remaining);
			if (!remaining) queue.push(to);
		}
	}
	// Lay out disconnected components independently: otherwise a long edge
	// between ranks could cross an unrelated component's entity boxes.
	const neighbors = new Map<string, string[]>(boxes.map(box => [box.entity.name, []]));
	for (const arc of arcs) {
		neighbors.get(arc.from)!.push(arc.to);
		neighbors.get(arc.to)!.push(arc.from);
	}
	const component = new Map<string, number>();
	for (const box of boxes) {
		if (component.has(box.entity.name)) continue;
		const id = component.size;
		const pending = [box.entity.name];
		component.set(box.entity.name, id);
		for (let index = 0; index < pending.length; index++) for (const name of neighbors.get(pending[index]!)!) {
			if (component.has(name)) continue;
			component.set(name, id);
			pending.push(name);
		}
	}
	const horizontal = spec.direction === "LR" || spec.direction === "RL";
	const reverse = spec.direction === "RL" || spec.direction === "BT";
	const components = new Map<number, Box[]>();
	for (const box of boxes) {
		const id = component.get(box.entity.name)!;
		const group = components.get(id) ?? [];
		group.push(box);
		components.set(id, group);
	}
	let width = 240;
	let height = 120;
	let top = 0;
	const laneSpace = relationships.length * 22 + 60;
	const rankGap = Math.max(140, ...relationships.map(rel => textWidth(rel.label, 12) + 64));
	for (const componentBoxes of components.values()) {
		const groups = new Map<number, Box[]>();
		for (const box of componentBoxes) {
			const group = groups.get(box.rank) ?? [];
			group.push(box);
			groups.set(box.rank, group);
		}
		let axis = 40;
		let occupiedAxis = 40;
		for (const rank of [...groups.keys()].sort((a, b) => a - b)) {
			let cross = 40;
			let depth = 0;
			for (const box of groups.get(rank)!) {
				box.x = horizontal ? axis : cross;
				box.y = horizontal ? cross : axis;
				cross += (horizontal ? box.h : box.w) + laneSpace;
				depth = Math.max(depth, horizontal ? box.w : box.h);
			}
			occupiedAxis = axis + depth;
			axis = occupiedAxis + rankGap;
		}
		if (reverse) for (const box of componentBoxes) {
			if (horizontal) box.x = occupiedAxis - box.x - box.w + 40;
			else box.y = occupiedAxis - box.y - box.h + 40;
		}
		let componentHeight = 0;
		for (const box of componentBoxes) {
			width = Math.max(width, box.x + box.w + laneSpace);
			componentHeight = Math.max(componentHeight, box.y + box.h + laneSpace);
			box.y += top;
		}
		top += componentHeight;
		height = Math.max(height, top);
	}
	const svg: string[] = [];
	const usedPairs = new Map<string, number>();
	const pairTotals = new Map<string, number>();
	for (const rel of relationships) {
		const token = pair(rel.from, rel.to);
		pairTotals.set(token, (pairTotals.get(token) ?? 0) + 1);
	}
	for (const rel of relationships) {
		const a = byName.get(rel.from)!;
		const b = byName.get(rel.to)!;
		const token = pair(rel.from, rel.to);
		const number = usedPairs.get(token) ?? 0;
		usedPairs.set(token, number + 1);
		const change = changes ? rel.change : "same";
		const stroke = change === "same" ? "var(--muted)" : color(change);
		const label = `${sign(change)}${sign(change) && rel.label ? " " : ""}${rel.label}`;
		let points: Point[];
		let labelPoint: Point;
		if (a === b) {
			const out = 50 + number * 40;
			if (horizontal) {
				points = [{ x: a.x + a.w / 2 - 20, y: a.y + a.h }, { x: a.x + a.w / 2 - 20, y: a.y + a.h + out }, { x: a.x + a.w / 2 + 20, y: a.y + a.h + out }, { x: a.x + a.w / 2 + 20, y: a.y + a.h }];
				labelPoint = { x: a.x + a.w / 2, y: a.y + a.h + out + 18 };
				height = Math.max(height, labelPoint.y + 30);
			} else {
				points = [{ x: a.x + a.w, y: a.y + a.head / 2 }, { x: a.x + a.w + out, y: a.y + a.head / 2 }, { x: a.x + a.w + out, y: a.y + a.head / 2 + 30 }, { x: a.x + a.w, y: a.y + a.head / 2 + 30 }];
				labelPoint = { x: a.x + a.w + out, y: a.y + a.head / 2 + 48 };
				width = Math.max(width, labelPoint.x + textWidth(label, 12) / 2 + 30);
			}
		} else if (a.rank === b.rank) {
			const lane = 35 + number * 24;
			if (horizontal) {
				const x = Math.max(a.x + a.w, b.x + b.w) + lane;
				points = [{ x: a.x + a.w, y: a.y + a.head / 2 }, { x, y: a.y + a.head / 2 }, { x, y: b.y + b.head / 2 }, { x: b.x + b.w, y: b.y + b.head / 2 }];
				labelPoint = { x, y: (points[1]!.y + points[2]!.y) / 2 };
			} else {
				const y = Math.max(a.y + a.h, b.y + b.h) + lane;
				points = [{ x: a.x + a.w / 2, y: a.y + a.h }, { x: a.x + a.w / 2, y }, { x: b.x + b.w / 2, y }, { x: b.x + b.w / 2, y: b.y + b.h }];
				labelPoint = { x: (points[1]!.x + points[2]!.x) / 2, y };
			}
		} else {
			const total = pairTotals.get(token)!;
			const spacing = Math.min(20, Math.min(horizontal ? a.head : a.w, horizontal ? b.head : b.w) / (total + 1));
			const offset = (number - (total - 1) / 2) * spacing;
			if (horizontal) {
				const forward = b.x > a.x;
				const start = { x: a.x + (forward ? a.w : 0), y: a.y + a.head / 2 + offset };
				const end = { x: b.x + (forward ? 0 : b.w), y: b.y + b.head / 2 + offset };
				const middle = (start.x + end.x) / 2 + offset;
				points = [start, { x: middle, y: start.y }, { x: middle, y: end.y }, end];
				labelPoint = { x: middle, y: (start.y + end.y) / 2 - 12 };
			} else {
				const forward = b.y > a.y;
				const start = { x: a.x + a.w / 2 + offset, y: a.y + (forward ? a.h : 0) };
				const end = { x: b.x + b.w / 2 + offset, y: b.y + (forward ? 0 : b.h) };
				const middle = (start.y + end.y) / 2 + offset;
				points = [start, { x: start.x, y: middle }, { x: end.x, y: middle }, end];
				labelPoint = { x: (start.x + end.x) / 2, y: middle - 10 };
			}
		}
		svg.push(`<g data-relationship="${escapeXml(rel.from)}:${escapeXml(rel.to)}" opacity="${change === "removed" ? 0.45 : 1}"><path d="${points.map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`).join(" ")}" fill="none" stroke="${stroke}" stroke-width="1.7"/>`, crow(points[0]!, points[1]!, rel.fromCard, stroke), crow(points.at(-1)!, points.at(-2)!, rel.toCard, stroke));
		if (label) {
			const labelLines = lines(label, 260, 12);
			const labelWidth = Math.max(...labelLines.map(line => textWidth(line, 12))) + 12;
			const x = Math.max(labelWidth / 2 + 10, labelPoint.x);
			width = Math.max(width, x + labelWidth / 2 + 10);
			height = Math.max(height, labelPoint.y + labelLines.length * 16 + 10);
			svg.push(`<rect x="${x - labelWidth / 2}" y="${labelPoint.y - 13}" width="${labelWidth}" height="${labelLines.length * 16 + 3}" rx="4" fill="var(--surface)"/>`);
			labelLines.forEach((line, index) => svg.push(textSvg(line, x, labelPoint.y + index * 16, 12, `text-anchor="middle"${change === "removed" ? ' text-decoration="line-through"' : ""}`)));
		}
		svg.push("</g>");
	}
	for (const box of boxes) {
		const change = changes ? box.entity.change : "same";
		const stroke = change === "same" && box.entity.highlighted ? "var(--accent)" : color(change);
		svg.push(`<g data-entity="${escapeXml(box.entity.name)}" opacity="${change === "removed" ? 0.45 : 1}"><rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="8" fill="var(--surface)" stroke="${stroke}" stroke-width="${change === "changed" || box.entity.highlighted ? 2.5 : 1.5}"/>`);
		box.title.forEach((line, index) => svg.push(textSvg(line, box.x + 14, box.y + 25 + index * 20, 15, `font-weight="600"${change === "removed" ? ' text-decoration="line-through"' : ""}`)));
		if (sign(change)) svg.push(`<rect x="${box.x + box.w - 32}" y="${box.y + 10}" width="22" height="22" rx="11" fill="${stroke}"/>`, textSvg(sign(change), box.x + box.w - 21, box.y + 26, 15, 'text-anchor="middle" font-weight="600"'));
		let y = box.y + box.head;
		const signed = changes && box.rows.some(row => row.field.change !== "same");
		for (const row of box.rows) {
			const state = changes ? row.field.change : "same";
			svg.push(`<g data-field="${escapeXml(row.field.name)}" opacity="${state === "removed" && change !== "removed" ? 0.45 : 1}"><path d="M${box.x},${y} H${box.x + box.w}" stroke="var(--border)"/>`);
			if (state !== "same") svg.push(`<rect x="${box.x + 1}" y="${y + 1}" width="${box.w - 2}" height="${row.height - 2}" fill="${color(state)}" fill-opacity="0.12"${state === "changed" ? ` stroke="${color(state)}"` : ""}/>`);
			if (sign(state)) svg.push(textSvg(sign(state), box.x + 10, y + 21, 13));
			row.text.forEach((line, index) => svg.push(textSvg(line, box.x + 14 + (signed ? 18 : 0), y + 21 + index * 18, 13, `${box.entity.highlighted ? 'font-weight="600"' : ""}${state === "removed" ? ' text-decoration="line-through"' : ""}`)));
			if (row.field.key) svg.push(`<rect x="${box.x + box.w - 40}" y="${y + 7}" width="30" height="18" rx="4" fill="var(--surface)" stroke="var(--border)"/>`, textSvg(row.field.key, box.x + box.w - 25, y + 20, 11, 'text-anchor="middle" font-weight="600"'));
			svg.push("</g>");
			y += row.height;
		}
		svg.push("</g>");
	}
	if (!boxes.length) svg.push(textSvg(tr("No entities in this view", "此视图没有实体"), 20, 40, 14));
	const drawing = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.min(1000, width)}" height="${height * Math.min(1, 1000 / width)}" viewBox="0 0 ${width} ${height}" font-family="sans-serif">${svg.join("")}</svg>`;
	const nodes = [ctx.svg(`${ctx.id}.diagram`, drawing, { w: Math.min(1000, width), h: height * Math.min(1, 1000 / width) }, tr(entities.map(entity => entity.name).join(", "), entities.map(entity => entity.name).join("、")))];
	if (spec.marked && changes) {
		const states = [...spec.entities.flatMap(entity => [entity.change, ...entity.fields.map(field => field.change)]), ...spec.relationships.flatMap(rel => rel.source.kind === "written" ? [rel.source.change] : [])];
		const counts = ["added", "removed", "changed"].map(change => states.filter(state => state === change).length);
		nodes.push({ id: `${ctx.id}.counts`, k: "text", p: { text: tr(`+${counts[0]} added · −${counts[1]} removed · ~${counts[2]} changed (entity, field, relationship rows)`, `+${counts[0]} 新增 · −${counts[1]} 删除 · ~${counts[2]} 修改（实体、字段、关系行）`) } });
	}
	return { nodes, diagnostics: [] satisfies DraftDiagnostic[] };
}
