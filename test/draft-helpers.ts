import type { EditHost, FenceInput, RenderContext } from "../src/service/draft/contract";

export function fence(input: Pick<FenceInput, "args" | "line" | "lines">): FenceInput {
	let offset = 0;
	const starts = input.lines.map(line => { const start = offset; offset += line.length + 1; return start; });
	return { ...input, starts, body: { start: 0, end: Math.max(0, offset - 1) } };
}

/** Read-only component harness; interaction tests supply a recording EditHost instead. */
export const passiveEdit: EditHost = {
	text: (_id, _span, _multiline, view) => view,
	slot: (id, name) => ({ id, k: "text", p: { text: name } }),
	list: (id, _span, _ordered, _start, items) => ({ id, k: "col", c: items.map(item => item.node) }),
	chain: (id, _body, chain) => ({ id, k: "col", c: chain.nodes.map((node, i) => ({ id: `${id}.${i}`, k: "text", p: { text: node.label } })) }),
	reference: (id, text, _target, alias) => ({ id, k: "text", p: { text: alias ?? text } }),
};
export const renderDefaults: Pick<RenderContext, "slots" | "edit"> = { slots: new Map(), edit: passiveEdit };
