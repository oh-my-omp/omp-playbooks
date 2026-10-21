import type { TspNode } from "../tsp-types";
import { diagnostic, type FenceInput, type Parsed, type RenderContext, type Rendered } from "./contract";
import { inlineSpans } from "./text";

/** An ask is a decision the coordinator offers; the UI may let the person pick options and submit them as a change request. */
export interface AskSpec {
	readonly question: string;
	readonly mode: "single" | "multi";
	readonly options: readonly {
		readonly label: string;
		readonly note: string;
		readonly suggested: boolean;
	}[];
}

const optionPattern = /^([*-])\s+(.+)$/;

export function parseAsk(input: FenceInput): Parsed<AskSpec> {
	const lines = input.lines
		.map((raw, index) => ({ text: raw.trim(), line: input.line + index }))
		.filter(({ text }) => text && !text.startsWith("//"));
	const first = lines[0];
	if (!first || optionPattern.test(first.text)) {
		return { ok: false, diagnostics: [diagnostic("ask", first?.line ?? input.line, "第一行须为问题，例如：选择哪种缓存？")] };
	}
	const mode = /(^|\s)multi(\s|$)/.test(input.args) ? "multi" : "single";
	const options: { label: string; note: string; suggested: boolean; line: number }[] = [];
	for (const { text, line } of lines.slice(1)) {
		const match = optionPattern.exec(text);
		if (!match) {
			return { ok: false, diagnostics: [diagnostic("ask", line, "选项须以 * 或 - 加空格开头，例如：* Redis | 重启后保留数据")] };
		}
		const [label = "", note = ""] = match[2]!.split("|").map(field => field.trim());
		if (!label) {
			return { ok: false, diagnostics: [diagnostic("ask", line, "选项须在 | 前写名称，例如：- Memcached | 无磁盘存储")] };
		}
		options.push({ label, note, suggested: match[1] === "*", line });
	}
	if (options.length < 2 || options.length > 6) {
		return { ok: false, diagnostics: [diagnostic("ask", first.line, `须写 2–6 个选项，当前 ${options.length} 个；例如：* Redis 和 - Memcached 分别占一行`)] };
	}
	if (mode === "single" && options.filter(option => option.suggested).length !== 1) {
		return { ok: false, diagnostics: [diagnostic("ask", first.line, "单选须恰好一个 * 建议项，其余用 -；多个建议项请改用 ask multi")] };
	}
	const labels = new Set<string>();
	for (const option of options) {
		if (labels.has(option.label)) {
			return { ok: false, diagnostics: [diagnostic("ask", option.line, `选项名称“${option.label}”重复，请改为不同名称`)] };
		}
		labels.add(option.label);
	}
	return {
		ok: true,
		value: {
			question: first.text,
			mode,
			options: options.map(({ label, note, suggested }) => ({ label, note, suggested })),
		},
		diagnostics: [],
	};
}

export function renderAsk(spec: AskSpec, ctx: RenderContext): Rendered {
	const children: TspNode[] = [
		{ id: `${ctx.id}.question`, k: "text", p: { spans: inlineSpans(spec.question, "strong") } },
	];
	if (ctx.askControl) children.push(...ctx.askControl(`${ctx.id}.choice`, spec));
	else {
		for (const [index, option] of spec.options.entries()) {
			const id = `${ctx.id}.option.${index}`;
			const heading: TspNode[] = [
				{ id: `${id}.label`, k: "text", p: { spans: inlineSpans(option.label, option.suggested ? "accent" : "") } },
			];
			if (option.suggested) heading.push({ id: `${id}.suggested`, k: "badge", p: { text: "建议", tone: "accent" } });
			const content: TspNode[] = [{ id: `${id}.heading`, k: "row", p: { gap: 1 }, c: heading }];
			if (option.note) content.push({ id: `${id}.note`, k: "text", p: { spans: inlineSpans(option.note, "muted") } });
			children.push({ id, k: "col", p: { gap: 0 }, c: content });
		}
	}
	children.push({ id: `${ctx.id}.mode`, k: "text", p: { spans: [{ t: spec.mode === "single" ? "单选" : "多选", s: "muted" }] } });
	return { nodes: [{ id: `${ctx.id}.ask`, k: "col", p: { gap: 1 }, c: children }], diagnostics: [] };
}
