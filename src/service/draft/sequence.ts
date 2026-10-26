import { tr } from "../../i18n";
import { diagnostic, type DraftDiagnostic, type FenceInput, type Parsed, type RenderContext, type Rendered } from "./contract";
import { escapeXml, plainText, textWidth, wrapText } from "./text";

export interface SequenceSpec {
	readonly participants: readonly string[];
	readonly numbered: boolean;
	readonly steps: readonly (
		| { readonly kind: "message"; readonly from: string; readonly to: string; readonly dashed: boolean; readonly label: string; readonly line: number }
		| { readonly kind: "note"; readonly over: readonly string[]; readonly text: string; readonly line: number }
		| { readonly kind: "divider"; readonly text: string; readonly line: number }
	)[];
}

export function parseSequence(input: FenceInput): Parsed<SequenceSpec> {
	const diagnostics: DraftDiagnostic[] = [];
	const participants: string[] = [];
	const steps: SequenceSpec["steps"][number][] = [];
	const options = input.args.trim().split(/\s+/).filter(Boolean);
	if (options.some(option => option !== "num")) {
		diagnostics.push(diagnostic("sequence", Math.max(1, input.line - 1), tr("The sequence diagram accepts only num; write sequence or sequence num.", "时序图参数只支持 num；请写 sequence 或 sequence num。")));
	}
	const add = (name: string): void => {
		if (!participants.includes(name)) participants.push(name);
	};
	const names = (text: string, line: number): string[] | undefined => {
		const values = text.split(/[,，]/).map(value => value.trim());
		if (values.some(value => !value || /[:：<>]/.test(value))) {
			diagnostics.push(diagnostic("sequence", line, tr("Participant names cannot be empty or contain colons or arrows; write A, B, C.", "参与者名称不能为空或含冒号、箭头；请写 A, B, C。")));
			return undefined;
		}
		return values;
	};
	for (const [offset, raw] of input.lines.entries()) {
		const text = raw.trim();
		const line = input.line + offset;
		if (!text || text.startsWith("//")) continue;
		const declaration = /^participants?\s*[:：]\s*(.*)$/i.exec(text);
		if (declaration) {
			const values = names(declaration[1]!, line);
			values?.forEach(add);
			continue;
		}
		const note = /^note\s+([^:：]+)[:：]\s*(.+)$/i.exec(text);
		if (note && note[2]!.trim()) {
			const over = names(note[1]!, line);
			if (over) {
				over.forEach(add);
				steps.push({ kind: "note", over, text: note[2]!.trim(), line });
			}
			continue;
		}
		const divider = /^==\s*(.+?)\s*==$/.exec(text);
		if (divider && divider[1]!.trim() && !/^=+$/.test(divider[1]!.trim())) {
			steps.push({ kind: "divider", text: divider[1]!.trim(), line });
			continue;
		}
		const message = /^([^:：<>]+?)\s*(-->|->)\s*([^:：<>]+?)\s*(?:[:：]\s*(.*))?$/.exec(text);
		if (message && message[1]!.trim() && message[3]!.trim() && !/[-=]$/.test(message[1]!)) {
			const from = message[1]!.trim();
			const to = message[3]!.trim();
			add(from);
			add(to);
			steps.push({ kind: "message", from, to, dashed: message[2] === "-->", label: (message[4] ?? "").trim(), line });
			continue;
		}
		diagnostics.push(diagnostic("sequence", line, tr("Unable to parse the sequence-diagram line; write A -> B: message, A --> B: return, note A, B: note, or == phase ==.", "无法解析时序图行；请写 A -> B: 消息、A --> B: 返回、note A, B: 说明或 == 阶段 ==。")));
	}
	if (!participants.length && !diagnostics.length) {
		diagnostics.push(diagnostic("sequence", input.line, tr("A sequence diagram needs participants; write A -> B: message.", "时序图需要参与者；请写 A -> B: 消息。")));
	}
	if (diagnostics.length) return { ok: false, diagnostics };
	return { ok: true, value: { participants, numbered: options.includes("num"), steps }, diagnostics };
}

// wrapText preserves unbroken Latin words; split those locally as well so labels
// (including URLs and identifiers) cannot escape the diagram's measured bounds.
function labelLines(text: string, width: number): string[] {
	const result: string[] = [];
	for (const line of wrapText(plainText(text), width, 14)) {
		let fragment = "";
		for (const char of line) {
			if (fragment && textWidth(fragment + char, 14) > width) {
				result.push(fragment);
				fragment = "";
			}
			fragment += char;
		}
		if (fragment || !result.length) result.push(fragment);
	}
	return result;
}

export function renderSequence(spec: SequenceSpec, ctx: RenderContext): Rendered {
	const count = spec.participants.length;
	const selfCalls = spec.steps.some(step => step.kind === "message" && step.from === step.to);
	const width = Math.max(360, count * 190 + (selfCalls ? 140 : 0));
	const left = 92;
	const right = width - (selfCalls ? 150 : 92);
	const gap = count > 1 ? (right - left) / (count - 1) : 180;
	const actorWidth = Math.min(148, gap - 16);
	const xs = spec.participants.map((_, index) => count === 1 ? width / 2 - (selfCalls ? 40 : 0) : left + gap * index);
	const actorLabels = spec.participants.map(name => labelLines(name, Math.max(14, actorWidth - 20)));
	const actorHeight = Math.max(...actorLabels.map(lines => lines.length * 20 + 20));
	const xFor = (name: string): number => xs[spec.participants.indexOf(name)]!;
	const text = (lines: readonly string[], x: number, y: number): string => lines.map((line, index) => `<text x="${x}" y="${y + 14 + index * 20}" text-anchor="middle">${escapeXml(line)}</text>`).join("");
	const arrow = (x: number, y: number, direction: number): string => `<polygon points="${x},${y} ${x - direction * 9},${y - 4} ${x - direction * 9},${y + 4}" fill="var(--accent)"/>`;
	const body: string[] = [];
	let y = actorHeight + 38;
	let ordinal = 0;
	for (const step of spec.steps) {
		switch (step.kind) {
			case "message": {
				ordinal++;
				const x1 = xFor(step.from);
				const x2 = xFor(step.to);
				const self = x1 === x2;
				const index = spec.participants.indexOf(step.from);
				const end = self ? Math.min(xs[index + 1] ?? width - 24, width - 24) - 12 : Math.max(x1, x2);
				const available = self ? end - x1 : Math.abs(x2 - x1);
				const lines = labelLines(`${spec.numbered ? `${ordinal}. ` : ""}${step.label}`, Math.max(14, available - 24));
				const cx = self ? (x1 + end) / 2 : (x1 + x2) / 2;
				const labelHeight = lines.length * 20;
				body.push(`<rect x="${cx - (available - 12) / 2}" y="${y - 2}" width="${available - 12}" height="${labelHeight}" fill="var(--surface)"/>`, text(lines, cx, y));
				const arrowY = y + labelHeight + 6;
				const dash = step.dashed ? ' stroke-dasharray="6 4"' : "";
				if (self) {
					const loopX = Math.min(x1 + 36, end);
					body.push(`<path d="M ${x1} ${arrowY} H ${loopX} V ${arrowY + 24} H ${x1 + 2}" fill="none" stroke="var(--accent)" stroke-width="1.6"${dash}/>`, arrow(x1 + 2, arrowY + 24, -1));
					y = arrowY + 54;
				} else {
					const direction = x2 > x1 ? 1 : -1;
					body.push(`<line x1="${x1}" y1="${arrowY}" x2="${x2 - direction * 2}" y2="${arrowY}" stroke="var(--accent)" stroke-width="1.6"${dash}/>`, arrow(x2 - direction * 2, arrowY, direction));
					y = arrowY + 30;
				}
				break;
			}
			case "note": {
				const positions = step.over.map(xFor);
				const lo = Math.min(...positions);
				const hi = Math.max(...positions);
				const noteWidth = Math.min(width - 48, Math.max(164, hi - lo + 36));
				const cx = Math.max(24 + noteWidth / 2, Math.min(width - 24 - noteWidth / 2, (lo + hi) / 2));
				const lines = labelLines(step.text, noteWidth - 24);
				const height = lines.length * 20 + 20;
				body.push(`<rect x="${cx - noteWidth / 2}" y="${y}" width="${noteWidth}" height="${height}" rx="5" fill="var(--surface)" stroke="var(--warning)"/>`, text(lines, cx, y + 10));
				y += height + 24;
				break;
			}
			case "divider": {
				const lines = labelLines(step.text, width - 100);
				const height = lines.length * 20 + 16;
				const labelWidth = Math.max(...lines.map(line => textWidth(line, 14))) + 24;
				body.push(`<line x1="24" y1="${y + height / 2}" x2="${width - 24}" y2="${y + height / 2}" stroke="var(--border)"/>`, `<rect x="${(width - labelWidth) / 2}" y="${y}" width="${labelWidth}" height="${height}" rx="4" fill="var(--surface)" stroke="var(--border)"/>`, text(lines, width / 2, y + 8));
				y += height + 24;
				break;
			}
		}
	}
	const height = y + 12;
	const actors = spec.participants.map((_, index) => `<line x1="${xs[index]}" y1="${actorHeight + 12}" x2="${xs[index]}" y2="${height - 12}" stroke="var(--border)" stroke-dasharray="4 5"/><rect x="${xs[index]! - actorWidth / 2}" y="12" width="${actorWidth}" height="${actorHeight}" rx="5" fill="var(--surface)" stroke="var(--border)"/>${text(actorLabels[index]!, xs[index]!, 22)}`).join("");
	// Keep the natural geometry for zooming; cap only the displayed size.
	const displayWidth = Math.min(1000, width);
	const displayHeight = height * displayWidth / width;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${displayWidth}" height="${displayHeight}" viewBox="0 0 ${width} ${height}" role="img"><g font-family="sans-serif" font-size="14" fill="var(--fg)">${actors}${body.join("")}</g></svg>`;
	return { nodes: [ctx.svg(`${ctx.id}.sequence`, svg, { w: displayWidth, h: displayHeight }, tr(`Sequence diagram: ${spec.participants.map(plainText).join(", ")}`, `时序图：${spec.participants.map(plainText).join("、")}`))], diagnostics: [] };
}
