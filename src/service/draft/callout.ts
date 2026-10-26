import { tr } from "../../i18n";
import { diagnostic, type FenceInput, type Parsed, type RenderContext, type Rendered, type Span } from "./contract.ts";

export interface CalloutSpec {
	readonly type: "info" | "ok" | "warn" | "err";
	readonly title: string;
	readonly body: string;
	readonly span: Span;
}

const tones = { info: "muted", ok: "success", warn: "warning", err: "error" } as const satisfies Record<CalloutSpec["type"], string>;

export function parseCallout(input: FenceInput): Parsed<CalloutSpec> {
	const args = input.args.trim();
	const [first = "", ...rest] = args.split(/\s+/);
	let type: CalloutSpec["type"];
	let title: string;
	switch (first) {
		case "info":
		case "ok":
		case "warn":
		case "err":
			type = first;
			title = rest.join(" ");
			break;
		default:
			type = "info";
			title = args;
	}
	const body = input.lines.join("\n");
	if (!title && !body.trim()) {
		return { ok: false, diagnostics: [diagnostic("callout", input.line, tr("callout needs a title or body, e.g. ```callout info Hint", "callout 需要标题或正文，例如：```callout info 提示"))] };
	}
	const firstLine = input.lines.findIndex(line => line.trim() && !line.trim().startsWith("//"));
	const misplacedType = firstLine < 0 ? null : /^type\s*[:：]\s*([a-z][\w-]*)\s*(?:#.*)?$/i.exec(input.lines[firstLine]!.trim());
	if (misplacedType) {
		let suggested: string;
		switch (misplacedType[1]!.toLowerCase()) {
			case "info": case "note": suggested = "info"; break;
			case "ok": suggested = "ok"; break;
			case "warn": case "warning": suggested = "warn"; break;
			case "err": case "error": suggested = "err"; break;
			default: suggested = "<info|ok|warn|err>";
		}
		return {
			ok: false,
			diagnostics: [diagnostic("callout", input.line + firstLine, tr(`Type must be on the fence line, not in the body, e.g. \`\`\`callout ${suggested} [title]`, `类型应写在围栏行而非正文，例如：\`\`\`callout ${suggested} [标题]`))],
		};
	}
	return { ok: true, value: { type, title, body, span: input.body }, diagnostics: [] };
}

export function renderCallout(spec: CalloutSpec, ctx: RenderContext): Rendered {
	// A note in comment style, not a box: `//`, the title in the callout's tone, then the text.
	return {
		nodes: [{
			id: `${ctx.id}.note`,
			k: "el",
			p: { tag: "div", class: "pb-comment" },
			c: [
				{ id: `${ctx.id}.slash`, k: "el", p: { tag: "span", class: "pb-comment-slash", text: "//" } },
				ctx.edit.text(`${ctx.id}.text`, spec.span, true, {
					id: `${ctx.id}.view`, k: "el", p: { tag: "div", class: "pb-comment-text" },
					c: [
						...(spec.title ? [{ id: `${ctx.id}.title`, k: "el", p: { tag: "strong", tone: tones[spec.type], text: spec.title } }] : []),
						...(spec.body.trim() ? [{ id: `${ctx.id}.body`, k: "md", p: { text: spec.body } }] : []),
					],
				}),
			],
		}],
		diagnostics: [],
	};
}
