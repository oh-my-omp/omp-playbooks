import { tr } from "../../i18n";
import type { DraftDiagnostic, FenceInput, Parsed, RenderContext, Rendered } from "./contract";
import { diagnostic } from "./contract";
import { escapeXml } from "./text";
import type { TspNode } from "../tsp-types";

type HtmlTag = "div" | "span" | "b" | "i" | "code" | "pre" | "strong" | "em" | "del" | "p" | "h1" | "h2" | "h3" | "h4" | "ul" | "ol" | "li" | "blockquote" | "hr" | "label" | "button" | "kbd" | "mark" | "section" | "article" | "header" | "footer" | "nav" | "dl" | "dt" | "dd" | "table" | "thead" | "tbody" | "tr" | "th" | "td";
type HtmlNode =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "element"; readonly tag: HtmlTag; readonly children: readonly HtmlNode[] }
	| { readonly kind: "link"; readonly href: string; readonly children: readonly HtmlNode[] }
	| { readonly kind: "svg"; readonly source: string; readonly w: number; readonly h: number; readonly alt: string };

/** HTML normalized to Tern's closed element vocabulary; attributes cannot escape into TSP. */
export interface HtmlSpec {
	readonly nodes: readonly HtmlNode[];
}

interface Attribute { readonly name: string; readonly value: string }
interface RawElement {
	readonly kind: "element";
	readonly name: string;
	readonly line: number;
	readonly attributes: readonly Attribute[];
	readonly children: RawNode[];
}
type RawNode = { readonly kind: "text"; readonly text: string } | RawElement;

const tags: Readonly<Record<HtmlTag, true>> = { div: true, span: true, b: true, i: true, code: true, pre: true, strong: true, em: true, del: true, p: true, h1: true, h2: true, h3: true, h4: true, ul: true, ol: true, li: true, blockquote: true, hr: true, label: true, button: true, kbd: true, mark: true, section: true, article: true, header: true, footer: true, nav: true, dl: true, dt: true, dd: true, table: true, thead: true, tbody: true, tr: true, th: true, td: true };
function supported(name: string): name is HtmlTag { return Object.hasOwn(tags, name); }
const forbidden: Readonly<Record<string, true>> = { script: true, style: true, iframe: true, object: true, embed: true };
const voidTags: Readonly<Record<string, true>> = { area: true, base: true, br: true, col: true, embed: true, hr: true, img: true, input: true, link: true, meta: true, param: true, source: true, track: true, wbr: true };
const paragraphBlocks: Readonly<Record<string, true>> = { div: true, p: true, h1: true, h2: true, h3: true, h4: true, h5: true, h6: true, ul: true, ol: true, blockquote: true, pre: true, section: true, article: true, header: true, footer: true, nav: true, dl: true, dt: true, dd: true, table: true, hr: true };
const entities: Readonly<Record<string, string>> = {
	amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©", reg: "®", trade: "™", cent: "¢", pound: "£", yen: "¥", euro: "€", sect: "§", para: "¶", deg: "°", plusmn: "±", times: "×", divide: "÷", micro: "µ", middot: "·", bull: "•", hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„", laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›", ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009", shy: "\u00ad", zwnj: "\u200c", zwj: "\u200d", lrm: "\u200e", rlm: "\u200f", iexcl: "¡", iquest: "¿", acute: "´", macr: "¯", uml: "¨", not: "¬", frac14: "¼", frac12: "½", frac34: "¾", sup1: "¹", sup2: "²", sup3: "³", fnof: "ƒ", minus: "−", ne: "≠", le: "≤", ge: "≥", asymp: "≈", infin: "∞", radic: "√", sum: "∑", prod: "∏", int: "∫", isin: "∈", notin: "∉", empty: "∅", forall: "∀", exist: "∃", and: "∧", or: "∨", cap: "∩", cup: "∪", sub: "⊂", sup: "⊃", sube: "⊆", supe: "⊇", larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", crarr: "↵", lArr: "⇐", rArr: "⇒", hArr: "⇔", Alpha: "Α", Beta: "Β", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω", alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", theta: "θ", lambda: "λ", mu: "μ", pi: "π", sigma: "σ", phi: "φ", psi: "ψ", omega: "ω",
};
const latinNames = ["Agrave", "Aacute", "Acirc", "Atilde", "Auml", "Aring", "AElig", "Ccedil", "Egrave", "Eacute", "Ecirc", "Euml", "Igrave", "Iacute", "Icirc", "Iuml", "ETH", "Ntilde", "Ograve", "Oacute", "Ocirc", "Otilde", "Ouml", "times", "Oslash", "Ugrave", "Uacute", "Ucirc", "Uuml", "Yacute", "THORN", "szlig", "agrave", "aacute", "acirc", "atilde", "auml", "aring", "aelig", "ccedil", "egrave", "eacute", "ecirc", "euml", "igrave", "iacute", "icirc", "iuml", "eth", "ntilde", "ograve", "oacute", "ocirc", "otilde", "ouml", "divide", "oslash", "ugrave", "uacute", "ucirc", "uuml", "yacute", "thorn", "yuml"];
const latinEntities: Readonly<Record<string, string>> = Object.fromEntries(latinNames.map((name, index) => [name, String.fromCodePoint(0xc0 + index)]));
const numericReplacements: Readonly<Record<number, number>> = { 128: 8364, 130: 8218, 131: 402, 132: 8222, 133: 8230, 134: 8224, 135: 8225, 136: 710, 137: 8240, 138: 352, 139: 8249, 140: 338, 142: 381, 145: 8216, 146: 8217, 147: 8220, 148: 8221, 149: 8226, 150: 8211, 151: 8212, 152: 732, 153: 8482, 154: 353, 155: 8250, 156: 339, 158: 382, 159: 376 };
function decode(text: string): string {
	return text.replace(/&(#(?:x[\da-f]+|\d+)|[a-z][\da-z]*)(;?)/gi, (reference: string, name: string, semicolon: string) => {
		if (name.startsWith("#")) {
			const hex = name[1]?.toLowerCase() === "x";
			let code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
			code = numericReplacements[code] ?? code;
			return String.fromCodePoint(!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? 0xfffd : code);
		}
		// Only legacy core references are unambiguous without a semicolon.
		if (!semicolon && !["amp", "lt", "gt", "quot", "nbsp", "copy", "reg"].includes(name)) return reference;
		return (Object.hasOwn(entities, name) ? entities[name] : undefined) ?? (Object.hasOwn(latinEntities, name) ? latinEntities[name] : undefined) ?? reference;
	});
}

function attribute(element: RawElement, name: string): string {
	return element.attributes.find(value => value.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Small tolerant tag/text scanner: not a browser DOM, but preserves text and nesting. */
function scan(source: string, firstLine: number, diagnostics: DraftDiagnostic[]): Parsed<readonly RawNode[]> {
	const roots: RawNode[] = [];
	const stack: RawElement[] = [];
	let offset = 0;
	let line = firstLine;
	const children = (): RawNode[] => stack.at(-1)?.children ?? roots;
	const advance = (end: number): void => {
		for (let index = offset; index < end; index++) if (source[index] === "\n") line++;
		offset = end;
	};
	const addText = (text: string): void => { if (text) children().push({ kind: "text", text: decode(text) }); };
	const closeOptional = (names: readonly string[], boundaries: readonly string[]): void => {
		for (let index = stack.length - 1; index >= 0; index--) {
			const name = stack[index]!.name.toLowerCase();
			if (names.includes(name)) { stack.length = index; return; }
			if (boundaries.includes(name)) return;
		}
	};
	while (offset < source.length) {
		if (source.startsWith("<!--", offset)) {
			const end = source.indexOf("-->", offset + 4);
			advance(end < 0 ? source.length : end + 3);
			continue;
		}
		if (source.startsWith("<![CDATA[", offset)) {
			const end = source.indexOf("]]>", offset + 9);
			children().push({ kind: "text", text: source.slice(offset + 9, end < 0 ? source.length : end) });
			advance(end < 0 ? source.length : end + 3);
			continue;
		}
		if (source[offset] !== "<") {
			const end = source.indexOf("<", offset);
			addText(source.slice(offset, end < 0 ? source.length : end));
			advance(end < 0 ? source.length : end);
			continue;
		}
		if (!/^<\s*(?:\/?\s*[a-z]|[!?])/i.test(source.slice(offset, offset + 32))) {
			addText("<");
			advance(offset + 1);
			continue;
		}
		let end = offset + 1;
		let quote = "";
		for (; end < source.length; end++) {
			const char = source[end]!;
			if (quote) { if (char === quote) quote = ""; }
			else if (char === '"' || char === "'") quote = char;
			else if (char === ">") break;
		}
		if (end === source.length) { addText(source.slice(offset)); break; }
		const token = source.slice(offset + 1, end);
		const match = /^\s*(\/?)\s*([a-z][\w:.-]*)([\s\S]*)$/i.exec(token);
		if (!match) {
			if (!/^\s*[!?]/.test(token)) addText(source.slice(offset, end + 1));
			advance(end + 1);
			continue;
		}
		const name = match[2]!;
		const lower = name.toLowerCase();
		if (match[1]) {
			for (let index = stack.length - 1; index >= 0; index--) {
				if (stack[index]!.name.toLowerCase() === lower) { stack.length = index; break; }
			}
			advance(end + 1);
			continue;
		}
		const inSvg = stack.some(element => element.name.toLowerCase() === "svg");
		if (!inSvg) {
			if (Object.hasOwn(paragraphBlocks, lower)) closeOptional(["p"], ["table", "li", "div"]);
			if (lower === "li") closeOptional(["li"], ["ul", "ol"]);
			if (lower === "dt" || lower === "dd") closeOptional(["dt", "dd"], ["dl"]);
			if (lower === "tr") closeOptional(["tr"], ["table", "thead", "tbody"]);
			if (lower === "td" || lower === "th") closeOptional(["td", "th"], ["tr", "table"]);
			if (["thead", "tbody", "tfoot"].includes(lower)) closeOptional(["thead", "tbody", "tfoot"], ["table"]);
		}
		// Bound every raw tree, including SVG, before any recursive normalization or rendering.
		if (stack.length >= 256) {
			diagnostics.push(diagnostic("html", line, tr("HTML nesting exceeds 256 levels; reduce tag nesting.", "HTML 嵌套深度超过 256 层；请减少标签嵌套。")));
			return { ok: false, diagnostics };
		}
		const attributes: Attribute[] = [];
		const attributeNames = new Set<string>();
		for (const attr of match[3]!.replace(/\/\s*$/, "").matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
			const attrName = attr[1]!;
			const key = inSvg || lower === "svg" ? attrName : attrName.toLowerCase();
			if (attributeNames.has(key)) {
				diagnostics.push(diagnostic("html", line, tr(`Removed duplicate attribute ${attrName}; the first value was kept.`, `已移除重复属性 ${attrName}，保留首次出现的值。`), "warning"));
				continue;
			}
			attributeNames.add(key);
			attributes.push({ name: attrName, value: decode(attr[2] ?? attr[3] ?? attr[4] ?? "") });
		}
		const element: RawElement = { kind: "element", name, line, attributes, children: [] };
		children().push(element);
		advance(end + 1);
		if (Object.hasOwn(voidTags, lower) || /\/\s*$/.test(match[3]!)) continue;
		// Raw-text elements must not let fake markup inside them affect their surrounding tree.
		if (["script", "style", "iframe"].includes(lower)) {
			const close = new RegExp(`<\\/\\s*${lower}\\s*>`, "ig");
			close.lastIndex = offset;
			const closing = close.exec(source);
			advance(closing ? closing.index + closing[0].length : source.length);
			continue;
		}
		stack.push(element);
	}
	return { ok: true, value: roots, diagnostics };
}

function rawText(nodes: readonly RawNode[]): string {
	return nodes.map(node => node.kind === "text" ? node.text : rawText(node.children)).join("");
}

function decodeCss(value: string): string {
	return value.replace(/\\(?:([\da-f]{1,6})(?:\r\n|[\t\n\f\r ])?|\r\n|[\n\r\f]|([\s\S]))/gi, (_escape: string, hex: string | undefined, char: string | undefined) => {
		if (hex === undefined) return char ?? "";
		const code = Number.parseInt(hex, 16);
		return String.fromCodePoint(!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? 0xfffd : code);
	});
}

/** Inspect CSS tokens without treating quoted text or comments as active references. */
function externalCssReference(value: string): boolean {
	const skipSpace = (start: number): number => {
		let cursor = start;
		while (cursor < value.length) {
			if (/\s/.test(value[cursor]!)) { cursor++; continue; }
			if (!value.startsWith("/*", cursor)) break;
			const end = value.indexOf("*/", cursor + 2);
			cursor = end < 0 ? value.length : end + 2;
		}
		return cursor;
	};
	const tokens = /\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|(?:[\w-]|\\(?:[\da-f]{1,6}(?:\r\n|[\t\n\f\r ])?|[^\n\r\f]))+|[^\s]/gi;
	let atKeyword = false;
	for (let token = tokens.exec(value); token; token = tokens.exec(value)) {
		const text = token[0];
		if (text.startsWith("/*")) continue;
		const word = decodeCss(text).toLowerCase();
		if (atKeyword && word === "import") return true;
		atKeyword = text === "@";
		if (word !== "url") continue;
		let cursor = skipSpace(tokens.lastIndex);
		if (value[cursor] !== "(") continue;
		cursor = skipSpace(cursor + 1);
		let target = "";
		const quote = value[cursor] === '"' || value[cursor] === "'" ? value[cursor++] : undefined;
		let closed = false;
		for (; cursor < value.length; cursor++) {
			const char = value[cursor]!;
			if (char === "\\") {
				const escape = /^\\(?:[\da-f]{1,6}(?:\r\n|[\t\n\f\r ])?|\r\n|[\s\S])/.exec(value.slice(cursor));
				if (!escape) return true;
				target += escape[0];
				cursor += escape[0].length - 1;
			} else if (char === (quote ?? ")")) {
				closed = true;
				break;
			} else if (!quote && value.startsWith("/*", cursor)) {
				const end = value.indexOf("*/", cursor + 2);
				if (end < 0) return true;
				// A comment is whitespace, not part of an unquoted URL.
				target += " ";
				cursor = end + 1;
			} else target += char;
		}
		if (!closed || !/^#[^\s"'()\\]+$/.test(decodeCss(target).trim())) return true;
		if (quote) {
			cursor = skipSpace(cursor + 1);
			if (value[cursor] !== ")") return true;
		}
		tokens.lastIndex = cursor + 1;
	}
	return false;
}

function svgNode(element: RawElement, warn: (line: number, message: string) => void): HtmlNode {
	const serialize = (node: RawNode): string => {
		if (node.kind === "text") return escapeXml(node.text);
		const lower = node.name.slice(node.name.lastIndexOf(":") + 1).toLowerCase();
		if (Object.hasOwn(forbidden, lower) || lower === "foreignobject") {
			warn(node.line, tr(`Removed <${node.name}>; use a safe SVG graphic instead.`, `已移除 <${node.name}>，请改用安全的 SVG 图形。`));
			return "";
		}
		const attributes = node.attributes.filter(attr => {
			if (attr.name === "xmlns" || attr.name.startsWith("xmlns:")) return true;
			const name = attr.name.slice(attr.name.lastIndexOf(":") + 1).toLowerCase();
			if (name.startsWith("on")) { warn(node.line, tr(`Removed ${attr.name}; delete SVG event handlers.`, `已移除 ${attr.name}，请删除 SVG 事件处理器。`)); return false; }
			if (((name === "href" || name === "src") && !/^#[^\s]+$/.test(attr.value.trim())) || externalCssReference(attr.value)) {
				warn(node.line, tr(`Removed external reference ${attr.name}; use a local #id reference instead.`, `已移除 ${attr.name} 外部引用，请改用 #id 本地引用。`));
				return false;
			}
			return true;
		}).map(attr => ` ${attr.name}="${escapeXml(attr.value)}"`).join("");
		const namespace = node === element && !attribute(node, "xmlns") ? ' xmlns="http://www.w3.org/2000/svg"' : "";
		return `<${node.name}${namespace}${attributes}>${node.children.map(serialize).join("")}</${node.name}>`;
	};
	const length = (value: string): number | undefined => {
		const match = /^\s*(\d+(?:\.\d+)?|\.\d+)(?:px)?\s*$/.exec(value);
		const number = match ? Number(match[1]) : 0;
		return number > 0 && Number.isFinite(number) ? number : undefined;
	};
	const box = attribute(element, "viewBox").trim().split(/[\s,]+/).map(Number);
	const boxWidth = box.length === 4 && box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0 ? box[2]! : undefined;
	const boxHeight = boxWidth ? box[3]! : undefined;
	const width = length(attribute(element, "width"));
	const height = length(attribute(element, "height"));
	const w = width ?? (height && boxWidth && boxHeight ? height * boxWidth / boxHeight : boxWidth ?? 300);
	const h = height ?? (width && boxWidth && boxHeight ? width * boxHeight / boxWidth : boxHeight ?? 150);
	const scale = Math.min(1, 1000 / w);
	const title = element.children.find(node => node.kind === "element" && node.name.toLowerCase() === "title");
	return { kind: "svg", source: serialize(element), w: w * scale, h: h * scale, alt: attribute(element, "aria-label") || (title?.kind === "element" ? rawText(title.children) : "") || tr("Embedded SVG", "内嵌 SVG") };
}

export function parseHtml(input: FenceInput): Parsed<HtmlSpec> {
	const diagnostics: DraftDiagnostic[] = [];
	const warn = (line: number, message: string): void => { diagnostics.push(diagnostic("html", line, message, "warning")); };
	const normalize = (node: RawNode): HtmlNode[] => {
		if (node.kind === "text") return [{ kind: "text", text: node.text }];
		const name = node.name.toLowerCase();
		if (Object.hasOwn(forbidden, name)) { warn(node.line, tr(`Removed <${name}> and its contents; use safe HTML tags instead.`, `已移除 <${name}> 及其内容，请改用安全的 HTML 标签。`)); return []; }
		if (name === "svg") return [svgNode(node, warn)];
		if (name === "br") return [{ kind: "text", text: "\n" }];
		const children = node.children.flatMap(normalize);
		if (name === "a") return [{ kind: "link", href: attribute(node, "href"), children }];
		if (["u", "ins", "small", "sup", "sub"].includes(name)) return [{ kind: "element", tag: "span", children }];
		if (name === "s") return [{ kind: "element", tag: "del", children }];
		if (name === "h5" || name === "h6") return [{ kind: "element", tag: "h4", children }];
		if (supported(name)) return [{ kind: "element", tag: name, children }];
		warn(node.line, tr(`The <${name}> tag is not supported; its content was kept. Use <div> instead.`, `不支持 <${name}>，已保留内容；请改用 <div>。`));
		return [{ kind: "element", tag: "div", children }];
	};
	const scanned = scan(input.lines.join("\n"), input.line, diagnostics);
	if (!scanned.ok) return scanned;
	return { ok: true, value: { nodes: scanned.value.flatMap(normalize) }, diagnostics };
}

export function renderHtml(spec: HtmlSpec, ctx: RenderContext): Rendered {
	let sequence = 0;
	const id = (): string => `${ctx.id}.html.${sequence++}`;
	const render = (node: HtmlNode): TspNode => {
		const nodeId = id();
		switch (node.kind) {
			case "text": return node.text.includes("\n")
				? { id: nodeId, k: "text", p: { spans: [{ t: node.text }] } }
				: { id: nodeId, k: "el", p: { tag: "span", text: node.text } };
			case "element": return { id: nodeId, k: "el", p: { tag: node.tag }, c: node.children.map(render) };
			case "link": return { id: nodeId, k: "el", p: { tag: "span" }, c: [...node.children.map(render), ...(node.href ? [{ id: id(), k: "text", p: { spans: [{ t: ` (${node.href})`, s: "muted" }] } }] : [])] };
			case "svg": return ctx.svg(nodeId, node.source, { w: node.w, h: node.h }, node.alt);
		}
	};
	return { nodes: spec.nodes.map(render), diagnostics: [] };
}
