import { fence, passiveEdit, renderDefaults } from "./draft-helpers";
import { describe, expect, test } from "bun:test";
import { renderDraft } from "../src/service/draft/components";
import type { ChangeView, Parsed, RenderContext } from "../src/service/draft/contract";
import { parseSvg, renderSvg, type SvgSpec } from "../src/service/draft/svg";

function parse(source: string, line = 10): Parsed<SvgSpec> {
	return parseSvg(fence({ args: "", lines: source.split("\n"), line }));
}

function value(source: string): SvgSpec {
	const result = parse(source);
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
	return result.value;
}

function rejected(source: string, line: number, message: string): void {
	const result = parse(source);
	expect(result.ok).toBe(false);
	expect(result.diagnostics).toContainEqual({ component: "svg", severity: "error", line, message: expect.stringContaining(message) });
	let svgCalls = 0;
	const rendered = renderDraft(`\`\`\`svg\n${source}\n\`\`\``, { edit: passiveEdit,
		id: "draft.rejected",
		context: {
			svg(id) { svgCalls++; return { id, k: "image" }; },
			image() { throw new Error("rejected SVG must not render an image"); },
			readFile() { throw new Error("rejected SVG must not read a file"); },
		},
		view: () => "changes",
		viewSwitch: id => ({ id, k: "row" }),
	});
	expect(rendered.diagnostics).toContainEqual(expect.objectContaining({ component: "svg", severity: "error", message: expect.stringContaining(message) }));
	expect(svgCalls).toBe(0);
}

describe("raw SVG sizing and preservation", () => {
	test("keeps exact source, whitespace, CJK, and theme variables", () => {
		const source = '\n<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80">\n  <rect width="240" height="80" fill="var(--surface)"/>\n  <text x="10" y="40" fill="var(--fg)">中文标签</text>\n</svg>\n';
		const result = parse(source);
		expect(result).toEqual({ ok: true, value: { source, width: 240, height: 80 }, diagnostics: [] });
	});

	test("uses both root dimensions before viewBox and ignores nested dimensions", () => {
		expect(value('<svg width="320px" height="160.5" viewBox="0 0 90 45"><rect width="9" height="8"/></svg>')).toMatchObject({ width: 320, height: 160.5 });
	});

	test("reads signed, decimal, exponential viewBox user units with whitespace or commas", () => {
		expect(value("<svg viewBox='-10, +.5, 6e2, 3E2' />")).toMatchObject({ width: 600, height: 300 });
		expect(value('<svg\nviewBox="0\n0\t240 80"/>')).toMatchObject({ width: 240, height: 80 });
	});

	for (const attributes of ['width="50"', 'height="30"', 'width="0" height="10"', 'width="-10" height="10"', 'width="100%" height="50%"', 'width="10px-junk" height="20"', 'width="Infinity" height="20"', 'width="1e999" height="20"']) {
		test(`falls back to viewBox for incomplete or unusable dimensions: ${attributes}`, () => {
			const result = parse(`<svg ${attributes} viewBox="0 0 240 80"/>`);
			expect(result).toMatchObject({ ok: true, value: { width: 240, height: 80 }, diagnostics: [] });
		});
	}

	for (const attributes of ["", 'viewBox="0 0 0 20"', 'viewBox="0 0 20 -10"', 'viewBox="0 0 NaN 20"', 'viewBox="0 0 1e999 20"', 'viewBox="0 0 20 10junk"', 'viewBox="0 0 20"']) {
		test(`warns and uses 600×300 when no valid dimensions exist: ${attributes}`, () => {
			const result = parse(`\n<svg ${attributes}/>`);
			expect(result).toMatchObject({ ok: true, value: { width: 600, height: 300 } });
			expect(result.diagnostics).toEqual([{ component: "svg", severity: "warning", line: 11, message: expect.stringContaining("600×300") }]);
		});
	}
});

describe("SVG root and safety validation", () => {
	for (const source of ["", "   ", "text", "<div><svg/></div>", '<svgish width="10" height="20"/>', "<SVG/>", "<svg/><svg/>"]) {
		test(`rejects absent or non-SVG/multiple roots: ${JSON.stringify(source)}`, () => {
			expect(parse(source).ok).toBe(false);
		});
	}

	for (const name of ["script", "SCRIPT", "foreignObject", "foreignobject", "s:script", "s:foreignObject"]) {
		test(`rejects unsafe element ${name} on its actual line`, () => {
			rejected(`<svg width="240" height="80">\n  <${name}/>\n</svg>`, 11, `禁止 <${name}>`);
		});
	}

	for (const name of ["onclick", "onload", "ONCLICK", "onmouseover", "s:onload"]) {
		test(`rejects event handler ${name} across lines and quoted >`, () => {
			rejected(`<svg width="240" height="80">\n<rect title="a > b"\n  ${name} = 'alert(1 > 0)'/>\n</svg>`, 12, name);
		});
	}

	for (const name of ["href", "xlink:href", "HREF", "XLINK:HREF"]) {
		for (const target of ["https://example.org/p.svg#shape", "//example.org/p.svg", "file.svg#shape", "data:image/svg+xml,foo", "javascript:alert(1)", "", "#", " #shape", "#two shapes", "&#35;shape"]) {
			test(`rejects external or nonfragment ${name}=${JSON.stringify(target)}`, () => {
				rejected(`<svg width="240" height="80">\n<use\n ${name}="${target}"/>\n</svg>`, 12, "#fragment");
			});
		}
	}

	test("permits internal href and xlink:href references without rewriting them", () => {
		const source = '<svg width="240" height="80" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><path id="图形" d="M0 0h10"/></defs><use href="#图形"/><use xlink:href="#图形"/></svg>';
		expect(parse(source)).toEqual({ ok: true, value: { source, width: 240, height: 80 }, diagnostics: [] });
	});
	for (const prefix of ["l", "link", "other"]) {
		test(`rejects XLink href under the ${prefix} namespace alias`, () => {
			rejected(`<svg width="240" height="80" xmlns:${prefix}="http://www.w3.org/1999/xlink">\n<image ${prefix}:href="https://example.org/image.svg"/>\n</svg>`, 11, "#fragment");
		});
	}

	for (const name of ["script", "foreignObject"]) {
		test(`rejects namespace-qualified ${name} by local name`, () => {
			rejected(`<svg width="240" height="80" xmlns:other="http://www.w3.org/2000/svg">\n<other:${name}/>\n</svg>`, 11, `禁止 <other:${name}>`);
		});
	}

	for (const attribute of [
		'fill="url(https://example.org/paint.svg#color)"',
		'filter="URL(//example.org/filter.svg#blur)"',
		'clip-path="url(file.svg#clip)"',
		'style="fill: url(&quot;https://example.org/paint.svg#color&quot;)"',
		'style="fill: url(\'data:image/svg+xml,foo\')"',
		'fill="u\\72l(https://example.org/paint.svg#color)"',
		'fill="\\75\\72\\6c(https://example.org/paint.svg#color)"',
		'fill="u\\r\\l(https://example.org/paint.svg#color)"',
		'fill="u&#114;l&#40;https://example.org/paint.svg#color)"',
		'fill="url(&#92;68 ttps://example.org/paint.svg#color)"',
		'fill="url(/*external*/#color)"',
		'fill="url(\\2f\\2a external\\2a\\2f#color)"',
		'fill="url()"',
		'fill="url(https://example.org/unclosed"',
		'fill="url(#safe) url(https://example.org/paint.svg#color)"',
	]) {
		test(`rejects external or malformed CSS URLs in attributes: ${attribute}`, () => {
			rejected(`<svg width="240" height="80">\n<rect ${attribute}/>\n</svg>`, 11, "#fragment");
		});
	}

	for (const css of [
		"rect { fill: url(https://example.org/paint.svg#color); }",
		"rect { filter: url('//example.org/filter.svg#blur'); }",
		"@import 'https://example.org/style.css';",
		"@IMPORT url(https://example.org/style.css);",
		"rect { fill: u\\72l(https://example.org/paint.svg#color); }",
		"@\\69mport 'https://example.org/style.css';",
		"rect { fill: url(#local); content: '\\41'; }",
	]) {
		for (const cdata of [false, true]) {
			test(`rejects unsafe ${cdata ? "CDATA" : "ordinary"} style text: ${css}`, () => {
				rejected(`<svg width="240" height="80">\n<style>${cdata ? `<![CDATA[${css}]]>` : css}</style>\n</svg>`, 11, css.includes("\\") ? "转义" : css.toLowerCase().includes("@import") ? "@import" : "#fragment");
			});
		}
	}

	test("checks style content joined across text, comments and CDATA", () => {
		rejected('<svg width="240" height="80">\n<style>u<!-- split -->r<![CDATA[l(https://example.org/paint.svg#color)]]></style>\n</svg>', 11, "#fragment");
		rejected('<svg width="240" height="80">\n<style>@im<![CDATA[port]]> "https://example.org/style.css";</style>\n</svg>', 11, "@import");
	});

	test("checks namespaced style and XML-encoded style text", () => {
		rejected('<svg width="240" height="80" xmlns:s="http://www.w3.org/2000/svg">\n<s:style>rect { fill: u&#114;l(https://example.org/paint.svg); }</s:style>\n</svg>', 11, "#fragment");
		rejected('<svg width="240" height="80">\n<style>rect { fill: u&#92;72l(https://example.org/paint.svg); }</style>\n</svg>', 11, "转义");
	});

	for (const element of [
		'<svg width="100" width="200" height="80"/>',
		'<svg width="240" height="80">\n<rect fill="red" fill="blue"/>\n</svg>',
		'<svg width="240" height="80">\n<use href="#one" href="#two"/>\n</svg>',
		'<svg width="240" height="80" xmlns:l="http://www.w3.org/1999/xlink">\n<use l:href="#one" l:href="#two"/>\n</svg>',
	]) {
		test(`rejects duplicate XML attributes: ${element}`, () => {
			rejected(element, element.includes("\n") ? 11 : 10, "重复");
		});
	}

	test("preserves internal fragment URLs, aliased href, and safe style text", () => {
		const source = '<svg width="240" height="80" xmlns:l="http://www.w3.org/1999/xlink"><defs><linearGradient id="color"/></defs><style>rect { fill: url("#color"); }</style><style><![CDATA[rect { filter: url(#blur); }]]></style><rect fill="u\\72l(#color)" style="clip-path: url(\'#clip\')"/><use l:href="#shape"/></svg>';
		expect(parse(source)).toEqual({ ok: true, value: { source, width: 240, height: 80 }, diagnostics: [] });
	});

	test("permits the same attribute on different elements and case-distinct XML names", () => {
		const source = '<svg width="240" height="80" WIDTH="300"><rect fill="red"/><rect fill="blue"/></svg>';
		expect(parse(source)).toEqual({ ok: true, value: { source, width: 240, height: 80 }, diagnostics: [] });
	});

	test("ignores forbidden-looking text only inside comments, CDATA and quoted text", () => {
		const source = '<?xml version="1.0"?>\n<!-- <script onload="bad()" href="external"/> -->\n<svg width="240" height="80">\n<!-- <foreignObject/> -->\n<text><![CDATA[<script onclick="bad" href="outside">]]></text>\n<rect data-note="onclick=bad > script"/>\n</svg>';
		expect(parse(source)).toEqual({ ok: true, value: { source, width: 240, height: 80 }, diagnostics: [] });
	});

	test("reports every unsafe construct rather than drawing a partially accepted source", () => {
		const result = parse('<svg width="240" height="80">\n<script/>\n<foreignObject/>\n<rect onclick="bad"/>\n<use href="outside"/>\n</svg>');
		expect(result.ok).toBe(false);
		expect(result.diagnostics.map(item => item.line)).toEqual([11, 12, 13, 14]);
	});

	for (const source of ['<svg width="240" height="80"><rect onload="bad></rect></svg>', '<svg><rect href=outside/></svg>', '<svg><rect/></g>', '<svg><rect/>', '<svg><!-- never closes', '<svg><![CDATA[never closes', '<?xml never closes', '<!DOCTYPE svg [<!ENTITY unsafe "external">]><svg/>']) {
		test(`does not bypass validation on malformed markup: ${JSON.stringify(source)}`, () => {
			expect(parse(source).ok).toBe(false);
		});
	}
});

describe("SVG rendering", () => {
	for (const view of ["changes", "before", "after"] satisfies readonly ChangeView[]) {
		test(`passes raw source and dimensions to ctx.svg in ${view} view`, () => {
			const spec = value('<svg width="240" height="80"><text fill="var(--accent)">中文</text></svg>');
			const calls: { readonly id: string; readonly source: string; readonly size: { readonly w: number; readonly h: number }; readonly alt: string }[] = [];
			const ctx: RenderContext = { ...renderDefaults,
				id: "draft.panel.3", view,
				svg(id, source, size, alt) {
					calls.push({ id, source, size, alt });
					return { id, k: "image", p: { alt, w: size.w, h: size.h } };
				},
				image() { throw new Error("raw SVG must use ctx.svg"); },
				readFile() { throw new Error("raw SVG must not read files"); },
			};
			const rendered = renderSvg(spec, ctx);
			expect(calls).toEqual([{ id: `${ctx.id}.image`, source: spec.source, size: { w: 240, h: 80 }, alt: "SVG 图形" }]);
			expect(rendered.diagnostics).toEqual([]);
			expect(rendered.nodes).toHaveLength(1);
			expect(rendered.nodes[0]?.id.startsWith(`${ctx.id}.`)).toBe(true);
			expect(new Set(rendered.nodes.map(node => node.id)).size).toBe(rendered.nodes.length);
		});
	}
});
