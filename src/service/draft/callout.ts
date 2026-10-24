import { diagnostic, type FenceInput, type Parsed, type RenderContext, type Rendered } from "./contract.ts";

export interface CalloutSpec {
	readonly type: "info" | "ok" | "warn" | "err";
	readonly title: string;
	readonly body: string;
}

const presentation = {
	info: { head: "信息", tone: "info" },
	ok: { head: "成功", tone: "success" },
	warn: { head: "警告", tone: "warning" },
	err: { head: "错误", tone: "error" },
} as const satisfies Record<CalloutSpec["type"], { readonly head: string; readonly tone: "info" | "success" | "warning" | "error" }>;

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
		return { ok: false, diagnostics: [diagnostic("callout", input.line, "callout 需要标题或正文，例如：```callout info 提示")] };
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
			diagnostics: [diagnostic("callout", input.line + firstLine, `类型应写在围栏行而非正文，例如：\`\`\`callout ${suggested} [标题]`)],
		};
	}
	return { ok: true, value: { type, title, body }, diagnostics: [] };
}

export function renderCallout(spec: CalloutSpec, ctx: RenderContext): Rendered {
	const { head } = presentation[spec.type];
	// A tinted block with a semantic start edge: the conclusion or warning is seen before it is read.
	return {
		nodes: [{
			id: `${ctx.id}.card`,
			k: "el",
			p: { tag: "div", class: `am-callout am-callout-${spec.type}` },
			c: [
				{ id: `${ctx.id}.head`, k: "el", p: { tag: "strong", class: "am-callout-title", text: spec.title || head } },
				...(spec.body.trim() ? [{ id: `${ctx.id}.body`, k: "md", p: { text: spec.body } }] : []),
			],
		}],
		diagnostics: [],
	};
}
